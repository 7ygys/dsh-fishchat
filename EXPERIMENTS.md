# 实测记录

> 每条实验都要有：**怎么做的 / 看到了什么 / 因此改了什么**。
> 没测成的也写，写清为什么测不了。

---

## 实验 1 · 投一条消息，睡着的会话会不会开新回合

**2026-11-10 21:47 · 结论：会。方案最硬的那一环成立。**

### 怎么做的

1. 用探针 `create` 一个一次性会话：
   `session-eab0b3d9-5570-4977-aa78-c3b798f16825`，cwd 指向 `.probe\session-cwd`
2. 查状态：`cursor=2, active=true, running=false, agent=live/idle`
3. `sessionController.prompt({ requestId, sessionId, mode:"queue", content:[{type:"text",text:"只回两个字：ok"}] })`
4. 立刻查、3 秒后查、8 秒后查
5. 翻会话日志

### 看到了什么

| 时刻 | cursor | running | queue | agent |
|---|---|---|---|---|
| 投递前 | 2 | false | 0 | live/idle |
| 投递后立刻 | **5** | **true** | 0 | live/idle |
| +3s | 21 | false | 0 | live/idle |
| +8s | 21 | false | 0 | live/idle |

日志（seq 4→20）：

```
turn/start → step/start → system/message → user/message… → request/header
→ assistant/message "ok" → step/end → turn/end
```

### 结论

- **`accepted: true` 之后 `running` 立刻变 true，回合真的开了。**
- 提前排除的两种失败（被拒 / 身份错）确实没发生。
- **`state().running` 可以在投递后立刻观测到**，比"等 5 秒看 agent 冒不冒"更直接。
- 投递**不需要等 agent 出现**——它本来就在。

---

## 实验 2 · 同一个 requestId，被拒之后还能不能用

**21:48 · 结论：拒绝不污染 requestId。**

1. `prompt` 到一个不存在的会话 → 抛 `RemoteError: session "…" not found`（**不是静默接受**）
2. 用**同一个** `requestId` 投到有效会话 → `accepted: true`，正常开回合

顺带确认：投到不存在的会话会抛错，所以"选成员"时必须校验会话存在。

---

## 实验 3 · 鱼正忙的时候投递，会怎样

**21:48 · 结论：进队列，不丢，回合边界消费。**

1. 投"写 400 字介绍" → 投递后 `running=true`，`queue=1`
2. 300ms 后再投"只回 ok" → `queue=2`，两条都是 `placement: queued`
3. 12 秒后：`cursor=48, running=false, queue=0`，两条都处理完了

### 对方案的影响

**这条推翻了"必须自己攒 pending 落盘"的必要性。** 官方队列本身就是可靠的"攒着"，会一直返回。我原来设计的 `room.pending` 落盘 + 监听 `api-session/status` 是重复造轮子。

改成更简单的：**投之前查 `state().queue`，里面已经有我们没被消费的"群消息"指针就跳过**（它读到那一条时会 `room_read` 拿到全部最新消息）。这才是真正要的"合并"，省的是回合数，不是可靠性。

---

## 实验 4 · `rpcId` 在持久事件里还在不在

**21:52 · 结论：在。搬运可以精确认领回合。**

第一次读错了字段（`user/message` 的事件 data 就是消息本身，不是 `data.message`）。改对之后：

```
seq=8  role=user  sourceKind=user            rpcId=probe-1794318445592   ← 我们投的
seq=9  role=user  sourceKind=runtime-context rpcId=（空）                ← DSH 自己注入的
seq=10 role=user  sourceKind=skill-catalog   rpcId=（空）
seq=11 role=user  sourceKind=time-context    rpcId=（空）
```

**结论**：投进去的那条带 `source.rpcId`，而 DSH 注入的几条（runtime-context / skill-catalog / time-context）`sourceKind` 不同、没有 rpcId。

→ 搬运时用 `source.rpcId === 我们的 requestId` 认领回合**可行且精确**，还能顺手避开那三条注入消息。

---

## 实验 5 · agent 的生命周期（`create` 之后就有 agent？）

**21:52 · 结论：有。而且没法卸。**

- `create()` 返回的瞬间，`agents.get(sessionId)` 就是 `live/idle`，`state.active=true`
- 进程里 4 个会话的 agent 全是 live（除当前会话 running，其余 idle）——**会话常驻内存，不会因为空闲被回收**
- 给 agent 试 `dispose / stop / destroy / shutdown`：**一个都没有**，对象上没有卸载方法

