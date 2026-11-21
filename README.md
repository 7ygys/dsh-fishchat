# 群插件（dsh-fishchat）

[![npm version](https://img.shields.io/npm/v/dsh-fishchat)](https://www.npmjs.com/package/dsh-fishchat)
[![license](https://img.shields.io/npm/l/dsh-fishchat)](LICENSE)
[![GitHub](https://img.shields.io/badge/GitHub-7ygys%2Fdsh-fishchat-181717?logo=github)](https://github.com/7ygys/dsh-fishchat)

> DSH 插件：侧栏一行「群」，主区域一整块微信群样式的聊天流。
> 用户 + 群里的几条「鱼」（DSH 会话）在同一个框里说话。

设计与早期决策见开发工作区的 `群插件-方案.md`（不随包发布）。
这个仓库是**代码**。

## 安装

已发布到 npm：`dsh-fishchat`（MIT）。

在 DSH 里：

```
plugin_manager install_bundle  target: "dsh-fishchat"
```

或者直接：

```sh
pnpm add dsh-fishchat
```

装完在 DSH 插件页启用 `dsh-fishchat`。数据写在 `$DSH_HOME/storages/rooms.json`（默认 `~/.dsh/storages/`），卸载插件不会删它。

## 这个插件在 DSH 生态里的位置

- **npm 包**：[dsh-fishchat](https://www.npmjs.com/package/dsh-fishchat)（无 scope，可直接安装）
- **发布方式**：`npm publish`（staged publishing，首次发布需在 npm 的 Staged Packages 页面批准）
- **npm keywords**：`dsh-plugin`、`dsh-bundle`、`deepseek-harness`、`group-chat`、`rooms`
- **GitHub topics**：`dsh-plugin`、`deepseek-harness`、`dsh`
- **社区目录**：待收录到 [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)（提交 `data/plugins/7ygys__dsh-fishchat.yml` 一个 PR）
- **市场索引**：收录后可通过 `dsh-plugin-catalog` 的索引在市场里搜到

## 目录

```
群插件\
├─ package.json        ← 插件清单（npm 发布配置）
├─ cordis.patch.yml    ← 把自己插进插件树
├─ index.js            ← 主机端：数据、投递、唤醒、搬运、HTTP、工具
├─ client.js           ← 浏览器端：侧栏一行 + 主区域聊天流
├─ icon.svg            ← 图标（DSH 鲸鱼阴阳构图）
├─ docs\               ← 插件详情页（DETAIL.md + preview.svg）
├─ locale\             ← meta.title / meta.description / meta.detail
├─ LICENSE             ← MIT
├─ CLEANUP.md          ← 开发用，不发布
├─ EXPERIMENTS.md      ← 开发用，不发布
├─ fix-link.cmd        ← 本地 link 修复脚本，开发用，不发布
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
- [x] 发布 npm `dsh-fishchat@1.0.0`

## 当前约束

- 每个群最多 **9 条鱼**（主机和成员弹窗同时限制）
- 群历史保留 7 天
- 群消息进鱼上下文只有短指针；全文由鱼自己调 `room_read`

## 起手

```sh
git log --oneline
```

装 / 卸都走 `plugin_manager`，不要手写 profile 的 `package.json` 或 `cordis.patch.yml`。
