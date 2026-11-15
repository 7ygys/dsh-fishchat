# 清理清单

> 这个仓库会往「仓库外面」放三类东西。这个文件是它们的总账。
> **规则：每一类都有「在哪 / 怎么清 / 怎么验证清干净了」三行。**
> 新增任何往外写的东西，必须同时在这里加一行。

---

## 1. 探针插件 `dsh-rooms-probe`（临时的，MVP 开始后就不需要）

| | |
|---|---|
| 在哪 | profile `desktop` 的 bundle 清单 + `node_modules\dsh-rooms-probe`（本地目录安装是**链接**，不是拷贝） |
| 怎么清 | `plugin_manager` → `action: "remove_bundle"`, `target: "dsh-rooms-probe"`，**然后手动删 node_modules 里的 junction** |
| 怎么验证 | `list_bundles` 里没有它；`package.json` 里没有它；`node_modules\dsh-rooms-probe` 不存在 |
| 状态 | **已于 2026-11-10 21:59 清理完毕** |

> ⚠️ 踩过的坑：`remove_bundle` 只移掉 `package.json` 的依赖行，**`node_modules` 里的 junction 会留下**（指向已删除的源码目录）。
> 不删它就会变成一个悬空链接，`Test-Path` 为真但打不开。删法：
> ```powershell
> $link = "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\<包名>"
> (Get-Item $link).Delete()   # 对 Junction 用 Delete，不要 -Recurse
> ```
> 这个坑对**正式插件卸载**同样适用，记在这里。

---

## 2. 探针测试会话

探针会创建一个一次性会话（cwd 指向 `.probe\session-cwd`），它会出现在侧栏会话列表里。

| | |
|---|---|
| 在哪 | 会话存储（`~/.dsh\sessions\`），以及侧栏 |
| 怎么清 | 侧栏右键归档；或删掉对应会话目录（归档更安全，能撤销） |
| 怎么验证 | 侧栏会话列表里看不到它 |

**已产生的一次性会话 id 记在下面（实测时填）：**

| session id | 用途 | 状态 |
|---|---|---|
| `session-eab0b3d9-5570-4977-aa78-c3b798f16825` | 唤醒/排队/rpcId/端到端实验 | **待归档**（侧栏里标题是「只回两个字ok」，别被名字骗了） |

> 归档方式：侧栏右键归档，或在会话里 `/archive`（如果有这个命令），或等 MVP 的清理脚本。
> 注意它跑过 5 次模型回合，标题被自动改了。

---

## 3. `.probe\` 目录（命令文件 / 结果文件 / 测试用 cwd）

| | |
|---|---|
| 在哪 | `E:\Agent\DeepSeek Harness\大肥鱼工作区\群插件\.probe\` |
| 怎么清 | `Remove-Item -Recurse -Force .\群插件\.probe`（确认没有插件在引用它） |
| 怎么验证 | 目录不存在；`git status` 干净（它本来就被 gitignore 排除了） |

---

## 4. 群插件的运行时数据（**现在是真实数据，别删**）

| | |
|---|---|
| 在哪 | `~/.dsh\storages\rooms.json` |
| 怎么清 | ⚠️ 2026-11-11 起这是**用户和两条鱼的聊天记录**，不是测试数据。要清只能由用户决定：删文件即可，插件下次启动会重建空群 |
| 怎么验证 | 文件不存在；群面板里消息清空 |

---

## 5. 这个 git 仓库本身

| | |
|---|---|
| 在哪 | `E:\Agent\DeepSeek Harness\大肥鱼工作区\群插件\` |
| 怎么清 | **不用清**。这是正式源码，要留 |
| 怎么验证 | `git log` 能看到提交历史 |

---

## 检查一次的总命令

```powershell
# 1. bundle 还在不在
#    用 plugin_manager action:"list_bundles" 看，不在这里跑

# 2. 探针链接还在不在
Test-Path "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-rooms-probe"

# 3. profile 的 package.json 里还有没有它的依赖行
Select-String -Path "$env:USERPROFILE\.dsh\profiles\desktop\package.json" -Pattern "dsh-rooms-probe"

# 4. .probe 目录
Test-Path ".\群插件\.probe"

# 5. 群数据
Test-Path "$env:USERPROFILE\.dsh\storages\rooms.json"
```
