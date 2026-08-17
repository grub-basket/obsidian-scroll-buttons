import {
  App,
  MarkdownView,
  Menu,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  WorkspaceLeaf,
  setIcon,
} from "obsidian";
import { EditorView, ViewUpdate } from "@codemirror/view";

type ScrollMode = "top" | "up" | "down" | "bottom";

/** A remembered cursor location, for the jump-between-carets feature. */
interface CaretPos {
  file: string;
  line: number;
  ch: number;
}

/** Min line distance for a cursor move to count as a "jump" worth recording. */
const CARET_JUMP_THRESHOLD = 10;
/** Cap on the caret jump-list length. */
const MAX_CARET_HISTORY = 50;

interface ButtonDef {
  mode: ScrollMode;
  /** Lucide icon id (rendered via setIcon). */
  icon: string;
  /** Human-readable label, used for the command name and tooltip. */
  label: string;
}

/** The four buttons, ordered top → bottom on screen. */
const BUTTON_DEFS: ButtonDef[] = [
  { mode: "top", icon: "chevrons-up", label: "Page top" },
  { mode: "up", icon: "chevron-up", label: "Page up" },
  { mode: "down", icon: "chevron-down", label: "Page down" },
  { mode: "bottom", icon: "chevrons-down", label: "Page bottom" },
];

interface PageScrollSettings {
  /** Master switch for the on-screen buttons. */
  showButtons: boolean;
  /** Hide the buttons when the focused pane has nothing to scroll. */
  smartHide: boolean;
  /** Keep the buttons faded out until the pointer hovers over them. */
  hoverOnly: boolean;
  /** Which of the four buttons to render. Commands/hotkeys are unaffected. */
  enabledButtons: Record<ScrollMode, boolean>;
  /** Page up/down distance as a percentage of the viewport height. */
  scrollPercent: number;
  /** Use a separate distance when in Reading view. */
  separateReadingSpeed: boolean;
  /** Page up/down distance (% of viewport) used in Reading view. */
  scrollPercentReading: number;
}

const DEFAULT_SETTINGS: PageScrollSettings = {
  showButtons: true,
  smartHide: true,
  hoverOnly: false,
  enabledButtons: { top: true, up: true, down: true, bottom: true },
  scrollPercent: 90,
  separateReadingSpeed: false,
  scrollPercentReading: 90,
};

export default class PageScrollPlugin extends Plugin {
  settings: PageScrollSettings;

  /**
   * One button container per Markdown pane (leaf), living inside that pane's
   * content element. This gives every split/tab its own buttons and keeps them
   * within the editor area (no sidebar overlap, works in pop-out windows).
   */
  private containers = new Map<WorkspaceLeaf, HTMLElement>();

  // --- Caret jump-list state (issue #1) ---
  /** Recorded jump-origin positions, oldest → newest. */
  private caretHistory: CaretPos[] = [];
  /** Pointer into caretHistory while navigating; -1 means "at the live cursor". */
  private caretIndex = -1;
  /** The most recent cursor position seen (to detect jumps). */
  private lastCaret: CaretPos | null = null;
  /** Live position captured when navigation starts, so forward can return to it. */
  private caretLive: CaretPos | null = null;
  /** Set while we move the cursor ourselves, so it isn't recorded as a jump. */
  private suppressCaretRecord = false;

