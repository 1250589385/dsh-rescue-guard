# 来源说明（PROVENANCE）

## 原创性

本插件的全部源码（`index.js`、`client.js`、`lib/`、`bin/`、`icon.svg`、词典）均为本项目
原创，采用 MIT 许可。

## 设计依据：本机真实崩溃日志

本插件的每一条防护都不是推测，而是从**本机 21 份真实崩溃日志**反推出来的。日志位于：

```
%APPDATA%\@deepseek-ai\dsh-desktop\logs\crash-*.log          (10 份)
%APPDATA%\@deepseek-ai.backup\dsh-desktop\logs\crash-*.log   (11 份)
```

归类结果（`%APPDATA%` 为 `C:\Users\HP\AppData\Roaming`）：

| 崩溃签名 | 次数 | 本插件对应能力 |
|---|---|---|
| `DesktopHostFatalError: ENOENT ... open '<path>'` | 8 | 构造期缺失文件预检 |
| `desktop welcome: Web authentication failed` | 8 | 安全模式 + 根路由遮蔽检测 |
| `command "rules" is already registered` | 2 | 命令名冲突预检 |
| `1 entry did not activate` | 2 | 安全模式（逐个启用定位） |
| `Desktop renderer exited: killed` | 1 | 仅归类与提示 |

崩溃日志本身**不属于**本项目的分发内容，仅在开发时只读分析；本仓库不包含这些日志。

## 0.3.0 的依据：2026-11-09 的真实事故

本机在 2026-11-09 07:04 / 07:05 / 07:06 连续三次启动失败，日志为：

```
DesktopHostFatalError: dsh: startup failed: 4 required plugins did not activate
Failed plugins (27): …
  TypeError: Cannot read properties of null (reading 'entry')
      at loaderCtx.on.global (…/node_modules/dsh-ops/lib/session-pwsh.js:19:25)
```

根因：`dsh-ops@0.3.0` 订阅 `internal/config`，回调里读 `this.entry`；宿主当时的 cordis 4.1.0
不再给 hook 绑定 `this`，于是每个插件的配置解析都抛错，24 个插件 failed、52 个 pending。

0.3.0 的四项修复/新增都直接来自这次事故的可复现证据：

| 现象 | 0.3.0 的对应改动 |
|---|---|
| 归类只说「entry did not activate」，栈里明明写着 `dsh-ops` | 栈帧解析 + 建议改为「禁用该包」 |
| 无法判断「上次是怎么跑起来的」 | 启动指纹 + `lastGood` + 自动 diff |
| 静态预检 3 条规则一条都没覆盖 | 第 4 条规则：`internal/*` 订阅 |
| 正常启动后仍误报「上次启动未完成」 | `confirmBoot` 定时器 |

事故日志不属于分发内容，仅在开发时只读分析；本仓库不包含这些日志。

## 无第三方素材

- 无第三方依赖（`dependencies` 与 `peerDependencies` 均为空，只用 Node 内置模块）
- `icon.svg` 为原创图形
- 不含从 DSH 应用安装目录（`app.asar`）提取的任何资源

## 代码引用

`client.js` 遵循 DSH Web UI 客户端插件的公开约定（`window.__ModuleLoader__`、
`ctx.slots.register`、`--dsw-alias-*` 主题变量），这些是对外接口而非他人代码。

本插件与 `dsh-stall-guard`（同一作者）共用客户端写法约定，两者无代码依赖。
