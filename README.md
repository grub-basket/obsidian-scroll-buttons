> [!IMPORTANT]
> **This plugin has moved to [Scroll Buttons](https://github.com/grub-basket/scroll-buttons).**
> This repo gets no further updates. Scroll Buttons is a from-scratch rewrite with the
> same buttons and settings, plus fixes.
>
> To switch:
> 1. In BRAT, add the beta plugin `grub-basket/scroll-buttons` (or install **Scroll Buttons**
>    from Community plugins once it's listed there).
> 2. Enable Scroll Buttons. Your Page Scroll settings are copied over automatically the
>    first time it runs.
> 3. Disable and remove Page Scroll (and remove `grub-basket/obsidian-scroll-buttons` from BRAT),
>    otherwise you'll see two sets of buttons.
> 4. If you set custom hotkeys for the Page Scroll commands, assign them again to the
>    matching Scroll Buttons commands.

### Introduce

原意是给墨水屏设备使用，因为正常地翻页会有残影，四个按钮分别是跳到顶部/向上翻页/向下翻页/跳到底部

The original intention is to use the ink screen device, because there will be residual shadows because of normal pages, the four buttons are jump to the top/pages up/down pages/jump to the bottom

## Settings

- **Show scroll buttons** — toggle the on-screen buttons off entirely and rely on the
  commands/hotkeys instead (useful when the buttons overlap UI from other plugins).
- **Smart hide** — automatically hide the buttons when the focused pane has nothing to
  scroll (e.g. non-editor views), so they get out of the way of other plugins.
- **Visible on hover only** — keep the buttons faded out until you hover over them, so
  they stay unobtrusive.
- **Visible buttons** — enable or disable each of the four buttons individually
  (Page top / up / down / bottom). Commands and hotkeys stay available regardless.

The buttons also render in pop-out windows, not just the main window.

## Example

### desktop

![desktop](_files/desktop_example.png)

### mobile

![mobile](_files/mobile_example.png)

## Credits

Originally created by [triski](https://github.com/chenshutian9610) as
[obsidian-pagescroll-plugin](https://github.com/chenshutian9610/obsidian-pagescroll-plugin).
This is an independent continuation with added settings, multi-window support, and
fixes. Licensed under MIT (see `LICENSE`).

Thanks to [nowell-morris](https://github.com/nowell-morris), whose independent fork
contributed the technique for keeping editor focus when a scroll button is clicked.