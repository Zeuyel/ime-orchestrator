import { App, MarkdownView, Plugin, PluginSettingTab, Setting } from "obsidian";
import { exec, execSync } from "child_process";
import { EditorView } from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";

type OS = "macos" | "windows" | "linux";

interface PlatformSetting {
  pathToIM: string; // 追加到 PATH
  cmdOnInsertEnter: string; // 进入 Insert 执行（无缓存，直接执行）
  cmdOnInsertLeave: string; // 离开 Insert 执行
  cmdOnInsertEnterMathEnter: string; // Insert 模式下进入数学块
  cmdOnInsertEnterMathLeave: string; // Insert 模式下离开数学块
}

interface OrchestratorSettings {
  macos: PlatformSetting;
  windows: PlatformSetting;
  linux: PlatformSetting;
  statusBar: boolean;
  asyncExec: boolean;
}

const DEFAULTS: OrchestratorSettings = {
  macos: {
    pathToIM: "/opt/homebrew/bin",
    cmdOnInsertEnter: "macism im.rime.inputmethod.Squirrel.Hans", // 示例：B
    cmdOnInsertLeave: "macism com.apple.keylayout.ABC", // 示例：A
    cmdOnInsertEnterMathEnter: "macism com.apple.keylayout.ABC", // A
    cmdOnInsertEnterMathLeave: "macism im.rime.inputmethod.Squirrel.Hans", // B
  },
  windows: {
    pathToIM: "%USERPROFILE%\\AppData\\Local\\bin",
    cmdOnInsertEnter: "im-select.exe 2052", // 示例：B（中文）
    cmdOnInsertLeave: "im-select.exe 1033",
    cmdOnInsertEnterMathEnter: "im-select.exe 1033",
    cmdOnInsertEnterMathLeave: "im-select.exe 2052",
  },
  linux: {
    pathToIM: "/usr/bin",
    cmdOnInsertEnter: "ibus engine cn.some-ime", // 示例：B
    cmdOnInsertLeave: "ibus engine xkb:us::eng",
    cmdOnInsertEnterMathEnter: "ibus engine xkb:us::eng",
    cmdOnInsertEnterMathLeave: "ibus engine cn.some-ime",
  },
  statusBar: false,
  asyncExec: true,
};

export default class IMEOrchestrator extends Plugin {
  settings: OrchestratorSettings;
  platform: OS;
  private plat: PlatformSetting;
  private statusEl: HTMLElement;

  // 运行时状态
  private isInsert = false; // 当前是否在 Insert 模式
  private inMath = false; // 光标是否在数学区域（仅在 Insert 内跟踪）
  private prevVimMode = "normal"; // 上一次 Vim 模式

  // 防止重复执行和竞态条件
  private isExecutingCommand = false; // 是否正在执行输入法切换命令
  private pendingCommand: string | null = null; // 待执行的命令
  private hookedEditors = new WeakSet<any>(); // 已经钩子的编辑器

