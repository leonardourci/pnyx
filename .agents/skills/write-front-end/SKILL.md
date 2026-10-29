---
name: write-front-end
description: Use only when writing or reviewing code under web/ (the React + Vite + Tailwind app). Not needed for CLI, core, store, server or integration work.
paths:
  - "web/**"
---

# Writing the web app

[follow-conventions](../follow-conventions/SKILL.md) applies here too; this skill adds what is specific to `web/`.

- Build UI from the primitives in `web/src/shared/ui/`. When one is missing, add it there and extend it; do not inline a one-off control.
- Never use native-styled controls (`<select>`, `<input type="checkbox">` and friends as the browser draws them) or a third-party styled kit such as DaisyUI. Pnyx has one look in every browser.
- Colors and fonts come from the theme tokens in `web/src/index.css`. No raw hex values or ad hoc font stacks in components.
- Reuse before building. Search `web/src/shared/ui/` and the feature folders under `web/src/` for a component, hook or formatter that already does the job; build a new one only when nothing composes into it.
- Keep components small: one job each, composed from primitives. A screen reads as a list of named pieces, not one block of JSX. A piece used by one file sits above the exported component in that file; a generic piece several features use moves to `web/src/shared/ui/`.
- Put derived values (labels, classes, formatted text) and compound conditions in named constants above the `return`, not inline in the JSX.
- Read Hydra state from the connection store over the one WebSocket. Don't keep a second copy of it in component state.
- Use the installed React, Vite and Tailwind versions' current APIs, checked against their types or docs, not deprecated props or callbacks.
- Keep accessible names, `aria-label` and `data-*` state attributes stable when you move or rename a component; assistive technology relies on them.
- Show agent- or owner-written text (questions, notes, briefs, reports, comments, chat) through `RichText` from `web/src/shared/ui/rich-text.tsx`, as in `<RichText text={card.intent} />`; a one-line summary inside a control uses `markdownText`. It shows tokens exactly as the composer does: task, column and skill chips, and image chips for `[image: <path>]` tokens and bare absolute image paths that open the picture on click. Never draw images outside their chips.
- Chat tokens (commands, skills and task mentions) share one rendering between the composer and sent messages, including their icons, colors and task navigation. Keep surrounding text normal and unknown command or skill names literal.
- Prefer inline creation and editing over modals and dialogs: a new column is created inline at the end of the Hydra, card fields edit in place. Reserve overlays for things that truly need them (command palette, confirming a destructive action).

## Actions show their result immediately

For reversible edits, publish the result through the shared optimistic resource as soon as the owner acts, then confirm it with the server in the background. Allocate a stable attempt/event ID before sending and retain it across uncertain delivery and retry. Key a created item by its client key, map that key to the confirmed ID, and update its fields in place. Confirmation must keep the same React element and DOM node: no refetch-driven remount, collapse or blink.

On a definite refusal, remove the refused preview and show the server's reason. Restore the draft when useful without replacing a newer edit. While delivery is unconfirmed, retain the preview and show “Checking…”; a timeout or disconnect does not mean the edit failed. Use the shared pending state for these outcomes instead of inventing a second local saved state. Destructive or irreversible actions stay confirm-first; preview the result only after explicit confirmation.

Bad: the editor waits for the server before showing the edit.

```ts
await command(edit)
closeEditor()
```

Good: the command publishes its shared preview synchronously, so the editor closes at once, while its durable ID lets confirmation reconcile it in place. The handler awaits the result and restores the draft on a refusal.

```ts
const saving = command({
  name: 'task',
  args: ['rename', task.key, '--title', title, '--event-id', crypto.randomUUID()],
})
closeEditor()

try {
  await saving
} catch (error) {
  restoreDraft({ title, error })
}
```

When testing an action, hold its server request and assert the visible result before releasing it. For creation, retain the element reference and check its first painted frame and visibility through confirmation, as well as refusal and reconnect behavior.

## Pull requests with visible changes

Show before and after screenshots of each changed view side by side in a `Before | After` table, at a reduced width (`<img src="..." width="360">`), in both light and dark themes. Add a short GIF when motion or interaction is the point. Host media on the `pr-media` branch under `pr-<number>/`, never in the PR's diff or a gist, and link it as `https://github.com/leonardourci/pnyx/blob/pr-media/pr-<number>/<file>?raw=true`.
