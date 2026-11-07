# dsh-rescue-guard · 启动救援与自我修复

**DSH 起不来的时候，能救回来。**

本插件由这台机器上的 **21 份真实崩溃日志**反推而来，不是凭空设计。每一条防护都对应一次
真实事故。

---

## 先说清楚一个矛盾（这决定了两半的分工）

插件是**被启动过程加载**的。所以：

> 如果崩溃发生在插件加载阶段，救援插件自己也加载不了。

这不是推测。实测 21 份日志里，**12 份的崩溃点就在插件加载中**：

| 崩溃原因 | 次数 | 崩在哪 |
|---|---|---|
| `ENOENT` 读缺失文件（插件构造时抛出） | 8 | **插件加载中** |
| `command "rules" is already registered` | 2 | **插件加载中** |
| `1 entry did not activate` | 2 | **插件加载中** |
| `desktop welcome: Web authentication failed` | 8 | 启动握手 |
| `renderer exited: killed` | 1 | 运行中 |

所以本插件分成两半，**职责不同**：

| 组件 | 何时工作 | 干什么 |
|---|---|---|
| **独立 CLI `dsh-rescue`** | DSH 起不来时 | **真救援**：不依赖 DSH，禁用可疑 bundle、回滚清单、布防安全模式 |
| **启动前预检** | DSH 正常时 | **预防**：在启动前就发现命令名冲突、缺失文件 |
| **面板 UI** | DSH 正常时 | 看诊断、一键布防、管理快照 |

---

## 独立 CLI（核心）

DSH 起不来时用这个。它只用 Node 内置模块，不需要 DSH。

```bat
:: 双击运行，或从命令行
D:\deepseek-workspaces\work\dsh-rescue-guard\bin\dsh-rescue.cmd diagnose
```

`dsh-rescue.cmd` 会自动探测 Node 运行时（本机 Node 不在 PATH，DSH 自带一份）。

```
dsh-rescue diagnose                 看崩溃原因 + 预检 + 给建议（先跑这个）
dsh-rescue crashes [--limit N]      只列归类后的崩溃历史
dsh-rescue scan                     只跑启动前静态预检
dsh-rescue safe-mode status|on|off  安全模式
dsh-rescue snapshot create|list|restore <id>
dsh-rescue disable <bundle>         把某个 bundle 移出启动列表
dsh-rescue enable <bundle>          加回启动列表

--profile <dir>  配置目录（默认 ~/.dsh/profiles/desktop）
--home <dir>     DSH_HOME
--json           以 JSON 输出
```

### 典型救援流程

```bat
:: 1. 先看是什么原因
dsh-rescue diagnose

:: 2. 布防安全模式：下次启动只加载官方 bundle
dsh-rescue safe-mode on

:: 3. 启动 DSH。能起来了 -> 面板会自动还原第三方 bundle
::    还起不来 -> 说明不是第三方插件的问题，看诊断里的 web_auth 建议

:: 4. 想定位到具体是哪个插件：逐个加回
dsh-rescue enable dsh-ops
```

---

## 启动前预检（预防）

在 DSH 还正常的时候跑，提前发现会让下次启动崩掉的问题。

| 检查 | 对应真实事故 |
|---|---|
| **命令名冲突** | `dsh-permission-rules` 与 `dsh-purge` 都注册 `/rules`，重复注册抛错 → `apply()` 中断 → **宿主停止**（发生 2 次） |
| **构造期读取的文件缺失** | 插件 `apply()` 里 `readFileSync` 一个更新尚未落地的文件 → 抛出 → **启动即死**（发生 8 次） |
| **可能遮蔽根路由的注册** | `prefix` 路由挂在 `/` 会拦掉桌面端握手，导致 `Web authentication failed`（发生 8 次） |

> 预检是**启发式静态分析，不是证明**。命中的问题值得查；没命中不代表没问题。
> UI 与 CLI 都会把这句话显示出来。

---

## 安全模式

布防后，**下次启动只加载 `@deepseek-ai/*` 官方 bundle**，第三方全部暂时移出；启动成功后
自动还原。

几条硬约束：

- **绝不触碰 `@deepseek-ai/*`**（有专门测试）
- 改写清单前**先自动快照**，回滚也可回滚
- 原子写（`.tmp` + rename），不会留下半截文件
- 幂等：重复布防/应用/还原都不会损坏清单

---

## 快照

每次启动保留一份配置快照（`package.json` / `pnpm-workspace.yaml` / `rules.yaml`），
存于 `<profile>/.rescue/snapshots/`，默认保留最近 10 份。

清单被写坏时：

```bat
dsh-rescue snapshot list
dsh-rescue snapshot restore 2026-11-07T13-35-29.164Z
```

---

## 面板

DSH 正常时，面板显示：上次启动是否正常、崩溃历史归类、预检结果、安全模式开关、
快照管理与回滚。底部固定给出一行可复制的救援命令。

