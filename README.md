# IME Orchestrator for Obsidian

在不修改现有插件的前提下，统一协调输入法切换：
- 退出 Insert 模式后：不因数学块边界发生任何输入法变化；
- 进入 Insert 模式后：仅由数学块监听负责切换输入法（数学区域→英文，离开→恢复上次非英文）。

## 使用方法
1. 将 `ime-orchestrator` 目录复制到你的库：`<vault>/.obsidian/plugins/ime-orchestrator/`。
2. 在设置中配置输入法命令（无缓存，直接执行）：
   - On InsertEnter（进入 Insert，切到 B）
   - On InsertLeave（离开 Insert，切到 A）
   - On InsertEnter MathEnter（Insert 内进入数学块，切到 A）
   - On InsertEnter MathLeave（Insert 内离开数学块，切回 B）
3. 启用插件并根据需要打开状态栏提示。

## 开发
```bash
npm i
npm run dev   # 开发模式（watch + bundle）
npm run build # 产物构建（main.js）
```

## 注意
- 插件内部自决策分支逻辑，与其他 IM 插件可共存但建议避免重复切换；
- 若已安装类似功能插件，建议关闭其 InsertEnter/Leave 自动切换功能。
