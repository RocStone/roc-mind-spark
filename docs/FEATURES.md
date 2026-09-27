# Feature list

What Roc Mind Spark can do today, as a **macOS overlay**. This is the product catalog for GitHub, not a changelog. Bug fixes stay in [CHANGELOG.md](../CHANGELOG.md).

[English](FEATURES.md) · [中文](FEATURES.zh.md)

**Platform:** macOS 14+ on Apple Silicon. The overlay is summoned over the current Space. It is not a website and not a browser tab.

---

## Overlay

- Global hotkey to show or hide the map over the current Space, including fullscreen apps. Default **⌃⌥⇧⌘Q**, changeable in Settings.
- Menu-bar extra: Show / Hide, Settings, Quit.
- Launch at login, on by default, off in Settings.
- Click the menu bar, the Dock, or another display to dismiss. Escape stays with the canvas and does not close the overlay.
- Visible startup errors and **Retry** when Node.js is missing, the canvas times out, packaged files are missing, or port 3034 is already in use. The app does not kill whatever occupies that port.

## Maps

- Any number of maps in a sidebar list. Create blank, duplicate, pin, rename, delete.
- Autosave to a local SQLite file under `~/Library/Application Support/RocMindSpark/`.
- Images dropped or pasted onto a map are stored locally with the map.
- Start from a built-in template, or save the current map as a reusable template.

## Editing

- Add a child with **Tab**, a sibling with **Enter**. Navigate with arrows. Edit with **F2** or double-click. Delete with Backspace / Delete.
- **Drag** a topic to move its subtree. Drop on the centre of another topic to nest. Drop on the top or bottom edge to insert as a sibling or reorder.
- **⌘ + drag** box-select. **⌘ + click** add or remove a topic from the selection. Bulk format, recolor, re-parent, or delete the selection.
- Right-click a topic for Add child, Add sibling, Edit, Notes, Set marker, Copy as Markdown, Duplicate subtree, Collapse / Expand and Delete. Arrow keys move through the menu; Esc or a click outside closes it.
- **⌘A** on the canvas selects every visible topic; **⌘⇧A** selects the current topic and its siblings.
- **⇧Esc** while editing a topic discards the edit and restores the text from before; **Esc** saves.
- Copy the selection as a Markdown outline from the bulk bar (**MD**) or **⌘C**. Parent/child among the selected topics is kept as indent. Unselected descendants are left out.
- With one topic selected (not editing), **⌘C** copies its whole subtree as a Markdown outline. **⌘V** on a selected topic pastes a just-copied subtree as a clone (notes, markers, colors and links inside it kept), or splits a multi-line Markdown outline into child topics. A single line of text still replaces the topic text.
- Cross-link any two topics with **L**.
- Collapse / expand a branch with **Space**. The **−** / **+** control on a topic is the same fold. Collapse all, one level per click.
- **⌘F** finds topic text in the current map, including topics hidden by a **−** fold. Focus stays in the find box. Enter cycles to the next hit, centres the canvas on it, and unfolds its ancestor chain. Enter again refolds that temporary chain when the previous topic was not edited. A second **⌘F** while find is open closes it. **⌘H** opens find and replace. The toolbar 🌐 control searches across all maps.
- Undo / redo for map edits. Node text, Markdown, and notes undo with the focused editor, not the map stack.
- Inline format on a topic: bold, italic, underline, strikethrough, size, color, highlight, alignment.
- Markers, hyperlinks, todo checkboxes, citations (DOI lookup when you ask), Markdown tables, code blocks, dividers. A GFM table in a topic is drawn as a table while the topic is not being edited; editing shows the Markdown source.
- Images on a topic, with a viewer on a second click.
- Resize a topic by its corner grip. Manual width is kept.

## Notes

- Each topic can hold a sticky-note with a formatting toolbar.
- Hover the note mark to preview. Click to pin and edit.
- Drag the tape or the toolbar to move the note.
- The note grows with the text until it reaches the bottom of the window, then the editor scrolls. Save / Cancel stay visible.

## Markdown

- Side pane to edit the whole map as a Markdown outline, with live two-way sync to the canvas.
- Word wrap, rendered preview, and PDF of the preview.
- Opening or resizing the Markdown pane does not auto-fit or change the map zoom. The same map point stays centred. Use the zoom bar Fit control if you want a fit.

## Look and layout

- Colour themes, map styles (modern / classic / others), and a handwritten / office / coffee-shop look.
- Layouts: balanced tree, left, right, down, org-chart up, timeline, fishbone, radial, grid, matrix. The 🎨 panel's **Layout presets** row lists the presets shipped in `web/public/layouts/`; click one to apply it. Its last tile, **Import…**, takes your own layout JSON.
- Interface language: English or 中文. This does not translate the words you type into nodes.
- Display size for chrome density. Scroll to zoom the map, drag empty canvas to pan, Fit to frame every topic, minimap to jump.
- Focus mode: select a topic first and the canvas shows only that topic's branch, with its ancestor chain dimmed for context; every other branch is hidden and the view fits the branch. You can edit and add topics inside the branch, not outside it. With nothing or the central topic selected, focus mode is immersive only: sidebar, toolbar and tips are hidden so just the canvas is left. Esc exits either way; ⌘F still opens the find box. Focus never changes folds and is not saved.
- Presentation mode to step through topics.

## Export and import

- PNG of the themed map.
- Markdown file, or copy as a plain outline.
- Word `.doc`, Mermaid, JSON backup, references list from citation nodes.
- Compile a subtree into a prompt, with `{{placeholders}}` filled from map variables.
- Import JSON, OPML, or a Markdown outline.

## Shortcuts and help

- **?** for the full shortcut list.
- Right-click any toolbar button to bind a custom shortcut.
- Cut / Copy / Paste / Undo / Redo / Select All from the text-field context menu.

## What this Mac app does not claim

- No live collaboration, cloud share, or GitHub sign-in. That inherited hosted-product code has been removed from the Mac canvas.
- Windows, Linux, Docker, Cloudflare, GitHub Pages, and a standalone web app are not supported products of this repository.
- Optional outbound calls (LLM with your own key, Crossref DOI, favicons, opened http(s) links) are documented in [PRIVACY.md](../PRIVACY.md).
