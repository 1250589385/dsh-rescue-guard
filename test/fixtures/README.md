# 测试夹具

这两个目录是**故意**的坏/好样本，用来锁住预检第 4 条规则的边界：

- `plugin-with-private-hook/session-pwsh.js`：`dsh-ops@0.3.0` 的肇事写法原文（订阅
  `internal/config` 并在回调里读 `this.entry`）。`test/regression.mjs` 断言它**必须命中**。
- `plugin-normal/pack.js`：普通类里恰好有一个 `entry` 字段。断言它**不得误报**——
  0.3.0 的第一版正则（`/this\.entry/`）在这里产生过 2 个假阳性。

不要"修好"这两个文件。