  async onload() {
    await this.loadSettings();
    this.platform = process.platform === "darwin" ? "macos" : process.platform === "win32" ? "windows" : "linux";
    this.plat = this.settings[this.platform];
    this.extendPATH(this.plat.pathToIM);

    this.statusEl = this.addStatusBarItem();
    this.setStatus("");

    // 监听 Vim 模式切换
    this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.hookVim()))
    this.registerEvent(this.app.workspace.on("file-open", () => this.hookVim()))
    this.hookVim();

    // 仅用于数学块切换：Insert 模式内监听编辑器事务（无缓存，直接执行）
    this.registerEditorExtension(
      EditorView.updateListener.of((update) => {
        if (!this.isInsert) return;
        if (!(update.docChanged || update.selectionSet)) return;

        const nowInMath = this.isCursorInMath(update.view);
        if (nowInMath === this.inMath) return;
        this.inMath = nowInMath;
        if (this.inMath) {
          // Math Enter：直接执行“进入数学块”命令（切到 A）
          this.execMaybeAsync(this.plat.cmdOnInsertEnterMathEnter);
        } else {
          // Math Leave：直接执行“离开数学块”命令（切回 B）
          this.execMaybeAsync(this.plat.cmdOnInsertEnterMathLeave);
        }
      })
    );

    this.addSettingTab(new OrchestratorSettingTab(this.app, this));
  }

  onunload(): void {}

  // —— Vim 模式钩子 ——
  private hookVim() {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    const cm = (view as any)?.sourceMode?.cmEditor?.cm?.cm;
    if (!cm) return;
    if (this.hookedEditors.has(cm)) return;

    cm.on("vim-mode-change", (modeObj: any) => {
      if (!modeObj) return;

      // 使用 setTimeout 确保在下一个事件循环中执行，避免与其他事件冲突
      setTimeout(() => {
        this.handleVimModeChange(modeObj);
      }, 0);
    });

    this.hookedEditors.add(cm);
  }

  private handleVimModeChange(modeObj: any) {
    const wasInsert = this.isInsert;
    this.isInsert = modeObj.mode === "insert";

    switch (modeObj.mode) {
      case "insert":
        if (!wasInsert) { // 只在真正进入 Insert 模式时执行
          this.onInsertEnter();
        }
        break;
      default:
        if (this.prevVimMode === "insert" && wasInsert) { // 只在真正离开 Insert 模式时执行
          this.onInsertLeave();
        }
        break;
    }
    this.prevVimMode = modeObj.mode;
  }

  // —— 数学块判定 ——
  private isCursorInMath(view: EditorView): boolean {
    try {
      const state = view.state;
      const pos = state.selection.main.head;
      const tree = syntaxTree(state);
      let node = tree.resolveInner(pos, -1);
      while (node) {
        const name = node.name.toLowerCase();
        if (name.includes("math")) {
          if (name.includes("math-end") && pos > node.to) return false;
          if (name.includes("math-begin") && pos < node.from) return false;
          return true;
        }
        node = node.parent;
      }
    } catch (_) {}
    // 退化：基于文本的 $ / $$ 粗略判断（避免无语法树时误判）
    const text = view.state.doc.toString();
    const pos = view.state.selection.main.head;
    let i = 0;
    while (i < text.length) {
      if (text[i] === "$") {
        if (i + 1 < text.length && text[i + 1] === "$") {
          const start = i; i += 2; let end = -1;
          while (i + 1 < text.length) { if (text[i] === "$" && text[i + 1] === "$") { end = i + 1; break; } i++; }
          if (end !== -1 && pos > start && pos <= end) return true;
          if (end === -1 && pos > start) return true;
          i = end !== -1 ? end + 1 : i;
        } else {
          const start = i; i++; let end = -1;
          while (i < text.length) { if (text[i] === "$" && (i + 1 >= text.length || text[i + 1] !== "$")) { end = i; break; } i++; }
          if (end !== -1 && pos > start && pos <= end) return true;
          if (end === -1 && pos > start) return true;
          i = end !== -1 ? end + 1 : i;
        }
      } else i++;
    }
    return false;
  }

  // —— 命令执行 ——
  private extendPATH(extra: string) {
    const delim = process.platform === "win32" ? ";" : ":";
    process.env.PATH = `${process.env.PATH || ""}${delim}${extra}`;
  }

  private injectIM(cmd: string, _im: string) { return cmd; }

  private execMaybeAsync(command: string) {
    // 防止重复执行和竞态条件
    if (!command || command.trim() === "") return;

    // 如果正在执行命令，将新命令设为待执行
    if (this.isExecutingCommand) {
      this.pendingCommand = command;
      return;
    }

    // 短时间内相同命令去重，避免重复切换导致界面闪动
    if (!this._dedupe(command)) return;

    this.isExecutingCommand = true;

    if (this.settings.asyncExec) {
      this.execAsync(command)
        .catch(() => this.setStatus(`IME ERR`))
        .finally(() => this.handleCommandComplete());
    } else {
      try {
        this.execSync(command);
      } catch {
        this.setStatus(`IME ERR`);
      } finally {
        this.handleCommandComplete();
      }
    }
  }

  private handleCommandComplete() {
    this.isExecutingCommand = false;

    // 如果有待执行的命令，执行它
    if (this.pendingCommand) {
      const cmd = this.pendingCommand;
      this.pendingCommand = null;
      // 使用 setTimeout 避免立即递归调用
      setTimeout(() => this.execMaybeAsync(cmd), 10);
    }
  }

  // —— 同目标命令去重（增加到 300ms 窗口以处理复杂场景）——
  private _lastCmd = "";
  private _lastAt = 0;
  private _dedupe(cmd: string, windowMs = 300): boolean {
    const now = Date.now();
    if (cmd && this._lastCmd === cmd && (now - this._lastAt) < windowMs) {
      return false;
    }
    this._lastCmd = cmd;
    this._lastAt = now;
    return true;
  }

  private execAsync(command: string): Promise<string> {
    return new Promise((resolve, reject) => {
      exec(command, (error, stdout, _stderr) => {
        if (error) { reject(error); return; }
        resolve(stdout?.toString().trim());
      });
    });
  }

  private execSync(command: string): string {
    try { return execSync(command, { encoding: "utf-8" }); } catch { return ""; }
  }

  private setStatus(msg: string) {
    if (!this.settings.statusBar) return;
    this.statusEl?.setText(msg || "");
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULTS, await this.loadData());
  }

  async saveSettings() { await this.saveData(this.settings); }

  // —— 无缓存核心：进入/离开 Insert ——
  private isOnInsertEnterEnabled() { return !!this.plat.cmdOnInsertEnter; }
  private isOnInsertLeaveEnabled() { return !!this.plat.cmdOnInsertLeave; }

  private onInsertEnter() {
    if (!this.isOnInsertEnterEnabled()) return;

    // 延迟检查数学块状态，确保编辑器状态已稳定
    setTimeout(() => {
      // 若当前在数学块，由 MathEnter 处理，避免与其同帧双触发
      const view = this.app.workspace.getActiveViewOfType(MarkdownView);
      const cmView: EditorView | undefined = (view as any)?.editor?.cm?.view;
      if (cmView && this.isCursorInMath(cmView)) {
        this.inMath = true;
        return;
      }

      this.inMath = false;
      this.execMaybeAsync(this.plat.cmdOnInsertEnter);
    }, 50); // 50ms 延迟确保编辑器状态稳定
  }

  private onInsertLeave() {
    if (!this.isOnInsertLeaveEnabled()) return;

    // 重置数学块状态
    this.inMath = false;
    this.execMaybeAsync(this.plat.cmdOnInsertLeave);
  }
}