Agent 原型上的全部方法（记下来，以后可能有用）：

```
send  followup  steer  inject  cancel  runMaintenance  wakeDriver  whenIdle
throwError  kick  preStep  toolsChanged  turn  step  prepareRequest  buildRequest
```

`wakeDriver` / `kick` 看名字是"踢驱动器"——如果哪天遇到"投递了但回合不开"，这是第一个可以试的兜底。

---

## 实验 6 · 重启之后、从没打开过的会话（**没测成**）

**结论：进程内无法模拟，留给"下次重启后第一次投递"验证。**

为什么测不了：
- `create()` 一返回就有 agent（实验 5），没有"创建了但没 agent"的状态；
- agent 没有卸载方法（`dispose` 等都不存在），卸不掉；
- 不能重启 DSH——用户正在用。

**间接证据（支持它能行）**：
- `prompt` 的官方描述就是「Admit one prompt after **explicitly resuming** its Session」
- 官方「定时任务」往**已存在的对话**投递，靠的正是这条路；它要是不能在冷会话上工作，这个功能就是废的
- 所有会话的持久化都在（`~\.dsh\sessions\`），`state()` 能冷读（实验 1 的投递前就是冷读 cursor=2）

**MVP 里的处置**：
- 投递前 `agents.get(sessionId)`：没有 → 记录 `state: "cold"`
- `prompt` 抛错 → 群里留一句「灯 没有响应」，不静默
- 如果冷启动真不行，兜底顺序：`prompt` 重试一次 → `agentLoop.resume()` 自拿句柄 → 群里报错

**重启后要做的第一件事**：打开群面板发一句不带 `#` 的话，看两条鱼是否都开回合。这条写进 `CLEANUP.md` 旁边……不对，写进这里就够。

---

## 实验 7 · 一套会话里都注入了什么（顺手发现）

投递一条消息后，会话里出现 3 条 DSH 自己注入的 user/message：

| sourceKind | 内容 |
|---|---|
| `runtime-context` | 当前工作目录等 |
| `skill-catalog` | 可用技能列表 |
| `time-context` | 时间采样 |

它们**没有 rpcId**，`sourceKind` 也不是 `user`。搬运时按 rpcId 认领就不会把它们当成群消息。

---

## 实验 8 · 端到端：没有界面，纯后端走通一整圈

**22:35 · 结论：通了。方案第 12 节"第三层验收"提前达成。**

**怎么做的**（全是 HTTP，没有界面）：

```
POST /rooms/r1/members  { members:[{sessionId:"session-eab0…", name:"测试鱼"}] }
POST /rooms/r1/say      { text:"#测试鱼 在吗？只回一句话：在。" }
等 12 秒
GET  /rooms/r1/messages
GET  /rooms/r1/status
```

**看到了什么**：

```
[1] 我(user):      #测试鱼 在吗？只回一句话：在。
[2] 测试鱼(agent): 在。
```

状态接口：

```
我       kind=user  unread=2
测试鱼   kind=agent running=false queued=0 unread=1
```

**证明的链条**：

1. 用户消息落盘（seq=1）
2. 1.5 秒窗口关闭 → 命中 `#测试鱼` → 投递指针
3. 测试鱼被唤醒、开回合、跑 `room_read`、正常回答
4. **搬运按 `source.rpcId` 找到自己的那一轮，把回答写回群里（seq=2）**
5. 状态接口能读出每个人的 running / queued / unread

**顺带验证的两件**：

- 插件注册的 `/rooms` 路由**不需要 token**（`GET /` 返回 401，但 `/rooms/…` 返回 200）——说明 401 是 SPA 静态服务的准入，不是全局闸门。浏览器同源 fetch 更没有障碍。
- 三个工具的守卫正确：在群里之外的会话调用 `room_read` 会拿到「你不在任何群里」，不是异常。

**测试数据已清理**：删了 `~\.dsh\storages\rooms.json` 并重载插件。`CLEANUP.md` 第 4 条记了这个文件。

---

## 实验 9 · 整改后：点名、鱼叫鱼、自点名

**2026-11-11 · 结论：三条链路都通，但抓到一个自点名的洞。**

### 9.1 改名（P0）

成员名从会话标题改成短名，并且**游标没被重置**：

```
改名前：本地模型部署与日记人设约 / 散樱乱武游戏开发现状   unread=0
改名后：灯 / 散樱                                     unread=0
```

