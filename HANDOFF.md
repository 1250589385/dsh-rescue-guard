# 交接：dsh-rescue-guard 0.3.0

> 给另一台电脑上的 Agent。本目录是**完整可发布的源码树**（从安装副本复制后改出来的），
> 不是 node_modules 里的运行副本。所有改动已通过语法门禁与 16 项回归测试。

## 1. 一分钟验证

```bash
cd dsh-rescue-guard
node test/regression.mjs        # 期望：全部通过：16 项
node --check index.js && node --check client.js
```

无任何依赖（`dependencies` 与 `peerDependencies` 均为空），只需 Node ≥ 20。

## 2. 这一版改了什么（都是真实事故反推，不是推测）

2026-11-09 07:04/07:05/07:06，本机连续三次启动失败：

```
DesktopHostFatalError: dsh: startup failed: 4 required plugins did not activate
Failed plugins (27): …
  TypeError: Cannot read properties of null (reading 'entry')
      at loaderCtx.on.global (…/node_modules/dsh-ops/lib/session-pwsh.js:19:25)
```

根因：`dsh-ops@0.3.0` 订阅宿主私有事件 `internal/config`，回调里读 `this.entry`；宿主 cordis
升到 4.1.0 后不再给 hook 绑定 `this` → 每个插件的配置解析都抛错 → 24 个 failed、52 个 pending。

**0.3.0 的四项改动 + 三个 bug 修复全部来自这次事故的实测证据**，见 `CHANGELOG.md` 的 0.3.0 段。

### 新增
| 能力 | 文件 | 关键函数 |
|---|---|---|
| 崩溃栈帧解析 → 指认肇事包 | `lib/crash.js` | `extractFrames` / `pickCulprit` |
| 启动指纹 + 与 lastGood 自动 diff | `lib/fingerprint.js`（新） | `captureFingerprint` / `diffFingerprints` / `describeDiff` |
| 预检第 4 条规则：`internal/*` 订阅 | `lib/scan.js` | `findPrivateHooks` |
| 快照记录宿主版本 | `lib/snapshot.js` | `createSnapshot({ hostVersion })` |
| 快照按时间轮换 | `lib/snapshot.js` | `shouldSnapshot` |

### 修复
| bug | 位置 | 症状 |
|---|---|---|
| `previousCrashes` 键名不一致（写 `previousCrashes`、读 `crashes`） | `lib/paths.js` `beginBoot` | 连崩 N 次恒报 1 |
| `confirmBoot` 只由 HTTP 路由触发 | `index.js` `apply` | `pending` 永远清不掉，每次正常启动后下一轮误报"上次启动未完成" |
| 快照"一份都没有才存"（与注释意图相反） | `index.js` | 永远只保留安装当天的清单 |

## 3. 你必须知道的仓库状态（我查过，别重复踩）

| 项 | 状态 |
|---|---|
| npm 上的包 | `dsh-rescue-guard` 已存在，latest = **0.2.1**，maintainer = `raysnows` (r1250589385@163.com) |
| 本机 npm 登录 | ❌ **未登录**（`npm whoami` → `ENEEDAUTH`）。需要 `npm login` |
| 上游源码仓库 | 本机**没有** git 仓库，这份目录已补齐 `repository`/`homepage`/`bugs` 字段指向 `github.com/1250589385/dsh-rescue-guard`。**若实际仓库地址不同，先改 package.json。** |
| 版本号 | 已改 0.2.1 → **0.3.0** |

## 4. 发布前检查清单

1. `node test/regression.mjs` 全绿（16 项）
2. `npm login`（GitHub 登录与 npm 是两套凭据）
3. 确认 `package.json` 的 `repository` 地址与真实仓库一致
4. `npm pack --dry-run` 核对文件清单——**新增文件必须在 `files` 里**，否则安装后 ENOENT
   （`files` 已含 `lib`/`bin`/`locale`/`test`，`lib/fingerprint.js` 随 `lib` 通配）
5. `npm publish`（0.3.0，无 scope，公开）
6. 发版后：删掉本地 `.rescue/snapshots` 里旧快照可验证新 meta 有 `hostVersion` 字段

## 5. 未做 / 明确不做的

- **没有实现"更新前拦截"**：宿主 `app.asar/lib/main.js` 的 `install()` 里唯一钩子
  `beforeRestart` 是主进程闭包参数，插件够不到；preload 只暴露 `updates.status()` /
  `updates.open()` / `updates.subscribe()`，**没有 check/download/install 权限**。
  `subscribe()` 能收到 `phase: "ready"`（已下载、等用户点安装），理论上可在那时提醒，
  但不能阻止——这是 v0.4 的可选项，本版未做。
- **未恢复** `ptc-plus` / `llm-fallbacks` / `dsh-ops-background` 三条 patch（前两个需要
  `pnpm add` 装包，第三个已被 dsh-ops 0.5.2 明确废弃）。与插件本身无关，是宿主 profile 的事。

## 6. 面板 UI 有一处新增需要肉眼确认

`client.js` 的启动状态区块新增了 `drift` 渲染（"相对上次成功启动的变化"）。已通过
`node --check`，但**未在真实浏览器里渲染验证**（我这边没有可操作宿主面板的条件）。
接手方首次安装后，若面板报错，优先检查：
- `client.js` 是 **CRLF** 行尾，改它时锚点必须带 `\r\n`
- 内联字典有两份（en @~4501、zh @~8974），两处都要加 key
- `locale/zh.json`、`locale/en.json` 是给 Host 用的另一份，与内联字典独立，两处都要有

---

**来源说明**：本目录由 2026-11-09 对 `C:\Users\dell\.dsh\profiles\desktop\node_modules\dsh-rescue-guard`
（0.2.1 安装副本）的复制与修改而来。修改过程的每一项都对应上面列出的真实证据。
