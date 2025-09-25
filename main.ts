import { App, MarkdownView, Plugin, PluginSettingTab, Setting } from 'obsidian';
import { exec, execSync } from 'child_process';
import { EditorView } from '@codemirror/view';
import { syntaxTree } from '@codemirror/language';

type OS = 'macos' | 'windows' | 'linux';

interface PlatformSetting {
  pathToIM: string; // Additional PATH to the input method executable
  cmdOnInsertEnter: string; // Command executed when entering Insert mode
  cmdOnInsertLeave: string; // Command executed when leaving Insert mode
  cmdOnInsertEnterMathEnter: string; // Command executed when entering a math block within Insert mode
  cmdOnInsertEnterMathLeave: string; // Command executed when leaving a math block within Insert mode
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
    pathToIM: '/opt/homebrew/bin',
    cmdOnInsertEnter: 'im-select im.rime.inputmethod.Squirrel.Hans',
    cmdOnInsertLeave: 'im-select com.apple.keylayout.ABC',
    cmdOnInsertEnterMathEnter: 'im-select com.apple.keylayout.ABC',
    cmdOnInsertEnterMathLeave: 'im-select im.rime.inputmethod.Squirrel.Hans',
  },
  windows: {
    pathToIM: '%USERPROFILE%\\AppData\\Local\\bin',
    cmdOnInsertEnter: 'im-select.exe 2052',
    cmdOnInsertLeave: 'im-select.exe 1033',
    cmdOnInsertEnterMathEnter: 'im-select.exe 1033',
    cmdOnInsertEnterMathLeave: 'im-select.exe 2052',
  },
  linux: {
    pathToIM: '/usr/bin',
    cmdOnInsertEnter: 'ibus engine cn.some-ime',
    cmdOnInsertLeave: 'ibus engine xkb:us::eng',
    cmdOnInsertEnterMathEnter: 'ibus engine xkb:us::eng',
    cmdOnInsertEnterMathLeave: 'ibus engine cn.some-ime',
  },
  statusBar: false,
  asyncExec: true,
};

export default class IMEOrchestrator extends Plugin {
  settings: OrchestratorSettings;
  platform: OS;
  private plat: PlatformSetting;
  private statusEl: HTMLElement;

  private isInsert = false;
  private inMath = false;
  private hookedEditors = new WeakSet<object>();

  // 尝试从 MarkdownView 获取可监听 'vim-mode-change' 的事件源（兼容不同 Obsidian/CM 版本）
  // Type guard for objects with an 'on' method
  private hasOnMethod(obj: unknown): obj is { on: (ev: string, cb: any) => void } {
    return !!obj && typeof (obj as any).on === 'function';
  }

  private getVimEventSourceFromView(view: MarkdownView): { on: (ev: string, cb: any) => void } | null {
    // Try to safely access possible event sources
    const candidates: unknown[] = [];
    // Check for sourceMode?.cmEditor?.cm?.cm
    if (
      typeof (view as any).sourceMode === 'object' &&
      typeof (view as any).sourceMode.cmEditor === 'object' &&
      typeof (view as any).sourceMode.cmEditor.cm === 'object' &&
      typeof (view as any).sourceMode.cmEditor.cm.cm === 'object'
    ) {
      candidates.push((view as any).sourceMode.cmEditor.cm.cm);
    }
    // Check for sourceMode?.cmEditor?.cm
    if (
      typeof (view as any).sourceMode === 'object' &&
      typeof (view as any).sourceMode.cmEditor === 'object' &&
      typeof (view as any).sourceMode.cmEditor.cm === 'object'
    ) {
      candidates.push((view as any).sourceMode.cmEditor.cm);
    }
    // Check for editor?.cm?.cm
    if (
      typeof (view as any).editor === 'object' &&
      typeof (view as any).editor.cm === 'object' &&
      typeof (view as any).editor.cm.cm === 'object'
    ) {
      candidates.push((view as any).editor.cm.cm);
    }
    // Check for editor?.cm
    if (
      typeof (view as any).editor === 'object' &&
      typeof (view as any).editor.cm === 'object'
    ) {
      candidates.push((view as any).editor.cm);
    }
    for (const c of candidates) {
      if (this.hasOnMethod(c)) return c;
    }
    return null;
  }

  // 尝试从 MarkdownView 获取 CodeMirror 6 的 EditorView，用于数学块判定
  // Type guard for EditorView (minimal)
  private isEditorView(obj: unknown): obj is EditorView {
    return (
      !!obj &&
      typeof (obj as any).state === 'object' &&
      typeof (obj as any).dispatch === 'function'
    );
  }

