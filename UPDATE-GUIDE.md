# dsh-rescue-guard 0.5.0 更新操作手册

> 目标：把本机 0.3.1 换成 0.5.0，并把源码推上 GitHub。
> 每一步都写了「为什么」和「怎么确认成功」，失败时看最后一节。

---

## 步骤 0：先看清现状（30 秒）

打开一个**普通 cmd 窗口**（不是 DSH 会话）：

```bat
cd %USERPROFILE%\.dsh\profiles\desktop
node -e "console.log(require('./node_modules/dsh-rescue-guard/package.json').version)"
```

应该输出 `0.3.1`。这是旧版本，下面换掉它。

**为什么在普通 cmd 里做**：DSH 会话有文件沙箱，写不到桌面、也可能拦 spawn。

---

## 步骤 1：推送 GitHub（先做这个，留一条可回退的路）

### 1.1 clone 远端（拿到完整 git 历史）

```bat
cd /d D:\Worksp
git clone https://github.com/1250589385/dsh-rescue-guard.git rg-src
cd rg-src
git log --oneline
```

应该看到 `41756e9 ...` 开头的提交（远端 latest = v0.3.1）。

**为什么必须 clone，而不是直接用我那个目录**：我这边那个目录是**空仓库**（0 个 commit）。
在空仓库上 `git push` 会覆盖远端全部历史，tag 和之前的提交都会丢。所以我是故意没帮你推的。

### 1.2 把新版本覆盖进去

```bat
:: 解压交付包
cd /d D:\Worksp
powershell -NoProfile -Command "Expand-Archive -Path 'dsh-rescue-guard-0.5.0.zip' -DestinationPath 'rg-new' -Force"

:: 覆盖（保留 .git）
robocopy D:\Worksp\rg-new\dsh-rescue-guard D:\Worksp\rg-src /E /XD .git /NFL /NDL /NJH /NJS
```

`robocopy` 返回码 **0-7 都算成功**（1 = 复制了文件），8 才是失败。别被红字吓到。

### 1.3 检查差异再提交

```bat
cd /d D:\Worksp\rg-src
git status
git diff --stat
```

**重点看有没有删除项**。正常只有新增和修改，**不应该出现 `D`（删除）**。
`DESIGN.md` 已补进包里了（远端独有文件，我最初漏了）。

确认无误后：

```bat
git add -A
git commit -m "feat(cookies): auto-clean policy, rescue console, drift fix (0.5.0)"
git push origin main
```

### 1.4 第一次 push 会弹窗要凭据

你机器上已装 Git Credential Manager（GCM 2.9.1）。第一次 push 会自动弹浏览器让你授权。
**这就是「浏览器登录了 GitHub」但命令行没权限的原因**——浏览器登录态和 git 凭据是两套东西。
授权一次后凭据进 Windows 凭据管理器，以后不再问。

---

## 步骤 2：更新本机安装（换成 0.5.0）

### 2.1 先备份旧版本（方便回退）

```bat
cd /d %USERPROFILE%\.dsh\profiles\desktop
xcopy node_modules\dsh-rescue-guard node_modules\dsh-rescue-guard.bak-0.3.1 /E /I /Q
```

### 2.2 用本地目录安装（最快，不依赖 npm）

**先完全退出 DSH**（含托盘图标右键退出），然后：

```bat
cd /d %USERPROFILE%\.dsh\profiles\desktop
dsh plugin add file:D:\Worksp\_rg040\dsh-rescue-guard
```

**为什么用 `file:`**：这是你机器上其他插件（workbuddy-fix、our-free-model、tool-git）
正在用的同一套写法。装完后 `package.json` 的 `dependencies` 会记成
`file:D:/Worksp/_rg040/dsh-rescue-guard` —— 你本地改代码、重启就生效，不用每次发布。

### 2.3 或者：等 GitHub 推送后从仓库装

```bat
dsh plugin add github:1250589385/dsh-rescue-guard
```

写法与 `dsh-quick-send`、`dsh-test-autofix` 一致。缺点：装的是默认分支最新提交，
本地改代码后要重新装一次。

### 2.4 确认装好了

```bat
node -e "console.log(require('./node_modules/dsh-rescue-guard/package.json').version)"
```

应输出 `0.5.0`。

---

## 步骤 3：重启 DSH，逐项验证

### 3.1 自检

```bat
cd /d %USERPROFILE%\.dsh\profiles\desktop\node_modules\dsh-rescue-guard
node test/regression.mjs
```

期望：**全部通过：50 项**。

### 3.2 看设置面板（重点，我没在真机验证过）

DSH → 设置 → 左栏应多出 **「启动救援」**（在「记忆」附近）。
里面三项：自动清理开关、保留最新令牌数、「立即清理」按钮。

**如果白屏或提示 `Failed to load plugins`**：设置分区注册出问题。
立刻按步骤 4 回退，把控制台报错发我。已知两个原因：
- `slots.register` 传了 `locale`（未注册的 namespace 会被校验拒绝）
- `slots.inject` 回调里同步抛错

代码里两处都做了防护并有测试锁住，但真机渲染我无法验证。

### 3.3 桌面救援台

```bat
cd /d %USERPROFILE%\.dsh\profiles\desktop\node_modules\dsh-rescue-guard
node bin\install-desktop.mjs
```

桌面出现 `DSH 救援台.cmd`，双击应看到菜单（含 `[9]` 自动清理策略）。

### 3.4 控制台调试 Cookie 策略

```bat
cd /d %USERPROFILE%\.dsh\profiles\desktop\node_modules\dsh-rescue-guard\bin
dsh-rescue.cmd cookies --policy
dsh-rescue.cmd cookies --auto on
```

第二条应输出「✓ 自动清理：已开启」并打印策略表。

---

## 步骤 4：回退（任何一步不对就这么做）

```bat
:: 完全退出 DSH
cd /d %USERPROFILE%\.dsh\profiles\desktop
rmdir /s /q node_modules\dsh-rescue-guard
xcopy node_modules\dsh-rescue-guard.bak-0.3.1 node_modules\dsh-rescue-guard /E /I /Q
```

然后重启 DSH，确认版本回到 0.3.1。

---

## 附：npm 发布（可选，最后做）

```bat
cd /d D:\Worksp\rg-src
npm login          :: 浏览器授权，与 GitHub 无关
npm whoami         :: 应显示 raysnows
npm pack --dry-run :: 核对清单，必须有 lib/cookies.js / lib/menu.js / lib/config.js
npm publish
```

`files` 已含 `lib`/`bin`/`locale`/`test`，新文件都在通配内。
`DESKTOP-SHORTCUT.md` 故意不发布（仓库文档，非运行必需）。

---

## 失败排查

| 现象 | 原因 | 处理 |
|---|---|---|
| `fatal: your current branch does not have any commits yet` | 在空仓库里操作 | 按 1.1 重新 clone |
| push 弹不出浏览器 | GCM 未配置 | `git config --global credential.helper manager` |
| `git clone` 报 `Connection was reset` | 国际链路不稳 | 重试，或换网络 |
| `dsh plugin add` 无反应 | DSH 还在跑 | 完全退出（含托盘图标）再试 |
| 设置面板白屏 | `settings.section` 注册失败 | 回退到 0.3.1，把报错发我 |
| `cookies --policy` 报 profile 不存在 | 传了错的 `--home` | 这条命令不依赖 profile，直接跑 |
