# 交接：dsh-rescue-guard 0.5.0

> 完整可发布的源码树。语法门禁 + **50 项**回归 + 5 套单测 + harness smoke + client-section 全绿。
>
> **先读这三份**：本文件（状态与坑）→ `UPDATE-GUIDE.md`（人照着做的更新步骤）→
> `CHANGELOG.md` 的 0.5.0 / 0.4.0 段（每项改动对应的真实事故）。
>
> `dsh-rescue-guard/` 就是插件源码，`cd` 进去即可跑；无第三方依赖，需 Node ≥ 22.5。

## 0. 你被交办了什么（先看这张表）

| # | 任务 | 验收标准 | 失败时 |
|---|---|---|---|
| 1 | 跑全测试，确认这棵树是好的 | `node test/regression.mjs` → **50/50**；`node test/harness-smoke.mjs` → `routes: 7` | 说明文件在传输中损坏，重新解压 |
| 2 | 补跑 CI 测试 | `node test/cli.test.mjs` → 9 项通过 | 我这边被沙箱禁了 piped spawn，**这一套只有你能验** |
| 3 | 推 GitHub（**必须 clone 后覆盖，不能直接推**） | `git log` 仍有 `41756e9`；`git status` 无删除项 | 见第 4 节，空仓库 push 会毁掉历史与 tag |
| 4 | 装到本机验证设置面板 | 设置左栏出现「启动救援」，三项控件可用 | 白屏 → 回退，报错发回；见第 5 节 |
| 5 | npm 发布（可选） | `npm publish` 后 `npm view dsh-rescue-guard version` → 0.5.0 | 需先 `npm login`（与 GitHub 无关）|

**不要做的事**：不要在没有 clone 的目录里 `git push -f`；不要把 `.git` 打进交付包；
不要 "修好" `test/fixtures/plugin-with-private-hook/`（那是有意保留的坏样本）。

---

## 1. 一分钟验证

```bash
cd dsh-rescue-guard
node test/regression.mjs            # 期望：全部通过：50 项
node test/harness-smoke.mjs         # 期望：routes: 7, command: rescue ...
node bin/dsh-rescue.mjs help
echo 0 | node bin/dsh-rescue.mjs menu   # 中文菜单必须正常
```

### 测试矩阵（本机实测）

| 套件 | 结果 |
|---|---|
| `test/regression.mjs` | **50/50** |
| `test/crash.test.mjs` | 18/18 |
| `test/scan.test.mjs` | 13/13 |
| `test/snapshot.test.mjs` | 8/8 |
| `test/safemode.test.mjs` | 16/16 |
| `test/watcher.test.mjs` | 9/9 |
| `test/harness-smoke.mjs` | OK（7 条路由实测） |
| `test/client-section.test.mjs` | OK（设置分区注册安全） |
| `test/cli.test.mjs` | **跳过**（沙箱禁 piped spawn，请在普通终端补跑） |

## 2. 0.5.0 改了什么

### 策略可配置、可调试（用户明确要求）

Cookie 自动清理策略存在 `~/.dsh/rescue-guard/config.json`，**不是**宿主 settings 命名空间。
原因：策略唯一有价值的时刻是「宿主起不来、要决定下次怎么清理」，那时宿主 settings 读不到，
只有独立文件能被 CLI 读到。

三个入口共用同一份：

| 入口 | 怎么用 |
|---|---|
| 设置面板 | 设置 → **启动救援**（与 Our Free Model / wb400修复 / 记忆 同级）|
| CLI | `cookies --policy` / `--auto on\|off` / `--keep-set N` / `--auto-run` |
| 救援台 | `[9]` 策略、`[a]` 开、`[b]` 关 |

配置字段：`autoClean`（默认 false）、`keepNewest`（默认 0）、`warnRatio`（0.6）、
`confirmBeforeClean`（true）。深合并写入、原子落盘、损坏自动回落。

### 0.5.0 修的真 bug

**空的分区库盖住了真正的库**：本机有 `Partitions/<hash>/Network/Cookies`（0 条、0 字节），
`worst` 原先只按 level 排序 → `--auto-run` 报「600 字节 0%，无需清理」，
而真库是 16117 字节。已改为**有令牌优先 → 有 cookie 优先 → 再比 level**；
连带修掉 reduce 以 null 起始导致永远返回 null 的缺陷。

### 0.4.0 的能力（本轮前半段）

- `cookies` 子命令：测量 + 清理（`--prune/--keep/--dry-run/--from-backup`）
- 桌面救援台（纯 ASCII `.cmd` + Node 菜单）
- 启动期 cookie 体检（延迟、不阻塞、读不到回退读备份）
- `web_auth` 改为可预检

### 顺带修掉 0.3.1 的真 bug

`client.js` 里 `driftLines` 被使用 5 次却**从未声明**（`drift`/`report.drift` 全无），
面板一打开就 `ReferenceError`。已补回 `drift`/`driftLines`/`cookies`/`cookieReport`。

## 3. 四个踩过的坑（别重复）

1. **`.cmd` 不能写中文**：`cmd.exe` 按控制台代码页解析批处理，`chcp 65001` 对已读入行无效。
   现在 `rescue-console.cmd` 是纯 ASCII（测试有断言：非 ASCII 字节必须为 0）。
2. **会话沙箱写不了桌面**：`install-desktop.mjs` 在 DSH 会话里 `EPERM`，已改为友好提示。
   在普通 cmd 里跑即可，或直接双击 `bin\rescue-console.cmd`。
3. **client.js 是 CRLF**：改它时锚点必须带 `\r\n`，否则静默不匹配。
4. **`settings.section` 不能传 `locale`**：未注册的 namespace 会被宿主校验拒绝，
   而 `slots.inject` 回调是同步抛错 → 整个 client 半身加载失败 → 白屏。
   `test/client-section.test.mjs` 锁住了这一条。

## 4. 发布

| 项 | 状态 |
|---|---|
| 仓库 | `github.com/1250589385/dsh-rescue-guard`（远端 latest **0.3.1**，本地 prepared 0.5.0）|
| npm | latest **0.2.1**，未登录（`ENEEDAUTH`）|
| push 权限 | ❌ 本机无 git 凭据（无 `.gitconfig`、无 `.git-credentials`、无 SSH 私钥、凭据管理器无 GitHub 项），且 `git clone` 报 `Connection was reset` |

**推送需要你在有自己的凭据的机器上做**：

```bash
git clone https://github.com/1250589385/dsh-rescue-guard.git dsh-rescue-guard-src
# 把本目录的文件覆盖进去（保留 .git）
git add -A && git commit -m "feat: cookie auto-clean policy, rescue console, drift fix (0.5.0)"
git push origin main
```

发布前：`npm login` → `npm pack --dry-run` 核对 → `npm publish`。

## 5. 未验证

- 设置面板的「启动救援」分区**未在真实浏览器渲染验证**（本机无法操作宿主面板）。
  只做了静态安全校验（不传 locale、回调有 try/catch、组件导入齐全）。
  首次装上后若白屏，优先查这三条。
- `bin/rescue-console.cmd` 的**真机双击**环境（工作目录 / UAC / 杀软）未测；
  已用 `cmd /c rescue-console.cmd` 验证菜单渲染与 Node 探测。