> 改名的实现坑：原来的 `POST /members` 会把 `lastReadSeq` 重置成 0，改名等于让鱼重读全部历史。改成保留原值。

### 9.2 点名只叫一个人（P0）

发 `#灯 门铃测试…`，6 秒后：

```
灯    running=true
散樱  running=false   ← 没被叫
```

只有被点名的那条开了回合。

### 9.3 鱼叫鱼（P0，实测）

指令让灯用 `room_say` 发一条 `#散樱 …`。结果：

```
[10] 我(user):    #灯 门铃测试，两件事…
[11] 灯(agent):   到
[12] 灯(agent):   #散樱 门铃响了      ← room_say 发的
[13] 散樱(agent): 到                  ← 被叫醒了！
[14] 散樱(agent): #散樱 门铃响了
```

**agent → agent 的投递真的通了**：灯那条 `#散樱` 把散樱叫起来了，散樱的回答也搬回了群。

### 9.4 抓到的洞：自点名

seq=14 是散樱发了一条 `#散樱 …`——**点的是它自己**。原实现的 `deliverAgentMessage` 不区分发送者，会给它自己再投一次，等于自己叫自己开下个回合。

**已修**：`member.name !== message.from`。

### 9.5 一个不是 bug 的现象

散樱把灯那条指令里的内容（`#散樱 门铃响了`）**当成了自己的任务又做了一遍**（seq=14）。

这不是投递的错，是「鱼读到了别的鱼的指令文本，当成对自己说的」。指针里现在带上了 `- 灯：#散樱 门铃响了` 这样的预览，能缓解但不能根治。记在这里，以后如果频繁发生，考虑在指针里加一句「上面是别人的话，不是给你的指令」。

### 9.6 没有实测到的

- **指针预览的实际观感**：我看不到灯会话里的那条指针（没有跨会话读取的工具）。只能从"它照做了"推断预览到了。
- **大静默开关**：API 层验过（`muteAgentToAgent` 能开能关），但没有在"鱼要叫鱼"的时刻验证它真的拦住了。留给下次。

---

## 实验 10 · 把自己拉进群，让三条鱼一起改插件

**2026-11-12 · 结论：这是最有效的一轮验收。她们报的问题比我自查到的多。**

用户把我（这个做插件的会话）加成群里第四个成员，署名「插件制作员」。于是我一边改代码，一边以群员身份跟另外两条鱼对话。

### 10.1 她们报的问题

| 谁报的 | 问题 | 根因 |
|---|---|---|
| 灯后、灯前 | 游标失效：`room_read` 永远说"没有新消息"，但指针照响 | 我清测试消息时把 `seq` 从 27 退回 25，没重置成员的 `lastReadSeq`。新消息 seq 比游标小，全被当成旧消息 |
| 灯后、灯前 | `room_read(before=…)` 报 `value is not lossless JSON` | `before` 分支里 `truncatedBefore` 可能是 `undefined`；其它分支都用展开语法绕开了，只有这条漏了 |
| 灯后 | 指针把正文整段塞进去 | 我给了 5 条 × 20 字预览，长消息时确实太多 |
| 灯前 | 有没有 `self.name`？靠猜名字 | 成员的"名字"没有以字段形式回到它手上 |

### 10.2 修法

- `room_read` 发现游标超过 `db.seq` → 自动重置 + 明确告知（`cursorReset`），不再静默。
- 工具出参统一递归剔除 `undefined`（`withCleanResult`），不再指望每个分支记得。
- 指针压缩成"一条预览 + 30 字 + 总字数"。
- 每次 `room_read` 末尾带「你在群里叫「X」」。
- 改名插一条系统公告（不唤醒任何人）。
- 红点在"正在看群"时隐藏。

### 10.3 她们提的设计建议 → 用户的裁决

| 建议 | 用户裁决 |
|---|---|
| 默认只醒"当班"一条，会话粘性 + 超时轮换 | **不用**。改成成员上的【活跃】勾选框，勾着=都醒，不勾=只有 `#` 才醒 |
| 成员加 `wakeOn: always \| mention-only` | 采纳，落成【活跃】勾选框，新成员默认勾选 |
| 链式深度最多 1 | **不做**，靠大静默 |
| ack 时自动移交下一条 | 采纳（只移交一次，防止来回踢） |
| 开 `#讨论` 模式 | **不开** |

### 10.4 实测

取消灯后和我的【活跃】，只留灯前，发一条不带 `#` 的消息：

```
灯后: running=False   ← 没被叫
灯前: running=True    ← 只有它醒
lastAck = { member: 灯前, seq: 53 }   ← 它按了 room_ack，不是没收到
```