---

## 与已有插件的关系（避免装重复）

生态里这个方向已经有不少插件。以下是对照，装之前可以先看看：

| 插件 | 它做什么 | 与本插件的关系 |
|---|---|---|
| `dsh-plugin-ops` | 10 条**完全静态**的预检规则 + 面板：bundle 声明完整性、依赖漂移、peer 缺口、patch 行解析、结构完整性、版本兼容、`minimumReleaseAgeExclude` 语法、重复物理副本 | **互补**。它不检测命令名注册冲突 —— 而那正是本机真实导致 2 次宿主崩溃的原因 |
| `dsh-fix` | 独立（不依赖 DSH）的启动故障诊断与修复工具 | **重叠**：独立 CLI + 修复启动故障。差别在本插件把「命令名冲突预检」和「崩溃日志六类归类」做成了明确能力 |
| `@perrylink/dsh-plugin-doctor` | 面向**插件作者**的包结构与沙箱冒烟检测 | 不同受众：它校验一个插件包是否合格，本插件诊断一个坏掉的 profile |
| `dsh-checkpoint-rewind` / `dsh-time-machine` / `@xiaoyuyu6420/dsh-backup` | 配置与会话快照、备份、回滚 | **重叠**：快照能力。本插件的快照只服务于救援（清单级、每次启动一份） |
| `@noob-stupid/dsh-plugin-console` | 升级门控：旧插件不适配自动禁用 | **相邻**：它管升级后禁用，本插件管启动崩溃后禁用 |

### 本插件真正独有的两点

1. **命令名注册冲突的静态预检**。生态里没有其它插件做这件事，而它在本机真实发生过 2 次：
   `dsh-permission-rules` 与 `dsh-purge` 都注册 `/rules`，重复注册抛错 → `dsh-purge` 的
   `apply()` 中断 → **宿主停止**。本插件的预检能在启动前就报出来。
2. **崩溃日志的六类归因**，并把「缺失文件路径」「冲突的命令名」抽出来。
   归类本身不出奇，但它是从本机 21 份真实日志反推的，能直接对上历史事故。

> 如果你的需求是**依赖/peer/版本兼容**类预检，`dsh-plugin-ops` 比本插件成熟得多，建议装它；
> 本插件的价值集中在**命令冲突**与**独立救援 CLI**这两点上。

---

## 它不能做什么

- **不能救插件加载期就死掉的启动**（那是 12/21 的情况）——这正是必须有独立 CLI 的原因
- **不做安全审计**
- **不自动删任何东西**：只禁用（可还原），不删除
- 修复不了 DSH 应用本身的问题（如 `renderer exited: killed` 这类进程被杀）

### 预检的已知盲区（如实声明）

- **命令冲突的检出以 `package.json` 声明为准**（bundles + dependencies）。一个插件若被从
  声明里删掉、只剩 `node_modules` 里的物理残留，扫描会漏报——彻底扫 `node_modules` 会引入
  卸载残留的噪声，这是取舍后的选择。命中项带 `active` 字段，可区分「已启用 bundle」与
  「仅安装未启用」。
- 动态构造的 `readFileSync` 路径无法静态解析（按 bundle 聚合为附注，不计入缺失清单）。

---

## 崩溃守护（平时零占用，出事即自检）

面板里可一键安装**开机自启的守护进程**（写入用户「启动」文件夹，卸载即删）。

工作方式（**事件驱动，不是轮询**）：

- 主触发是**操作系统推送**的目录变更事件（Windows 上是内核级的
  ReadDirectoryChangesW）：进程平时睡眠，**空闲零 CPU、零唤醒，不耗电**
- 出现新崩溃日志 → 系统通知进程 → 2 秒防抖合并同一次崩溃的多个写入事件 → 生成报告
- 一条 10 分钟一次的兜底扫描只防两类极端丢事件（目录在挂接后才创建/被整体替换），
  平时不是它干活
- 报告 `<profile>/.rescue/last-crash-report.txt`：本次错误原文、历史归类、启动前预检
  结果（命令冲突/缺失文件）、「立即可做的事」
- 报告**每次覆盖**，不累积历史 —— 崩溃一千次也只有一份文件 + 一个状态 JSON

单实例锁保证不会出现两个守护进程；守护进程自身崩溃也不影响手动 CLI。

---

## 安装与生效

安装后**需要重启宿主**，路由与面板才会出现（插件在启动时加载；装完不重启，`/dsh-rescue/*.json` 会是 404 —— 这是本机实测过的正常行为，不是故障）。

## 安装

```bash
dsh plugin add dsh-rescue-guard
```

CLI 在项目目录的 `bin/dsh-rescue.cmd`。建议记下这个路径，DSH 崩了就用它。

## 许可

MIT
