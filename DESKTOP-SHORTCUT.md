# 把这个救援台放到桌面（一条命令）

## 方式 A：命令行（推荐）

```
cd <本插件目录>
node bin/install-desktop.mjs
```

成功会在桌面生成 `DSH 救援台.cmd`，双击即开。

## 方式 B：手动建快捷方式

1. 右键桌面 → 新建 → 快捷方式
2. 目标填（替换成你的实际路径）：

   ```
   <本插件目录>\bin\rescue-console.cmd
   ```

3. 名称写 `DSH 救援台`，完成。

## 如果方式 A 报「无权写入桌面目录」

在普通 cmd / PowerShell 窗口里重跑同一条命令即可。这个报错通常是因为：

- 命令是在 DSH 会话里执行的，而会话有文件系统沙箱，写不到桌面；
- 或桌面被 OneDrive 重定向 / 受控文件夹访问拦住。

功能完全不受影响——你随时可以直接双击 `bin\rescue-console.cmd`，效果一样。

## 为什么 .cmd 里没有一个中文字

`cmd.exe` 按**控制台代码页**解析批处理文件，`chcp 65001` 对已经读入的行不起作用。
第一版把中文菜单写进 .cmd，实测输出变成一片
`'…' is not recognized as an internal or external command`。
所以 `.cmd` 现在只有 20 行纯 ASCII：找 Node、调 `dsh-rescue.mjs menu`，
所有中文界面由 Node 渲染（UTF-8 天然正确）。