### 10.5 她们留下的话（值得记住）

- 灯前：*「漏听闲聊的代价很低，历史还在；反过来，一条『在吗』把我这个堆着几十个文件的会话叫醒，那才是真浪费。」*
- 灯后：*「指针是门铃，不是信件。」*
- 灯后：*「报错信息是『返回了非法 JSON』，而不是『truncatedBefore 是 undefined』，中间隔了两层，找起来才这么绕。」*
- 灯前：*「我没有 `self.name`——我的名字不是我的属性，是别人怎么签我。」*

### 10.6 仍然没解决的

- **指针污染上下文**：每条指针是 `user` 消息，永久留在鱼的历史里。用户决定接受。
- **信息差不收敛**：三个独立上下文，靠指针和 `room_read` 拼共同认知。用户接受（会区分工作/聊天会话）。
- **可观测性弱**：投递失败、搬运错，界面看不到，只有 warn 日志。用户说等完善界面时再说。
- **不活跃成员的可见性**：用户确认"每条消息每个 agent 都能看到，只是回不回自己判断"——现状已满足（游标不动，`room_read` 能拿到全部积压），没有代码改动。

---

## 实验 11 · 换信封：指针能不能不以 `user` 身份进入会话

**2026-11-13 · 结论：不能。两条路都试过了，都堵。**

灯后/灯前追问过两次的问题：指针冒充 `user` 进上下文、永久占位，能不能换成 `system` 或带 `source`。

### 试法

临时加了一个 `/rooms/r1/_probe` 路由（测完已删），建了个一次性会话
`session-25e5f1a5-1a69-4ca3-a7be-fbb14c6254c7`，跑了三个变体：

| 变体 | 做法 | 返回 | 日志里实际落下的 |
|---|---|---|---|
| `role` | `prompt({content:[{type:'text', text, role:'system'}]})` | `ok: true` | `role=user, source=user` —— **字段被静默忽略** |
| `source` | `prompt({content:[{type:'text', text, source:{kind:'room'}}]})` | `ok: true` | `role=user, source=user` —— **同上** |
| `followup` | `agent.followup({role:'developer', content, source})` | `ok: true` | **整条没落盘**，日志里找不到 |

### 为什么这条比"报错"更坏

三条都**不报错**。`prompt` 会把不认识的字段悄悄扔掉，返回成功——调用方会以为换了信封，其实没有。
这正是灯后说的那种"看不出是坏了"。

### 结论（可以结案）

- **`session/prompt` 不支持改投递身份**（已验证：字段被丢）。
- **`agent.followup` 走 developer 角色不落盘**（已验证：消息消失）。
- 剩下的可能只有"surface replace"（把已写入的指针从历史里替换掉），那是另一套机制，没试，风险更高。

**所以指针继续是 `user` 消息。** 这是可以写进"已定"的一栏：不是没试，是试了不通。



---

## 实验 12 · 多群隔离修复、人数上限与投递窗口（2026-11-19）

**结论：跨群漏传、投递窗口串群、删除复活都修了；每群上限定为 9 条鱼。**

### 12.1 修了什么

| 问题 | 修法 |
|---|---|
| `recoverRoomInflight` 只查 r1 成员 | 改成 `agentMembers(roomId)` |
| `room_read` 游标重置用了 r1 的消息 | 改成 `messages(roomId)` + `roomEarliest(roomId)` |
| `sweepQueued` 只扫 r1 | 遍历所有房间 |
| `mergeDiskBeforeWrite` 只合并 r1 | 按房间合并，并接住另一个窗口新建的群 |
| `earliestSeq` 全局一份 | 每群一份，旧全局字段保留做迁移 |
| 投递窗口全局单例 | `windows: Map<roomId, {timer, fromSeq, openedAt}>`，删群时清掉 |

### 12.2 验证

- **人数**：一次提交 10 个成员 → 保存 9 个；状态接口返回 1 个用户 + 9 条鱼
- **窗口**：临时探针观察两个群交叉发言——两群各自有窗口（fromSeq 263 / 264），3 秒后各自清零；探针测完已删
- **删除**：建测试群再删，`/rooms` 和 `rooms.json` 里都不再出现（删除墓碑生效）

### 12.3 还没验证的

- 多窗口同时写盘的合并（需要第二个 DSH 窗口）
- 非 r1 群跑到一半重载的 inflight 恢复（需要真实跨群回合中断）
