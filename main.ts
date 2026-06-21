import {
  App,
  MarkdownView,
  Plugin,
  PluginSettingTab,
  Setting,
  WorkspaceContainer,
  WorkspaceWindow,
  setIcon,
} from "obsidian";

type ScrollMode = "top" | "up" | "down" | "bottom";

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

  /**
   * One button container per workspace root (main window + pop-outs).
   * Keyed by the WorkspaceContainer so the buttons anchor to the editor
   * area, not the whole window — they don't overlap the sidebars.
   */
  private containers = new Map<WorkspaceContainer, HTMLElement>();

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

    this.addSettingTab(new PageScrollSettingTab(this.app, this));

    this.app.workspace.onLayoutReady(() => {
      // Track the main window's root plus any pop-outs restored on startup.
      this.trackContainer(this.app.workspace.rootSplit);
      const floating = (
        this.app.workspace as unknown as {
          floatingSplit?: { children?: WorkspaceContainer[] };
        }
      ).floatingSplit;
      floating?.children?.forEach((c) => this.trackContainer(c));
      this.renderAll();
    });

    this.registerEvent(
      this.app.workspace.on("window-open", (win: WorkspaceWindow) => {
        this.trackContainer(win);
        this.renderAll();
      })
    );
    this.registerEvent(
      this.app.workspace.on("window-close", (win: WorkspaceWindow) =>
        this.untrackContainer(win)
      )
    );

    // Recompute visibility (smart-hide) whenever the focused pane changes.
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", () => this.updateVisibility())
    );
    this.registerEvent(
      this.app.workspace.on("layout-change", () => this.updateVisibility())
    );
    // Sidebar resize/collapse changes the right-edge offset.
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

  // --- Window tracking ------------------------------------------------------

  private trackContainer(root: WorkspaceContainer) {
    if (this.containers.has(root)) return;
    const container = root.doc.body.createDiv({ cls: "pagescroll-container" });
    this.containers.set(root, container);
  }

  /**
   * Right-edge offset (px) for a window's buttons. On the main window we add
   * the width of the right sidebar so the buttons sit over the editor content
   * instead of overlapping the panel; pop-outs have no sidebar.
   */
  private rightInset(root: WorkspaceContainer): number {
    const base = 12;
    if (root !== this.app.workspace.rootSplit) return base;
    const right = this.app.workspace.rightSplit as unknown as {
      collapsed?: boolean;
      containerEl?: HTMLElement;
    };
    if (!right || right.collapsed) return base;
    return base + (right.containerEl?.offsetWidth ?? 0);
  }

  private untrackContainer(root: WorkspaceContainer) {
    this.containers.get(root)?.remove();
    this.containers.delete(root);
  }

  // --- Rendering ------------------------------------------------------------

  /** Rebuild button structure in every window, then apply visibility. */
  private renderAll() {
    for (const [root, container] of this.containers) {
      this.renderButtons(root, container);
    }
    this.updateVisibility();
  }

  /** (Re)build the buttons inside one root's container from current settings. */
  private renderButtons(root: WorkspaceContainer, container: HTMLElement) {
    container.empty();
    if (!this.settings.showButtons) return;

    for (const def of BUTTON_DEFS) {
      if (!this.settings.enabledButtons[def.mode]) continue;

      const button = container.createEl("button", {
        cls: ["pagescroll-button", "clickable-icon"],
        attr: { "aria-label": def.label, id: `${def.mode}TriskiPageBtn` },
      });
      setIcon(button, def.icon);
      button.onclick = () => this.scroll(def.mode, root);
    }
  }

  /** Toggle visibility classes on every root's container (cheap; event-safe). */
  private updateVisibility() {
    for (const [root, container] of this.containers) {
      const scrollEl = this.getScrollEl(root);
      // Always hide when the active pane isn't a Markdown editor (e.g. Stashpad
      // or other custom plugin views) — the buttons can't scroll those.
      // Smart-hide additionally hides when the note has nothing to scroll.
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
      // Keep the buttons clear of the right sidebar (main window only).
      container.style.right = `${this.rightInset(root)}px`;
    }
  }

  // --- Scrolling ------------------------------------------------------------

  /**
   * The Markdown view that is the *active* pane of `root` (or of the whole
   * workspace if `root` is omitted). Returns null for any other active view —
   * e.g. custom plugin editors like Stashpad — so the buttons stay hidden
   * there instead of acting on a background markdown tab.
   */
  private getActiveMarkdownView(root?: WorkspaceContainer): MarkdownView | null {
    const leaf = this.app.workspace.getMostRecentLeaf(root as never);
    return leaf?.view instanceof MarkdownView ? leaf.view : null;
  }

  /** Resolve the scrollable element for the active Markdown pane of `root`. */
  private getScrollEl(root?: WorkspaceContainer): HTMLElement | null {
    const view = this.getActiveMarkdownView(root);
    if (!view) return null;

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

  /** Scroll the active Markdown pane of `root` (or the workspace's active one). */
  scroll(mode: ScrollMode, root?: WorkspaceContainer) {
    const scrollEl = this.getScrollEl(root);
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