  private getEditorViewFromView(view: MarkdownView): EditorView | null {
    const candidates: unknown[] = [];
    // Check for editor?.cm?.view
    if (
      typeof (view as any).editor === 'object' &&
      typeof (view as any).editor.cm === 'object' &&
      typeof (view as any).editor.cm.view === 'object'
    ) {
      candidates.push((view as any).editor.cm.view);
    }
    // Check for sourceMode?.cmEditor?.cm?.view
    if (
      typeof (view as any).sourceMode === 'object' &&
      typeof (view as any).sourceMode.cmEditor === 'object' &&
      typeof (view as any).sourceMode.cmEditor.cm === 'object' &&
      typeof (view as any).sourceMode.cmEditor.cm.view === 'object'
    ) {
      candidates.push((view as any).sourceMode.cmEditor.cm.view);
    }
    for (const v of candidates) {
      if (this.isEditorView(v)) {
        return v;
      }
    }
    return null;
  }

  async onload() {
    await this.loadSettings();
    this.platform = process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'windows' : 'linux';
    this.plat = this.settings[this.platform];
    this.extendPATH(this.plat.pathToIM);

    this.statusEl = this.addStatusBarItem();
    this.setStatus('');

    // Vim 模式切换
    this.registerEvent(this.app.workspace.on('active-leaf-change', () => this.hookVim()));
    this.registerEvent(this.app.workspace.on('file-open', () => this.hookVim()));
    this.hookVim();

    // Insert 内数学块自动切换
    this.registerEditorExtension(
      EditorView.updateListener.of((update) => {
        if (!this.isInsert) return;
        if (!(update.docChanged || update.selectionSet)) return;
        const nowInMath = this.isCursorInMath(update.view);
        if (nowInMath === this.inMath) return;
        this.inMath = nowInMath;
        if (this.inMath) {
          this.execMaybeAsync(this.plat.cmdOnInsertEnterMathEnter);
        } else {
          this.execMaybeAsync(this.plat.cmdOnInsertEnterMathLeave);
        }
      })
    );

    this.addSettingTab(new OrchestratorSettingTab(this.app, this));
  }

  onunload(): void {}

  private hookVim() {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view) return;
    const emitter = this.getVimEventSourceFromView(view);
    if (!emitter) return;
    if (this.hookedEditors.has(emitter)) return;