  async onload() {
    await this.loadSettings();

    for (const def of BUTTON_DEFS) {
      this.addCommand({
        id: `page-scroll-${def.mode}`,
        name: def.label,
        // No default hotkeys — bind your own in Settings → Hotkeys.
        callback: () => this.scroll(def.mode),
      });
    }

    this.addCommand({
      id: "caret-jump-back",
      name: "Jump to previous cursor position",
      callback: () => this.jumpCaret(-1),
    });
    this.addCommand({
      id: "caret-jump-forward",
      name: "Jump to next cursor position",
      callback: () => this.jumpCaret(1),
    });

    // Track cursor movement in the editor to build the jump-list.
    this.registerEditorExtension([
      EditorView.updateListener.of((update) => this.handleCaretUpdate(update)),
    ]);

    this.addSettingTab(new PageScrollSettingTab(this.app, this));

    this.app.workspace.onLayoutReady(() => this.refresh());

    // Panes come and go (splits, tabs, pop-out windows) — reconcile on change.
    this.registerEvent(
      this.app.workspace.on("layout-change", () => this.refresh())
    );
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", () => this.refresh())
    );
    this.registerEvent(
      this.app.workspace.on("window-open", () => this.refresh())
    );
    this.registerEvent(
      this.app.workspace.on("window-close", () => this.refresh())
    );
    // Overflow (and thus smart-hide) can change on resize.
    this.registerEvent(
      this.app.workspace.on("resize", () => this.updateVisibility())
    );
  }

  onunload() {
    for (const container of this.containers.values()) container.remove();
    this.containers.clear();
  }

  async loadSettings() {
    const data = await this.loadData();
    this.settings = Object.assign({}, DEFAULT_SETTINGS, data);
    // Merge nested object so new modes keep their default if absent from saved data.
    this.settings.enabledButtons = Object.assign(
      {},
      DEFAULT_SETTINGS.enabledButtons,
      data?.enabledButtons
    );
  }

  async saveSettings() {
    await this.saveData(this.settings);
    // Re-reconcile every window so changes apply everywhere, immediately.
    this.renderAll();
  }

  // --- Per-pane containers --------------------------------------------------

  /**
   * Reconcile containers with the current set of Markdown panes: add a button
   * stack to each Markdown leaf (any window/split), drop stacks for panes that
   * are gone or no longer Markdown, then refresh visibility.
   */
  private refresh() {
    const seen = new Set<WorkspaceLeaf>();
    this.app.workspace.iterateAllLeaves((leaf) => {
      if (leaf.view instanceof MarkdownView) {
        seen.add(leaf);
        if (!this.containers.has(leaf)) this.createContainer(leaf);
      }
    });
    for (const [leaf, container] of this.containers) {
      if (!seen.has(leaf)) {
        container.remove();
        this.containers.delete(leaf);
      }
    }
    this.updateVisibility();
  }

  private createContainer(leaf: WorkspaceLeaf) {
    const view = leaf.view as MarkdownView;
    const container = view.contentEl.createDiv({ cls: "pagescroll-container" });
    this.containers.set(leaf, container);
    this.renderButtons(leaf, container);
  }

  // --- Rendering ------------------------------------------------------------

  /** Re-render buttons in every existing container, then refresh visibility. */
  private renderAll() {
    for (const [leaf, container] of this.containers) {
      this.renderButtons(leaf, container);
    }
    this.updateVisibility();
  }

  /**
   * How many buttons fit stacked in this pane, and whether an overflow menu is
   * needed. When the pane is too short, buttons fold into a single menu button;
   * at the smallest, that one menu button holds all of them.
   */
  private layout(
    view: MarkdownView,
    enabledCount: number
  ): { visible: number; menu: boolean } {
    const paneH = view.contentEl.clientHeight;
    if (!paneH) return { visible: enabledCount, menu: false }; // not laid out yet
    const SLOT = 34; // button (28px) + gap (6px)
    const usable = paneH * 0.85; // stack rises above the bottom-12% anchor
    const fit = Math.max(1, Math.floor(usable / SLOT));
    if (fit >= enabledCount) return { visible: enabledCount, menu: false };
    // Reserve one slot for the menu button; the rest of the slots show buttons.
    return { visible: Math.max(0, fit - 1), menu: true };
  }

  /** Signature of the desired layout, to detect when a re-render is needed. */
  private layoutSig(view: MarkdownView): string {
    const enabled = BUTTON_DEFS.filter((d) => this.settings.enabledButtons[d.mode]);
    if (!this.settings.showButtons || enabled.length === 0) return "none";
    const { visible, menu } = this.layout(view, enabled.length);
    return `${visible}${menu ? "m" : ""}`;
  }

  /** (Re)build the buttons inside one pane's container from current settings. */
  private renderButtons(leaf: WorkspaceLeaf, container: HTMLElement) {
    container.empty();
    const view = leaf.view;
    container.dataset.sig =
      view instanceof MarkdownView ? this.layoutSig(view) : "none";
    if (!this.settings.showButtons || !(view instanceof MarkdownView)) return;

    const enabled = BUTTON_DEFS.filter((d) => this.settings.enabledButtons[d.mode]);
    if (enabled.length === 0) return;

    const { visible, menu } = this.layout(view, enabled.length);
    const shown = enabled.slice(0, visible);
    const overflow = enabled.slice(visible);

    const scrollFrom = (mode: ScrollMode) => {
      if (leaf.view instanceof MarkdownView) this.scroll(mode, leaf.view);
    };

    for (const def of shown) {
      const button = container.createEl("button", {
        cls: ["pagescroll-button", "clickable-icon"],
        attr: { "aria-label": def.label, id: `${def.mode}TriskiPageBtn` },
      });
      setIcon(button, def.icon);
      button.onclick = () => scrollFrom(def.mode);
    }

    if (menu && overflow.length) {
      const menuBtn = container.createEl("button", {
        cls: ["pagescroll-button", "clickable-icon"],
        attr: { "aria-label": "Scroll actions" },
      });
      setIcon(menuBtn, "ellipsis-vertical");
      menuBtn.onclick = (evt) => {
        const m = new Menu();
        for (const def of overflow) {
          m.addItem((item) =>
            item
              .setTitle(def.label)
              .setIcon(def.icon)
              .onClick(() => scrollFrom(def.mode))
          );
        }
        m.showAtMouseEvent(evt);
      };
    }
  }

  /** Toggle visibility classes on every pane's container. */
  private updateVisibility() {
    for (const [leaf, container] of this.containers) {
      if (!(leaf.view instanceof MarkdownView)) continue;
      const view = leaf.view;
      // Re-attach if the view was rebuilt (mode switch) or detached (issue #4).
      // Stacking above content is handled by z-index in styles.css.
      if (container.parentElement !== view.contentEl) {
        view.contentEl.appendChild(container);
      }
      // Re-render if the pane height changed the compaction level.
      if (container.dataset.sig !== this.layoutSig(view)) {
        this.renderButtons(leaf, container);
      }
      const scrollEl = this.getScrollEl(view);
      // Smart-hide: also hide when the note is too short to scroll.
      const noOverflow =
        !!scrollEl && scrollEl.scrollHeight <= scrollEl.clientHeight + 1;
      const hidden =
        !this.settings.showButtons ||
        scrollEl == null ||
        (this.settings.smartHide && noOverflow);
      container.toggleClass("pagescroll-hidden", hidden);
      container.toggleClass(
        "pagescroll-hover-only",
        this.settings.showButtons && this.settings.hoverOnly
      );
    }
  }

  // --- Scrolling ------------------------------------------------------------

  /** Resolve the scrollable element for a Markdown view. */
  private getScrollEl(view: MarkdownView): HTMLElement | null {
    const internal = view as unknown as {
      previewMode?: { renderer?: { previewEl?: HTMLElement } };
      editMode?: { cm?: { scrollDOM?: HTMLElement } };
    };
    const el =
      view.getMode() === "preview"
        ? internal.previewMode?.renderer?.previewEl
        : internal.editMode?.cm?.scrollDOM;
    return el ?? null;
  }

  /** Page up/down distance (px) for a view, honoring the speed settings. */
  private pageDistance(view: MarkdownView, scrollEl: HTMLElement): number {
    const reading = view.getMode() === "preview";
    const percent =
      this.settings.separateReadingSpeed && reading
        ? this.settings.scrollPercentReading
        : this.settings.scrollPercent;
    return scrollEl.clientHeight * (percent / 100);
  }

  /** Scroll a Markdown pane (defaults to the active one, for commands). */
  scroll(mode: ScrollMode, view?: MarkdownView) {
    const v = view ?? this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!v) return;
    const scrollEl = this.getScrollEl(v);
    if (!scrollEl) return;

    const page = this.pageDistance(v, scrollEl);
    switch (mode) {
      case "up":
        scrollEl.scrollBy(0, -page);
        break;
      case "down":
        scrollEl.scrollBy(0, page);
        break;
      case "top":
        scrollEl.scroll(0, 0);
        break;
      case "bottom":
        this.scrollToEnd(scrollEl);
        break;
    }
  }

  /**
   * Scroll to the true bottom, re-checking over the next few frames. In reading
   * mode, embeds/images render lazily and grow scrollHeight *after* the initial
   * scroll, which would otherwise leave us stuck partway (issue #2). Keep
   * nudging to the new bottom until it settles or we run out of attempts.
   */
  private scrollToEnd(el: HTMLElement, attempts = 12) {
    el.scroll(0, el.scrollHeight);
    if (attempts <= 0) return;
    const win = el.ownerDocument.defaultView ?? window;
    win.requestAnimationFrame(() => {
      if (Math.ceil(el.scrollTop + el.clientHeight) < el.scrollHeight) {
        this.scrollToEnd(el, attempts - 1);
      }
    });
  }

  // --- Caret jump-list (issue #1) -------------------------------------------

  /** CM update listener: notice large cursor jumps and record their origin. */
  private handleCaretUpdate(update: ViewUpdate) {
    if (!update.selectionSet || this.suppressCaretRecord) return;

    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    const file = view?.file?.path;
    if (!file) return;

    const head = update.state.selection.main.head;
    const lineObj = update.state.doc.lineAt(head);
    const pos: CaretPos = {
      file,
      line: lineObj.number - 1,
      ch: head - lineObj.from,
    };

    const prev = this.lastCaret;
    this.lastCaret = pos;
    if (!prev) return;

    const jumped =
      prev.file !== pos.file ||
      Math.abs(prev.line - pos.line) >= CARET_JUMP_THRESHOLD;
    if (!jumped) return;

    // A fresh jump invalidates any forward history.
    if (this.caretIndex !== -1) {
      this.caretHistory = this.caretHistory.slice(0, this.caretIndex + 1);
      this.caretIndex = -1;
    }
    this.caretLive = null;
    this.caretHistory.push(prev);
    if (this.caretHistory.length > MAX_CARET_HISTORY) this.caretHistory.shift();
  }

  /** Navigate the caret jump-list: dir = -1 (back) or +1 (forward). */
  private jumpCaret(dir: -1 | 1) {
    if (this.caretHistory.length === 0) return;

    if (dir === -1) {
      if (this.caretIndex === -1) {
        // Starting to navigate: remember the live spot for the return trip.
        this.caretLive = this.lastCaret;
        this.caretIndex = this.caretHistory.length - 1;
      } else if (this.caretIndex > 0) {
        this.caretIndex--;
      } else {
        return; // already at the oldest
      }
      this.applyCaret(this.caretHistory[this.caretIndex]);
      return;
    }

    // Forward
    if (this.caretIndex === -1) return; // not navigating
    if (this.caretIndex < this.caretHistory.length - 1) {
      this.caretIndex++;
      this.applyCaret(this.caretHistory[this.caretIndex]);
    } else {
      // Past the newest origin → return to the live position.
      this.caretIndex = -1;
      if (this.caretLive) this.applyCaret(this.caretLive);
    }
  }

  /** Move the cursor to a remembered position (opening the file if needed). */
  private async applyCaret(pos: CaretPos) {
    this.suppressCaretRecord = true;
    try {
      let view = this.app.workspace.getActiveViewOfType(MarkdownView);
      if (!view || view.file?.path !== pos.file) {
        const file = this.app.vault.getAbstractFileByPath(pos.file);
        if (file instanceof TFile) {
          await this.app.workspace.getLeaf(false).openFile(file);
          view = this.app.workspace.getActiveViewOfType(MarkdownView);
        }
      }
      const editor = view?.editor;
      if (!editor) return;

      const line = Math.min(pos.line, editor.lineCount() - 1);
      const ch = Math.min(pos.ch, editor.getLine(line)?.length ?? 0);
      editor.setCursor({ line, ch });
      editor.scrollIntoView({ from: { line, ch }, to: { line, ch } }, true);
      editor.focus();
      this.lastCaret = { file: pos.file, line, ch };
    } finally {
      // Release after the programmatic selection change has settled.
      window.setTimeout(() => (this.suppressCaretRecord = false), 50);
    }
  }
}

