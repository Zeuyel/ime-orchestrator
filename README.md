# IME Orchestrator for Obsidian

在 Obsidian 的 Vim 模式下，按场景自动切换输入法：
- 进入 Insert：执行一条命令（通常切到“文本输入法”）。
- 退出 Insert：执行一条命令（通常切回“英文/导航输入法”）。
- Insert 模式内：进入/离开数学块（$ 与 $$）各执行一条命令。

所有切换均可自定义：数学块进入/退出可与 Insert 的 A/B 不同，你可以设置为 C/D。

## 使用方法（一般 → 进阶）
1) 安装与启用
- 将 `ime-orchestrator` 拷贝到 `<vault>/.obsidian/plugins/ime-orchestrator/`，在 Obsidian 中启用。

2) 最小配置（多数用户）
- On InsertEnter：你的“文本输入法”（B，例如中文 IME）。
- On InsertLeave：你的“英文/导航输入法”（A）。

3) 进阶配置（数学块差异化）
- On InsertEnter MathEnter：进入数学块时的输入法（可与 A 相同）。
- On InsertEnter MathLeave：离开数学块时的输入法（可与 B 相同，或自定义为 C/D）。

推荐工具：im-select（跨平台稳定）
示例（macOS）：
```
On InsertEnter:            im-select im.rime.inputmethod.Squirrel.Hans   # B/C
On InsertLeave:            im-select com.apple.keylayout.ABC             # A
On InsertEnter MathEnter:  im-select com.apple.keylayout.ABC             # A/D
On InsertEnter MathLeave:  im-select im.rime.inputmethod.Squirrel.Hans   # B/C
```

## 常见问题（FAQ）
- 切换时界面闪动或输入无效？
  - 请使用 im-select，并避免同时启用多个会切换输入法的插件。
- 如何找到输入法标识？
  - 在终端运行 `im-select` 查看/切换；或参考系统输入法的标识命名。

## 开发与构建
```bash
npm i
npm run dev
npm run build
```

## 提示
- 建议只启用一个会切换输入法的插件，避免叠加触发。
