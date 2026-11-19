# 群插件（dsh-fishchat）

> DSH 插件：侧栏一行「群」，主区域一整块微信群样式的聊天流。
> 用户 + 群里的几条「鱼」（DSH 会话）在同一个框里说话。

设计与早期决策在 `..\群插件-方案.md`（第三稿，末尾有实现补充）。
这个仓库是**代码**。

---

## 目录

```
群插件\
├─ CLEANUP.md          ← 往仓库外写的东西的总账（每次新增都要加一行）
├─ EXPERIMENTS.md      ← 实测记录
├─ package.json        ← 插件清单
├─ cordis.patch.yml    ← 把自己插进插件树
├─ index.js            ← 主机端：数据、投递、唤醒、搬运、HTTP、工具
├─ client.js           ← 浏览器端：侧栏一行 + 主区域聊天流
├─ icon.svg            ← 图标（DSH 鲸鱼阴阳构图）
├─ fix-link.cmd        ← 重建 profile 里的 junction（pnpm install 弄坏时用）
├─ locale\             ← meta.title / meta.description
└─ .probe\             ← 一次性探针（gitignore）
```

## 状态

- [x] 方案定稿（第三稿）
- [x] 唤醒实测（`EXPERIMENTS.md` 实验 1~9）
- [x] MVP 主机插件：数据、单写者、投递窗口、忙时排队、HTTP、三个工具
- [x] MVP 界面插件：侧栏一行 + 主区域聊天流
- [x] 搬运回路：按 `source.rpcId` 认领回合
- [x] 多群：群列表、新建 / 删除 / 切换，数据按群隔离
- [x] 消息增强：引用、`@` 文件引用（带 base 校验）、附件上传、长消息落盘
- [x] 界面增强：头像、背景、主题、字号、笔记侧栏
- [x] 可靠性：wakeLog 账本、每群 earliestSeq、投递窗口按群、删除墓碑、inflight 恢复
- [x] 图标：DSH 鲸鱼阴阳构图（插件图标 + 侧栏同一张图）

## 当前约束

- 每个群最多 **9 条鱼**（主机和成员弹窗同时限制）
- 群历史保留 7 天
- 群消息进鱼上下文只有短指针；全文由鱼自己调 `room_read`

## 起手

```powershell
git log --oneline
```

装 / 卸都走 `plugin_manager`，不要手写 profile 的 `package.json` 或 `cordis.patch.yml`。