class PageScrollSettingTab extends PluginSettingTab {
  plugin: PageScrollPlugin;

  constructor(app: App, plugin: PageScrollPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName("Show scroll buttons")
      .setDesc(
        "Display the on-screen page-scroll buttons. Turn this off to use only the commands/hotkeys (the buttons can overlap UI from other plugins)."
      )
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.showButtons).onChange(async (value) => {
          this.plugin.settings.showButtons = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Smart hide")
      .setDesc(
        "Also hide the buttons when the current note is short enough that there's nothing to scroll. (Non-editor panes — e.g. other plugins' views — always hide.)"
      )
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.smartHide).onChange(async (value) => {
          this.plugin.settings.smartHide = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Visible on hover only")
      .setDesc(
        "Keep the buttons faded out until you hover over them, so they stay unobtrusive."
      )
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.hoverOnly).onChange(async (value) => {
          this.plugin.settings.hoverOnly = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl).setName("Scroll distance").setHeading();

    new Setting(containerEl)
      .setName("Page up/down distance")
      .setDesc("How far a page up/down scrolls, as a percentage of the visible height.")
      .addSlider((slider) =>
        slider
          .setLimits(20, 100, 5)
          .setValue(this.plugin.settings.scrollPercent)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.scrollPercent = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Separate distance in Reading view")
      .setDesc("Use a different page up/down distance when viewing in Reading mode.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.separateReadingSpeed)
          .onChange(async (value) => {
            this.plugin.settings.separateReadingSpeed = value;
            await this.plugin.saveSettings();
            this.display(); // show/hide the Reading-view slider
          })
      );

    if (this.plugin.settings.separateReadingSpeed) {
      new Setting(containerEl)
        .setName("Reading view distance")
        .setDesc("Page up/down distance used in Reading mode.")
        .addSlider((slider) =>
          slider
            .setLimits(20, 100, 5)
            .setValue(this.plugin.settings.scrollPercentReading)
            .setDynamicTooltip()
            .onChange(async (value) => {
              this.plugin.settings.scrollPercentReading = value;
              await this.plugin.saveSettings();
            })
        );
    }

    new Setting(containerEl).setName("Visible buttons").setHeading();
    containerEl.createEl("p", {
      text: "Choose which buttons appear on screen. Commands and hotkeys stay available regardless.",
      cls: "setting-item-description",
    });

    for (const def of BUTTON_DEFS) {
      new Setting(containerEl).setName(def.label).addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.enabledButtons[def.mode])
          .onChange(async (value) => {
            this.plugin.settings.enabledButtons[def.mode] = value;
            await this.plugin.saveSettings();
          })
      );
    }
  }
}