    emitter.on('vim-mode-change', (modeObj: any) => {
      if (!modeObj) return;
      const wasInsert = this.isInsert;
      this.isInsert = modeObj.mode === 'insert';
      if (this.isInsert && !wasInsert) {
        // 若进入时光标在数学块，由 MathEnter 处理；否则执行 InsertEnter
        const cmView = this.getEditorViewFromView(view);
        if (cmView && this.isCursorInMath(cmView)) return;
        this.execMaybeAsync(this.plat.cmdOnInsertEnter);
      }
      if (!this.isInsert && wasInsert) {
        this.inMath = false;
        this.execMaybeAsync(this.plat.cmdOnInsertLeave);
      }
    });
    this.hookedEditors.add(emitter);
  }

  private isCursorInMath(view: EditorView): boolean {
    try {
      const state = view.state;
      const pos = state.selection.main.head;
      const tree = syntaxTree(state);
      let node = tree.resolveInner(pos, -1);
      while (node) {
        const name = node.name.toLowerCase();
        if (name.includes('math')) {
          if (name.includes('math-end') && pos > node.to) return false;
          if (name.includes('math-begin') && pos < node.from) return false;
          return true;
        }
        node = node.parent;
      }
    } catch (_) {}
    // 回退：使用结构化的 $/$$ 判定（可读性更高）
    const text = view.state.doc.toString();
    const pos = view.state.selection.main.head;
    return this.isInDollarMath(text, pos);
  }

  // -- Fallback parsing: $ / $$ --
  private isInDollarMath(text: string, pos: number): boolean {
    return this.isInsideBlockMath(text, pos) || this.isInsideInlineMath(text, pos);
  }

  private isInsideBlockMath(text: string, pos: number): boolean {
    // 规则：未转义的“$$ … $$”，若右侧未找到收尾也视为在块内
    const left = this.lastIndexOfUnescaped(text, '$$', Math.max(0, pos - 1));
    if (left === -1) return false;
    const right = this.indexOfUnescaped(text, '$$', left + 2);
    if (right === -1) return pos > left; // 未闭合，仍视为块内
    return pos > left && pos <= right;
  }

  private isInsideInlineMath(text: string, pos: number): boolean {
    // 规则：未转义的“$ … $”（两侧不是 $$）
    const left = this.lastIndexOfUnescaped(text, '$', Math.max(0, pos - 1), /*singleOnly*/ true);
    if (left === -1) return false;
    const right = this.indexOfUnescaped(text, '$', left + 1, /*singleOnly*/ true);
    if (right === -1) return pos > left; // 未闭合，仍视为内
    return pos > left && pos <= right;
  }

  private lastIndexOfUnescaped(text: string, token: '$' | '$$', from: number, singleOnly = false): number {
    for (let i = from; i >= 0; i--) {
      if (token === '$$') {
        if (i >= 1 && text[i - 1] === '$' && text[i] === '$' && !this.isEscaped(text, i - 1)) return i - 1;
      } else {
        // 单个 $，需要排除 $$
        if (text[i] === '$' && !this.isEscaped(text, i)) {
          const isDouble = i + 1 < text.length && text[i + 1] === '$';
          if (!isDouble || !singleOnly) return i;
        }
      }
    }
    return -1;
  }

  private indexOfUnescaped(text: string, token: '$' | '$$', from: number, singleOnly = false): number {
    for (let i = from; i < text.length; i++) {
      if (token === '$$') {
        if (i + 1 < text.length && text[i] === '$' && text[i + 1] === '$' && !this.isEscaped(text, i)) return i + 1;
      } else {
        if (text[i] === '$' && !this.isEscaped(text, i)) {
          const isDouble = i + 1 < text.length && text[i + 1] === '$';
          if (!isDouble || !singleOnly) return i;
        }
      }
    }
    return -1;
  }

  private isEscaped(text: string, idx: number): boolean {
    // 统计 idx 之前连续反斜杠数量，奇数为转义
    let count = 0;
    let i = idx - 1;
    while (i >= 0 && text[i] === '\\') { count++; i--; }
    return (count % 2) === 1;
  }

  private extendPATH(extra: string) {
    const delim = process.platform === 'win32' ? ';' : ':';
    process.env.PATH = `${process.env.PATH || ''}${delim}${extra}`;
  }

  private execMaybeAsync(command: string) {
    if (!command || command.trim() === '') return;
    if (this.settings.asyncExec) {
      this.execAsync(command).catch(() => this.setStatus('IME ERR'));
    } else {
      try { this.execSync(command); } catch { this.setStatus('IME ERR'); }
    }
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
    try {
      return execSync(command, { encoding: 'utf-8' });
    } catch (error) {
      console.error('execSync error:', error);
      return '';
    }
  }

  private setStatus(msg: string) {
    if (!this.settings.statusBar) return;
    this.statusEl?.setText(msg || '');
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULTS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }
}

class OrchestratorSettingTab extends PluginSettingTab {
  plugin: IMEOrchestrator;
  constructor(app: App, plugin: IMEOrchestrator) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl('h3', { text: '平台命令' });
    this.section(containerEl, 'macOS', this.plugin.settings.macos);
    this.section(containerEl, 'Windows', this.plugin.settings.windows);
    this.section(containerEl, 'Linux', this.plugin.settings.linux);
    containerEl.createEl('h3', { text: '通用' });
    new Setting(containerEl).setName('异步执行').setDesc('启用子进程异步执行命令')
      .addToggle(t => 
        t.setValue(this.plugin.settings.asyncExec).onChange(async v => {
          this.plugin.settings.asyncExec = v;
          await this.plugin.saveSettings();
        })
      );
    new Setting(containerEl).setName('状态栏提示').setDesc('在状态栏显示错误提示')
      .addToggle(t => 
        t.setValue(this.plugin.settings.statusBar).onChange(async v => {
          this.plugin.settings.statusBar = v;
          await this.plugin.saveSettings();
        })
      );
  }

  private section(containerEl: HTMLElement, title: string, s: PlatformSetting) {
    containerEl.createEl('h4', { text: title });
    new Setting(containerEl).setName('PATH to IM Tool').addText(t => t.setValue(s.pathToIM).onChange(async v => { s.pathToIM = v; await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName('On InsertEnter').addText(t => t.setValue(s.cmdOnInsertEnter).onChange(async v => { s.cmdOnInsertEnter = v; await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName('On InsertLeave').addText(t => t.setValue(s.cmdOnInsertLeave).onChange(async v => { s.cmdOnInsertLeave = v; await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName('On InsertEnter MathEnter').addText(t => t.setValue(s.cmdOnInsertEnterMathEnter).onChange(async v => { s.cmdOnInsertEnterMathEnter = v; await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName('On InsertEnter MathLeave').addText(t => t.setValue(s.cmdOnInsertEnterMathLeave).onChange(async v => { s.cmdOnInsertEnterMathLeave = v; await this.plugin.saveSettings(); }));
  }
}
