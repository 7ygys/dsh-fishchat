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

    // Which room the panel is showing. Module-level because the small
    // components (icon, avatar picker) render outside GroupPanel.
    let activeRoomId = (() => {
      try {
        return localStorage.getItem('dsh-rooms:active') ?? 'r1'
      } catch {
        return 'r1'
      }
    })()

    function roomBase() {
      return `/rooms/${activeRoomId}`
    }
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
            const data = await getJson(`${roomBase()}/status`)
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

    function Avatar({ name, size = 34, src, onClick, title }) {
      const initial = String(name ?? '?').trim().slice(0, 1) || '?'
      const box = {
        width: size,
        height: size,
        flex: `0 0 ${size}px`,
        borderRadius: 6,
        overflow: 'hidden',
        cursor: onClick === undefined ? 'default' : 'pointer',
      }
      if (typeof src === 'string' && src !== '') {
        return h('img', {
          src,
          alt: String(name ?? ''),
          title: title ?? String(name ?? ''),
          onClick,
          style: { ...box, objectFit: 'cover', display: 'block' },
        })
      }
      return h('div', {
        title: title ?? String(name ?? ''),
        onClick,
        style: {
          ...box,
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

    // A room's icon is a mosaic of its members' avatars (up to 2×2).
    function GroupMosaic({ members, size = 40 }) {
      const cells = (members ?? []).slice(0, 4)
      const columns = cells.length <= 1 ? 1 : 2
      const rows = cells.length <= 2 ? 1 : 2
      const gap = 1
      const cell = Math.floor((size - gap * (columns - 1)) / Math.max(columns, 1))
      return h('div', {
        style: {
          width: size, height: size, flex: `0 0 ${size}px`,
          display: 'grid',
          gridTemplateColumns: `repeat(${columns}, ${cell}px)`,
          gridTemplateRows: `repeat(${rows}, ${cell}px)`,
          gap,
          borderRadius: 6,
          overflow: 'hidden',
          background: 'var(--dsw-alias-border-l1)',
        },
      }, cells.map((member, index) => h(Avatar, {
        key: index,
        name: member.name,
        size: cell,
        src: typeof member.avatar === 'string' && member.avatar !== '' ? `${roomBase()}/file/${member.avatar}` : undefined,
      })))
    }

    function RoomList({ rooms, activeId, onPick, onCreate, onClose }) {
      return h('div', {
        style: {
          width: 200, flex: '0 0 auto', display: 'flex', flexDirection: 'column', minHeight: 0,
          background: 'var(--dsw-alias-bg-layer-1)', borderRight: '1px solid var(--dsw-alias-border-l1)',
        },
      },
      h('div', { style: { display: 'flex', alignItems: 'center', gap: 4, padding: '8px 6px 4px' } },
        h('span', { style: { flex: 1, fontSize: 12, color: 'var(--dsw-alias-label-secondary)' } }, '群'),
        h('button', {
          onClick: onCreate,
          title: '新建群',
          style: {
            width: 22, height: 22, borderRadius: 4, cursor: 'pointer', lineHeight: '18px',
            border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-base)',
            color: 'var(--dsw-alias-label-primary)',
          },
        }, '+'),
        h('button', {
          onClick: onClose,
          title: '收起',
          style: {
            width: 22, height: 22, borderRadius: 4, cursor: 'pointer', lineHeight: '18px',
            border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-base)',
            color: 'var(--dsw-alias-label-secondary)',
          },
        }, '×')
      ),
      h('div', { style: { flex: 1, minHeight: 0, overflowY: 'auto' } },
        rooms.length === 0 && h('div', {
          style: { padding: '8px 10px', fontSize: 11, color: 'var(--dsw-alias-label-secondary)' },
        }, '还没有群'),
        rooms.map((room) => h('div', {
          key: room.id,
          onClick: () => onPick(room.id),
          style: {
            display: 'flex', alignItems: 'center', gap: 8, padding: '7px 8px', cursor: 'pointer',
            background: room.id === activeId ? 'var(--dsw-alias-bg-layer-2)' : 'transparent',
          },
        },
        h(GroupMosaic, { members: room.members, size: 34 }),
        h('div', { style: { minWidth: 0, flex: 1 } },
          h('div', {
            style: { fontSize: 12, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
          }, room.title),
          h('div', {
            style: {
              fontSize: 10, color: 'var(--dsw-alias-label-secondary)',
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            },
          }, room.lastText === '' ? '还没有消息' : room.lastText)
        ))
      )))
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
        // Keep it a compressed blue chip after sending, not a wall of text:
        // one line, ellipsised, full text on hover.
        return h('div', { key: index, style: { margin: '2px 0', maxWidth: '100%' } },
          h('span', {
            title: body,
            style: {
              // A quarter of the bubble, so a quote reads as a tag rather than
              // a line of body text.
              display: 'inline-block', maxWidth: '25%', overflow: 'hidden', textOverflow: 'ellipsis',
              whiteSpace: 'nowrap', verticalAlign: 'bottom', padding: '1px 7px', borderRadius: 4,
              fontSize: 12, lineHeight: '18px',
              color: 'var(--dsw-alias-brand-primary)',
              background: 'rgba(43,127,212,.14)',
              borderLeft: '2px solid var(--dsw-alias-brand-primary)',
            },
          }, body),
          seq !== null && h('span', {
            title: `引用的是 seq ${seq}`,
            style: { fontSize: 10, opacity: 0.6, marginLeft: 5, whiteSpace: 'nowrap' },
          }, `#${seq}`)
        )
      })
    }

    function Bubble({ message, mine, name, readers, onQuote, avatarSrc, onAvatarClick }) {
      return h('div', {
        style: {
          display: 'flex',
          flexDirection: mine ? 'row-reverse' : 'row',
          alignItems: 'flex-start',
          gap: 8,
          margin: '6px 0',
        },
      },
      h(Avatar, { name: name, size: 34, src: avatarSrc, onClick: onAvatarClick, title: `${name}（点头像换图）` }),
      h('div', { style: { maxWidth: '68%', minWidth: 40 } },
        h('div', {
          style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)', margin: '0 4px 3px', textAlign: mine ? 'right' : 'left' },
        }, name),
        h('div', {
          style: {
            background: mine ? '#95ec69' : 'var(--rooms-bubble-bg, #f2f2f2)',
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
        Array.isArray(message.attachments) && message.attachments.length > 0 && h('div', {
          style: { display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: String(message.text ?? '') === '' ? 0 : 7 },
        },
        message.attachments.map((file) => {
          const src = `${roomBase()}/file/${file.id}`
          if (file.kind === 'image') {
            return h('img', {
              key: file.id,
              src,
              alt: file.name,
              title: file.name,
              style: { maxWidth: 220, maxHeight: 220, borderRadius: 6, display: 'block' },
            })
          }
          if (file.kind === 'video') {
            return h('video', {
              key: file.id,
              src,
              controls: true,
              preload: 'metadata',
              style: { maxWidth: 260, maxHeight: 220, borderRadius: 6, display: 'block' },
            })
          }
          return h('a', {
            key: file.id,
            href: src,
            download: file.name,
            target: '_blank',
            rel: 'noreferrer',
            title: file.name,
            style: {
              display: 'inline-flex', alignItems: 'center', gap: 6, padding: '6px 10px', borderRadius: 6,
              background: 'rgba(43,127,212,.12)', color: 'var(--dsw-alias-brand-primary)',
              textDecoration: 'none', fontSize: 12, maxWidth: 240, overflow: 'hidden',
            },
          }, `附件 ${file.name}`)
        })),
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
        onClick: (event) => {
          // Do not let this bubble: clicking outside the notes panel closes it,
          // and this click has to reach the notes editor instead.
          event.stopPropagation()
          onQuote({ seq: message.seq, from: name, text: String(message.text ?? '').slice(0, 200) })
        },
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
        getJson(`${roomBase()}/candidates`)
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
          await postJson(`${roomBase()}/members`, { members })
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
          // Only block adding a fourth member; anything already picked can be
          // unticked and re-ticked freely.
          const disabled = !picked && Object.keys(selected).length >= 3
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
      // `#name` / `¥name` completion: same idea, members instead of files.
      const [mentionPicker, setMentionPicker] = useState(null) // { symbol, query, items }
      // Files waiting to be sent with the next message.
      const [attachments, setAttachments] = useState([])
      const [dragging, setDragging] = useState(false)
      const fileInputRef = useRef(null)
      const [bgPanel, setBgPanel] = useState(false)
      const bgInputRef = useRef(null)
      const avatarInputRef = useRef(null)
      const avatarTargetRef = useRef(null)
      const [roomList, setRoomList] = useState([])
      const [roomsOpen, setRoomsOpen] = useState(false)
      const [, bumpRoom] = useState(0)
      const [settingsOpen, setSettingsOpen] = useState(false)
      const [fontScale, setFontScale] = useState(() => {
        try {
          const saved = Number(localStorage.getItem('dsh-rooms:font-scale') ?? 1)
          return Number.isFinite(saved) ? Math.min(1.4, Math.max(0.8, saved)) : 1
        } catch {
          return 1
        }
      })
      const [themeMode, setThemeMode] = useState(() => {
        try {
          const saved = localStorage.getItem('dsh-rooms:theme') ?? 'auto'
          return saved === 'dark' ? 'dark' : 'auto'
        } catch {
          return 'auto'
        }
      })
      // Notes: a sliding sidebar with its own storage, width remembered locally.
      const [notesOpen, setNotesOpen] = useState(false)
      const [notes, setNotes] = useState([])
      const [activeNote, setActiveNote] = useState(null)
      const [noteDraft, setNoteDraft] = useState({ title: '', text: '' })
      const [notesWidth, setNotesWidth] = useState(() => {
        try {
          const saved = Number(localStorage.getItem('dsh-rooms:notes-width') ?? 320)
          return Number.isFinite(saved) ? Math.min(640, Math.max(220, saved)) : 320
        } catch {
          return 320
        }
      })
      const notesWidthRef = useRef(notesWidth)
      // Refs, so the debounced save never reads a stale draft or note id out of
      // an old render.
      const noteDraftRef = useRef({ title: '', text: '' })
      const activeNoteRef = useRef(null)
      const noteSaveTimer = useRef(null)
      const noteEditorRef = useRef(null)
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
          const data = await getJson(`${roomBase()}/status`)
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
          const data = await getJson(`${roomBase()}/messages`)
          setMessages(data.messages ?? [])
          lastSeqRef.current = data.seq ?? 0
          setMeta({ seq: data.seq, earliestSeq: data.earliestSeq, hasMore: data.hasMore, truncatedBefore: data.truncatedBefore })
          await postJson(`${roomBase()}/read`, {})
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

      // Restore whatever was half-typed before the user left the room.
      useEffect(() => {
        const node = editorRef.current
        if (node === null) return
        try {
          const saved = localStorage.getItem(`dsh-rooms:draft:${activeRoomId}`)
          if (saved !== null && saved !== '') {
            node.innerHTML = saved
            setHasText(true)
          }
        } catch {
          /* storage unavailable: start empty */
        }
      }, [])

      // Heartbeat: while the group panel is open, remember it. A plugin reload
      // removes the `main` entry, which makes the layout fall back to the
      // conversation view — on the way back up, this is what tells us to return.
      useEffect(() => {
        const key = 'dsh-rooms:group-open'
        const beat = () => localStorage.setItem(key, String(Date.now()))
        beat()
        const handle = setInterval(beat, 5000)
        return () => clearInterval(handle)
      }, [])

      // Poll the delta while the panel is visible; stop when it is not.
      useEffect(() => {
        let alive = true
        const tick = async () => {
          if (document.visibilityState !== 'visible') return
          try {
            const data = await getJson(`${roomBase()}/messages?since=${lastSeqRef.current}&limit=200`)
            if (!alive) return
            if (Array.isArray(data.messages) && data.messages.length > 0) {
              lastSeqRef.current = Math.max(lastSeqRef.current, data.seq ?? 0)
              setMessages((current) => [...current, ...data.messages])
              void postJson(`${roomBase()}/read`, {})
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
          const data = await getJson(`${roomBase()}/messages?before=${first.seq}&limit=${PAGE}`)
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
        if (text === '' && attachments.length === 0) return
        if (editorRef.current !== null) editorRef.current.innerHTML = ''
        setHasText(false)
        const outgoing = attachments
        setAttachments([])
        // Clearing the DOM does not fire `input`, so the pickers must be closed
        // by hand or they stay pinned over an empty composer.
        setAtPicker(null)
        setMentionPicker(null)
        try {
          localStorage.removeItem(`dsh-rooms:draft:${activeRoomId}`)
        } catch {
          /* storage unavailable */
        }
        stickRef.current = true
        try {
          await postJson(`${roomBase()}/say`, {
            text,
            ...(outgoing.length === 0 ? {} : { attachments: outgoing }),
            ...(fileRootRef.current === '' ? {} : { root: fileRootRef.current }),
          })
          const data = await getJson(`${roomBase()}/messages?since=${lastSeqRef.current}&limit=200`)
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
          await postJson(`${roomBase()}/wake`, { enabled: next })
          void refreshStatus()
        } catch (error) {
          setError(String(error.message ?? error))
        }
      }

      const toggleMute = async () => {
        try {
          const next = !(status?.room?.muteAgentToAgent === true)
          await postJson(`${roomBase()}/mute`, { enabled: next })
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
          await postJson(`${roomBase()}/title`, { title })
          void refreshStatus()
        } catch (error) {
          setError(String(error.message ?? error))
        }
      }

      const loadFiles = useCallback(async (dir, query, start) => {
        try {
          const data = await getJson(`${roomBase()}/files?dir=${encodeURIComponent(dir)}&q=${encodeURIComponent(query)}`)
          if (typeof data.root === 'string' && data.root !== '') fileRootRef.current = data.root
          setAtPicker({ dir, items: data.items ?? [], query, start })
          atStartRef.current = start
        } catch {
          setAtPicker(null)
        }
      }, [])

      // Read the editor's DOM back into plain text. Chips serialise to the
      // syntax the bubble renderer understands: `> quote` and `@path`.
      // `readEditor` / `insertChip` are generic over the editor node: the
      // composer and the notes body both use them.
      const readTree = (node) => {
        if (node === null || node === undefined) return ''
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
              // Inline marker, no newline: a quote can sit mid-sentence, and a
              // newline here would split the line the user was typing.
              const seq = child.dataset.seq
              out += `>${child.dataset.text}${seq === undefined ? '' : `(#${seq})`}`
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

      const readEditor = () => readTree(editorRef.current)

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

      const caretRangeIn = (node) => {
        if (node === null || node === undefined) return null
        const selection = window.getSelection()
        if (selection === null || selection.rangeCount === 0) return null
        if (!node.contains(selection.anchorNode)) return null
        return selection.getRangeAt(0)
      }

      const caretRange = () => caretRangeIn(editorRef.current)

      const insertChipInto = (node, kind, text, label, seq) => {
        if (node === null || node === undefined) return
        node.focus()
        let range = caretRangeIn(node)
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
        // Only the composer feeds the send button; the notes body does not.
        if (node === editorRef.current) setHasText(readEditor() !== '')
      }

      const insertChip = (kind, text, label, seq) => insertChipInto(editorRef.current, kind, text, label, seq)

      // Quote the message the user pressed ↩ on. When the notes panel is open
      // the quote goes into the note; otherwise into the message composer.
      const quoteMessage = (message) => {
        const snippet = String(message.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 120)
        if (snippet === '') return
        if (notesOpen && noteEditorRef.current !== null) {
          insertChipInto(noteEditorRef.current, 'quote', snippet, snippet, message.seq)
          updateNote({ text: readTree(noteEditorRef.current) })
          return
        }
        insertChip('quote', snippet, snippet, message.seq)
      }

      const setBackground = async (background) => {
        try {
          await postJson(`${roomBase()}/background`, background)
          void refreshStatus()
        } catch (error) {
          setError(String(error?.message ?? error))
        }
      }

      // A saved note is plain text where a quote is written `>text(#seq)` —
      // possibly mid-line, so scan rather than split by lines.
      const countBreaks = (chunk) => String(chunk).split('\n').length - 1

      const appendPlain = (node, chunk) => {
        const parts = String(chunk).split('\n')
        parts.forEach((part, index) => {
          if (part !== '') node.appendChild(document.createTextNode(part))
          if (index < parts.length - 1) node.appendChild(document.createElement('br'))
        })
      }

      const hydrateNote = (text) => {
        const node = noteEditorRef.current
        if (node === null) return
        node.textContent = ''
        const source = String(text ?? '')
        const pattern = />([^>\n]*?)\(#(\d+)\)/g
        let cursor = 0
        let match
        while ((match = pattern.exec(source)) !== null) {
          if (match.index > cursor) appendPlain(node, source.slice(cursor, match.index))
          node.appendChild(makeChip('quote', match[1], match[1], match[2]))
          cursor = pattern.lastIndex
        }
        if (cursor < source.length) appendPlain(node, source.slice(cursor))
      }

      const selectNote = (note) => {
        setActiveNote(note)
        activeNoteRef.current = note
        noteDraftRef.current = { title: note.title, text: note.text }
        setNoteDraft({ title: note.title, text: note.text })
      }

      useEffect(() => {
        if (activeNote === null) return
        hydrateNote(activeNote.text)
      }, [activeNote])

      const createNote = async () => {
        try {
          const data = await postJson('/notes', {})
          setNotes((current) => [data.note, ...current])
          selectNote(data.note)
        } catch (error) {
          setError(String(error?.message ?? error))
        }
      }

      const updateNote = (patch) => {
        const next = { ...noteDraftRef.current, ...patch }
        noteDraftRef.current = next
        setNoteDraft(next)
        const note = activeNoteRef.current
        if (note !== null) {
          if (noteSaveTimer.current !== null) clearTimeout(noteSaveTimer.current)
          noteSaveTimer.current = setTimeout(() => {
            void postJson(`/notes/${note.id}`, { title: next.title, text: next.text })
              .catch((error) => setError(`笔记保存失败：${String(error?.message ?? error)}`))
          }, 700)
          setNotes((current) => current.map((item) => (item.id === note.id
            ? { ...item, ...patch, updatedAt: Date.now() }
            : item)))
        }
      }

      const deleteNote = async () => {
        if (activeNote === null) return
        try {
          await fetch(`/notes/${activeNote.id}`, { method: 'DELETE' })
          const rest = notes.filter((note) => note.id !== activeNote.id)
          setNotes(rest)
          if (rest.length > 0) selectNote(rest[0])
          else {
            setActiveNote(null)
            activeNoteRef.current = null
            noteDraftRef.current = { title: '', text: '' }
            setNoteDraft({ title: '', text: '' })
          }
        } catch (error) {
          setError(String(error?.message ?? error))
        }
      }

      const startNotesResize = (event) => {
        event.preventDefault()
        const startX = event.clientX
        const startWidth = notesWidth
        const move = (moveEvent) => {
          const next = Math.min(640, Math.max(220, startWidth + (moveEvent.clientX - startX)))
          notesWidthRef.current = next
          setNotesWidth(next)
        }
        const up = () => {
          window.removeEventListener('mousemove', move)
          window.removeEventListener('mouseup', up)
          try {
            localStorage.setItem('dsh-rooms:notes-width', String(notesWidthRef.current))
          } catch {
            /* storage unavailable */
          }
        }
        window.addEventListener('mousemove', move)
        window.addEventListener('mouseup', up)
      }

      useEffect(() => {
        if (!notesOpen) return undefined
        let alive = true
        getJson('/notes')
          .then((data) => {
            if (!alive) return
            const list = data.notes ?? []
            setNotes(list)
            if (list.length > 0) selectNote(list[0])
          })
          .catch(() => {})
        return () => { alive = false }
      }, [notesOpen])

      const startAvatarPick = (targetId) => {
        avatarTargetRef.current = targetId
        avatarInputRef.current?.click()
      }

      const uploadAvatar = async (file) => {
        const target = avatarTargetRef.current
        if (file === undefined || file === null || target === null) return
        try {
          const response = await fetch(`${roomBase()}/upload?name=${encodeURIComponent(file.name)}`, { method: 'POST', body: file })
          if (!response.ok) throw new Error(`HTTP ${response.status}`)
          const meta = await response.json()
          await postJson(`${roomBase()}/avatar`, { sessionId: target, avatar: meta.id })
          void refreshStatus()
        } catch (error) {
          setError(`头像设置失败：${String(error?.message ?? error)}`)
        }
      }

      const uploadBackground = async (file) => {        if (file === undefined || file === null) return
        try {
          const response = await fetch(`${roomBase()}/upload?name=${encodeURIComponent(file.name)}`, { method: 'POST', body: file })
          if (!response.ok) throw new Error(`HTTP ${response.status}`)
          const meta = await response.json()
          await setBackground({ type: 'image', value: meta.id })
        } catch (error) {
          setError(`背景上传失败：${String(error?.message ?? error)}`)
        }
      }

      const loadRooms = useCallback(async () => {
        try {
          const data = await getJson('/rooms')
          setRoomList(data.rooms ?? [])
        } catch {
          /* the list is cosmetic: a failure must not break the panel */
        }
      }, [])

      const switchRoom = (id) => {
        setRoomsOpen(false)
        if (id === activeRoomId) return
        activeRoomId = id
        try { localStorage.setItem('dsh-rooms:active', id) } catch { /* storage unavailable */ }
        bumpRoom((value) => value + 1)
        setMessages([])
        setMeta({ seq: 0, earliestSeq: 1, hasMore: false, truncatedBefore: null })
        lastSeqRef.current = 0
        // Each room keeps its own half-typed draft.
        if (editorRef.current !== null) editorRef.current.innerHTML = ''
        setHasText(false)
        try {
          const saved = localStorage.getItem(`dsh-rooms:draft:${id}`)
          if (saved !== null && saved !== '' && editorRef.current !== null) {
            editorRef.current.innerHTML = saved
            setHasText(true)
          }
        } catch {
          /* storage unavailable: start empty */
        }
        void loadInitial()
        void refreshStatus()
      }

      const createRoom = async () => {
        try {
          const data = await postJson('/rooms', { title: '新群' })
          if (data?.room?.id !== undefined) {
            await loadRooms()
            switchRoom(data.room.id)
          }
        } catch (error) {
          setError(`建群失败：${String(error?.message ?? error)}`)
        }
      }

      useEffect(() => {
        void loadRooms()
      }, [loadRooms])

      const uploadFiles = async (fileList) => {
        const list = Array.from(fileList ?? []).slice(0, 9)
        for (const file of list) {
          try {
            const response = await fetch(`${roomBase()}/upload?name=${encodeURIComponent(file.name)}`, {
              method: 'POST',
              body: file,
            })
            if (!response.ok) throw new Error(`HTTP ${response.status}`)
            const meta = await response.json()
            setAttachments((current) => [...current, meta].slice(0, 9))
          } catch (error) {
            setError(`上传失败：${file.name}（${String(error?.message ?? error)}）`)
          }
        }
      }

      const insertText = (value) => {
        const node = editorRef.current
        if (node === null) return
        node.focus()
        // Let the browser do it: execCommand manages the caret and the
        // surrounding text nodes correctly, which hand-rolled range surgery
        // kept getting wrong (a duplicated character on the next keystroke).
        let done = false
        try {
          done = document.execCommand('insertText', false, value)
        } catch {
          done = false
        }
        if (!done) {
          let range = caretRangeIn(node)
          if (range === null) {
            range = document.createRange()
            range.selectNodeContents(node)
            range.collapse(false)
          }
          range.deleteContents()
          const textNode = document.createTextNode(value)
          range.insertNode(textNode)
          const after = document.createRange()
          after.setStartAfter(textNode)
          after.collapse(true)
          const selection = window.getSelection()
          selection?.removeAllRanges()
          selection?.addRange(after)
        }
        setHasText(readEditor() !== '')
        try {
          localStorage.setItem(`dsh-rooms:draft:${activeRoomId}`, editorRef.current?.innerHTML ?? '')
        } catch {
          /* storage unavailable */
        }
      }

      const pickMention = (name) => {
        if (mentionPicker === null) return
        const range = caretRange()
        if (range !== null) {
          const back = mentionPicker.query.length + 1
          try {
            const cut = document.createRange()
            cut.setStart(range.startContainer, Math.max(0, range.startOffset - back))
            cut.setEnd(range.startContainer, range.startOffset)
            cut.deleteContents()
          } catch {
            /* caret straddled nodes */
          }
        }
        const symbol = mentionPicker.symbol
        setMentionPicker(null)
        insertText(`${symbol}${name} `)
      }

      const onEditorInput = () => {
        setHasText(readEditor() !== '')
        try {
          localStorage.setItem(`dsh-rooms:draft:${activeRoomId}`, editorRef.current?.innerHTML ?? '')
        } catch {
          /* storage unavailable */
        }
        const range = caretRange()
        const node = editorRef.current
        if (range === null || node === null) {
          if (atPicker !== null) setAtPicker(null)
          return
        }
        const before = range.cloneRange()
        before.setStart(node, 0)
        const text = before.toString()
        // Only the TRIGGER characters are folded, via a tiny table. Whole-string
        // NFKC would rewrite body text (① → 1, ㌔ → キロ); the query itself stays
        // exactly as typed.
        const TRIGGERS = { '#': '#', '@': '@', '¥': '¥', '＃': '#', '＠': '@', '￥': '¥' }
        let triggerAt = -1
        let trigger = null
        for (let index = text.length - 1; index >= 0; index -= 1) {
          const char = text[index]
          if (/\s/.test(char)) break
          if (TRIGGERS[char] !== undefined) {
            triggerAt = index
            trigger = TRIGGERS[char]
            break
          }
        }
        if (triggerAt < 0) {
          if (atPicker !== null) setAtPicker(null)
          if (mentionPicker !== null) setMentionPicker(null)
          return
        }
        const query = text.slice(triggerAt + 1)
        if (trigger === '@') {
          setMentionPicker(null)
          void loadFiles(atPicker?.dir ?? '', query, triggerAt)
          return
        }
        if (atPicker !== null) setAtPicker(null)
        const items = (status?.members ?? []).filter((member) => member.kind === 'agent'
          && (query === '' || member.name.includes(query)))
        setMentionPicker({ symbol: trigger, query, items })
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
      const bg = status?.room?.background
      const roomBackground = bg?.type === 'image' && bg.value !== ''
        ? `url("${roomBase()}/file/${bg.value}") center / cover no-repeat`
        : (bg?.value !== '' && bg?.value !== undefined ? bg.value : 'var(--dsw-alias-bg-base)')
      // Dark mode is a local override of the theme tokens, so the room can be
      // dark while the rest of the harness stays light.
      const themeVars = themeMode === 'dark'
        ? {
          '--dsw-alias-bg-base': '#1b1b1d',
          '--dsw-alias-bg-layer-1': '#242427',
          '--dsw-alias-bg-layer-2': '#2e2e32',
          '--dsw-alias-bg-overlay': '#2e2e32',
          '--dsw-alias-label-primary': '#ececec',
          '--dsw-alias-label-secondary': '#a0a0a0',
          '--dsw-alias-border-l1': '#3a3a3f',
          '--dsw-alias-border-l2': '#4a4a52',
          // The bubble is its own surface: a light bubble with light text is
          // exactly how messages "disappeared" in dark mode.
          '--rooms-bubble-bg': '#2f2f34',
        }
        : { '--rooms-bubble-bg': '#f2f2f2' }
      const setFontScalePersist = (next) => {
        const value = Math.min(1.4, Math.max(0.8, Math.round(next * 10) / 10))
        setFontScale(value)
        try { localStorage.setItem('dsh-rooms:font-scale', String(value)) } catch { /* storage unavailable */ }
      }
      const setThemePersist = (next) => {
        setThemeMode(next)
        try { localStorage.setItem('dsh-rooms:theme', next) } catch { /* storage unavailable */ }
      }
      const deleteThisRoom = async () => {
        if (activeRoomId === 'r1') {
          setError('默认群不能删除')
          return
        }
        // eslint-disable-next-line no-alert
        const ok = typeof window.confirm === 'function'
          ? window.confirm(`删除「${status?.room?.title ?? '这个群'}」？消息记录会一起删掉，不能恢复。`)
          : false
        if (!ok) return
        try {
          await fetch(`/rooms/${activeRoomId}`, { method: 'DELETE' })
          activeRoomId = 'r1'
          try { localStorage.setItem('dsh-rooms:active', 'r1') } catch { /* storage unavailable */ }
          setRoomsOpen(false)
          setSettingsOpen(false)
          bumpRoom((value) => value + 1)
          setMessages([])
          lastSeqRef.current = 0
          void loadRooms()
          void loadInitial()
          void refreshStatus()
        } catch (error) {
          setError(`删群失败：${String(error?.message ?? error)}`)
        }
      }

      return h('div', {
        style: { display: 'flex', height: '100%', minHeight: 0 },
      },
      roomsOpen
        ? h(RoomList, {
          rooms: roomList,
          activeId: activeRoomId,
          onPick: switchRoom,
          onCreate: () => { void createRoom() },
          onClose: () => setRoomsOpen(false),
        })
        : h('div', {
          onClick: () => setRoomsOpen(true),
          title: '展开群列表',
          style: {
            width: 16, flex: '0 0 auto', display: 'flex', alignItems: 'center', justifyContent: 'center',
            cursor: 'pointer', color: 'var(--dsw-alias-label-secondary)', fontSize: 12, userSelect: 'none',
            background: 'var(--dsw-alias-bg-layer-1)', borderRight: '1px solid var(--dsw-alias-border-l1)',
          },
        }, '>'),
      h('div', {
        style: {
          flex: 1, minWidth: 0,
          position: 'relative', display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0,
          background: roomBackground, color: 'var(--dsw-alias-label-primary)', fontFamily: 'inherit',
          ...themeVars,
          zoom: fontScale,
          outline: dragging ? '2px dashed var(--dsw-alias-brand-primary)' : 'none', outlineOffset: -6,
        },
        // Clicking the message area dismisses every floating panel.
        onClick: () => {
          if (notesOpen) setNotesOpen(false)
          if (roomsOpen) setRoomsOpen(false)
          if (settingsOpen) setSettingsOpen(false)
          if (bgPanel) setBgPanel(false)
        },
        onDragOver: (event) => {
          event.preventDefault()
          if (!dragging) setDragging(true)
        },
        onDragLeave: (event) => {
          if (event.currentTarget === event.target) setDragging(false)
        },
        onDrop: (event) => {
          event.preventDefault()
          setDragging(false)
          void uploadFiles(event.dataTransfer?.files)
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
      }, [
        `叫醒 ${status.wakeStats.called}`,
        `回 ${status.wakeStats.replied}`,
        status.wakeStats.noTurn > 0 ? `没醒 ${status.wakeStats.noTurn}` : null,
        status.wakeStats.missed > 0 ? `没匹配 ${status.wakeStats.missed}` : null,
        status.wakeStats.failed > 0 ? `失败 ${status.wakeStats.failed}` : null,
      ].filter(Boolean).join(' · ')),
      h('button', {
        onClick: () => setSettingsOpen(!settingsOpen),
        title: '设置',
        style: {
          padding: '3px 8px', fontSize: 14, borderRadius: 4, cursor: 'pointer', lineHeight: '16px',
          border: '1px solid var(--dsw-alias-border-l1)',
          background: settingsOpen ? 'var(--dsw-alias-bg-layer-2)' : 'var(--dsw-alias-bg-layer-1)',
          color: 'inherit',
        },
      }, '⚙'),
      h('button', {
        onClick: () => setNotesOpen(!notesOpen),
        title: '笔记',
        style: {
          padding: '4px 8px', fontSize: 12, borderRadius: 4, cursor: 'pointer',
          border: '1px solid var(--dsw-alias-border-l1)',
          background: notesOpen ? 'var(--dsw-alias-bg-layer-2)' : 'var(--dsw-alias-bg-layer-1)',
          color: 'inherit',
        },
      }, '笔记'),
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
      }, muted ? '大静默' : '鱼可叫')
      ),
      // body: notes sidebar + messages
      h('div', { style: { display: 'flex', flex: 1, minHeight: 0 } },
      notesOpen && h('div', {
        style: {
          width: notesWidth, flex: '0 0 auto', minWidth: 0, display: 'flex', flexDirection: 'column',
          background: 'var(--dsw-alias-bg-layer-1)', borderRight: '1px solid var(--dsw-alias-border-l1)',
        },
      },
      h('div', {
        style: {
          display: 'flex', alignItems: 'center', gap: 6, padding: '6px 8px',
          borderBottom: '1px solid var(--dsw-alias-border-l1)',
        },
      },
      h('span', { style: { flex: 1, fontSize: 12, color: 'var(--dsw-alias-label-secondary)' } }, '笔记'),
      h('button', {
        onClick: () => { void createNote() },
        style: {
          padding: '2px 8px', fontSize: 11, borderRadius: 4, cursor: 'pointer',
          border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-base)',
          color: 'var(--dsw-alias-label-primary)',
        },
      }, '新建'),
      h('button', {
        onClick: () => { void deleteNote() },
        disabled: activeNote === null,
        style: {
          padding: '2px 8px', fontSize: 11, borderRadius: 4, cursor: activeNote === null ? 'default' : 'pointer',
          border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-base)',
          color: 'var(--dsw-alias-label-secondary)', opacity: activeNote === null ? 0.5 : 1,
        },
      }, '删除')
      ),
      h('div', { style: { maxHeight: 130, overflowY: 'auto', borderBottom: '1px solid var(--dsw-alias-border-l1)' } },
        notes.length === 0 && h('div', {
          style: { padding: '8px 10px', fontSize: 11, color: 'var(--dsw-alias-label-secondary)' },
        }, '还没有笔记，点「新建」'),
        notes.map((note) => h('div', {
          key: note.id,
          onClick: () => selectNote(note),
          style: {
            padding: '5px 9px', cursor: 'pointer', fontSize: 12,
            background: activeNote?.id === note.id ? 'var(--dsw-alias-bg-layer-2)' : 'transparent',
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          },
        }, note.title || '无标题'))
      ),
      h('input', {
        value: noteDraft.title,
        onChange: (event) => updateNote({ title: event.target.value }),
        placeholder: '标题',
        style: {
          margin: 8, padding: '4px 8px', fontSize: 13, fontWeight: 600, borderRadius: 4,
          border: '1px solid var(--dsw-alias-border-l1)', outline: 'none',
          background: 'var(--dsw-alias-bg-base)', color: 'var(--dsw-alias-label-primary)',
        },
      }),
      h('div', {
        ref: noteEditorRef,
        contentEditable: true,
        suppressContentEditableWarning: true,
        onInput: () => { updateNote({ text: readTree(noteEditorRef.current) }) },
        style: {
          flex: 1, minHeight: 0, margin: '0 8px 8px', padding: '6px 8px', fontSize: 13,
          lineHeight: 1.6, overflowY: 'auto', borderRadius: 4, outline: 'none',
          border: '1px solid var(--dsw-alias-border-l1)',
          background: 'var(--dsw-alias-bg-base)', color: 'var(--dsw-alias-label-primary)',
          whiteSpace: 'pre-wrap', wordBreak: 'break-word',
        },
      })
      ),
      notesOpen && h('div', {
        onMouseDown: startNotesResize,
        title: '拖动调节宽度',
        style: { width: 5, flex: '0 0 auto', cursor: 'col-resize', background: 'transparent' },
      }),
      // message list
      h('div', {
        ref: listRef,
        onScroll,
        // Clicking anywhere outside the notes panel closes it.
        onClick: () => { if (notesOpen) setNotesOpen(false) },
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
        const memberHit = (status?.members ?? []).find((member) => member.name === displayName)
        const avatarSrc = typeof memberHit?.avatar === 'string' && memberHit.avatar !== ''
          ? `${roomBase()}/file/${memberHit.avatar}`
          : undefined
        const avatarTargetId = memberHit?.kind === 'user' ? 'user' : memberHit?.sessionId
        const readers = (status?.members ?? [])
          .filter((member) => member.kind === 'agent'
            && Number.isFinite(member.seenSeq)
            && member.seenSeq >= message.seq)
          .map((member) => member.name)
        const body = message.kind === 'system'
          ? h(SystemRow, { key: message.seq, message })
          : h(Bubble, {
            key: message.seq,
            message,
            mine: displayName === mine,
            name: displayName,
            readers,
            onQuote: quoteMessage,
            avatarSrc,
            onAvatarClick: avatarTargetId === undefined
              ? undefined
              : () => { startAvatarPick(avatarTargetId) },
          })
        return h(React.Fragment, { key: `f-${message.seq}` }, divider, body)
      }),
      messages.length === 0 && h('div', {
        style: { textAlign: 'center', color: 'var(--dsw-alias-label-secondary)', fontSize: 13, marginTop: 40 },
      }, '群里还没有消息。先点右上角「成员」把两条鱼拉进来。')
      )
      ),
      // ack flash
      ack !== null && status !== null && h('div', {
        style: { position: 'absolute', left: 16, bottom: 84, fontSize: 12, color: 'var(--dsw-alias-label-secondary)', pointerEvents: 'none' },
      }, `${ack.member} 看过了 · ${timeLabel(ack.at)}`),
      error !== null && h('div', {
        style: { position: 'absolute', left: 14, right: 14, bottom: 78, color: '#c0392b', fontSize: 12, background: '#fff4f2', padding: '6px 10px', borderRadius: 4 },
        onClick: () => setError(null),
      }, error),
      // files waiting to go out with the next message
      attachments.length > 0 && h('div', {
        style: {
          flex: '0 0 auto', display: 'flex', gap: 6, flexWrap: 'wrap', padding: '6px 10px',
          background: 'var(--dsw-alias-bg-layer-2)', borderTop: '1px solid var(--dsw-alias-border-l1)',
        },
      },
      attachments.map((file) => h('div', {
        key: file.id,
        style: {
          display: 'flex', alignItems: 'center', gap: 5, padding: '3px 6px', borderRadius: 5,
          background: 'var(--dsw-alias-bg-base)', fontSize: 11,
        },
      },
      file.kind === 'image'
        ? h('img', { src: `${roomBase()}/file/${file.id}`, alt: '', style: { width: 22, height: 22, objectFit: 'cover', borderRadius: 3 } })
        : h('span', null, file.kind === 'video' ? '视频' : '文件'),
      h('span', { style: { maxWidth: 90, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, file.name),
      h('button', {
        onClick: () => setAttachments((current) => current.filter((item) => item.id !== file.id)),
        title: '移除',
        style: { border: 'none', background: 'transparent', cursor: 'pointer', color: 'inherit', padding: 0, fontSize: 12 },
      }, '×')
      ))
      ),
      // settings
      settingsOpen && h('div', {
        style: {
          position: 'absolute', top: 48, right: 12, zIndex: 40, width: 240,
          background: 'var(--dsw-alias-bg-overlay)', border: '1px solid var(--dsw-alias-border-l2)',
          borderRadius: 8, padding: 10, boxShadow: '0 8px 24px rgba(0,0,0,.3)',
          display: 'flex', flexDirection: 'column', gap: 10, fontSize: 12,
        },
      },
      h('div', { style: { display: 'flex', alignItems: 'center', gap: 6 } },
        h('span', { style: { flex: 1, color: 'var(--dsw-alias-label-secondary)' } }, '字号'),
        ['0.9', '1', '1.15', '1.3'].map((value) => h('button', {
          key: value,
          onClick: () => setFontScalePersist(Number(value)),
          style: {
            padding: '2px 7px', fontSize: 11, borderRadius: 4, cursor: 'pointer',
            border: '1px solid var(--dsw-alias-border-l2)',
            background: Math.abs(fontScale - Number(value)) < 0.01 ? 'var(--dsw-alias-bg-layer-2)' : 'var(--dsw-alias-bg-base)',
            color: 'inherit',
          },
        }, Number(value) < 1 ? 'A-' : Number(value) > 1 ? 'A+' : 'A'))
      ),
      h('div', { style: { display: 'flex', alignItems: 'center', gap: 6 } },
        h('span', { style: { flex: 1, color: 'var(--dsw-alias-label-secondary)' } }, '主题'),
        h('button', {
          onClick: () => setThemePersist(themeMode === 'dark' ? 'auto' : 'dark'),
          style: {
            padding: '3px 10px', fontSize: 11, borderRadius: 4, cursor: 'pointer',
            border: '1px solid var(--dsw-alias-border-l2)',
            background: themeMode === 'dark' ? 'var(--dsw-alias-bg-layer-2)' : 'var(--dsw-alias-bg-base)',
            color: 'inherit',
          },
        }, themeMode === 'dark' ? '深色（点击还原）' : '跟随 Harness')
      ),
      h('div', { style: { height: 1, background: 'var(--dsw-alias-border-l1)' } }),
      h('button', {
        onClick: () => { setSettingsOpen(false); setPicker(true) },
        style: {
          padding: '6px 10px', fontSize: 12, borderRadius: 4, cursor: 'pointer', textAlign: 'left',
          border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-base)', color: 'inherit',
        },
      }, '成员管理'),
      h('button', {
        onClick: () => { setSettingsOpen(false); setBgPanel(true) },
        style: {
          padding: '6px 10px', fontSize: 12, borderRadius: 4, cursor: 'pointer', textAlign: 'left',
          border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-base)', color: 'inherit',
        },
      }, '聊天背景'),
      h('button', {
        onClick: () => void deleteThisRoom(),
        disabled: activeRoomId === 'r1',
        style: {
          padding: '6px 10px', fontSize: 12, borderRadius: 4, textAlign: 'left',
          cursor: activeRoomId === 'r1' ? 'default' : 'pointer',
          opacity: activeRoomId === 'r1' ? 0.45 : 1,
          border: '1px solid var(--dsw-alias-state-error-primary, #c0392b)',
          background: 'var(--dsw-alias-bg-base)',
          color: 'var(--dsw-alias-state-error-primary, #c0392b)',
        },
      }, activeRoomId === 'r1' ? '删除此群（默认群不可删）' : '删除此群（连同消息）')
      ),
      // background picker
      bgPanel && h('div', {
        style: {
          position: 'absolute', top: 48, right: 12, zIndex: 30, width: 232,
          background: 'var(--dsw-alias-bg-overlay)', border: '1px solid var(--dsw-alias-border-l2)',
          borderRadius: 8, padding: 10, boxShadow: '0 8px 24px rgba(0,0,0,.25)',
          display: 'flex', flexDirection: 'column', gap: 8,
        },
      },
      h('div', { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)' } }, '背景颜色'),
      h('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap' } },
        ['', '#f2f2f2', '#e8f0e0', '#eef2f7', '#f7f0e8', '#2b2b2b', '#1d2b36'].map((color) => h('button', {
          key: color === '' ? 'theme' : color,
          onClick: () => { void setBackground({ type: 'color', value: color }) },
          title: color === '' ? '跟随主题' : color,
          style: {
            width: 26, height: 26, borderRadius: 4, cursor: 'pointer',
            border: '1px solid var(--dsw-alias-border-l2)',
            background: color === '' ? 'var(--dsw-alias-bg-base)' : color,
            color: 'var(--dsw-alias-label-secondary)', fontSize: 12,
          },
        }, color === '' ? '⟳' : ''))
      ),
      h('button', {
        onClick: () => bgInputRef.current?.click(),
        style: {
          padding: '6px 10px', fontSize: 12, borderRadius: 4, cursor: 'pointer',
          border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-layer-1)',
          color: 'var(--dsw-alias-label-primary)',
        },
      }, '用图片做背景'),
      h('input', {
        ref: bgInputRef,
        type: 'file',
        accept: 'image/*',
        style: { display: 'none' },
        onChange: (event) => {
          void uploadBackground(event.target.files?.[0])
          event.target.value = ''
        },
      })
      ),
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
      // `#` / `¥` member completion
      mentionPicker !== null && mentionPicker.items.length > 0 && h('div', {
        style: {
          flex: '0 0 auto', maxHeight: 150, overflowY: 'auto', margin: '0 8px 4px',
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
      }, mentionPicker.symbol === '#' ? '派活给（必须回）' : '叫一声（不必回）'),
      mentionPicker.items.map((member) => h('div', {
        key: member.name,
        onMouseDown: (event) => { event.preventDefault(); pickMention(member.name) },
        style: { padding: '5px 10px', fontSize: 12, cursor: 'pointer', display: 'flex', gap: 6, alignItems: 'center' },
      },
      h(Avatar, { name: member.name, size: 18 }),
      h('span', null, `${mentionPicker.symbol}${member.name}`)
      ))
      ),
      // composer
      h('div', {
        style: { flex: '0 0 auto', borderTop: '1px solid var(--dsw-alias-border-l1)', background: 'var(--dsw-alias-bg-layer-1)', padding: 8, display: 'flex', gap: 8, alignItems: 'flex-end' },
      },
      h('button', {
        onClick: () => fileInputRef.current?.click(),
        title: '添加图片 / 视频 / 文件（也可以直接拖进窗口）',
        style: {
          height: 38, width: 38, borderRadius: 6, border: '1px solid var(--dsw-alias-border-l2)',
          background: 'var(--dsw-alias-bg-layer-1)', cursor: 'pointer', fontSize: 15, flex: '0 0 auto',
          color: 'var(--dsw-alias-label-primary)',
        },
      }, '📎'),
      h('input', {
        ref: fileInputRef,
        type: 'file',
        multiple: true,
        style: { display: 'none' },
        onChange: (event) => {
          void uploadFiles(event.target.files)
          event.target.value = ''
        },
      }),
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
          // While a picker is open, Enter picks instead of sending: typing "#"
          // and pressing Enter must not post a bare "#".
          if (mentionPicker !== null && mentionPicker.items.length > 0) {
            if (event.key === 'Enter') {
              event.preventDefault()
              pickMention(mentionPicker.items[0].name)
              return
            }
            if (event.key === 'Escape') {
              event.preventDefault()
              setMentionPicker(null)
              return
            }
          }
          if (atPicker !== null && atPicker.items.length > 0) {
            if (event.key === 'Enter') {
              event.preventDefault()
              pickEntry(atPicker.items[0])
              return
            }
            if (event.key === 'Escape') {
              event.preventDefault()
              setAtPicker(null)
              return
            }
          }
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
      h('input', {
        ref: avatarInputRef,
        type: 'file',
        accept: 'image/*',
        style: { display: 'none' },
        onChange: (event) => {
          void uploadAvatar(event.target.files?.[0])
          event.target.value = ''
        },
      }),
      picker && h(MemberPicker, {
        status,
        onClose: () => setPicker(false),
        onSaved: () => { setPicker(false); void refreshStatus(); void loadInitial() },
      })
      )
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist', id: 'group', order: 100, label: '群',
        }, GroupIcon))
        ctx.slots.inject('main', () => {
          const dispose = ctx.slots.register({ name: 'main', key: 'group' }, GroupPanel)
          // If the panel was open right before a reload, put the user back.
          try {
            const last = Number(localStorage.getItem('dsh-rooms:group-open') ?? 0)
            if (Date.now() - last < 60000) {
              setTimeout(() => {
                try {
                  ctx.layout.selectPanel('group')
                } catch {
                  /* layout not ready yet: leaving the default view is fine */
                }
              }, 300)
            }
          } catch {
            /* localStorage unavailable: skip the restore */
          }
          return dispose
        })
      },
    }
  },
})
