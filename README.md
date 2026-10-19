# dsh-project-memory

一句话定位：给 DSH 装一道收尾守卫 —— 会话动过手却没在 `.dsh/memory/` 下写东西时，在收尾阶段拦一次，用 `agent.steer()` 塞一条理由，强制模型再跑一轮去补写项目记忆。

## 解决的问题

在 DSH 里，"模型记得写项目记忆"只能靠自觉，写了是运气，不写也没人管。本插件把这件事变成硬保证：动过手 → 必须有记忆落盘 → 否则不放行。

## 运行流程

三个挂点全是 DSH 原生扩展点，不依赖 hooks 桥、不起子进程：

1. **`agent/created`（会话开始）**：建状态文件 `<DSH_HOME>/project-memory/state/<session_id>.json`，记下本周期起点 `cycleStart`（`DSH_HOME` 未设置时取 `~/.dsh`）；若 `reminder: true`，用 `agent.inject()` 注入三行提醒（约 100 tokens）。
2. **`tools/post-execute`（每次工具跑完）**：只记账，**恒走 `next()`**，绝不阻塞工具。`write` / `edit` / `str_replace_editor` 记 `fileWrites + 1`；`pwsh` / `bash` / `run_code` / `shell` 记 `shellCalls + 1`；其它工具不记。
3. **`agent/turn-stopping`（模型要收尾）**：判定，不放行就 `agent.steer()` 一条中文理由，让模型再跑一轮。

## 判定规则

- 没有状态 / 从未动过手 → 放行
- 证据不足（`fileWrites < 1` 且 `shellCalls < 2`）→ 放行（一条 `git log` 这种纯查证不该被拦）
- `<项目根>/.dsh/memory/` 下任一 `*.md` 的 mtime ≥ 本周期起点 → 视为已写：放行，并开启新周期（计数清零）
- 每个周期最多拦 `maxBlocksPerCycle`（默认 1）次；全会话最多拦 `maxBlocksTotal`（默认 6）次
- **为什么必须自限次**：拦截会触发 `agent.steer()` 再来一轮；DSH 的 `stop_hook_active` 恒为 `false`，也没有连击上限，无条件阻塞会无限续轮
- 判定只看 mtime，不看工具名 —— 用 `write`、用 shell 的 `>>`、还是跑 `append_memory.py`，写进 `.dsh/memory/` 都算数

## 项目根如何确定

从会话 cwd 逐级向上找最近的 `.git`，找到就用那一级；一路到盘根都没有就用 cwd 本身。**故意不认 `.dsh` 标记**：`~/.dsh` 是 DSH 自己的 home，认了会把用户主目录当成项目根。

## 仓库结构

```
src/index.js          宿主侧插件（export name / Config / apply），只做接线
src/guard.js          判定核心：纯函数、零宿主 import，可裸 node 单测
test/guard.test.mjs   11 个用例（node test/guard.test.mjs）
skills/project-memory/  给模型看的规范 + 只追加写入器 append_memory.py
hooks/                降级路线：hooks.json 模板 + memory_guard.py
cordis.patch.yml      bundle 层：把本插件 insert 进宿主树
install.ps1           两条安装路线，带备份、幂等、-DryRun
```

## 安装

**本包没有发布到 npm，只能从仓库本地安装。** 整体是「克隆 → 跑脚本 → 重启 DSH」。

```powershell
git clone https://github.com/HaoDuoYv/dsh-project-memory.git
cd dsh-project-memory
```

然后二选一（**不要两条都装**，见「已知限制」）。

