import {
  App,
  MarkdownView,
  Plugin,
  PluginSettingTab,
  Setting,
  WorkspaceWindow,
} from "obsidian";

type ScrollMode = "top" | "up" | "down" | "bottom";

interface ButtonDef {
  mode: ScrollMode;
  label: string;
}

/** The four buttons, ordered top → bottom on screen. Positioning lives in styles.css. */
const BUTTON_DEFS: ButtonDef[] = [
  { mode: "top", label: "⇈" },
  { mode: "up", label: "↑" },
  { mode: "down", label: "↓" },
  { mode: "bottom", label: "⇊" },
];

/** Amount of overlap kept between pages when scrolling, in px. */
const PAGE_OVERLAP = 60;

interface PageScrollSettings {
  /** Master switch for the on-screen buttons. */
  showButtons: boolean;
  /** Hide the buttons when the focused pane has nothing to scroll. */
  smartHide: boolean;
  /** Keep the buttons faded out until the pointer hovers over them. */
  hoverOnly: boolean;
  /** Which of the four buttons to render. Commands/hotkeys are unaffected. */
  enabledButtons: Record<ScrollMode, boolean>;
}

const DEFAULT_SETTINGS: PageScrollSettings = {
  showButtons: true,
  smartHide: true,
  hoverOnly: false,
  enabledButtons: { top: true, up: true, down: true, bottom: true },
};

export default class PageScrollPlugin extends Plugin {
  settings: PageScrollSettings;

  /** Every document we have rendered buttons into (main window + pop-outs). */
  private docs = new Set<Document>();

