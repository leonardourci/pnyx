---
name: write-front-end
description: Use only when writing or reviewing code under web/ (the React + Vite + Tailwind app). Not needed for CLI, core, store, server or integration work.
paths:
  - "web/**"
---

# Writing the web app

- Build UI from the primitives in `web/src/shared/ui/`. When one is missing, add it there and extend it; do not inline a one-off control.
- Never use native-styled controls (`<select>`, `<input type="checkbox">` and friends as the browser draws them) or a third-party styled kit such as DaisyUI. Pnyx has one look in every browser.
- Colors and fonts come from the theme tokens in `web/src/index.css`. No raw hex values or ad hoc font stacks in components.
- Keep components small: one job each, composed from primitives.
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

Good: the command publishes its shared preview synchronously, while its durable ID lets confirmation reconcile it in place.

```ts
const saving = command({
  name: 'task',
  args: ['rename', task.key, '--title', title, '--event-id', crypto.randomUUID()],
})
closeEditor()
void saving.catch(error => restoreDraft({ title, error }))
```

When testing an action, hold its server request and assert the visible result before releasing it. For creation, retain the element reference and check its first painted frame and visibility through confirmation, as well as refusal and reconnect behavior.
