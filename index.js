// dsh-rooms — host half.
//
// One room, two fish, one WeChat-style message stream.
// Data lives in `<DSH_HOME>/storages/rooms.json`; the browser half talks to it
// over the `/rooms` HTTP routes registered here.
//
// Design notes that matter while reading this file:
//   * `seq` is the global message cursor; `at` is only for drawing time.
//   * There is exactly one writer: every mutation goes through `persist()`,
//     which serializes one write at a time.
//   * Only a user message may start a delivery. An agent message never does —
//     that is the single guard against two agents waking each other forever.
//   * A delivery is identified by its `requestId`, which survives in the
//     durable session log (`source.rpcId`), so harvesting can claim exactly
//     the turn it caused.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'

const ROOM_ID = 'r1'
const DELIVERY_WINDOW_MS = 1500
// A fast typist keeps resetting the debounce; the batch still has to leave.
const DELIVERY_WINDOW_MAX_MS = 6000
const READ_LIMIT = 20
const KEEP_DAYS = 7
const MAX_MESSAGE_CHARS = 8000
const WATCH_TIMEOUT_MS = 2 * 60 * 60 * 1000
const LONG_TURN_NOTICE_MS = 10 * 60 * 1000
const POINTER_PREFIX = 'room-'
const AGENT_HORN_EVERY = 20
// How many missed messages one pointer may ask a member to catch up on.
const BACKFILL_MAX = 12
// A bare acknowledgement answered in words is not worth a bubble. `room_ack`
// is the supported way to say it; this only catches the model's habit.
const CONFIRM_ONLY = /^(看过了|收到|明白了?|已读|了解|收到啦|知道了|看见了)[。.!！~～…\s]*$/

export const name = 'rooms'
export const inject = ['tools', 'webServer', 'sessionController']

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function storageFile() {
  const home = process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? process.env.HOME ?? '.', '.dsh')
  return join(home, 'storages', 'rooms.json')
}

function emptyDb() {
  const now = Date.now()
  return {
    seq: 0,
    earliestSeq: 1,
    rooms: {
      [ROOM_ID]: {
        id: ROOM_ID,
        title: '群',
        createdAt: now,
        deleted: false,
        wakeEnabled: true,
        activity: null,
        acks: {},
        members: [{ kind: 'user', name: '我', lastReadSeq: 0 }],
      },
    },
    messages: { [ROOM_ID]: [] },
  }
}

