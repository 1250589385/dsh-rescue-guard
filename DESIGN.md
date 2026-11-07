# dsh-rescue-guard — 设计与接口契约

## 一、先讲清楚一个架构矛盾

需求是「DSH 启动不了时能救援」。但**插件在启动过程中加载**，所以：

> 如果崩溃发生在插件加载阶段，救援插件自己也加载不了，救不了。

这不是推测，是这台机器上的实测事实。21 份崩溃日志里：

| 崩溃 | 次数 | 发生时 DSH 处于 |
|---|---|---|
| `ENOENT` 读缺失文件（插件构造时抛出） | 8 | **插件加载中** |
| `command "rules" is already registered` | 2 | **插件加载中** |
| `1 entry did not activate` | 2 | **插件加载中** |
| `desktop welcome: Web authentication failed` | 8 | 启动握手（插件已加载） |
| `renderer exited: killed` | 1 | 运行中 |

**前 3 类（12/21）恰好是插件在加载时把宿主搞死的** —— 这类事故插件救不了自己。

### 因此分成两半，职责不同

| 组件 | 何时工作 | 职责 |
|---|---|---|
| **静态预检 + 备份** | DSH 正常时 | **预防**：启动前就发现命令名冲突、缺文件、坏配置 |
| **独立 CLI（`dsh-rescue`）** | DSH 起不来时 | **救援**：不依赖 DSH，禁用可疑 bundle、回滚清单 |
| **插件 UI** | DSH 正常时 | 呈现诊断、一键布防、快照管理 |

「救援」必须有一部分在 DSH 进程之外，否则就是悖论。

## 二、历史崩溃原因 → 对策（全覆盖）

| # | 签名 | 次数 | 机制 | 对策 |
|---|---|---|---|---|
| 1 | `DesktopHostFatalError: ENOENT ... open '<path>'` | 8 | 插件 `apply()` 里 `readFileSync` 一个尚不存在的文件（更新未落地）→ 抛出 → 宿主致命 | **预检**：扫描各 bundle 构造期读取的路径，不存在就报警 |
| 2 | `desktop welcome: Web authentication failed` | 8 | Shell 用启动令牌握手被拒（根路径被占/端口/陈旧令牌） | **救援**：安全模式 + 路由遮蔽检测 + 清陈旧令牌 |
| 3 | `command "X" is already registered` | 2 | 两个 bundle 注册同名命令 → `apply()` 中止 → 宿主停止（实测 `dsh-permission-rules` 与 `dsh-purge` 都注册 `/rules`） | **预检**：静态收集各 bundle 的命令名，冲突即报（**这是本次最有价值的检查**） |
| 4 | `1 entry did not activate`（host + web 各 1） | 2 | 某个 bundle 行激活失败 | **救援**：安全模式（逐个启用以定位） |
| 5 | `Desktop renderer exited: killed` | 1 | 渲染进程被杀（内存/外部） | 记录并提示查看日志 |

## 三、模块与接口契约

写作用域严格分离，避免互相踩。

### `lib/crash.js` — 崩溃日志解析与归类（负责人：scout）

```js
/** 已知原因表。id 稳定，UI 与 CLI 都用它。 */
export const CAUSES = {
  missing_file:  { id, zh, en, preventable: true,  action: 'zh 建议' },
  command_clash: { ... preventable: true },
  web_auth:      { ... preventable: false },
  entry_inactive:{ ... },
  renderer_dead: { ... },
  unknown:       { ... },
};

/** 解析单份日志。容忍缺字段。 */
export function parseCrashLog(text) -> {
  time, source, phase, app, error, stack,
  signature,        // 归一化后的错误首行（路径替换为 '<path>'，命令名保留）
  causeId,          // CAUSES 的键
  ops: [{ target, stage, enabled }],
}

/** 从目录读取多份日志，按时间升序。忽略非 crash-*.log。 */
export function readCrashes({ dirs, limit = 100 }) -> [{ file, path, ...parsed }]

/** 汇总：总计、按原因计数、时间范围、是否短时间内反复崩溃。 */
export function summarize(crashes) -> {
  total, byCause: { [causeId]: n }, first, last, repeatedWithinMinutes, episodeCount,
}
```

分组规则（必须与实现一致，测试要覆盖）：
- `ENOENT` → `missing_file`，并从错误里抽出被读路径（`path` 字段）
- `already registered` → `command_clash`，抽出命令名
- `Web authentication failed` → `web_auth`
- `did not activate` → `entry_inactive`
- `renderer exited` → `renderer_dead`
- 其它 → `unknown`

### `lib/scan.js` — 启动前静态预检（负责人：scout）

