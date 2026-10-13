---
name: write-front-end
description: Use only when writing or reviewing code under web/ (the React + Vite + Tailwind board). Not needed for CLI, core, store, server or integration work.
---

# Writing the web board

- Build UI from the primitives in `web/src/components/ui/`. When one is missing, add it there and extend it; do not inline a one-off control.
- Never use native-styled controls (`<select>`, `<input type="checkbox">` and friends as the browser draws them) or a third-party styled kit such as DaisyUI. The board has one look in every browser.
- Colors and fonts come from the theme tokens in `web/src/index.css`. No raw hex values or ad hoc font stacks in components.
- Keep components small: one job each, composed from primitives.
- Prefer inline creation and editing over modals and dialogs: a new column is created inline at the end of the board, card fields edit in place. Reserve overlays for things that truly need them (command palette, confirming a destructive action).
