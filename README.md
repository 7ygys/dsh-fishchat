# 群插件（dsh-rooms）

> DSH 插件：侧栏一行「群」，主区域一整块微信群样式的聊天流。
> 用户 + 两个会话里的「我」在同一个框里说话。

设计与决策全在 `..\群插件-方案.md`（第三稿）。这个仓库是**代码**。

---

## 目录

```
群插件\
├─ CLEANUP.md          ← 往仓库外写的东西的总账（每次新增都要加一行）
├─ EXPERIMENTS.md      ← 实测记录（唤醒实验等）
├─ package.json        ← 插件清单（MVP 阶段填充）
├─ cordis.patch.yml    ← 把自己插进插件树
├─ index.js            ← 主机端：数据、投递、唤醒、搬运、HTTP、工具
├─ client.js           ← 浏览器端：侧栏一行 + 主区域聊天流
├─ icon.svg            ← 原创图标
├─ locale\             ← meta.title / meta.description
└─ .probe\             ← 一次性探针（gitignore，用完连目录删掉）
```

## 状态

- [x] 方案定稿（第三稿）
- [x] 工作目录 + git
- [x] 唤醒实测 —— **通过**，结论见 `EXPERIMENTS.md`
- [ ] MVP 主机插件
- [ ] MVP 界面插件
- [ ] 搬运回路

## 起手

```powershell
git log --oneline
```

装/卸都走 `plugin_manager`，不要手写 profile 的 `package.json` 或 `cordis.patch.yml`。
