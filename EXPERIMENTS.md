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