function textOf(blocks) {
  if (!Array.isArray(blocks)) return ''
  return blocks
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim()
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// Both symbols follow the same token rule: they must start a token and the name
// must end it, so `#灯灯` never wakes `灯` and `abc#灯` never fires.
function symbolMentions(normalizedText, symbol, memberName) {
  const pattern = new RegExp(`(^|[\\s\\p{P}])${escapeRegExp(symbol)}${escapeRegExp(memberName)}($|[\\s\\p{P}])`, 'u')
  return pattern.test(normalizedText)
}

// `#name` = work hand-off. `¥name` = "someone is looking for you" (no work
// implied). NFKC folds the full-width ￥ into ¥, so either input works.
function mentions(normalizedText, memberName) {
  return symbolMentions(normalizedText, '#', memberName)
}

function attentionMentions(normalizedText, memberName) {
  return symbolMentions(normalizedText, '¥', memberName)
}

export function apply(ctx) {
  const FILE = storageFile()
  let db = loadDb()
  let saveChain = Promise.resolve()
  const deliveries = new Map() // sessionId -> delivery record
  const pendingDelivery = new Map() // sessionId -> { fromSeq } that arrived mid-turn
  const runtime = new Map() // sessionId -> { lastSayAt, lastAckAt }
  const memberState = new Map() // name -> { live, running, queued }
  let windowTimer = null
  let windowFromSeq = 0
  let windowOpenedAt = 0
  let recoverRetryTimer = null

  // ---------------------------------------------------------------- storage

  function loadDb() {
    try {
      if (!existsSync(FILE)) return emptyDb()
      const parsed = JSON.parse(readFileSync(FILE, 'utf8'))
      return normalizeDb(parsed)
    } catch (error) {
      ctx.logger?.warn?.(`rooms: could not read ${FILE}: ${String(error?.message ?? error)}`)
      return emptyDb()
    }
  }

  function normalizeDb(input) {
    const base = emptyDb()
    if (input === null || typeof input !== 'object') return base
    const db2 = {
      seq: Number.isFinite(input.seq) ? input.seq : 0,
      earliestSeq: Number.isFinite(input.earliestSeq) ? input.earliestSeq : 1,
      rooms: {},
      messages: {},
    }
    for (const [id, room] of Object.entries(input.rooms ?? {})) {
      if (room === null || typeof room !== 'object') continue
      db2.rooms[id] = {
        id,
        title: typeof room.title === 'string' ? room.title : '群',
        createdAt: Number.isFinite(room.createdAt) ? room.createdAt : Date.now(),
        deleted: room.deleted === true,
        wakeEnabled: room.wakeEnabled !== false,
        muteAgentToAgent: room.muteAgentToAgent === true,
        activity: room.activity ?? null,
        acks: room.acks ?? {},
        receipts: room.receipts ?? {},
        inflight: room.inflight ?? {},
        wakeLog: Array.isArray(room.wakeLog) ? room.wakeLog : [],
        consecutiveAgent: Number.isFinite(room.consecutiveAgent) ? room.consecutiveAgent : 0,
        members: Array.isArray(room.members)
          ? room.members
            .filter((m) => m && typeof m.name === 'string')
            .map((m) => (m.kind === 'agent'
            ? {
              ...m,
              active: m.active !== false,
              // Highest seq this member has SEEN, by any read mode. `lastReadSeq`
              // is the "give me the next ones" cursor; this one only exists so a
              // re-read cannot make an old batch look unread.
              lastSeenSeq: Number.isFinite(m.lastSeenSeq) ? m.lastSeenSeq : 0,
            }
            : m))
          : [],
      }
      db2.messages[id] = Array.isArray(input.messages?.[id]) ? input.messages[id] : []
    }
    if (db2.rooms[ROOM_ID] === undefined) db2.rooms[ROOM_ID] = base.rooms[ROOM_ID]
    if (db2.messages[ROOM_ID] === undefined) db2.messages[ROOM_ID] = []
    return db2
  }

  // Another process (a second DSH window) may have advanced the log since our
  // last read. Pull its messages in before overwriting, so two long-running
  // windows cannot silently erase each other's history.
  function mergeDiskBeforeWrite() {
    if (!existsSync(FILE)) return
    let disk
    try {
      disk = JSON.parse(readFileSync(FILE, 'utf8'))
    } catch {
      return
    }
    if (!Number.isFinite(disk?.seq) || disk.seq <= db.seq) return
    const known = new Set(messages().map((message) => message.seq))
    const incoming = (disk.messages?.[ROOM_ID] ?? [])
      .filter((message) => Number.isFinite(message?.seq) && !known.has(message.seq))
    if (incoming.length > 0) {
      db.messages[ROOM_ID].push(...incoming)
      db.messages[ROOM_ID].sort((left, right) => left.seq - right.seq)
    }
    db.seq = Math.max(db.seq, disk.seq)
    if (Number.isFinite(disk.earliestSeq)) db.earliestSeq = Math.min(db.earliestSeq, disk.earliestSeq)
  }

  // The one writer. Every mutation funnels through here.
  function persist() {
    saveChain = saveChain.then(() => {
      try {
        mergeDiskBeforeWrite()
        mkdirSync(dirname(FILE), { recursive: true })
        writeFileSync(FILE, JSON.stringify(db, null, 2), 'utf8')
      } catch (error) {
        ctx.logger?.warn?.(`rooms: could not write ${FILE}: ${String(error?.message ?? error)}`)
      }
    })
    return saveChain
  }

  function room() {
    return db.rooms[ROOM_ID]
  }

  function messages() {
    return db.messages[ROOM_ID] ?? []
  }

  // ------------------------------------------------------------------ time

  function trimHistory() {
    const current = room()
    if (current === undefined) return
    const cutoff = Date.now() - KEEP_DAYS * 24 * 60 * 60 * 1000
    const list = messages()
    const kept = list.filter((message) => message.at >= cutoff)
    if (kept.length === list.length) return
    db.messages[ROOM_ID] = kept
    db.earliestSeq = kept.length > 0 ? kept[0].seq : db.seq + 1
    // No marker message on purpose: it would need a seq, and any seq newer than
    // the kept messages would break the ascending order every cursor relies on.
    // The client renders `truncatedBefore` instead.
    for (const member of current.members ?? []) {
      if (Number.isFinite(member.lastReadSeq) && member.lastReadSeq < db.earliestSeq - 1) {
        member.lastReadSeq = db.earliestSeq - 1
      }
    }
  }

  function blobPath(name) {
    return join(dirname(FILE), 'rooms-blobs', name)
  }

  function appendMessage({ from, kind, text, memberId }) {
    trimHistory()
    db.seq += 1
    const seq = db.seq
    let body = String(text ?? '')
    let blob = null
    // A very long message keeps its body in its own file so the room log stays
    // readable; the bubble carries a truncated copy plus the file's location.
    if (body.length > MAX_MESSAGE_CHARS) {
      const name = `${ROOM_ID}-${seq}.txt`
      try {
        mkdirSync(dirname(blobPath(name)), { recursive: true })
        writeFileSync(blobPath(name), body, 'utf8')
        blob = { name, chars: body.length, bytes: Buffer.byteLength(body, 'utf8') }
        body = `${body.slice(0, MAX_MESSAGE_CHARS)}\n\n（太长，全文 ${blob.chars} 字，已存到 rooms-blobs/${name}）`
      } catch (error) {
        ctx.logger?.warn?.(`rooms: could not spill message ${seq}: ${shortError(error)}`)
      }
    }
    const message = {
      seq,
      roomId: ROOM_ID,
      from,
      kind,
      text: body,
      at: Date.now(),
      // `memberId` is the durable identity: `from` is only the name at send
      // time, and names get changed. Old rows have no memberId and fall back to
      // their recorded signature.
      ...(memberId === undefined ? {} : { memberId }),
      ...(blob === null ? {} : { blob }),
    }
    db.messages[ROOM_ID].push(message)
    void persist()
    routeMessage(message)
    return message
  }

  function appendSystem(text) {
    return appendMessage({ from: '系统', kind: 'system', text })
  }

  // --------------------------------------------------------------- members

  function agentMembers() {
    const current = room()
    return (current?.members ?? []).filter((member) => member.kind === 'agent' && typeof member.sessionId === 'string')
  }

  function memberBySession(sessionId) {
    return agentMembers().find((member) => member.sessionId === sessionId)
  }

  function userMember() {
    return (room()?.members ?? []).find((member) => member.kind === 'user')
  }

  function setMemberStatus(memberName, patch) {
    memberState.set(memberName, { ...(memberState.get(memberName) ?? {}), ...patch })
  }

  // ------------------------------------------------------------- delivery

  function queueHasPointer(state, requestId) {
    const queue = Array.isArray(state?.queue) ? state.queue : []
    return queue.some((item) => {
      const id = item?.rpcId
      if (typeof id !== 'string') return false
      return requestId === undefined ? id.startsWith(POINTER_PREFIX) : id === requestId
    })
  }

  // A pointer is a doorbell, not the letter: one short preview so the woken
  // member can decide whether the turn is worth taking, and the length so it
  // knows what it is skipping.
  function previewLine(message) {
    const flat = String(message?.text ?? '').replace(/\s+/g, ' ').trim()
    const cut = flat.length <= 30 ? flat : `${flat.slice(0, 30)}…`
    const size = flat.length > 30 ? `（共 ${flat.length} 字）` : ''
    return `- ${message.from}：${cut}${size}`
  }

  // Who wrote the batch. The API cannot carry a custom source on a prompt, but
  // the model reads the body, so the origin is stated there.
  function originLine(batch) {
    const seen = new Set()
    const names = []
    for (const message of batch) {
      const label = message.kind === 'user' ? `${message.from}（用户）` : `${message.from}（另一个 agent）`
      if (!seen.has(label)) {
        seen.add(label)
        names.push(label)
      }
    }
    return `发起者：${names.join('、')}`
  }

  // A member can miss messages because `#` / `¥` only ring the named ones. Tell
  // it what to catch up on: at most 12, and never crossing into yesterday.
  // Anything older gets no hint — that is left to the user to point out.
  function backfillLine(member, beforeSeq) {
    const seen = Math.max(
      Number.isFinite(member.lastReadSeq) ? member.lastReadSeq : 0,
      Number.isFinite(member.lastSeenSeq) ? member.lastSeenSeq : 0,
    )
    const from = seen + 1
    const to = beforeSeq - 1
    if (to < from) return null
    const dayStart = new Date().setHours(0, 0, 0, 0)
    // Your own messages are not "missed": counting them would tell a member it
    // failed to read the thing it just said.
    const missed = messages().filter((message) => message.kind !== 'system'
      && message.from !== member.name
      && message.seq >= from
      && message.seq <= to)
    if (missed.length === 0) return null
    const today = missed.filter((message) => message.at >= dayStart)
    if (today.length === 0) return null
    const shown = today.length <= BACKFILL_MAX ? today : today.slice(-BACKFILL_MAX)
    const first = shown[0].seq
    const last = shown[shown.length - 1].seq
    const range = first === last ? `seq ${first}` : `seq ${first}..${last}`
    const omitted = missed.length - shown.length
    if (omitted === 0) return `补读：你落了 ${shown.length} 条（${range}），room_read() 能一次捞到`
    return `补读：你落了 ${missed.length} 条，但只看 ${range} 这 ${shown.length} 条就够；更早的（含昨天的）不用管`
  }

  function pointerText(member, batch, highlighted, alsoNames, mode = 'chat') {
    const first = batch[0]
    const last = batch[batch.length - 1]
    const range = first.seq === last.seq ? `seq ${first.seq}` : `seq ${first.seq}..${last.seq}`
    const label = mode === 'work' ? '派活' : mode === 'attention' ? '特指' : '闲聊'
    const head = `【${room()?.title ?? '群'}】${batch.length} 条新消息（${range}）· ${label}`
    const receipt = room()?.receipts?.[member.name]
    const receiptLine = receipt === undefined || receipt === null
      ? null
      : `（你上一条已带回群，seq=${receipt.seq}）`
    // The three questions a woken member should not have to work out itself.
    const mustLine = highlighted
      ? '回不回：必须回'
      : mode === 'attention'
        ? '回不回：别人被 ¥ 点名了，你看到了，回不回自己判断'
        : '回不回：可不回，自己判断'
    const alsoLine = Array.isArray(alsoNames) && alsoNames.length > 0
      ? `也在回：${alsoNames.length} 个人`
      : null
    const lines = batch.slice(-1).map(previewLine)
    const backfill = backfillLine(member, first.seq)
    let footer
    if (mode === 'work' && highlighted) {
      footer = `#${member.name} 被点名。只回群里这一条，别顺手做历史里的活。`
    } else if (mode === 'work') {
      footer = '这条是派给别人的活，你只是旁听；不想回就调 room_ack()。'
    } else if (mode === 'attention' && highlighted) {
      footer = '¥ 有人点名要你回，但没说是不是活。回一句就行，不用展开。'
    } else if (mode === 'attention') {
      footer = '这是广播，有人被 ¥ 点名要回。你看着办，回短一点。'
    } else {
      footer = '闲聊：回短一点，一两句就够；不想回就调 room_ack()。'
    }
    return [head, originLine(batch), mustLine, alsoLine, backfill, receiptLine, ...lines, footer]
      .filter((line) => line !== null)
      .join('\n')
  }

  function scheduleDeliveryWindow(message) {
    if (windowFromSeq === 0) {
      windowFromSeq = message.seq
      windowOpenedAt = Date.now()
    }
    if (windowTimer !== null) clearTimeout(windowTimer)
    const waited = Date.now() - windowOpenedAt
    const delay = Math.max(0, Math.min(DELIVERY_WINDOW_MS, DELIVERY_WINDOW_MAX_MS - waited))
    windowTimer = setTimeout(() => {
      const from = windowFromSeq
      windowFromSeq = 0
      windowTimer = null
      void flushUserWindow(from)
    }, delay)
  }

  // User messages: a `#name` narrows the delivery to the named members (work
  // mode); otherwise everyone hears it (chat mode).
  // Who hears this batch, and in what capacity.
  //   `#name`  → work hand-off: ONLY the named members are woken, and must reply.
  //   `¥name`  → broadcast: everyone active hears it, only the named must reply.
  //   neither  → broadcast: everyone active hears it, reply is optional.
  function classifyBatch(normalized, senderName) {
    const pool = agentMembers().filter((member) => member.name !== senderName)
    const active = pool.filter((member) => member.active !== false)
    const work = pool.filter((member) => mentions(normalized, member.name))
    const attention = pool.filter((member) => attentionMentions(normalized, member.name))
    if (work.length > 0) return { mode: 'work', targets: work, work, attention }
    if (attention.length > 0) return { mode: 'attention', targets: active, work, attention }
    return { mode: 'chat', targets: active, work, attention }
  }

  async function deliverBatch(batch, normalized, senderName) {
    const current = room()
    if (current === undefined || current.deleted || current.wakeEnabled === false) return
    const { mode, targets, work, attention } = classifyBatch(normalized, senderName)
    if (targets.length === 0) return
    const targetNames = targets.map((member) => member.name)
    for (const member of targets) {
      const called = (mode === 'work' ? work : mode === 'attention' ? attention : [])
        .some((candidate) => candidate.sessionId === member.sessionId)
      await deliverTo(
        member,
        batch,
        called,
        0,
        targetNames.filter((name) => name !== member.name),
        mode,
      )
    }
  }

  async function flushUserWindow(fromSeq) {
    const current = room()
    if (current === undefined || current.deleted || current.wakeEnabled === false) return
    const batch = messages().filter((message) => message.seq >= fromSeq && message.kind === 'user')
    if (batch.length === 0) return
    const normalized = batch.map((message) => String(message.text ?? '').normalize('NFKC')).join('\n')
    await deliverBatch(batch, normalized, undefined)
  }

  // Agent messages now fan out too: everyone visible, reply optional. The mute
  // is the only brake, because a chain of "no one was named" replies can loop.
  async function deliverAgentMessage(message) {
    const current = room()
    if (current === undefined || current.deleted || current.wakeEnabled === false) return
    if (current.muteAgentToAgent === true) return
    const normalized = String(message.text ?? '').normalize('NFKC')
    await deliverBatch([message], normalized, message.from)
  }

  function routeMessage(message) {
    if (message.kind === 'system') return
    const current = room()
    if (current === undefined) return
    if (message.kind === 'user') {
      if (current.consecutiveAgent > 0) {
        current.consecutiveAgent = 0
        void persist()
      }
      scheduleDeliveryWindow(message)
      return
    }
    // Agent message: the watchdog only speaks up, it never stops anything.
    current.consecutiveAgent += 1
    if (current.consecutiveAgent === AGENT_HORN_EVERY) {
      appendSystem(`已经连续 ${AGENT_HORN_EVERY} 条 agent 消息没有你说话了。只是提醒，不会停任何东西。`)
    }
    void persist()
    void deliverAgentMessage(message)
  }

  async function deliverTo(member, batch, highlighted, handoffDepth = 0, alsoNames, mode = 'chat') {
    // Last line of defence: whatever path produced this batch, a member is never
    // woken by its own message. Filtering at each caller missed one.
    batch = batch.filter((message) => message.from !== member.name)
    if (batch.length === 0) return
    // Already read past this batch (an ack or a read moved the cursor forward).
    // Delivering it again is exactly the "same message twice" bug.
    const lastSeqOfBatch = batch[batch.length - 1].seq
    if (Number.isFinite(member.lastReadSeq) && member.lastReadSeq >= lastSeqOfBatch) return
    if (Number.isFinite(member.lastSeenSeq) && member.lastSeenSeq >= lastSeqOfBatch) return
    // Already waiting on a turn for this member. Do not drop the message: the
    // queued pointer cannot carry it (it was never sent), so remember the seq
    // and re-deliver once that turn settles.
    if (deliveries.has(member.sessionId)) {
      const previous = pendingDelivery.get(member.sessionId)
      pendingDelivery.set(member.sessionId, {
        fromSeq: Math.min(previous?.fromSeq ?? batch[0].seq, batch[0].seq),
      })
      return
    }
    let state
    try {
      state = await ctx.sessionController.state({ sessionId: member.sessionId }, AbortSignal.timeout(5000))
    } catch (error) {
      setMemberStatus(member.name, { live: false, running: false, queued: 0 })
      appendSystem(`${member.name} 不在（会话找不到：${shortError(error)}）`)
      return
    }
    // An un-consumed group pointer already queued means this agent will read
    // everything when it gets there; another pointer would only cost a turn.
    if (queueHasPointer(state)) return
    const requestId = `${POINTER_PREFIX}${randomUUID()}`
    const cursorBefore = state.cursor
    const startedAt = Date.now()
    try {
      await ctx.sessionController.prompt({
        requestId,
        sessionId: member.sessionId,
        mode: 'queue',
        content: [{ type: 'text', text: pointerText(member, batch, highlighted, alsoNames, mode) }],
      }, AbortSignal.timeout(15000))
    } catch (error) {
      appendSystem(`${member.name} 没有响应（${shortError(error)}）`)
      return
    }
    const record = { requestId, cursorBefore, startedAt, sawRunning: false, memberName: member.name, batch, handoffDepth: handoffDepth ?? 0 }
    deliveries.set(member.sessionId, record)
    const current = room()
    if (current !== undefined) {
      // Persisted so a plugin reload mid-turn does not orphan the answer.
      current.inflight[member.sessionId] = { requestId, cursorBefore, startedAt, memberName: member.name }
      // A wake leaves a trace nobody has to be woken for: not a message, not
      // unread, never in room_read. It only exists to reconcile "called" with
      // "actually said something".
      current.wakeLog.push({
        at: startedAt,
        requestId,
        member: member.name,
        seqFrom: batch[0].seq,
        seqTo: batch[batch.length - 1].seq,
        state: 'called',
      })
      if (current.wakeLog.length > 200) current.wakeLog.splice(0, current.wakeLog.length - 200)
      void persist()
    }
    setMemberStatus(member.name, { activity: 'thinking' })
    void watchDelivery(member, record)
  }

  function clearInflight(sessionId) {
    const current = room()
    if (current?.inflight === undefined || current.inflight[sessionId] === undefined) return
    delete current.inflight[sessionId]
    void persist()
  }

  async function watchDelivery(member, record) {
    const deadline = Date.now() + WATCH_TIMEOUT_MS
    try {
      while (Date.now() < deadline) {
        await sleep(700)
        let state
        try {
          state = await ctx.sessionController.state({ sessionId: member.sessionId }, AbortSignal.timeout(5000))
        } catch {
          continue
        }
        if (state.running) {
          record.sawRunning = true
          setMemberStatus(member.name, { running: true, queued: 0 })
          if (record.longNotified !== true && Date.now() - record.startedAt > LONG_TURN_NOTICE_MS) {
            record.longNotified = true
            appendSystem(`${member.name} 还在跑，已经超过 ${Math.round(LONG_TURN_NOTICE_MS / 60000)} 分钟。它会跑完，不会被打断。`)
          }
          continue
        }
        setMemberStatus(member.name, { running: false })
        if (record.sawRunning) break
        // Never observed running: either it finished inside one poll or the
        // prompt is still parked. A moved cursor with no pending pointer means
        // the turn already happened.
        if (state.cursor !== record.cursorBefore && !queueHasPointer(state, record.requestId)) break
      }
    } finally {
      deliveries.delete(member.sessionId)
      setMemberStatus(member.name, { activity: null, running: false })
    }
    try {
      await harvest(member, record)
    } finally {
      clearInflight(member.sessionId)
    }
    // Messages that arrived while this turn was running were only remembered,
    // never sent. Deliver them now that the member is free again.
    const pending = pendingDelivery.get(member.sessionId)
    if (pending !== undefined) {
      pendingDelivery.delete(member.sessionId)
      // Never re-deliver the member its own message: that is how a broadcast
      // woke an agent with its own reply.
      const fresh = messages().filter((message) => message.seq >= pending.fromSeq
        && message.kind !== 'system'
        && message.from !== member.name)
      if (fresh.length > 0) {
        const normalized = fresh.map((message) => String(message.text ?? '').normalize('NFKC')).join('\n')
        const mode = mentions(normalized, member.name) ? 'work' : 'chat'
        void deliverTo(member, fresh.slice(-5), mentions(normalized, member.name), 0, undefined, mode)
      }
    }
  }

  function markWake(requestId, state) {
    if (typeof requestId !== 'string') return
    const current = room()
    const entry = (current?.wakeLog ?? []).find((item) => item.requestId === requestId)
    if (entry === undefined) return
    entry.state = state
    entry.doneAt = Date.now()
    void persist()
  }

  function commitHarvest(member, text, requestId) {
    if (CONFIRM_ONLY.test(text)) {
      markWake(requestId, 'silent')
      return
    }
    const message = appendMessage({ from: member.name, kind: 'agent', text, memberId: member.sessionId })
    const current = room()
    if (current !== undefined) {
      current.receipts[member.name] = { seq: message.seq, at: Date.now() }
      void persist()
    }
    markWake(requestId, 'replied')
  }

  async function harvest(member, record) {
    const marks = runtime.get(member.sessionId) ?? {}
    if (typeof marks.lastSayAt === 'number' && marks.lastSayAt >= record.startedAt) return
    if (typeof marks.lastAckAt === 'number' && marks.lastAckAt >= record.startedAt) return
    let page
    try {
      page = await ctx.sessionController.events({
        address: { kind: 'session', sessionId: member.sessionId },
        maxMessages: 200,
      }, AbortSignal.timeout(10000))
    } catch (error) {
      ctx.logger?.warn?.(`rooms: harvest could not read ${member.name}: ${shortError(error)}`)
      return
    }
    const records = Array.isArray(page?.records) ? page.records : []
    const startIndex = records.findIndex((entry) => {
      const event = entry?.event
      return event?.type === 'user/message' && event?.data?.source?.rpcId === record.requestId
    })
    if (startIndex >= 0) {
      const texts = records
        .slice(startIndex + 1)
        .filter((entry) => entry?.event?.type === 'assistant/message')
        .map((entry) => textOf(entry.event.data?.message?.content))
        .filter((text) => text !== '')
      const text = texts[texts.length - 1]
      if (text === undefined) return
      commitHarvest(member, text, record.requestId)
      return
    }
    // A long turn can push the pointer past the read window. Fall back to the
    // first assistant text after the delivery cursor rather than dropping the
    // answer on the floor silently.
    const fallback = records
      .filter((entry) => (entry?.event?.seq ?? 0) > record.cursorBefore)
      .filter((entry) => entry?.event?.type === 'assistant/message')
      .map((entry) => textOf(entry.event.data?.message?.content))
      .filter((text) => text !== '')
    const text = fallback[fallback.length - 1]
    if (text === undefined) {
      ctx.logger?.warn?.(`rooms: ${member.name} produced no assistant text for ${record.requestId}`)
      return
    }
    ctx.logger?.warn?.(`rooms: pointer for ${member.name} fell out of the window; harvested the last answer instead`)
    commitHarvest(member, text, record.requestId)
  }

  function shortError(error) {
    const message = String(error?.message ?? error ?? 'unknown')
    return message.length <= 60 ? message : `${message.slice(0, 57)}…`
  }

  // ---------------------------------------------------------------- routes

  function json(res, status, payload) {
    const body = JSON.stringify(payload)
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    })
    res.end(body)
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = []
      let size = 0
      req.on('data', (chunk) => {
        size += chunk.length
        if (size > 1_000_000) {
          reject(new Error('body too large'))
          req.destroy()
          return
        }
        chunks.push(chunk)
      })
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8')
        if (raw.trim() === '') return resolve({})
        try {
          resolve(JSON.parse(raw))
        } catch (error) {
          reject(error)
        }
      })
      req.on('error', reject)
    })
  }

  function publicMessages(list) {
    return list.map((message) => ({
      seq: message.seq,
      from: message.from,
      kind: message.kind,
      text: message.text,
      at: message.at,
      ...(message.memberId === undefined ? {} : { memberId: message.memberId }),
      ...(message.blob === undefined ? {} : { blob: message.blob }),
    }))
  }

  async function handleStatus() {
    const current = room()
    const members = []
    for (const member of current?.members ?? []) {
      if (member.kind === 'user') {
        members.push({ kind: 'user', name: member.name, unread: unreadCount(member) })
        continue
      }
      let state = null
      let live = false
      try {
        state = await ctx.sessionController.state({ sessionId: member.sessionId }, AbortSignal.timeout(3000))
        live = Boolean(ctx.get('agents')?.get?.(member.sessionId))
      } catch {
        state = null
      }
      members.push({
        kind: 'agent',
        name: member.name,
        sessionId: member.sessionId,
        active: member.active !== false,
        unread: unreadCount(member),
        live,
        running: state?.running === true,
        queued: Array.isArray(state?.queue) ? state.queue.length : 0,
      })
    }
    const ackEntries = Object.entries(current?.acks ?? {})
      .map(([member, value]) => ({ member, at: value?.at ?? 0, seq: value?.seq ?? 0 }))
      .sort((left, right) => right.at - left.at)
    const dayStart = new Date().setHours(0, 0, 0, 0)
    const todayWakes = (current?.wakeLog ?? []).filter((entry) => entry.at >= dayStart)
    return {
      room: {
        id: ROOM_ID,
        title: current?.title ?? '群',
        wakeEnabled: current?.wakeEnabled !== false,
        muteAgentToAgent: current?.muteAgentToAgent === true,
      },
      seq: db.seq,
      earliestSeq: db.earliestSeq,
      consecutiveAgent: current?.consecutiveAgent ?? 0,
      members,
      lastAck: ackEntries[0] ?? null,
      receipts: current?.receipts ?? {},
      wakeStats: {
        called: todayWakes.length,
        replied: todayWakes.filter((entry) => entry.state === 'replied').length,
        acked: todayWakes.filter((entry) => entry.state === 'acked').length,
      },
      recentWakes: (current?.wakeLog ?? []).slice(-8),
    }
  }

  function unreadCount(member) {
    const from = Number.isFinite(member.lastReadSeq) ? member.lastReadSeq : 0
    return messages().filter((message) => message.seq > from).length
  }

  // Candidate sessions for the member picker. `session/list` summaries carry no
  // top-level title, so the title is read from the projection hints when present.
  function pickTitle(summary) {
    const values = summary?.projections?.values ?? {}
    for (const key of ['title', 'sessionTitle', 'name']) {
      const value = values[key]
      if (typeof value === 'string' && value.trim() !== '') return value.trim()
      if (value !== null && typeof value === 'object' && typeof value.title === 'string' && value.title.trim() !== '') {
        return value.title.trim()
      }
    }
    return null
  }

  async function handleCandidates() {
    const result = await ctx.sessionController.list({}, AbortSignal.timeout(8000))
    const chosen = new Set(agentMembers().map((member) => member.sessionId))
    const items = (result?.items ?? [])
      .filter((item) => item.blank !== true && item.parentSessionId === undefined)
      .map((item) => ({
        sessionId: item.sessionId,
        updatedAt: item.updatedAt,
        cwd: item.cwd ?? null,
        running: item.running === true,
        title: pickTitle(item),
        member: chosen.has(item.sessionId),
      }))
      .sort((left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0))
    return { items }
  }

  async function handleMessages(query) {
    const all = messages()
    const sinceRaw = query.get('since')
    const beforeRaw = query.get('before')
    const limitRaw = query.get('limit')
    const limit = Math.min(Math.max(Number.parseInt(limitRaw ?? '', 10) || 50, 1), 200)
    let page
    let hasMore = false
    if (sinceRaw !== null) {
      const since = Number.parseInt(sinceRaw, 10)
      page = all.filter((message) => message.seq > since).slice(0, limit)
      hasMore = all.filter((message) => message.seq > since).length > page.length
    } else if (beforeRaw !== null) {
      const before = Number.parseInt(beforeRaw, 10)
      const older = all.filter((message) => message.seq < before)
      page = older.slice(Math.max(0, older.length - limit))
      hasMore = older.length > page.length
    } else {
      page = all.slice(Math.max(0, all.length - limit))
      hasMore = all.length > page.length
    }
    return {
      messages: publicMessages(page),
      seq: db.seq,
      earliestSeq: db.earliestSeq,
      truncatedBefore: db.earliestSeq > 1 ? db.earliestSeq : null,
      hasMore,
    }
  }

  async function route(req, res) {
    let url
    try {
      url = new URL(req.url ?? '/', 'http://127.0.0.1')
    } catch {
      return json(res, 400, { error: 'bad url' })
    }
    const path = url.pathname.replace(/\/+$/, '')
    const method = (req.method ?? 'GET').toUpperCase()
    try {
      if (method === 'GET' && path === '/rooms/r1/messages') {
        return json(res, 200, await handleMessages(url.searchParams))
      }
      if (method === 'GET' && path === '/rooms/r1/status') {
        return json(res, 200, await handleStatus())
      }
      if (method === 'GET' && path === '/rooms/r1/candidates') {
        return json(res, 200, await handleCandidates())
      }
      if (method === 'POST' && path === '/rooms/r1/say') {
        const body = await readBody(req)
        const text = typeof body.text === 'string' ? body.text.trim() : ''
        if (text === '') return json(res, 400, { error: 'text is required' })
        const message = appendMessage({ from: userMember()?.name ?? '我', kind: 'user', text, memberId: 'user' })
        scheduleDeliveryWindow(message)
        return json(res, 200, { message })
      }
      if (method === 'POST' && path === '/rooms/r1/read') {
        const user = userMember()
        if (user !== undefined) {
          user.lastReadSeq = db.seq
          void persist()
        }
        return json(res, 200, { ok: true })
      }
      if (method === 'POST' && path === '/rooms/r1/wake') {
        const body = await readBody(req)
        const current = room()
        if (current !== undefined) {
          current.wakeEnabled = body.enabled !== false
          void persist()
        }
        return json(res, 200, { wakeEnabled: current?.wakeEnabled !== false })
      }
      if (method === 'POST' && path === '/rooms/r1/mute') {
        const body = await readBody(req)
        const current = room()
        if (current !== undefined) {
          current.muteAgentToAgent = body.enabled === true
          void persist()
        }
        return json(res, 200, { muteAgentToAgent: current?.muteAgentToAgent === true })
      }
      if (method === 'POST' && path === '/rooms/r1/members') {
        const body = await readBody(req)
        const incoming = Array.isArray(body.members) ? body.members : []
        const previous = new Map(
          (room()?.members ?? [])
            .filter((member) => member.kind === 'agent' && typeof member.sessionId === 'string')
            .map((member) => [member.sessionId, member]),
        )
        const agents = incoming
          .filter((entry) => entry !== null && typeof entry === 'object' && typeof entry.sessionId === 'string')
          .slice(0, 3)
          .map((entry) => {
            const before = previous.get(entry.sessionId)
            const name = typeof entry.name === 'string' && entry.name.trim() !== ''
              ? entry.name.trim().slice(0, 24)
              : (before?.name ?? '成员')
            return {
              kind: 'agent',
              name,
              sessionId: entry.sessionId,
              // Ticked = hears every message; unticked = only an explicit `#name`.
              active: typeof entry.active === 'boolean' ? entry.active : before?.active !== false,
              // Renaming must not rewind a member's cursor: that would make it
              // read the whole history again.
              lastReadSeq: Number.isFinite(before?.lastReadSeq) ? before.lastReadSeq : 0,
            }
          })
        const current = room()
        if (current !== undefined) {
          const user = userMember()
          current.members = [user ?? { kind: 'user', name: '我', lastReadSeq: 0 }, ...agents]
          void persist()
        }
        // A rename nobody announces is one the member may never notice: it only
        // learns its name when something calls it. The row is a system message,
        // so it wakes no one.
        for (const next of agents) {
          const before = previous.get(next.sessionId)
          if (before !== undefined && before.name !== next.name) {
            appendSystem(`${before.name} 改名为「${next.name}」`)
          }
        }
        return json(res, 200, { ok: true, members: agents.length })
      }
      return json(res, 404, { error: `no route: ${method} ${path}` })
    } catch (error) {
      return json(res, 500, { error: String(error?.message ?? error) })
    }
  }

  // ----------------------------------------------------------------- tools

  function callerMember(exec) {
    const sessionId = exec?.agent?.id
    if (typeof sessionId !== 'string') return undefined
    return memberBySession(sessionId)
  }

  // Remember the highest seq this member has actually seen, whatever read mode
  // produced it. A later delivery of the same batch must not look "new".
  function touchSeen(member, page) {
    if (!Array.isArray(page) || page.length === 0) return
    const highest = page[page.length - 1].seq
    if (!Number.isFinite(member.lastSeenSeq) || member.lastSeenSeq < highest) {
      member.lastSeenSeq = highest
      void persist()
    }
  }

  const sayTool = {
    name: 'room_say',
    description: '往「群」里说一句话。群是你和用户、以及别的 agent 共用的聊天室。你在自己会话里的正常回答会自动被带回群里，所以只有想额外补一句、或主动开口时才用它。用符号叫人：`#名字` = 派活（只叫被点名的，必须回），`¥名字` = 点到为止（所有人都收到，但被点名的必须回）；两个都可以一次点多个。不带符号 = 广播给所有人，回不回各自判断。',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '要说的话，纯文本。' },
      },
      required: ['text'],
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          seq: { type: 'number' },
          from: { type: 'string' },
        },
        required: ['seq', 'from'],
      },
      render(_args, value) {
        return [{ type: 'text', text: `已发到群里（seq=${value.seq}，署名「${value.from}」）。` }]
      },
    },
    async execute(args, exec) {
      const member = callerMember(exec)
      if (member === undefined) throw new Error('你不在任何群里，不能使用 room_say。')
      const text = String(args?.text ?? '').trim()
      if (text === '') throw new Error('text 不能为空。')
      const message = appendMessage({ from: member.name, kind: 'agent', text, memberId: member.sessionId })
      runtime.set(member.sessionId, { ...(runtime.get(member.sessionId) ?? {}), lastSayAt: Date.now() })
      return { seq: message.seq, from: member.name }
    },
  }

  const readTool = {
    name: 'room_read',
    description: '读「群」里的消息。默认从你上次读到的位置往后读（读完后游标推进，重复调用不会重复返回）。也支持回看：给 `before`（某个 seq 之前的几条）或 `after`（某个 seq 之后的几条），这两种不推进游标。',
    parameters: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: `最多读几条，默认 ${READ_LIMIT}，上限 50。` },
        before: { type: 'number', description: '可选。读 seq 小于这个值的最近几条（回看用，不推进游标）。' },
        after: { type: 'number', description: '可选。读 seq 大于这个值的几条（补看用，不推进游标）。' },
      },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          messages: { type: 'array' },
          lastSeq: { type: 'number' },
          truncatedBefore: { type: 'number' },
          youAre: { type: 'string' },
          cursorReset: { type: 'boolean' },
        },
        required: ['messages', 'lastSeq'],
      },
      render(_args, value) {
        if (value.messages.length === 0) {
          return [{ type: 'text', text: '群里没有新消息。' }]
        }
        const lines = value.messages.map((message) => `[seq=${message.seq}] ${message.from}：${message.text}`)
        if (value.cursorReset === true) {
          lines.unshift('（房间重建过，你的游标已经失效，已重置；下面是最近几条）')
        }
        if (typeof value.truncatedBefore === 'number') {
          lines.unshift(`（早于 seq=${value.truncatedBefore} 的消息已被清理）`)
        }
        if (typeof value.youAre === 'string') {
          lines.push(`（你在群里叫「${value.youAre}」）`)
        }
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(args, exec) {
      const member = callerMember(exec)
      if (member === undefined) throw new Error('你不在任何群里，不能使用 room_read。')
      const requested = Number.parseInt(String(args?.limit ?? ''), 10)
      const limit = Number.isFinite(requested) ? Math.min(Math.max(requested, 1), 50) : READ_LIMIT
      const all = messages()
      const after = Number(args?.after)
      if (Number.isFinite(after)) {
        const page = all.filter((message) => message.seq > after).slice(0, limit)
        touchSeen(member, page)
        return { messages: publicMessages(page), lastSeq: db.seq }
      }
      const before = Number(args?.before)
      if (Number.isFinite(before)) {
        const older = all.filter((message) => message.seq < before)
        const page = older.slice(Math.max(0, older.length - limit))
        touchSeen(member, page)
        // A tool result must be lossless JSON: an `undefined` value here fails
        // the whole output, which is what broke this branch.
        const truncated = db.earliestSeq > 1 && before <= db.earliestSeq ? db.earliestSeq : undefined
        return {
          messages: publicMessages(page),
          lastSeq: db.seq,
          youAre: member.name,
          ...(truncated === undefined ? {} : { truncatedBefore: truncated }),
        }
      }
      const from = Number.isFinite(member.lastReadSeq) ? member.lastReadSeq : 0
      // A cursor ahead of the log means the room was rebuilt or cleaned while
      // this member slept. Left alone it makes every future read answer "no new
      // messages" while pointers keep ringing — a silent deafness.
      if (from > db.seq) {
        const recent = messages().slice(-limit)
        member.lastReadSeq = recent.length > 0 ? recent[recent.length - 1].seq : Math.max(0, db.earliestSeq - 1)
        touchSeen(member, recent)
        void persist()
        return {
          messages: publicMessages(recent),
          lastSeq: db.seq,
          youAre: member.name,
          cursorReset: true,
        }
      }
      const truncatedBefore = db.earliestSeq > 1 && from < db.earliestSeq - 1 ? db.earliestSeq : undefined
      const fresh = all.filter((message) => message.seq > from)
      const page = fresh.slice(0, limit)
      if (page.length > 0) {
        member.lastReadSeq = page[page.length - 1].seq
        touchSeen(member, page)
        void persist()
      }
      return {
        messages: publicMessages(page),
        lastSeq: db.seq,
        youAre: member.name,
        ...(truncatedBefore === undefined ? {} : { truncatedBefore }),
      }
    },
  }

  const ackTool = {
    name: 'room_ack',
    description: '表示「我看到了，这一轮不说话」。调用后这一轮不会把你的回答搬进群里。注意：这是群聊里的「已读」，不是拒绝，也不是结束对话——用户会在群界面上看到「你看过了」。不想接话的时候才用它。',
    parameters: {
      type: 'object',
      properties: {
        note: { type: 'string', description: '可选备注，只留在群数据里备查，不进群、不进你的上下文。' },
      },
    },
    output: {
      schema: { type: 'object', properties: { acked: { type: 'boolean' } }, required: ['acked'] },
      render() {
        return [{ type: 'text', text: '已标记为「看过了，不回」。' }]
      },
    },
    async execute(args, exec) {
      const member = callerMember(exec)
      if (member === undefined) throw new Error('你不在任何群里，不能使用 room_ack。')
      const record = deliveries.get(member.sessionId)
      // "Read it, not mine" still means READ: advance the cursor to the end of
      // this batch, or the same message stays "unread" and gets delivered again.
      if (record !== undefined && Array.isArray(record.batch) && record.batch.length > 0) {
        const lastSeq = record.batch[record.batch.length - 1].seq
        if (!Number.isFinite(member.lastReadSeq) || member.lastReadSeq < lastSeq) {
          member.lastReadSeq = lastSeq
        }
      }
      const current = room()
      if (current !== undefined) {
        current.acks[member.name] = {
          at: Date.now(),
          seq: db.seq,
          ...(typeof args?.note === 'string' && args.note.trim() !== '' ? { note: args.note.trim().slice(0, 200) } : {}),
        }
        void persist()
      }
      runtime.set(member.sessionId, { ...(runtime.get(member.sessionId) ?? {}), lastAckAt: Date.now() })
      markWake(record?.requestId, 'acked')
      // "Read it, not mine" should not leave the user waiting on nobody: pass
      // the same batch to the other active members, once.
      // Hand along only a USER batch. Under the broadcast rule an agent message
      // already reached everyone, so passing it on would just start a loop.
      if (record !== undefined && record.handoffDepth === 0 && Array.isArray(record.batch)) {
        const fromUser = record.batch.some((message) => message.kind === 'user')
        if (fromUser) {
          const others = agentMembers().filter((other) => other.active !== false && other.sessionId !== member.sessionId)
          for (const other of others) {
            void deliverTo(other, record.batch, false, 1)
          }
        }
      }
      return { acked: true }
    },
  }

  // ------------------------------------------------------------------ wire

  // A tool result must be lossless JSON; one stray `undefined` rejects the whole
  // output. Strip them once here instead of trusting every branch to remember.
  function cleanValue(value) {
    if (Array.isArray(value)) return value.map(cleanValue)
    if (value !== null && typeof value === 'object') {
      const out = {}
      for (const [key, item] of Object.entries(value)) {
        if (item !== undefined) out[key] = cleanValue(item)
      }
      return out
    }
    return value
  }

  function withCleanResult(tool) {
    const run = tool.execute
    return {
      ...tool,
      async execute(args, exec) {
        return cleanValue(await run(args, exec))
      },
    }
  }

  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: '/rooms', handler: route }))
  ctx.effect(() => ctx.tools.register(withCleanResult(sayTool)))
  ctx.effect(() => ctx.tools.register(withCleanResult(readTool)))
  ctx.effect(() => ctx.tools.register(withCleanResult(ackTool)))
  ctx.effect(() => () => {
    if (windowTimer !== null) clearTimeout(windowTimer)
    windowTimer = null
    if (recoverRetryTimer !== null) clearTimeout(recoverRetryTimer)
    recoverRetryTimer = null
  })

  // A reload during a turn would otherwise lose that turn's answer: pick up the
  // persisted deliveries once the process has settled.
  ctx.effect(() => {
    const handle = setTimeout(() => { void recoverInflight() }, 10000)
    return () => clearTimeout(handle)
  })

  async function recoverInflight() {
    const current = room()
    if (current?.inflight === undefined || Object.keys(current.inflight).length === 0) return
    let stillRunning = false
    for (const [sessionId, item] of Object.entries(current.inflight)) {
      const member = agentMembers().find((candidate) => candidate.sessionId === sessionId)
      if (member === undefined) {
        delete current.inflight[sessionId]
        continue
      }
      let state = null
      try {
        state = await ctx.sessionController.state({ sessionId }, AbortSignal.timeout(5000))
      } catch {
        state = null
      }
      if (state?.running === true) {
        // Still mid-turn: keep the record and check again instead of dropping
        // the answer this turn is about to produce.
        stillRunning = true
        continue
      }
      try {
        await harvest(member, {
          requestId: item.requestId,
          cursorBefore: item.cursorBefore,
          startedAt: item.startedAt,
          memberName: item.memberName ?? member.name,
          sawRunning: true,
        })
      } catch (error) {
        ctx.logger?.warn?.(`rooms: recovery for ${member.name} failed: ${shortError(error)}`)
      }
      delete current.inflight[sessionId]
    }
    void persist()
    if (stillRunning && recoverRetryTimer === null) {
      recoverRetryTimer = setTimeout(() => {
        recoverRetryTimer = null
        void recoverInflight()
      }, 30000)
    }
  }

  ctx.logger?.info?.(`rooms: ready, ${agentMembers().length} agent member(s), ${messages().length} message(s)`)
}