class OrchestratorSettingTab extends PluginSettingTab {
  plugin: IMEOrchestrator;
  constructor(app: App, plugin: IMEOrchestrator) { super(app, plugin); this.plugin = plugin; }

  display(): void {
    const { containerEl } = this; containerEl.empty();
    containerEl.createEl("h3", { text: "平台命令" });
    this.section(containerEl, "macOS", this.plugin.settings.macos);
    this.section(containerEl, "Windows", this.plugin.settings.windows);
    this.section(containerEl, "Linux", this.plugin.settings.linux);

    containerEl.createEl("h3", { text: "通用" });
    new Setting(containerEl).setName("异步执行").setDesc("启用子进程异步执行命令")
      .addToggle(t => t.setValue(this.plugin.settings.asyncExec).onChange(async v => { this.plugin.settings.asyncExec = v; await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName("状态栏提示").setDesc("在状态栏显示错误提示")
      .addToggle(t => t.setValue(this.plugin.settings.statusBar).onChange(async v => { this.plugin.settings.statusBar = v; await this.plugin.saveSettings(); }));
  }

  private section(containerEl: HTMLElement, title: string, s: PlatformSetting) {
    containerEl.createEl("h4", { text: title });
    new Setting(containerEl).setName("PATH to IM Tool").addText(t => t.setValue(s.pathToIM).onChange(async v => { s.pathToIM = v; await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName("On InsertEnter").addText(t => t.setValue(s.cmdOnInsertEnter).onChange(async v => { s.cmdOnInsertEnter = v; await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName("On InsertLeave").addText(t => t.setValue(s.cmdOnInsertLeave).onChange(async v => { s.cmdOnInsertLeave = v; await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName("On InsertEnter MathEnter").addText(t => t.setValue(s.cmdOnInsertEnterMathEnter).onChange(async v => { s.cmdOnInsertEnterMathEnter = v; await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName("On InsertEnter MathLeave").addText(t => t.setValue(s.cmdOnInsertEnterMathLeave).onChange(async v => { s.cmdOnInsertEnterMathLeave = v; await this.plugin.saveSettings(); }));
  }
}