  async onload() {
    await this.loadSettings();

    for (const def of BUTTON_DEFS) {
      this.addCommand({
        id: `page-scroll-${def.mode}`,
        name: `Page ${def.mode}`,
        callback: () => this.scroll(def.mode, activeDocument),
        hotkeys:
          def.mode === "up"
            ? [{ key: "AudioVolumeUp", modifiers: [] }]
            : def.mode === "down"
              ? [{ key: "AudioVolumeDown", modifiers: [] }]
              : [],
      });
    }

    this.addSettingTab(new PageScrollSettingTab(this.app, this));

    // Add buttons once the workspace (and any restored pop-out windows) exists.
    this.app.workspace.onLayoutReady(() => {
      this.addButtonsToDocument(document);
      this.app.workspace.iterateAllLeaves((leaf) =>
        this.addButtonsToDocument(leaf.view.containerEl.ownerDocument)
      );
      this.updateVisibility();
    });

    // Keep pop-out windows in sync.
    this.registerEvent(
      this.app.workspace.on("window-open", (win: WorkspaceWindow) =>
        this.addButtonsToDocument(win.doc)
      )
    );
    this.registerEvent(
      this.app.workspace.on("window-close", (win: WorkspaceWindow) =>
        this.removeButtonsFromDocument(win.doc)
      )
    );

    // Re-evaluate smart-hide whenever the focused pane changes.
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", () => this.updateVisibility())
    );
    this.registerEvent(
      this.app.workspace.on("layout-change", () => this.updateVisibility())
    );
  }

  onunload() {
    for (const doc of [...this.docs]) {
      this.removeButtonsFromDocument(doc);
    }
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
    this.refreshButtons();
  }

  /**
   * Resolve the scrollable element for the active pane within `doc`.
   * Falls back to any markdown/text pane living in that document.
   */
  private getScrollEl(doc: Document): HTMLElement | null {
    const inDoc = (el?: HTMLElement | null) =>
      !!el && el.ownerDocument === doc;

    // Prefer the active markdown view, but only if it lives in this document.
    let view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view || !inDoc(view.containerEl)) {
      view = null;
      for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
        if (leaf.view instanceof MarkdownView && inDoc(leaf.view.containerEl)) {
          view = leaf.view;
          break;
        }
      }
    }

    if (view) {
      const renderer = view as unknown as {
        previewMode?: { renderer?: { previewEl?: HTMLElement } };
        editMode?: { cm?: { scrollDOM?: HTMLElement } };
      };
      const el =
        view.getMode() === "preview"
          ? renderer.previewMode?.renderer?.previewEl
          : renderer.editMode?.cm?.scrollDOM;
      if (el) return el;
    }

    // Fallback for other TextFileView panes (e.g. canvas, custom editors).
    const fileView = (
      this.app.workspace as unknown as {
        getActiveFileView(): { containerEl: HTMLElement } | null;
      }
    ).getActiveFileView();
    if (fileView && inDoc(fileView.containerEl)) {
      const el = fileView.containerEl.children[1];
      if (el instanceof HTMLElement) return el;
    }

    return null;
  }

  /** Scroll the active pane in `doc`. */
  scroll(mode: ScrollMode, doc: Document) {
    const scrollEl = this.getScrollEl(doc);
    if (!scrollEl) return;

    const page = scrollEl.clientHeight - PAGE_OVERLAP;
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
        scrollEl.scroll(0, scrollEl.scrollHeight);
        break;
    }
  }

  private buttonId(mode: ScrollMode) {
    return `${mode}TriskiPageBtn`;
  }

  /** Render the four buttons into `doc` (no-op if already present or disabled). */
  private addButtonsToDocument(doc: Document) {
    this.docs.add(doc);
    if (!this.settings.showButtons) return;

    for (const def of BUTTON_DEFS) {
      if (!this.settings.enabledButtons[def.mode]) continue;
      const id = this.buttonId(def.mode);
      if (doc.getElementById(id)) continue;

      const button = doc.body.createEl("button", {
        attr: { id },
        cls: ["pagescroll-button", `pagescroll-${def.mode}`],
        text: def.label,
      });

      this.registerDomEvent(button, "click", () => this.scroll(def.mode, doc));
    }
  }

  /** Remove the buttons from `doc`. */
  private removeButtonsFromDocument(doc: Document) {
    for (const def of BUTTON_DEFS) {
      doc.getElementById(this.buttonId(def.mode))?.remove();
    }
    this.docs.delete(doc);
  }

  /** Apply the current settings to every tracked document. */
  private refreshButtons() {
    for (const doc of [...this.docs]) {
      // Remove any button that is now disabled (or all of them if hidden).
      for (const def of BUTTON_DEFS) {
        const enabled =
          this.settings.showButtons && this.settings.enabledButtons[def.mode];
        if (!enabled) doc.getElementById(this.buttonId(def.mode))?.remove();
      }
      if (this.settings.showButtons) this.addButtonsToDocument(doc);
    }
    this.updateVisibility();
  }

  /** Show/hide buttons per document based on the smart-hide setting. */
  private updateVisibility() {
    if (!this.settings.showButtons) return;
    for (const doc of this.docs) {
      const visible = !this.settings.smartHide || this.getScrollEl(doc) != null;
      for (const def of BUTTON_DEFS) {
        const button = doc.getElementById(this.buttonId(def.mode));
        button?.toggleClass("pagescroll-hidden", !visible);
        button?.toggleClass("pagescroll-hover-only", this.settings.hoverOnly);
      }
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
        "Automatically hide the buttons when the focused pane has nothing to scroll (e.g. non-editor views), so they don't block other plugins."
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

    new Setting(containerEl).setName("Visible buttons").setHeading();
    containerEl.createEl("p", {
      text: "Choose which buttons appear on screen. Commands and hotkeys stay available regardless.",
      cls: "setting-item-description",
    });

    const BUTTON_LABELS: { mode: ScrollMode; name: string }[] = [
      { mode: "top", name: "Page top (⇈)" },
      { mode: "up", name: "Page up (↑)" },
      { mode: "down", name: "Page down (↓)" },
      { mode: "bottom", name: "Page bottom (⇊)" },
    ];

    for (const { mode, name } of BUTTON_LABELS) {
      new Setting(containerEl).setName(name).addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.enabledButtons[mode])
          .onChange(async (value) => {
            this.plugin.settings.enabledButtons[mode] = value;
            await this.plugin.saveSettings();
          })
      );
    }
  }
}
