# IME Orchestrator 输入法切换问题修复报告

## 问题描述

在整合插件中，输入法切换存在严重的用户体验问题：
1. **首次进入插入模式正常**：第一次执行 `insertenter` 时输入法切换工作正常
2. **后续进入插入模式异常**：之后每次执行 `insertenter` 都会出现：
   - 鼠标显示，窗口抖动（视觉闪烁/重新渲染）
   - 输入无效（键盘输入不被识别），等待抖动完成后才能够输入

## 根本原因分析

### 1. 重复的事件监听器注册
- 原代码使用简单的 `_imeOrchHooked` 标记来防止重复注册
- 但在某些情况下，同一个编辑器可能被多次注册监听器
- 导致单个 Vim 模式变化触发多个回调

### 2. 时序冲突问题
- `onInsertEnter()` 和数学块检测的 `EditorView.updateListener` 在同一帧内执行
- 可能导致多个输入法切换命令同时执行
- 造成输入法状态混乱和界面抖动

### 3. 竞态条件
- 异步执行的输入法切换命令可能重叠
- 没有适当的队列机制来处理连续的命令请求

### 4. 去重时间窗口不足
- 原来的 120ms 去重窗口对于复杂的编辑器状态变化来说太短

## 修复方案

### 1. 改进事件监听器管理
```typescript
// 使用 WeakSet 来跟踪已钩子的编辑器
private hookedEditors = new WeakSet<any>();

private hookVim() {
  // ... 
  if (this.hookedEditors.has(cm)) return;
  // ...
  this.hookedEditors.add(cm);
}
```

### 2. 添加异步处理和状态稳定化
```typescript
// 使用 setTimeout 确保在下一个事件循环中执行
cm.on("vim-mode-change", (modeObj: any) => {
  setTimeout(() => {
    this.handleVimModeChange(modeObj);
  }, 0);
});
```

### 3. 实现命令执行队列机制
```typescript
// 防止重复执行和竞态条件
private isExecutingCommand = false;
private pendingCommand: string | null = null;

private execMaybeAsync(command: string) {
  if (this.isExecutingCommand) {
    this.pendingCommand = command;
    return;
  }
  // ... 执行命令并在完成后处理待执行命令
}
```

### 4. 增加状态检查延迟
```typescript
private onInsertEnter() {
  // 延迟检查数学块状态，确保编辑器状态已稳定
  setTimeout(() => {
    // 检查数学块状态并执行相应命令
  }, 50);
}
```

### 5. 扩展去重时间窗口
```typescript
// 从 120ms 增加到 300ms
private _dedupe(cmd: string, windowMs = 300): boolean
```

## 修复效果

这些修复应该能够解决：
1. **窗口抖动问题**：通过命令队列和去重机制避免重复执行
2. **输入失效问题**：通过状态稳定化确保输入法切换在正确时机执行
3. **竞态条件**：通过执行队列确保命令按顺序执行
4. **时序冲突**：通过延迟执行避免同帧内的冲突

## 测试建议

1. 重新加载插件后测试多次进入/离开插入模式
2. 测试在数学块内外的输入法切换
3. 测试快速连续的模式切换操作
4. 验证输入法状态的一致性和稳定性