### 路线 1：钩子路线（不需要把包装进 profile 依赖，最快）

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 -Route hooks
```

它会做三件事：把技能复制到 `%DSH_HOME%\skills\project-memory`；把 `hooks/hooks.json` 里的 `{{PYTHON}}` / `{{GUARD}}` 占位符换成真实绝对路径后落到 `%DSH_HOME%\hooks.json`；把 `@deepseek-ai/dsh-hooks-claude-code` 钩子桥 insert 进 profile 补丁。改动前都会先备份。

代价：每次命中工具调用要起一个 python 进程。

### 路线 2：插件路线（无子进程，需要把包装进 profile）

```powershell
# 注意 file: 后面是本机绝对路径，用正斜杠
dsh plugin --profile desktop add file:C:/Users/Administrator/Desktop/micis/dsh-project-memory
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1
```

再把 `"dsh-project-memory"` 加进 `%USERPROFILE%\.dsh\profiles\desktop\package.json` 的 `dsh.profile.bundles` 数组。包自带的 `cordis.patch.yml` 会自动插入插件行。

### 最后一步：重启 DSH

两条路线都要重启（profile 补丁只在启动时读一次）。技能正文改动不需要重启。

`-ExecutionPolicy Bypass` 是因为 install.ps1 不在受信任签名白名单里；脚本本身自带 UTF-8 BOM，PS 5.1 才能正确解码中文。加 `-DryRun` 可以先看它要做什么，不写任何文件。

### 附：手工 insert（不想跑脚本时）

在 `%USERPROFILE%\.dsh\profiles\desktop\cordis.patch.yml` 末尾追加：

```yaml
- insert:
    - id: project-memory
      name: "dsh-project-memory"
      config:
        memoryDir: .dsh/memory
        maxBlocksPerCycle: 1
        maxBlocksTotal: 6
```

然后重启 DSH。注意：**profile 补丁没有"直接写一行就新增插件"的语义**，漏掉 `- insert:` 外壳会报 `patch: entry not found` 并被静默跳过。

## 配置项

| 名称 | 默认值 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关；`false` 时 `apply()` 直接返回，不注册任何监听器 |
| `memoryDir` | `".dsh/memory"` | 记忆目录，相对项目根 |
| `maxBlocksPerCycle` | `1` | 每个「工作 → 收尾」周期最多拦几次 |
| `maxBlocksTotal` | `6` | 全会话拦截硬上限 |
| `reminder` | `true` | 会话开始时注入三行提醒（约 100 tokens） |
| `stateTtlDays` | `7` | 状态文件保留天数，超过的在下次会话开始时清理 |

## 技能与脚本

- `skills/project-memory/SKILL.md`：给模型看的记忆规范，记忆分四层（当日日志 / `MEMORY.md` / `PLAYBOOK.md` / 用户级），配 `references/examples.md`。
- `skills/project-memory/scripts/append_memory.py`：只追加、拒绝疑似密钥、同名标题去重的写入器，纯 Python 3 标准库。
- 技能文件复制到 `~/.dsh/skills/project-memory` 时同样可用（技能正文改动立即生效，不需重启）。

## 已验证 / 未验证

已验证：

- `node --check src/index.js src/guard.js` 通过
- `node test/guard.test.mjs` 11/11 通过（**不能**用 `node --test <dir>`：本机沙箱下子进程 spawn 会 EPERM，直接跑测试文件即可）

未验证：

- 插件尚未在真实 DSH 进程里挂载启动过（需要重启 DSH），所以"宿主侧三个监听器真的被调用"目前只有代码依据，没有运行时证据。

挂载后的自检方法：

1. 改一个文件，然后结束回合 —— 应当收到一次中文拦截理由。
2. 看 DSH 日志里有没有以 `project-memory:` 开头的 warn（状态目录不可写、记账失败、判定失败都走这条）。

## 已知限制

- 状态目录固定 `<DSH_HOME>/project-memory/state`，与 C 路线 `memory-guard` 的目录不同 → **两条路线不要同时装**，否则各自计数、可能拦两次。
- 只认上列 5 类工具名；自定义工具改了文件不会被计入证据。
- 依赖 `@deepseek-ai/dsh-llm` 的 `createUserMessage` 与 `@deepseek-ai/schemastery`，两者都是宿主提供的 peerDependency，不随包发布。
- `dshTarget` 标的是 `0.2.0-rc.2`，DSH 演进后扩展点签名可能变。
- 项目根只看 `.git`；无 `.git` 的目录用会话 cwd。

## 自测命令

```powershell
cd dsh-project-memory
node --check src/index.js
node --check src/guard.js
node test/guard.test.mjs
```

（本仓库的作者机器用 DSH 自带的 node；你自己的 node ≥ 18 即可。）

## 许可

MIT，全文见 `LICENSE`（`package.json` 的 `license` 字段同为 MIT）。
