# 更新日志

本项目的所有重要变更都记录在此文件。

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循[语义化版本](https://semver.org/lang/zh-CN/)。

## [0.6.3] - 2026-11-21

### 修复

- **预设体检不再只认内置四个**：可判定集合改为「内置 ∪ profile patch ∪ 已启用 bundle 的
  `cordis.patch.yml` 里声明的预设」。上一版会把插件正常登记的自定义档（如 `forge` / `qianyu`）
  误判为悬空，并可能把用户正在用的档改写掉。现在只认「声明来源真的没了」。
- **`default` 指针也纳入体检与修复**：原先只处理 `selectedDefault`，当 `default` 指向已消失的 id 时，
  未显式选择预设的新会话仍会失败。现在两个键都体检，只修悬空的那个。
- **修复目标改为通用推导**：仍有效的 `default` → 配置里的 `preset.fallback` → 内置兜底，
  不再固定写 `ptc`。
- 面板与 CLI 文案同步改为「已不再被任何插件声明」，不再说「不是内置预设」。

### 测试

- `test/regression.mjs`：**156 项**。新增 `[22]` 六条：bundle 声明被发现 / 声明的自定义档不误判 /
  声明消失后立即判悬空并列出要修的键 / 只改悬空键 / 会话逐帧改写 / `default` 自身悬空。

## [0.6.2] - 2026-11-16

### 新增

- **救援台菜单 `[p] 恢复缺失预设为 PTC`**：不再只修 `ops-ptc`，任何被删除/禁用插件留下的
  自定义预设引用都可一键恢复为内置 `ptc`。确认后执行
  `dsh-rescue preset --fix --rewrite-sessions --to ptc`：修 patch 指针、逐帧改会话、同步投影缓存；
  DSH 仍在运行时拒绝改写会话，回答 N 不执行任何操作。

### 修复

- **会话中途切换过预设时只修了创建时的 id**：例如首帧是 `custom-alpha`、后续
  `agent-preset/selected` 事件是 `custom-beta`，旧逻辑只改 `custom-alpha`。现在一次修复会处理
  本次扫描到的全部自定义 id，所有帧都不再有残留（由真实桌面菜单端到端测试抓到）。
- **批量修复时同名会话日志的备份互相覆盖**：所有会话文件都叫 `session.v4.jsonl.zstd`，
  共享备份目录原先只按文件名命名，N 个会话只剩最后一份备份。现在备份名带 session-id 目录，
  每个会话都能独立回滚。

### 测试

- `test/regression.mjs`：**150 项**（含真实桌面菜单 `p → Y` 端到端：两种自定义预设、
  全部帧、投影缓存、独立备份、修复后复检）。

## [0.6.1] - 2026-11-16

### 修复

- **桌面「DSH救援台」双击后立即退出（exit 4）**：生成脚本在 `if not defined SCRIPT (...)`
  块里输出了一句带 `(or: dsh-rescue menu)` 的帮助文本，未转义的 `)` 被 cmd.exe 当成
  块结束符，后面的 `exit /b 4` 因此无条件执行。帮助文本改为不含括号的形式。
  该问题只影响 0.6.0 新生成的桌面入口；旧的 `rescue-console.cmd` 与直接运行 CLI 正常。
- 回归测试不再只检查 .cmd 文本：新增一条**真实调用 cmd.exe 启动桌面入口、显示菜单、
  输入 0 退出**的端到端用例（旧脚本会 exit 4，新脚本 exit 0）。

### 测试

- `test/regression.mjs`：**143 项**（142 → 143）。

## [0.6.0] - 2026-11-15

两件事：**预设悬空**（那个没有崩溃日志、但每个会话都开不了的故障）有了体检与离线修复；
外部代码审查里的 4 项严重 / 11 项中 / 4 项低全部收口，外加三项「直接击穿功能」的缺陷。

### 新增

- **预设体检与修复**（`lib/preset.js` + `dsh-rescue preset`）：
  `cordis.patch.yml` 的 `selectedDefault` 可以指向一个**由插件在运行时注册**的预设；插件一被禁用，
  指针就悬空，新会话报 `agent-preset/not-found`、老会话 `resume failed`——而宿主不崩，没有崩溃日志。
  三处一起查、一起修：
  ```
  dsh-rescue preset                                       只体检
  dsh-rescue preset --dry-run --fix --rewrite-sessions   看会改什么
  dsh-rescue preset --fix --rewrite-sessions             真修（需先完全退出 DSH）
  ```
  - 指针：只改 `selectedDefault` 那一行，注释 / `default:` / 其它块原样保留（有测试锁）。
  - 会话：v4 多帧 zstd 逐帧处理，只重压含 `"agentPreset":"<旧 id>"` 的帧，其余帧字节原样保留；
    落盘前四重校验（帧数不变 / 每帧可解 / 未命中帧逐字节相等 / 残留为 0）。
  - 投影缓存 `storages/session_projcache/sessions/*.json` 同步改写。
  - 每文件先备份到 `~/.dsh/backups/preset-<时间戳>/`；DSH 在跑时**拒绝**改写会话（只允许 --dry-run）。
- **预设守护是开关，默认关**：设置 → 启动救援 → 预设卡片里「悬空时自动回退」+「回退目标」下拉。
  关（默认）时只体检、不改配置——用户可能正是要用某个插件提供的预设。开着时启动发现悬空，
  才把 patch 的 `selectedDefault` 改成所选目标（先备份，下次启动生效）。回退目标列表来自宿主
  注册表（含插件提供的预设），默认 `ptc`；与 CLI 共用 `config.json` 的 `preset.{guard,fallback}`，
  CLI 等价写法 `dsh-rescue preset --guard on --fallback standard`。
- **运行时预设守卫**（`index.js`）：启动 3 秒后对照 `agentPresets.list()` 与实际默认 id，
  悬空就写 `.rescue/preset-state.json` 并在启动日志里点名 + 给出 CLI 命令。**只诊断不代注册**：
  用空组合别名会让会话「能打开但工具全没了」，比报错更难查。
- **更新前检查**新增一条规则：默认预设不是内置四个（`standard/ptc/minimal/cordis`）时警告。
- **面板新增「预设」卡片**（设置 → 启动救援）：指针状态、哪些会话引用了缺失预设、
  可复制的修复命令；加载失败只降级成一行灰字 + 气泡，不会整块消失。
- `/rescue` 命令输出加入预设体检结果。

### 安全（审查 S1 / S2 / S3 / S5 / S6 / S14 / S15 / L4）

- **S1 路由鉴权**（`lib/route-auth.js`）：所有 `/dsh-rescue/*` 写请求三层防线——
  只认回环地址（`127.0.0.1`/`::1`）、同源校验（缺失 Origin 放行，Electron 同源不保证带）、
  进程内 token（`<profile>/.rescue/route-token.txt`，0600 / icacls）。
  高危动作（回滚快照、安全模式 apply/off、装守护、创建桌面入口、清 cookie、写配置）
  再加**一次性 nonce**：`GET /handshake.json` 下发，5 分钟过期、用过即废。面板已内置握手。
- **S2 cookie 清理只写副本**：面板不再就地改写 Chromium 独占的库；路由返回 409 + 预览 +
  可复制的 CLI 命令，原库一字未动（`--force` 不再能绕过写保护）。
- **S3 明文备份**：随机后缀、显式收紧权限、只保留最近 3 份、临时副本独占目录 + 退出清理；
  stdout 不再打印完整路径。
- **S5 批处理脚本**：`%~dp0` 自检定位、关闭 delayed expansion、拒绝含令符/UNC 的路径
  （`isSafeBatchPath`），`installDesktopEntry` 校验 desktop/pluginDir。
- **S6 预检边界**：npm 包名白名单（拒 `..` 与分隔符）、文件数/字节/单文件上限、
  `lstat` 不跟随 symlink/junction、去重改 `Set`。
- **S14 脱敏**（`lib/redact.js`）：崩溃 errorLine 里的家目录/用户名/profile 路径替换成
  `<home>` / `<profile>`；`path`（修复动作要用）保持原样。路由错误不再外泄绝对路径。
- **S15 client-errors**：单条 ≤2000 字符、最多 20 条、去控制字符、总量上限，
  落 `.rescue/client-errors.jsonl`（+ 旧 txt 镜像）。
- **L4 状态码**：错误用 4xx/5xx（401/403/405/409/413/400），不再一律 200；
  客户端保留 4xx 响应体里的原因（`locked`、`nonce-expired`…）。

### 健壮性 / 性能（S7 / S9 / S10 / S11 / S13 / L1 / L3）

- **S7 原子写收敛成一份**（`lib/paths.js`）：唯一 tmp（pid + 随机 + 计数）→ rename
  （EPERM/EACCES/EBUSY 退避重试）→ 失败保留 tmp 并在错误里给 `.tmpPath`；
  异步写走模块级串行队列（`atomicWriteFileAsync` / `drainAtomicWrites`）。
  snapshot / safemode / config / watcher / fingerprint / CLI / preset 全部改用它。
- **S9 崩溃日志有界读取**：先按 mtime 取最近 N 个再读；单文件 2MB 上限、超限只回 meta；
  0 字节日志单独标记（说明崩溃记录器自己死了）；`sinceMtime` 让 watcher 只解析新文件。
- **S10**：`/diagnose.json` 的 watcher 状态只读一次；preflight 复用扫描缓存。
- **S11**：cookie 体积改 SQL 侧聚合（不再把明文令牌全量取回 JS）；VACUUM 按需。
- **S13**：崩溃分组 `useMemo`、时间串缓存、列表项 `React.memo`、各列表 slice 上限 + 「去 CLI 看完整」。
- **L1**：报告路径白名单（`<profile>/.rescue/` 且 `.txt`）+ `noopener,noreferrer`。
- **L3**：定时器句柄统一登记/清理、两份错误上报改走带超时的请求、不再静默吞错。

### 测试

- `test/regression.mjs`：**142 项**（54 → 70 → 134 → 142）。新增块覆盖预设悬空（11 项）、
  路由鉴权/握手 nonce 契约/只写副本/client-errors 约束（30+ 项）、原子写、崩溃日志有界读取、脱敏。
- `test/client-section.test.mjs`：**24 项**（内嵌面板不吞滚轮、气泡栈、预设卡片、S13/L1/L3 源码锁）。
- `node --test`：77 项中 76 通过；唯一失败是 `scan.test.mjs` 的「真实 profile `/rules`」用例，
  用未修改的 0.5.3 备份跑同样失败（当前 profile 的 `dsh-purge` 未启用且已打过补丁），属既有环境问题。

### 升级注意

- 面板的**写操作**现在会先 `GET /handshake.json` 拿 token + nonce（客户端已内置，无需操作）；
  `index.js` / `lib/routes.js` 改动**必须完整重启宿主**才生效（client.js 刷新页面即可）。
- 「立即清理 Cookie」按钮在面板里**只做预览并给出 CLI 命令**：DSH 正在运行时改写 cookie 库
  本来就会被 Chromium 覆盖或写坏。

## [0.5.4] - 2026-11-15

针对 2026-11-15 的实地反馈与一次外部代码审查（4 严重 / 11 中 / 4 低 + 3 项「直接击穿功能」）。

### 修复（实地反馈）

- **设置页中段滚不动**：内嵌面板沿用了浮动面板的 `.drg-body{overflow-y:auto;overscroll-behavior:contain}`。
  `contain` 让一个「没有东西可滚」的盒子也吞掉滚轮，宿主页面在它背后不再滚动。
  内嵌模式改为普通内容（`.drg-panel-embedded .drg-body{overflow:visible;overscroll-behavior:auto}`），
  滚动交还宿主页面。
- **错误/结果只出现在页面底部一行**：新增气泡通知（Toast）。
  `showToast()` 挂 `document.body`，不依赖 React 树与宿主 slot；容器 `pointer-events:none`、
  条目 `auto`，最多堆 3 条；成功 2.4s、警告 4s、错误 6s 自动消失，可手动关闭。
  面板的 `flash()`、设置页的保存 / 立即清理 / 创建桌面入口 / 更新前检查全部改走气泡；
  错误另外保留底部状态行，漏看气泡时仍可回读。
- **重挂载后面板卡在初始态**：`mountedRef` 只在卸载时置 false，重新注入或 StrictMode 二次挂载
  后所有请求提前 return。改为挂载时复位。
- **写操作可并发**：安全模式 / 快照回滚 / 守护安装现在由 `writeLock` 串行化，且刷新完成前
  按钮不解除禁用（原来 `setBusy(false)` 早于尾部 `load()`）。
- **取数竞态**：`load()` 带递增序号，慢的旧响应不再覆盖新报告。
- **设置页取数循环**：`useTranslate` 的兜底函数原来每次渲染新建，使 `load` 依赖恒变、
  `useEffect` 反复发 GET。兜底函数提为模块级 `identityT`，加载器改读 `tRef`、依赖数组清空。
- **复制按钮定时器**：改为 `copyTimer` 句柄，卸载时清理。

### 修复（审查确认「直接击穿功能」的三项）

- **崩溃守护永远拿不到锁**（`bin/dsh-rescue-watch.mjs`）：用到的 `WATCH_INTERVAL_MS` 只在
  `lib/watcher.js` 导出，本文件从未 import → `ReferenceError` → 被 `catch { return null }`
  吞掉，`acquireLock` 恒为 null，守护起来即退。改为 import 该常量；锁改用
  `openSync(file,'wx')`（O_CREAT|O_EXCL）原子创建，EEXIST 时按 mtime 判陈旧再重试；
  fd 写入后 `closeSync`；守护每 15s `utimesSync` 刷新锁 mtime（心跳，unref），
  否则 60s 后自己会被「陈旧」规则抢走锁，面板的 running 判定也永远为 false。
  入口加 `isEntryPoint()` 守卫，测试可直接 import `acquireLock` 而不拉起常驻进程。
- **守护进程活 0 秒**（`lib/watcher.js`）：debounce、`fs.watch({persistent:false})`、
  兜底轮询全都 `unref()`，`main()` 返回后事件循环为空。现在 10 分钟兜底轮询是唯一
  **referenced** 句柄（不引入忙轮询），`stop()` 显式清理；另加 `keepAlive:false` 供探针用。
- **安装期「是否创建救援台」弹窗永不出现**（`lib/desktop-offer.js`）：`buildPromptScript()`
  的结果赋给 `dialogScript` 后从未使用，`spawn` 的 `-Command` 传的是
  `bin/dsh-rescue.mjs` 的**路径字符串** —— PowerShell 去运行一个文件名，弹窗不出现；
  路径含 `;` / 换行时即为命令注入面。改为 `-EncodedCommand`（UTF-16LE base64），
  脚本以**数据**传递；`psString` 转义保留，`encodeCommand()` / `buildPromptScript()` 导出以便断言。

### 测试

- `test/client-section.test.mjs` 新增 6 条源码锁：内嵌面板不得成为滚动容器、气泡栈存在且
  不挡点击、`flash` 走气泡、`mountedRef` 挂载复位、写操作串行、`t` 兜底稳定。
- `test/regression.mjs` 新增 16 项（54 → **70**）：锁的原子创建 / 陈旧抢占 / release、
  守护子进程存活 >1.5s（旧代码 0s）、`-EncodedCommand` 载荷解码后是脚本而非文件路径。
- `test/watcher.test.mjs` 新增「常驻 >1s」「stop() 后进程能退出」两条；两条既有用例的
  日志 mtime 锚点改为相对值（本卷 mtime 粒度约 15.6ms，紧随其后的写入可能取到相等时间戳，
  是既有 flake，断言未削弱）。

## [0.5.0] - 2026-11-10

Cookie 自动清理策略现在**可配置、可调试、两处入口共用一份真源**。

### 新增

- **设置面板里的「启动救援」分区**（`settings.section`，order 46）：设置 → 启动救援，
  与「Our Free Model」「wb400修复」「记忆」同级。放三件东西：
  1. 自动清理开关；
  2. 保留最新令牌数（0 = 全删）；
  3. 「立即清理」按钮（被占用时给出明确原因）。
- **`~/.dsh/rescue-guard/config.json`**（`lib/config.js`）：策略的唯一真源。
  选文件而不是宿主 settings 命名空间，是因为这个策略的价值在于「DSH 起不来时已经生效」——
  那时宿主 settings 读不到，而 CLI 必须读到。深合并写入、原子落盘、损坏自动回落默认。
- **CLI 侧同源控制**（控制台可调试）：
  ```
  dsh-rescue cookies --policy      查看策略
  dsh-rescue cookies --auto on|off 开关自动清理
  dsh-rescue cookies --keep-set N  持久化保留数
  dsh-rescue cookies --auto-run    按策略执行一次（计划任务/启动前钩子用）
  ```
- **救援台菜单**新增 `[9] 自动清理策略`、`[a] 打开自动清理`、`[b] 关闭自动清理`、
  `[d] 生成桌面入口`（`[9]` 让位给策略）。
- **`/dsh-rescue/config.json`**（GET 读 / POST 写）与 **`/dsh-rescue/cookies/clean.json`**
  两个路由，供面板调用。

### 修复

- **空的分区库会盖住真正的库**（`lib/cookies.js`）：`worst` 原先只按 level 排序，
  而每台机器都可能存在一个空的 `Partitions/<hash>/Network/Cookies`，它测出来 0 字节、
  level `ok`，于是 `--auto-run` 打印「0% 无需清理」——在真正 98% 的库旁边。
  改为「有 dsh-auth 令牌优先 → 有 cookie 优先 → 再比 level」，并修掉 reduce 以 null 起始
  导致永远返回 null 的连带缺陷。
- **`cookies` 不再要求 profile 存在**：cookie 库在 Electron 的 userData 里，与 profile 无关；
  profile 正在被重建恰恰是救援工具最该能跑的时刻。

### 测试

50 项（44 → +6）：策略默认值 / 写入重读 / 深合并不丢字段 / 损坏回落 / 非法值规范化 /
空分区库不得盖过真库。`harness-smoke` 纳入两个新路由（路由数改为动态计数）。

## [0.4.0] - 2026-11-10

针对 2026-11-10 的真实事故。这次崩溃的弹窗说「Web authentication failed」，看起来像账号
问题，实际是 **cookie 堆积把 HTTP 请求头撑过了 16 KiB**。

### 新增

- **`dsh-rescue cookies` 子命令**（`lib/cookies.js`）：测量 Chromium cookie 库里
  `dsh-auth-*` 令牌的数量与 Cookie 头字节数，判定是否逼近/超过 Node 默认
  `maxHeaderSize`（16 KiB），并可按 `--keep N` / `--dry-run` / `--force` 清理。
  实测数据：故障时 71 条令牌、Cookie 头 16117 字节、加其它头 16717 字节 → 431。
  - 读实时库会 `EBUSY`（Chromium 独占），因此新增 `--from-backup` 读上次备份估算。
  - 删除前必定备份到 `~/.dsh/backups/dsh-cookies-<时间戳>.db`。
  - 用 `node:sqlite`（Node ≥ 22.5 内置），无第三方依赖；缺该模块时给出可执行的提示。
- **桌面救援台**（`bin/rescue-console.cmd` + `bin/install-desktop.mjs`）：
  `dsh-rescue-desktop` 在桌面生成一个双击即开的编号菜单，覆盖诊断 / Cookie / 崩溃历史 /
  预检 / 安全模式 / 快照 / 禁用插件。自己探测 Node（优先 DSH 自带运行时），**不依赖 PATH、
  不依赖 DSH 能启动、不改注册表、不加开机自启**，删掉文件即完全还原。
- **启动期 cookie 体检**：`apply` 里起一个延迟定时器（不阻塞启动），能读到库时对
  `broken`/`warn` 记一条警告，附上具体清理命令。
- `web_auth` 分类由「不可预检」改为**可预检**，`action` 与 `advise()` 都改为
  **先量 Cookie、再谈根路由**——这次的教训正是旧建议直接指向 safe-mode 二分。
- `package.json` 增加 `bin`（`dsh-rescue`、`dsh-rescue-desktop`）与 `scripts.desktop-shortcut`。

### 关键认知

Cookie 头 16117 + 其它请求头约 600 = 约 16700 字节。**只看 Cookie 头会低估**，因为这
600 字节正是决定越过 16384 的那部分。判定因此按「Cookie + `OTHER_HEADER_RESERVE`」计算，
而报告的百分比仍如实基于实际测量值。

### 测试

33 项（24 → +9）。新增的 9 项覆盖：令牌计数、Cookie 头估算精度、整请求头判定、
dry-run 不改动、`--keep N` 精确保留、备份存在、清理后降为 `ok`、SQLite 完整性、默认全删。

## [0.3.1] - 2026-11-09

对 0.3.0 的代码审查结论落地。0.3.0 的三项 bug 修复经逐行核对属实并保留；本版修掉审查中
复现出的两个真实缺陷，以及若干稳健性与体积问题。

### 修复

- **作用域包在 Windows 反斜杠路径下解析错成 `C:/Users`**（`lib/crash.js`）：作用域包名的
  补救分支只按 `/` 切分，而 Node 在 Windows 上默认打印原生路径，于是
  `C:\...\node_modules\@scope\pkg\lib\a.js` 被解析成包名 `C:/Users`，进而被当作「第三方
  插件」写进报告与建议。改为按两种分隔符切分，并统一包内路径的分隔符风格。
- **`pickCulprit` 指认的是调用方而非抛错方**（`lib/crash.js`）：原实现取**最外层**第三方
  帧，但栈的位置不代表「谁抛的」。`plugin-a → plugin-b → host` 的链条里真正抛出的是
  innermost 的 plugin-b，原实现会点名 plugin-a —— 而 CLI 的措辞是「可能性最高，先禁用它」，
  照着做会禁用无辜插件。现改为 innermost 优先，并额外返回 `suspects`（完整嫌疑链，
  从内到外）。11-09 那次只有一帧，所以旧实现侥幸正确，测试也因此漏掉。
- **CLI 措辞从断言降级为怀疑**：'肇事插件' → '可疑插件'，并显式说明「帧只能证明当时在跑
  谁的代码，不能证明责任归属」，同时列出完整调用链供人工判断。
- 两个 25 秒定时器之间存在隐式时序依赖（安全模式还原要求前一个已把 `pending` 置 false）。
  还原分支现在自行确认启动健康，不再依赖注册顺序。

### 变更

- **boot.json 体积减半**：持久化指纹时剥掉 `hostVersionCandidates`（解析过程的痕迹，
  diff 用不到）。实测真实 profile：改前约 4KB → 现在约 1.7KB。仍在每次启动写入，但只写
  真正会被读的部分。
- `hostVersionCandidates` 去掉未使用的 `home` 参数，并把推测性环境变量（
  `DSH_RESOURCES_PATH` / `DSH_VERSION` / `PORTABLE_EXECUTABLE_DIR` —— 审核 app.asar 时
  出现 0 次）在注释里标明为兜底，主路径是已验证的 `process.resourcesPath`。
- 删除无调用点的 `moduleCount` / `isDir` 导出。
- 面板的漂移列表不再静默截断：超过 8 项时显示「还有 N 项」（四个词典都加了 `driftMore`）。
- README 补上自检命令 `node test/regression.mjs`（`test/` 随包发布，就要说明怎么跑）。

### 测试

回归测试 16 → **24 项**，新增 8 项正好覆盖上面两个缺陷此前漏掉的盲区：

- 反斜杠路径下的作用域包名（旧行为输出 `C:/Users`）
- 多插件调用链应指认 innermost、`suspects` 顺序、官方帧不进嫌疑链
- 正斜杠形式仍然正确（防止修一个坏一个）

## [0.3.0] - 2026-11-09

### 新增

- **崩溃栈帧解析**（`lib/crash.js` 的 `extractFrames` / `pickCulprit`）：从崩溃日志的栈里抽出
  第三方帧，报告「哪个包 → 哪个文件:行号」。2026-11-09 那次事故里，归类只给出「有 bundle 未能
  激活」，而栈里第一行就写着 `dsh-ops/lib/session-pwsh.js:19` —— 有了这条，恢复从「跑 5 次
  安全模式二分」变成「禁用这个包」。
- **启动指纹与「相对上次成功启动的变化」**（新 `lib/fingerprint.js`）：每次启动记录宿主版本与
  每个插件的解析版本，启动成功时存为 `lastGood`；下次启动失败时自动 diff，把
  「dsh-ops 0.5.2 → 0.3.0」这样的变化直接写进日志、CLI 与面板。
- **预检新增第 4 条规则**：检测插件对宿主私有事件（`internal/*`）的订阅。这类 API 没有兼容
  承诺——本次事故正是 `dsh-ops@0.3.0` 钩 `internal/config` 后，cordis 4.1 不再绑定 `this` 导致。
  正则锚定在订阅调用本身（`\.on('internal/…')`），实测对「普通 `this.entry` 类字段」零误报。
- **快照记录宿主版本**（`meta.hostVersion`）：一份不知道是哪个宿主版本下生成的清单，回滚时无法
  判断安不安全。
- `package.json` 补齐 `author` / `repository` / `homepage` / `bugs`。

### 修复

- **`confirmBoot` 只由路由触发，导致 `pending` 永远清不掉**：正常启动后下次启动仍误报「上次启动
  未完成」。现在 `apply` 里起一个 25 秒定时器无条件确认——能走到定时器，就证明所有插件已 apply
  且路由已注册。
- **`previousCrashes` 键名不一致**：写 `previousCrashes`、读 `crashes`，算术恒为 1，连崩 3 次
  也只报 1 次。现在正确读取自身字段，连续崩溃会累加到 3。
- **快照「只存一次」**：注释写的是「最新一份不够新才存」，代码是「一份都没有才存」，结果永远
  保留安装当天的清单。新增 `shouldSnapshot()` 按时间间隔轮换。
- **`entry_inactive` 的建议不再无脑指向二分**：栈里能定位到第三方包时，直接建议
  `dsh-rescue disable <包>`。

## [0.2.1] - 2026-11-07

### 变更

- **守护进程改为事件驱动**（用户反馈：15 秒轮询耗电）。主触发换成操作系统推送的目录
  变更事件（Windows 上是内核级 ReadDirectoryChangesW）：进程平时睡眠，**空闲零 CPU、
  零唤醒**；同一次崩溃的多个写入事件用 2 秒防抖合并成一次检查。原来 15 秒的轮询降级为
  10 分钟一次的兜底（只防「目录在挂接后才创建/被整体替换」两类丢事件）。
  反应速度反而更快：从「平均 7.5 秒」变成「事件到达 + 2 秒防抖」。
- 新增真实 fs 事件触发测试：往被挂接的目录写崩溃日志，断言报告在无轮询的情况下出现。

### 修复

- 真实日志分布测试不再硬编码总数：运行时会清理旧崩溃日志，改为断言「截断切片的构成
  稳定、各分类计数只减不增」。

## [0.2.0] - 2026-11-07

### 新增

- **崩溃守护进程**（`bin/dsh-rescue-watch.mjs`）：独立于 DSH 常驻，15 秒轮询崩溃日志目录。
  **平时零占用**（无新崩溃时不写任何文件）；出现新崩溃日志的那一刻，自动生成一份
  覆盖式自检报告 `<profile>/.rescue/last-crash-report.txt`（本次错误、历史归类、
  预检发现、立即行动清单）。单实例锁防重复；报告不累积。
- **面板「崩溃守护」区块**：自启安装/卸载（写入用户启动文件夹）、运行状态（PID）、
  打开最近一份报告。
- 扫描器跳过 `test*/` 目录与 `*.test.*` 文件：测试装置里的字面量不再是「注册」
  （修掉了 self-scan 时出现的假 `/purge` 冲突与 4 条假缺失文件）。

## [0.1.0] - 2026-11-07

首个版本。所有防护均由**本机 21 份真实崩溃日志**反推而来。

### 新增

- **独立救援 CLI（`bin/dsh-rescue.mjs` + `bin/dsh-rescue.cmd`）**：不依赖 DSH，起不来时
  也能运行。子命令：`diagnose` / `crashes` / `scan` / `safe-mode` / `snapshot` /
  `disable` / `enable`。启动器自动探测 Node 运行时（本机 Node 不在 PATH，DSH 自带一份）。
- **崩溃归类**：把 `crash-*.log` 解析成六类可行动的原因，并抽取关键信息
  （缺失文件路径、冲突的命令名、崩溃附近的插件操作）。
- **启动前静态预检**：命令名冲突、构造期读取的缺失文件、可能遮蔽根路由的注册。
  已能在本机复现历史上真实导致宿主停止的 `/rules` 冲突
  （`dsh-permission-rules` 与 `dsh-purge`）。
- **安全模式**：布防后只加载 `@deepseek-ai/*` 官方 bundle，启动成功后自动还原。
  绝不触碰官方 bundle；改写清单前先自动快照；原子写；幂等。
- **配置快照与回滚**：每次启动保留一份清单快照，默认保留最近 10 份；回滚前先自动快照，
  所以回滚本身也可回滚。
- **启动健康标记**：每次启动写 `pending` 标记，路由被成功访问即证明启动完成。
  上次标记仍为 `pending` 说明上次启动死了 —— 这是面板上报「上次启动未完成」的依据。
- **Web UI 面板**：上次启动状态、崩溃归类、预检结果、安全模式开关、快照管理与回滚，
  底部给出可复制的救援命令。

### 已知限制

- **救不了「插件加载期就死掉」的启动**。本机 21 次崩溃中有 12 次属于此类（缺失文件 8 次、
  命令名冲突 2 次、entry 未激活 2 次），此时救援插件自身也无法加载。这正是必须有独立
  CLI 的原因 —— 请把 `bin/dsh-rescue.cmd` 的路径记下来。
- 预检是**启发式静态分析，不是证明**。命中的问题值得查，没命中不代表没问题。
- 修复不了 DSH 应用本身的问题（如渲染进程被系统杀掉）。
- 只禁用、不删除任何东西。