```js
export function scanProfile({ profileDir, homeDir }) -> {
  bundles: [{ name, dir, firstParty, exists }],
  commands: [{ name, plugin, file, line }],
  collisions: [{ name, plugins: [..] }],      // 同名命令被多个 bundle 注册
  missingFiles: [{ plugin, path, file, line }],
  routeShadows: [{ plugin, path, kind }],     // kind==='prefix' 且 path 为 '/' 等
  warnings: [string],
}
export function scanBundle(dir) -> { commands, missingFiles, routeShadows }
```

静态解析规则（**必须写进代码注释，且文档里说明是启发式**）：
- 命令名：匹配 `commands.register({ ... name: 'x' })` 与 `registerCommand({ ... name: 'x' })`；跨行要能匹配
- 缺失文件：匹配 `readFileSync(<字面量路径或 path.join(...)>`；把 `$DSH_HOME`/`DSH_HOME` 解析为 `homeDir`；相对路径按插件目录解析；**只检查路径形态可静态确定的**，其余跳过并在 `warnings` 里记账
- 路由遮蔽：匹配 `kind: 'prefix'` 且该注册的 `path` 为 `/` 或空

> 预检是启发式，不是证明。UI 与 CLI 输出都要带这句话。误报要记为 `warnings` 而不是 `collisions`。

### `lib/snapshot.js` — 清单快照与回滚（负责人：keeper）

```js
export function createSnapshot({ profileDir, keep = 10 }) -> { id, at, dir, files: [..] }
export function listSnapshots({ profileDir }) -> [{ id, at, files, bytes }]
export function restoreSnapshot({ profileDir, id }) -> { restored: [..], skipped: [..] }
```

- 备份对象：`profiles/<p>/package.json`、`pnpm-workspace.yaml`、`rules.yaml`（存在才备）
- 目录：`<profileDir>/.rescue/snapshots/<ISO 时间戳>/`
- **原子写**：先写 `.tmp` 再 rename
- 只保留最近 `keep` 份
- 回滚前**先自动快照当前状态**（回滚也要可回滚）

### `lib/safemode.js` — 安全模式（负责人：keeper）

```js
export function status({ profileDir }) -> { armed, armedAt, reason, disabled: [..] }
export function arm({ profileDir, reason }) -> { ok, armed, willDisable: [..] }
export function disarm({ profileDir }) -> { ok }
/** CLI 布防时立即调用（没有可靠的「启动前」钩子，所以布防即应用）。 */
export function applyIfArmed({ profileDir }) -> { applied, disabled: [..] }
/** 启动成功后调用，把上次禁用的一键还原。 */
export function confirmHealthyBoot({ profileDir }) -> { restored: [..] }
```

机制（**必须照此实现**）：
- 状态文件：`<profileDir>/.rescue/safemode.json`
- 布防 = 记录当前 `dsh.profile.bundles` 全量 + 写 `armed: true`
- 应用 = 把 `dsh.profile.bundles` 重写为**只留 `@deepseek-ai/*`**；被移除的原样存进状态文件
- 还原 = 把保存的第三方项并回（与期间新增的项合并，去重，保持原顺序）
- **绝不触碰 `@deepseek-ai/*`**；写前先 `createSnapshot`；原子写
- 幂等：重复 arm / apply / restore 不得损坏清单

## 四、CLI（`bin/dsh-rescue.mjs`，负责人：lead）

```
dsh-rescue diagnose                 # 读崩溃日志 + 预检 + 给建议
dsh-rescue scan                     # 只跑预检
dsh-rescue crashes [--limit N]      # 列出归类后的崩溃
dsh-rescue safe-mode on|off|status  # 布防/解除/查看
dsh-rescue snapshot create|list|restore <id>
dsh-rescue disable|enable <bundle>  # 单个 bundle 开关
--profile <dir>   默认 C:\Users\HP\.dsh\profiles\desktop
```

## 五、插件（负责人：lead）

- Host：`/dsh-rescue/{diagnose,scan,snapshot,safe-mode}.json`；启动标记 `.rescue/boot.started` / `boot.ok`；上次启动未完成则上报
- Client：`shell.overlay` 面板 —— 崩溃归类列表、预检结果、一键布防、快照创建/回滚

## 六、验收（负责人：verify）

1. `node --test test/*.test.mjs` 全绿
2. **用真实 profile 做一次布防→应用→还原**，还原后 `package.json` 与原始**逐字节相同**
3. 预检能在这台机器上**复现** `rules` 冲突（dsh-permission-rules vs dsh-purge）
4. 崩溃归类对 21 份真实日志的分布与 `crash-report.txt` 一致
5. 故意造一个坏清单（删掉 `profiles/desktop/package.json` 的 bundles 键 / 写入非法 JSON），CLI 能从快照恢复
