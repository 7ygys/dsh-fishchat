// dsh-rooms — browser half.
//
// One sidebar row ("群") that selects one main panel: a WeChat-style group chat.
// The host half owns the data; this file only draws it and posts to /rooms/r1.

window.__ModuleLoader__.load({
  id: 'dsh-rooms',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useRef, useCallback } = React

    const ROOM = '/rooms/r1'
    const POLL_MS = 1500
    const FORCE_TIME_EVERY = 30
    const PAGE = 50

    // ------------------------------------------------------------ utilities

    const PALETTE = ['#5b8def', '#e08a3c', '#4fa36b', '#b7628a', '#7a6fd1', '#c05a5a', '#3f9aa8', '#8a8f4f']

    function hashName(name) {
      let hash = 0
      const text = String(name ?? '')
      for (let index = 0; index < text.length; index += 1) {
        hash = (hash * 31 + text.charCodeAt(index)) >>> 0
      }
      return hash
    }

    function avatarColor(name) {
      return PALETTE[hashName(name) % PALETTE.length]
    }

    function pad(value) {
      return String(value).padStart(2, '0')
    }

    function timeLabel(at) {
      const date = new Date(at)
      const now = new Date()
      const clock = `${pad(date.getHours())}:${pad(date.getMinutes())}`
      if (date.toDateString() === now.toDateString()) return clock
      const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1)
      if (date.toDateString() === yesterday.toDateString()) return `昨天 ${clock}`
      const days = (now.getTime() - date.getTime()) / 86400000
      if (days < 7) return `星期${'日一二三四五六'[date.getDay()]} ${clock}`
      if (date.getFullYear() === now.getFullYear()) return `${date.getMonth() + 1}月${date.getDate()}日 ${clock}`
      return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日 ${clock}`
    }

    function showTime(index, message, previous) {
      if (previous === undefined) return true
      if (index % FORCE_TIME_EVERY === 0) return true
      return message.at - previous.at > 5 * 60 * 1000
    }

    async function getJson(url) {
      const response = await fetch(url, { headers: { accept: 'application/json' } })
      if (!response.ok) throw new Error(`${url} -> ${response.status}`)
      return response.json()
    }

    async function postJson(url, body) {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body ?? {}),
      })
      if (!response.ok) throw new Error(`${url} -> ${response.status}`)
      return response.json()
    }

    // ----------------------------------------------------------------- views

    function GroupIcon({ size = 20, active = false }) {
      const edge = Math.max(14, Math.round(size))
      const [unread, setUnread] = useState(0)
      useEffect(() => {
        let alive = true
        const tick = async () => {
          if (document.visibilityState !== 'visible') return
          try {
            const data = await getJson(`${ROOM}/status`)
            if (!alive) return
            const user = (data.members ?? []).find((member) => member.kind === 'user')
            setUnread(user?.unread ?? 0)
          } catch {
            /* transient: the host may be reloading */
          }
        }
        void tick()
        const handle = setInterval(tick, 5000)
        return () => { alive = false; clearInterval(handle) }
      }, [])
      return h('div', {
        style: { position: 'relative', display: 'inline-flex', width: edge, height: edge },
      },
      h('svg', {
        viewBox: '0 0 24 24',
        width: edge,
        height: edge,
        'aria-hidden': true,
        style: { display: 'block', opacity: active ? 1 : 0.9 },
      },
        h('rect', { x: 1.5, y: 3, width: 15, height: 11, rx: 3.5, fill: active ? 'currentColor' : 'none', stroke: 'currentColor', strokeWidth: active ? 0 : 1.6 }),
        h('rect', { x: 7.5, y: 9.5, width: 15, height: 11, rx: 3.5, fill: active ? '#ffffff' : 'none', stroke: 'currentColor', strokeWidth: active ? 0 : 1.6 }),
        h('circle', { cx: 5.5, cy: 8.5, r: 1.1, fill: active ? '#ffffff' : 'currentColor' }),
        h('circle', { cx: 9.5, cy: 8.5, r: 1.1, fill: active ? '#ffffff' : 'currentColor' }),
        h('circle', { cx: 12.5, cy: 15, r: 1.2, fill: active ? 'currentColor' : 'currentColor' }),
        h('circle', { cx: 16.5, cy: 15, r: 1.2, fill: active ? 'currentColor' : 'currentColor' })
      ),
      unread > 0 && !active && h('span', {
        title: `${unread} 条未读`,
        style: {
          position: 'absolute', top: -3, right: -3, minWidth: 8, height: 8, borderRadius: 4,
          background: '#e34d59', boxShadow: '0 0 0 1.5px #fff', pointerEvents: 'none',
        },
      })
      )
    }

    function Avatar({ name, size = 34 }) {
      const initial = String(name ?? '?').trim().slice(0, 1) || '?'
      return h('div', {
        style: {
          width: size,
          height: size,
          flex: `0 0 ${size}px`,
          borderRadius: 6,
          background: avatarColor(name),
          color: '#fff',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: Math.round(size * 0.46),
          fontWeight: 600,
          userSelect: 'none',
        },
      }, initial)
    }

    function TimeDivider({ at }) {
      return h('div', {
        style: { textAlign: 'center', color: 'var(--dsw-alias-label-secondary)', fontSize: 12, margin: '10px 0' },
      }, timeLabel(at))
    }

    // A message shows its sender's CURRENT name when its durable identity is
    // known; rows from before memberId existed keep their recorded signature.
    function nameFor(message, members) {
      if (message.memberId === 'user') {
        const user = (members ?? []).find((entry) => entry.kind === 'user')
        return user?.name ?? message.from
      }
      if (typeof message.memberId === 'string') {
        const agent = (members ?? []).find((entry) => entry.sessionId === message.memberId)
        if (agent !== undefined) return agent.name
      }
      return message.from
    }

    // `@path` tokens render as brand-coloured chips; hover shows the path.
    function renderWithRefs(text) {
      const parts = String(text ?? '').split(/(@[^\s@]+)/g)
      return parts.map((part, index) => (part.startsWith('@') && part.length > 1
        ? h('span', {
          key: index,
          title: part.slice(1),
          style: { color: 'var(--dsw-alias-brand-primary)' },
        }, part)
        : part))
    }

    // A quote line ends with `(#seq)` so the reference survives re-delivery.
    function splitQuoteSeq(text) {
      const match = /\s*\(#(\d+)\)\s*$/.exec(text)
      return match === null ? { body: text, seq: null } : { body: text.slice(0, match.index), seq: match[1] }
    }

    // Body lines: `> ` prefixes are inline quotes (brand colour), the rest is
    // normal text with @path chips.
    function renderBody(text) {
      const lines = String(text ?? '').split('\n')
      return lines.map((line, index) => {
        if (!line.startsWith('> ')) {
          return h('div', { key: index, style: { minHeight: '1.2em' } }, ...renderWithRefs(line))
        }
        const { body, seq } = splitQuoteSeq(line.slice(2))
        return h('div', {
          key: index,
          style: {
            color: 'var(--dsw-alias-brand-primary)',
            borderLeft: '2px solid var(--dsw-alias-brand-primary)',
            paddingLeft: 6,
            margin: '1px 0',
            opacity: 0.92,
            display: 'flex',
            gap: 6,
            alignItems: 'baseline',
          },
        },
        h('span', { style: { flex: 1, minWidth: 0 } }, ...renderWithRefs(body)),
        seq !== null && h('span', {
          title: `引用的是 seq ${seq}`,
          style: { fontSize: 10, opacity: 0.65, whiteSpace: 'nowrap' },
        }, `#${seq}`)
        )
      })
    }

    function Bubble({ message, mine, name, readers, onQuote }) {
      return h('div', {
        style: {
          display: 'flex',
          flexDirection: mine ? 'row-reverse' : 'row',
          alignItems: 'flex-start',
          gap: 8,
          margin: '6px 0',
        },
      },
      h(Avatar, { name: name }),
      h('div', { style: { maxWidth: '68%', minWidth: 40 } },
        h('div', {
          style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)', margin: '0 4px 3px', textAlign: mine ? 'right' : 'left' },
        }, name),
        h('div', {
          style: {
            background: mine ? '#95ec69' : '#f2f2f2',
            // On the green bubble the theme's primary label can be white, which
            // disappears; the bubble keeps its own ink.
            color: mine ? '#1a1a1a' : 'var(--dsw-alias-label-primary)',
            padding: '8px 11px',
            borderRadius: 8,
            fontSize: 14,
            lineHeight: 1.55,
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            // A visible edge: layer colours alone are too close to the panel.
            border: mine ? '1px solid rgba(0,0,0,.10)' : '1px solid var(--dsw-alias-border-l2)',
            boxShadow: '0 1px 4px rgba(0,0,0,.14)',
          },
        },
        message.quote !== undefined && h('div', {
          title: `${message.quote.from}：${message.quote.text}`,
          style: {
            borderLeft: '3px solid var(--dsw-alias-brand-primary)',
            paddingLeft: 7, marginBottom: 6, fontSize: 12, lineHeight: 1.45,
            opacity: 0.8, whiteSpace: 'pre-wrap', cursor: 'help',
          },
        }, `${message.quote.from}：${message.quote.text}`),
        h('div', null, ...renderBody(message.text))
        ),
        message.blob !== undefined && h('div', {
          style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)', margin: '3px 4px 0', textAlign: mine ? 'right' : 'left' },
        }, `全文 ${message.blob.chars} 字 · rooms-blobs/${message.blob.name}`),
        // One reserved line under every bubble: who has seen this one.
        h('div', {
          style: {
            fontSize: 10, lineHeight: '14px', minHeight: 14, margin: '3px 4px 0',
            color: 'var(--dsw-alias-label-secondary)',
            textAlign: mine ? 'right' : 'left', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
          },
        }, readers.length > 0 ? `已通知 ${readers.join('、')}` : '')
      ),
      // One small control per message: quote it into the composer.
      h('button', {
        onClick: () => onQuote({ seq: message.seq, from: name, text: String(message.text ?? '').slice(0, 200) }),
        title: '引用这条',
        style: {
          alignSelf: 'center', border: 'none', background: 'transparent', cursor: 'pointer',
          color: 'var(--dsw-alias-label-secondary)', fontSize: 13, padding: '2px 4px', opacity: 0.55,
        },
      }, '↩')
      )
    }

    function SystemRow({ message }) {
      return h('div', {
        style: { textAlign: 'center', color: 'var(--dsw-alias-label-secondary)', fontSize: 12, margin: '10px 0', padding: '0 24px' },
      }, message.text)
    }

    function StatusText({ status }) {
      if (status === null) return null
      const agents = (status.members ?? []).filter((member) => member.kind === 'agent')
      if (agents.length === 0) return '还没有成员，点右边「成员」加人'
      const busy = agents.filter((agent) => agent.running)
      const queued = agents.reduce((total, agent) => total + (agent.queued ?? 0), 0)
      const dead = agents.filter((agent) => agent.live === false)
      // Per-member backlog: which one is behind, not just how much is behind.
      const behind = agents
        .filter((agent) => (agent.unread ?? 0) > 0)
        .map((agent) => `${agent.name} ${agent.unread}`)
      if (busy.length > 0) {
        return `● ${busy.map((agent) => agent.name).join('、')} 在想…${queued > 0 ? ` · 排队 ${queued}` : ''}`
      }
      if (dead.length > 0) return `${dead.map((agent) => agent.name).join('、')} 不在线`
      const here = `${agents.map((agent) => agent.name).join('、')} 在这里`
      return behind.length > 0 ? `${here} · 积压 ${behind.join(' / ')}` : here
    }

    function MemberPicker({ status, onClose, onSaved }) {
      const [items, setItems] = useState([])
      const [error, setError] = useState(null)
      const [selected, setSelected] = useState({}) // sessionId -> { name, active }
      const [busy, setBusy] = useState(false)

      useEffect(() => {
        let alive = true
        getJson(`${ROOM}/candidates`)
          .then((data) => {
            if (!alive) return
            setItems(data.items ?? [])
            const preload = {}
            for (const member of (status?.members ?? [])) {
              if (member.kind === 'agent') {
                preload[member.sessionId] = { name: member.name, active: member.active !== false }
              }
            }
            setSelected(preload)
          })
          .catch((error) => { if (alive) setError(String(error.message ?? error)) })
        return () => { alive = false }
      }, [])

      const toggle = (item) => {
        setSelected((current) => {
          const next = { ...current }
          if (next[item.sessionId] !== undefined) {
            delete next[item.sessionId]
            return next
          }
          if (Object.keys(next).length >= 3) return next
          const short = String(item.title ?? item.cwd ?? '成员').replace(/[（(【\[].*$/, '').trim()
          next[item.sessionId] = { name: (short || '成员').slice(0, 4), active: true }
          return next
        })
      }

      const rename = (sessionId, value) => {
        setSelected((current) => ({ ...current, [sessionId]: { ...current[sessionId], name: value } }))
      }

      const setActive = (sessionId, value) => {
        setSelected((current) => ({ ...current, [sessionId]: { ...current[sessionId], active: value } }))
      }

      const save = async () => {
        setBusy(true)
        try {
          const byId = new Map(items.map((item) => [item.sessionId, item]))
          const members = Object.entries(selected).map(([sessionId, entry]) => ({
            sessionId,
            name: entry.name.trim() || '成员',
            active: entry.active !== false,
            ...(typeof byId.get(sessionId)?.cwd === 'string' ? { cwd: byId.get(sessionId).cwd } : {}),
          }))
          await postJson(`${ROOM}/members`, { members })
          onSaved()
        } catch (error) {
          setError(String(error.message ?? error))
        } finally {
          setBusy(false)
        }
      }

      return h('div', {
        style: {
          position: 'absolute', inset: 0, background: 'rgba(0,0,0,.35)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 20,
        },
        onClick: onClose,
      },
      h('div', {
        onClick: (event) => event.stopPropagation(),
        style: {
          width: 520, maxWidth: '86%', maxHeight: '76%', background: '#fff', borderRadius: 10,
          display: 'flex', flexDirection: 'column', overflow: 'hidden', boxShadow: '0 12px 40px rgba(0,0,0,.28)',
        },
      },
      h('div', {
        style: { padding: '12px 16px', fontWeight: 600, borderBottom: '1px solid #eee', display: 'flex', justifyContent: 'space-between' },
      },
      h('span', null, '选成员（最多三条鱼）'),
      h('span', { style: { color: 'var(--dsw-alias-label-secondary)', fontWeight: 400, fontSize: 12 } }, `已选 ${Object.keys(selected).length}/3`)
      ),
      h('div', { style: { overflowY: 'auto', flex: 1 } },
        error !== null && h('div', { style: { padding: 12, color: '#c0392b' } }, error),
        items.length === 0 && h('div', { style: { padding: 16, color: 'var(--dsw-alias-label-secondary)' } }, '没有可选会话'),
        items.map((item) => {
          const picked = selected[item.sessionId] !== undefined
          const disabled = item.member && !picked
          return h('div', {
            key: item.sessionId,
            onClick: () => { if (!disabled) toggle(item) },
            style: {
              padding: '9px 16px', borderBottom: '1px solid var(--dsw-alias-border-l1)', cursor: disabled ? 'default' : 'pointer',
              background: picked ? 'var(--dsw-alias-bg-layer-2)' : 'transparent', opacity: disabled ? 0.45 : 1,
            },
          },
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
            h('span', { style: { width: 16, color: '#2b7fd4' } }, picked ? '☑' : '☐'),
            h('div', { style: { flex: 1, minWidth: 0 } },
              h('div', { style: { fontSize: 13, fontWeight: 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } },
                item.title ?? '（无标题）'),
              h('div', { style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } },
                `${item.cwd ?? ''} · ${timeLabel(item.updatedAt ?? Date.now())}${item.running ? ' · 正在跑' : ''}`)
            )
          ),
          picked && h('div', { style: { marginTop: 6, marginLeft: 24, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' } },
            h('span', { style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)', whiteSpace: 'nowrap' } }, '群里叫它'),
            h('input', {
              value: selected[item.sessionId].name,
              onClick: (event) => event.stopPropagation(),
              onChange: (event) => rename(item.sessionId, event.target.value),
              placeholder: '短一点，`#` 用它点名',
              autoFocus: true,
              style: {
                width: 120, padding: '4px 8px', fontSize: 12,
                border: '1px solid #b9d4ef', borderRadius: 4,
              },
            }),
            h('label', {
              onClick: (event) => event.stopPropagation(),
              style: { display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer', fontSize: 11, color: 'var(--dsw-alias-label-secondary)' },
            },
            h('input', {
              type: 'checkbox',
              checked: selected[item.sessionId].active !== false,
              onChange: (event) => setActive(item.sessionId, event.target.checked),
            }),
            h('span', null, '活跃（不点名也叫醒）')
            )
          )
          )
        })
      ),
      h('div', { style: { padding: '10px 16px', borderTop: '1px solid #eee', display: 'flex', justifyContent: 'flex-end', gap: 8 } },
        h('button', { onClick: onClose, style: { padding: '6px 14px', borderRadius: 4, border: '1px solid #ddd', background: '#fff', cursor: 'pointer' } }, '取消'),
        h('button', {
          onClick: save,
          disabled: busy,
          style: { padding: '6px 16px', borderRadius: 4, border: 'none', background: '#2b7fd4', color: '#fff', cursor: 'pointer', opacity: busy ? 0.6 : 1 },
        }, busy ? '保存中…' : '保存')
      )
      )
      )
    }

    function GroupPanel() {
      const [messages, setMessages] = useState([])
      const [meta, setMeta] = useState({ seq: 0, earliestSeq: 1, hasMore: false, truncatedBefore: null })
      const [status, setStatus] = useState(null)
      const [error, setError] = useState(null)
      const [picker, setPicker] = useState(false)
      const [ack, setAck] = useState(null)
      const [editingTitle, setEditingTitle] = useState(false)
      const [titleDraft, setTitleDraft] = useState('')
      const [hasText, setHasText] = useState(false)
      // `@` picker: open while the caret sits in an unfinished `@token`.
      const [atPicker, setAtPicker] = useState(null) // { dir, items, query, start }
      const atStartRef = useRef(0)
      const editorRef = useRef(null)
      // Directory this user's `@path` tokens are relative to.
      const fileRootRef = useRef('')
      const listRef = useRef(null)
      const lastSeqRef = useRef(0)
      const ackAtRef = useRef(0)
      const stickRef = useRef(true)
      const scrollHeightRef = useRef(0)

      const refreshStatus = useCallback(async () => {
        try {
          const data = await getJson(`${ROOM}/status`)
          setStatus(data)
          const latest = (data.members ?? []).find((member) => member.kind === 'agent')
          // Only a NEW acknowledgement flashes; an old one must not sit on
          // screen forever while the panel keeps polling.
          if (data.lastAck !== null && data.lastAck !== undefined && data.lastAck.at !== ackAtRef.current) {
            ackAtRef.current = data.lastAck.at
            setAck(data.lastAck)
          }
          return latest
        } catch (error) {
          setError(String(error.message ?? error))
          return null
        }
      }, [])

      const loadInitial = useCallback(async () => {
        try {
          const data = await getJson(`${ROOM}/messages`)
          setMessages(data.messages ?? [])
          lastSeqRef.current = data.seq ?? 0
          setMeta({ seq: data.seq, earliestSeq: data.earliestSeq, hasMore: data.hasMore, truncatedBefore: data.truncatedBefore })
          await postJson(`${ROOM}/read`, {})
        } catch (error) {
          setError(String(error.message ?? error))
        }
      }, [])

      useEffect(() => { void loadInitial(); void refreshStatus() }, [loadInitial, refreshStatus])

      useEffect(() => {
        if (ack === null) return
        const handle = setTimeout(() => setAck(null), 6000)
        return () => clearTimeout(handle)
      }, [ack])

      // Poll the delta while the panel is visible; stop when it is not.
      useEffect(() => {
        let alive = true
        const tick = async () => {
          if (document.visibilityState !== 'visible') return
          try {
            const data = await getJson(`${ROOM}/messages?since=${lastSeqRef.current}&limit=200`)
            if (!alive) return
            if (Array.isArray(data.messages) && data.messages.length > 0) {
              lastSeqRef.current = Math.max(lastSeqRef.current, data.seq ?? 0)
              setMessages((current) => [...current, ...data.messages])
              void postJson(`${ROOM}/read`, {})
            }
            setMeta((current) => ({
              seq: data.seq ?? current.seq,
              earliestSeq: data.earliestSeq ?? current.earliestSeq,
              hasMore: current.hasMore,
              truncatedBefore: data.truncatedBefore ?? current.truncatedBefore,
            }))
            void refreshStatus()
          } catch {
            /* transient: the host may be reloading */
          }
        }
        const handle = setInterval(tick, POLL_MS)
        return () => { alive = false; clearInterval(handle) }
      }, [refreshStatus])

      // Keep the view pinned to the newest message unless the user scrolled up.
      useEffect(() => {
        const node = listRef.current
        if (node === null) return
        if (stickRef.current) node.scrollTop = node.scrollHeight
        scrollHeightRef.current = node.scrollHeight
      }, [messages])

      const onScroll = () => {
        const node = listRef.current
        if (node === null) return
        stickRef.current = node.scrollHeight - node.scrollTop - node.clientHeight < 60
      }

      const loadOlder = async () => {
        const first = messages[0]
        if (first === undefined) return
        try {
          const data = await getJson(`${ROOM}/messages?before=${first.seq}&limit=${PAGE}`)
          const node = listRef.current
          const before = node === null ? 0 : node.scrollHeight
          setMessages((current) => [...(data.messages ?? []), ...current])
          setMeta((current) => ({ ...current, hasMore: data.hasMore, truncatedBefore: data.truncatedBefore ?? current.truncatedBefore }))
          stickRef.current = false
          requestAnimationFrame(() => {
            if (node !== null) node.scrollTop = node.scrollHeight - before
          })
        } catch (error) {
          setError(String(error.message ?? error))
        }
      }

      const send = async () => {
        const text = readEditor()
        if (text === '') return
        if (editorRef.current !== null) editorRef.current.innerHTML = ''
        setHasText(false)
        stickRef.current = true
        try {
          await postJson(`${ROOM}/say`, {
            text,
            ...(fileRootRef.current === '' ? {} : { root: fileRootRef.current }),
          })
          const data = await getJson(`${ROOM}/messages?since=${lastSeqRef.current}&limit=200`)
          if (Array.isArray(data.messages) && data.messages.length > 0) {
            lastSeqRef.current = Math.max(lastSeqRef.current, data.seq ?? 0)
            setMessages((current) => [...current, ...data.messages])
          }
          void refreshStatus()
        } catch (error) {
          setError(String(error.message ?? error))
          if (editorRef.current !== null) editorRef.current.textContent = text
          setHasText(true)
        }
      }

      const toggleWake = async () => {
        try {
          const next = !(status?.room?.wakeEnabled !== false)
          await postJson(`${ROOM}/wake`, { enabled: next })
          void refreshStatus()
        } catch (error) {
          setError(String(error.message ?? error))
        }
      }

      const toggleMute = async () => {
        try {
          const next = !(status?.room?.muteAgentToAgent === true)
          await postJson(`${ROOM}/mute`, { enabled: next })
          void refreshStatus()
        } catch (error) {
          setError(String(error.message ?? error))
        }
      }

      const saveTitle = async () => {
        const title = titleDraft.trim()
        setEditingTitle(false)
        if (title === '' || title === (status?.room?.title ?? '群')) return
        try {
          await postJson(`${ROOM}/title`, { title })
          void refreshStatus()
        } catch (error) {
          setError(String(error.message ?? error))
        }
      }

      const loadFiles = useCallback(async (dir, query, start) => {
        try {
          const data = await getJson(`${ROOM}/files?dir=${encodeURIComponent(dir)}&q=${encodeURIComponent(query)}`)
          if (typeof data.root === 'string' && data.root !== '') fileRootRef.current = data.root
          setAtPicker({ dir, items: data.items ?? [], query, start })
          atStartRef.current = start
        } catch {
          setAtPicker(null)
        }
      }, [])

      // Read the editor's DOM back into plain text. Chips serialise to the
      // syntax the bubble renderer understands: `> quote` and `@path`.
      const readEditor = () => {
        const node = editorRef.current
        if (node === null) return ''
        let out = ''
        const walk = (element) => {
          for (const child of element.childNodes) {
            if (child.nodeType === 3) {
              out += child.textContent
              continue
            }
            if (child.nodeType !== 1) continue
            const chip = child.dataset?.chip
            if (chip === 'quote') {
              // Keep the seq: the room can re-deliver, so text alone cannot
              // identify which message was quoted.
              const seq = child.dataset.seq
              out += `> ${child.dataset.text}${seq === undefined ? '' : ` (#${seq})`}\n`
              continue
            }
            if (chip === 'file') {
              out += `@${child.dataset.text} `
              continue
            }
            if (child.tagName === 'BR') {
              out += '\n'
              continue
            }
            if (child.tagName === 'DIV' || child.tagName === 'P') {
              out += '\n'
              walk(child)
              continue
            }
            walk(child)
          }
        }
        walk(node)
        return out.replace(/\u200b/g, '').replace(/^\n+/, '').trim()
      }

      const makeChip = (kind, text, label, seq) => {
        const chip = document.createElement('span')
        chip.contentEditable = 'false'
        chip.dataset.chip = kind
        chip.dataset.text = text
        if (seq !== undefined) chip.dataset.seq = String(seq)
        chip.textContent = label
        chip.title = text
        chip.style.cssText = [
          'display:inline-block', 'max-width:240px', 'overflow:hidden', 'text-overflow:ellipsis',
          'white-space:nowrap', 'vertical-align:bottom', 'padding:0 5px', 'margin:0 2px',
          'border-radius:4px', 'font-size:12px', 'line-height:18px',
          'color:var(--dsw-alias-brand-primary)', 'background:rgba(43,127,212,.14)',
        ].join(';')
        if (kind === 'quote') chip.style.borderLeft = '2px solid var(--dsw-alias-brand-primary)'
        return chip
      }

      const caretRange = () => {
        const node = editorRef.current
        if (node === null) return null
        const selection = window.getSelection()
        if (selection === null || selection.rangeCount === 0) return null
        if (!node.contains(selection.anchorNode)) return null
        return selection.getRangeAt(0)
      }

      const insertChip = (kind, text, label, seq) => {
        const node = editorRef.current
        if (node === null) return
        node.focus()
        let range = caretRange()
        if (range === null) {
          range = document.createRange()
          range.selectNodeContents(node)
          range.collapse(false)
        }
        range.deleteContents()
        const chip = makeChip(kind, text, label, seq)
        range.insertNode(chip)
        const tail = document.createTextNode('\u200b')
        chip.after(tail)
        const after = document.createRange()
        after.setStartAfter(tail)
        after.collapse(true)
        const selection = window.getSelection()
        selection?.removeAllRanges()
        selection?.addRange(after)
        setHasText(readEditor() !== '')
      }

      // Quote the message the user pressed ↩ on, inline at the caret.
      const quoteMessage = (message) => {
        const snippet = String(message.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 120)
        if (snippet === '') return
        insertChip('quote', snippet, snippet, message.seq)
      }

      const onEditorInput = () => {
        setHasText(readEditor() !== '')
        const range = caretRange()
        const node = editorRef.current
        if (range === null || node === null) {
          if (atPicker !== null) setAtPicker(null)
          return
        }
        const before = range.cloneRange()
        before.setStart(node, 0)
        const text = before.toString()
        const at = text.lastIndexOf('@')
        const inside = at >= 0 && !/\s/.test(text.slice(at + 1))
        if (!inside) {
          if (atPicker !== null) setAtPicker(null)
          return
        }
        void loadFiles(atPicker?.dir ?? '', text.slice(at + 1), at)
      }

      const pickEntry = (entry) => {
        if (atPicker === null) return
        if (entry.dir) {
          void loadFiles([atPicker.dir, entry.name].filter(Boolean).join('/'), atPicker.query, atPicker.start)
          return
        }
        const range = caretRange()
        // Remove the half-typed `@query` before inserting the chip.
        if (range !== null) {
          const back = atPicker.query.length + 1
          try {
            const cut = document.createRange()
            cut.setStart(range.startContainer, Math.max(0, range.startOffset - back))
            cut.setEnd(range.startContainer, range.startOffset)
            cut.deleteContents()
          } catch {
            /* caret straddled nodes: leave the text, the chip still lands */
          }
        }
        setAtPicker(null)
        const rel = [atPicker.dir, entry.name].filter(Boolean).join('/')
        insertChip('file', rel, `@${rel}`)
      }

      const mine = (status?.members ?? []).find((member) => member.kind === 'user')?.name ?? '我'
      const agents = (status?.members ?? []).filter((member) => member.kind === 'agent')
      const wakeOn = status?.room?.wakeEnabled !== false
      const muted = status?.room?.muteAgentToAgent === true

      return h('div', {
        style: {
          position: 'relative', display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0,
          background: 'var(--dsw-alias-bg-base)', color: 'var(--dsw-alias-label-primary)', fontFamily: 'inherit',
        },
      },
      // status bar
      h('div', {
        style: {
          display: 'flex', alignItems: 'center', gap: 10, padding: '0 14px', height: 44,
          background: 'var(--dsw-alias-bg-layer-1)', borderBottom: '1px solid var(--dsw-alias-border-l1)', flex: '0 0 auto',
        },
      },
      editingTitle
        ? h('input', {
          value: titleDraft,
          autoFocus: true,
          onChange: (event) => setTitleDraft(event.target.value),
          onBlur: () => { void saveTitle() },
          onKeyDown: (event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              void saveTitle()
            }
            if (event.key === 'Escape') setEditingTitle(false)
          },
          style: {
            fontWeight: 600, fontSize: 14, width: 150, padding: '2px 6px',
            border: '1px solid #b9d4ef', borderRadius: 4, fontFamily: 'inherit',
          },
        })
        : h('div', {
          title: '点一下改群名',
          onClick: () => { setTitleDraft(status?.room?.title ?? '群'); setEditingTitle(true) },
          style: { fontWeight: 600, fontSize: 14, cursor: 'text', padding: '2px 4px', borderRadius: 4 },
        }, status?.room?.title ?? '群'),
      agents.length > 0 && h('div', { style: { display: 'flex', gap: 2 } },
        agents.slice(0, 2).map((agent) => h(Avatar, { key: agent.sessionId, name: agent.name, size: 20 }))
      ),
      h('div', { style: { flex: 1, fontSize: 12, color: 'var(--dsw-alias-label-secondary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } },
        h(StatusText, { status })),
      status?.wakeStats !== undefined && h('span', {
        title: (status.recentWakes ?? []).map((entry) => {
          const tail = entry.state === 'replied' ? '→ 回了' : entry.state === 'acked' ? '→ 说了看过了' : '→ 没说话'
          return `${timeLabel(entry.at)} ${entry.member} 被叫醒（seq ${entry.seqFrom}）${tail}`
        }).join('\n'),
        style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)', whiteSpace: 'nowrap', cursor: 'default' },
      }, `叫醒 ${status.wakeStats.called} · 回 ${status.wakeStats.replied}`),
      h('button', {
        onClick: () => setPicker(true),
        style: { padding: '4px 10px', fontSize: 12, borderRadius: 4, border: '1px solid var(--dsw-alias-border-l1)', background: '#fff', cursor: 'pointer' },
      }, '成员'),
      h('button', {
        onClick: toggleWake,
        title: wakeOn ? '正在叫醒：有新消息会把鱼叫起来' : '已静音：只落盘，不叫人',
        style: {
          padding: '4px 10px', fontSize: 12, borderRadius: 4, cursor: 'pointer',
          border: `1px solid ${wakeOn ? '#9fd6a6' : 'var(--dsw-alias-border-l1)'}`,
          background: wakeOn ? '#eaf7ec' : '#fff',
        },
      }, wakeOn ? '叫醒' : '不叫'),
      h('button', {
        onClick: toggleMute,
        title: muted ? '大静默：鱼之间不再互相点名叫醒（你说话照常）' : '鱼之间可以互相点名叫醒',
        style: {
          padding: '4px 10px', fontSize: 12, borderRadius: 4, cursor: 'pointer',
          border: `1px solid ${muted ? '#e0b0a0' : 'var(--dsw-alias-border-l1)'}`,
          background: muted ? '#fdeee8' : '#fff',
        },
      }, muted ? '鱼静默' : '鱼可叫')
      ),
      // message list
      h('div', {
        ref: listRef,
        onScroll,
        style: { flex: 1, minHeight: 0, overflowY: 'auto', padding: '10px 16px 16px' },
      },
      meta.hasMore && h('div', { style: { textAlign: 'center', marginBottom: 8 } },
        h('button', {
          onClick: loadOlder,
          style: { fontSize: 12, padding: '3px 10px', borderRadius: 10, border: '1px solid #d8d8d8', background: '#fff', cursor: 'pointer', color: 'var(--dsw-alias-label-secondary)' },
        }, '加载更早')
      ),
      meta.truncatedBefore !== null && meta.truncatedBefore !== undefined && h('div', {
        style: { textAlign: 'center', fontSize: 12, color: 'var(--dsw-alias-label-secondary)', marginBottom: 8 },
      }, `早于 seq=${meta.truncatedBefore} 的消息已清理（只留一周）`),
      messages.map((message, index) => {
        const previous = index === 0 ? undefined : messages[index - 1]
        const divider = showTime(index, message, previous) ? h(TimeDivider, { key: `t-${message.seq}`, at: message.at }) : null
        const displayName = nameFor(message, status?.members)
        const readers = (status?.members ?? [])
          .filter((member) => member.kind === 'agent'
            && Number.isFinite(member.seenSeq)
            && member.seenSeq >= message.seq)
          .map((member) => member.name)
        const body = message.kind === 'system'
          ? h(SystemRow, { key: message.seq, message })
          : h(Bubble, { key: message.seq, message, mine: displayName === mine, name: displayName, readers, onQuote: quoteMessage })
        return h(React.Fragment, { key: `f-${message.seq}` }, divider, body)
      }),
      messages.length === 0 && h('div', {
        style: { textAlign: 'center', color: 'var(--dsw-alias-label-secondary)', fontSize: 13, marginTop: 40 },
      }, '群里还没有消息。先点右上角「成员」把两条鱼拉进来。')
      ),
      // ack flash
      ack !== null && status !== null && h('div', {
        style: { position: 'absolute', left: 16, bottom: 84, fontSize: 12, color: 'var(--dsw-alias-label-secondary)', pointerEvents: 'none' },
      }, `${ack.member} 看过了 · ${timeLabel(ack.at)}`),
      error !== null && h('div', {
        style: { position: 'absolute', left: 14, right: 14, bottom: 78, color: '#c0392b', fontSize: 12, background: '#fff4f2', padding: '6px 10px', borderRadius: 4 },
        onClick: () => setError(null),
      }, error),
      // `@` file picker
      atPicker !== null && h('div', {
        style: {
          flex: '0 0 auto', maxHeight: 190, overflowY: 'auto', margin: '0 8px 4px',
          background: 'var(--dsw-alias-bg-overlay)',
          border: '1px solid var(--dsw-alias-border-l2)',
          borderRadius: 6, boxShadow: '0 4px 16px rgba(0,0,0,.18)',
        },
      },
      h('div', {
        style: {
          padding: '4px 10px', fontSize: 11, color: 'var(--dsw-alias-label-secondary)',
          borderBottom: '1px solid var(--dsw-alias-border-l1)',
        },
      }, atPicker.dir === '' ? '工作区' : atPicker.dir),
      atPicker.items.length === 0 && h('div', {
        style: { padding: 8, fontSize: 12, color: 'var(--dsw-alias-label-secondary)' },
      }, '没有匹配的文件'),
      atPicker.items.map((entry) => h('div', {
        key: entry.name,
        onMouseDown: (event) => { event.preventDefault(); pickEntry(entry) },
        style: { padding: '5px 10px', fontSize: 12, cursor: 'pointer', display: 'flex', gap: 6, alignItems: 'center' },
      },
      h('span', { style: { opacity: 0.6 } }, entry.dir ? '▸' : '·'),
      h('span', { style: { flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, entry.name),
      entry.dir && h('span', { style: { fontSize: 10, color: 'var(--dsw-alias-label-secondary)' } }, '进入')
      ))
      ),
      // composer
      h('div', {
        style: { flex: '0 0 auto', borderTop: '1px solid var(--dsw-alias-border-l1)', background: 'var(--dsw-alias-bg-layer-1)', padding: 8, display: 'flex', gap: 8, alignItems: 'flex-end' },
      },
      h('div', {
        style: { flex: 1, position: 'relative', minWidth: 0 },
      },
      hasText === false && h('div', {
        style: {
          position: 'absolute', left: 12, top: 9, fontSize: 14, lineHeight: 1.5,
          color: 'var(--dsw-alias-label-secondary)', pointerEvents: 'none', userSelect: 'none',
          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', right: 8,
        },
      }, '说点什么…（#名字 派活 · ¥名字 叫人 · @文件 引用 · Enter 发送）'),
      h('div', {
        ref: editorRef,
        contentEditable: true,
        suppressContentEditableWarning: true,
        onInput: onEditorInput,
        onKeyDown: (event) => {
          if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent?.isComposing) {
            event.preventDefault()
            void send()
          }
        },
        style: {
          minHeight: 38, maxHeight: 38 * 5, overflowY: 'auto', padding: '9px 11px', fontSize: 14,
          borderRadius: 6, border: '1px solid var(--dsw-alias-border-l2)', outline: 'none',
          fontFamily: 'inherit', lineHeight: 1.5, background: 'var(--dsw-alias-bg-base)',
          color: 'var(--dsw-alias-label-primary)', whiteSpace: 'pre-wrap', wordBreak: 'break-word',
        },
      })
      ),
      h('button', {
        onClick: () => void send(),
        disabled: hasText === false,
        style: {
          padding: '0 18px', height: 38, borderRadius: 6, border: 'none',
          background: hasText === false ? '#c9c9c9' : '#07c160', color: '#fff',
          cursor: hasText === false ? 'default' : 'pointer',
          fontSize: 14, flex: '0 0 auto',
        },
      }, '发送')
      ),
      picker && h(MemberPicker, {
        status,
        onClose: () => setPicker(false),
        onSaved: () => { setPicker(false); void refreshStatus(); void loadInitial() },
      })
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist', id: 'group', order: 100, label: '群',
        }, GroupIcon))
        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main', key: 'group',
        }, GroupPanel))
      },
    }
  },
})
