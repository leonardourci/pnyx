import assert from 'node:assert/strict'
import { hydraSdk } from './hydra-host-fixture.ts'
import { cpSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { decidePush } from '../src/core/decide.ts'
import { commands } from '../src/cli/commands.ts'
import { startServer } from '../src/server/server.ts'
import { loadHydra, withWriter } from '../src/store/hydra-store.ts'
import { smokeBrowser } from './browser.ts'

const home = realpathSync(mkdtempSync(join(
  tmpdir(),
  'pnyx-task-smoke-',
)))
process.env.PNYX_HOME = home; process.env.PNYX_SEMANTIC = 'off'
process.env.CLAUDE_CONFIG_DIR = join(
  home,
  'claude',
)
commands.hydra([
  'create',
  'default',
])
commands.task([
  'create',
  '--key',
  'review',
  '--title',
  'Review the migration plan',
  '--brief',
  'Check the rollback path before rollout.',
  '--column',
  'in_progress',
])
commands.task([
  'create',
  '--key',
  'long',
  '--title',
  'A very long title '.repeat(15),
  '--column',
  'in_progress',
])
const state = () => loadHydra({ hydraId: 'default' }).state
const task = () => state().cards[state().keys.review!]!
withWriter({
  hydraId: 'default',
  fn: ({ writer }) => {
    for (const key of [
      'review',
      'long',
    ]) {
      const decision = decidePush({
        state: writer.state,
        key,
        input: {
          project: key === 'review' ? 'payments-api' : undefined,
          tags: ['canary'],
        },
        meta: {
          actor: 'fixture',
          at: new Date().toISOString(),
        },
      })
      assert.ok('event' in decision); writer.append({ event: decision.event })
    }
  },
})
const transcript = join(
  home,
  'worker.jsonl',
)
writeFileSync(
  transcript,
  Array.from(
    { length: 12 },
    (
      _,
      i,
    ) => JSON.stringify({
      type: i % 2 ? 'assistant' : 'user',
      timestamp: `2026-10-16T01:${String(i).padStart(
        2,
        '0',
      )}:00Z`,
      message: { content: i % 2 ? 'The migration passes locally. I am checking the rollback path and the canary gate.\n\n' + 'A factual update from the worker. '.repeat(4) : 'Please inspect the migration and preserve its existing data.' },
    }),
  ).join('\n') + '\n',
)
commands.task([
  'status',
  'review',
  'working',
  '--note',
  'The migration passes locally; checking the rollback path.',
  '--actor',
  'worker',
])
const native = join(
  home,
  'firstmate',
)
cpSync(
  join(
    import.meta.dirname,
    'fixtures/firstmate-home',
  ),
  native,
  { recursive: true },
)
const server = await startServer({
  query: hydraSdk().query,
  hydraId: 'default',
  homes: [native],
})
const {
  browser,
  evaluate,
  check,
  click,
  text,
  fill,
  screenshot,
  eventually,
  close,
} = smokeBrowser({
  home,
  session: 'pnyx-tasks',
})

try {
  await browser({
    args: [
      'open',
      server.url,
    ],
  }); await browser({
    args: [
      'resize',
      '1440',
      '900',
    ],
  }); await browser({
    args: [
      'wait',
      'Review the migration plan',
    ],
  })
  await check({
    condition: '[...document.querySelectorAll(".card")].every(c => c.getBoundingClientRect().height > 0 && c.querySelector(".card-open").getBoundingClientRect().bottom <= c.getBoundingClientRect().bottom)',
    label: 'closed cards contain their titles despite long content',
  })
  const colors = state().labelColors!
  const projectColor = colors.find(entry => entry.label === 'payments-api')!.color
  const tagColor = colors.find(entry => entry.label === 'canary')!.color
  await check({
    condition: `document.querySelector('[data-task="${task().id}"]').dataset.labelColor === '${projectColor}' && document.querySelector('[data-task="${state().keys.long}"]').dataset.labelColor === '${tagColor}'`,
    label: 'the saved project color supplies the tint, with a saved label fallback',
  })
  await check({
    condition: 'document.querySelector(".last-message").textContent.includes("migration passes locally")',
    label: 'a factual worker update appears at rest',
  })
  await screenshot({ name: 'cards-closed-after.png' })
  await evaluate({ code: `const text = document.querySelector('[data-task="${task().id}"] .last-message'); text.style.userSelect = 'text'; const range = document.createRange(); range.selectNodeContents(text); const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range); if (!selection.toString()) throw new Error('Expected selected preview text'); text.click(); return true;` })
  await check({
    condition: '!document.querySelector(".card.selected")',
    label: 'selecting preview text leaves the card closed',
  })
  await evaluate({ code: 'window.getSelection().removeAllRanges(); document.querySelector(\'.last-message\').style.userSelect = \'\'; return true;' })
  await click({ selector: `[data-task="${task().id}"] .card-state` })
  await eventually({
    condition: 'document.activeElement.matches(".task-updates") && !!document.querySelector(".card.selected .detail")',
    label: 'opening a card shows its detail and focuses Updates',
  })
  await eventually({
    condition: 'document.querySelector(".task-updates")?.textContent.includes("migration passes locally")',
    label: 'factual worker updates fill the open card',
  })
  await click({ selector: `[data-task="${task().id}"] .card-state` })
  await check({
    condition: '!document.querySelector(".card.selected")',
    label: 'clicking the open card body closes it',
  })
  await click({ selector: `[data-task="${task().id}"] .card-state` })
  withWriter({
    hydraId: 'default',
    fn: ({ writer }) => {
      const decision = decidePush({
        state: writer.state,
        key: 'review',
        input: {
          agent: {
            provider: 'claude-code',
            sessionId: 'fixture',
            transcriptPath: transcript,
            cwd: home,
          },
          activity: 'finished',
          source: {
            adapter: 'firstmate',
            instanceId: native,
            objectId: 'work',
          },
        },
        meta: {
          at: new Date().toISOString(),
          actor: 'hydra',
        },
      })
      assert.ok('event' in decision); writer.append({ event: decision.event })
    },
  })
  await eventually({
    condition: '!!document.querySelector(".card.selected .card-agent")',
    label: 'the attached agent appears in the card header',
  })
  await check({
    condition: '!!document.querySelector(".card.selected .task-updates") && !document.querySelector(".detail .thread, .detail .composer")',
    label: 'open card shows factual Updates without a reply thread',
  })
  await screenshot({ name: 'cards-open-after.png' })
  await browser({
    args: [
      'resize',
      '1440',
      '400',
    ],
  })
  await check({
    condition: 'document.querySelector(".task-updates").getBoundingClientRect().bottom <= document.querySelector(".card.selected").getBoundingClientRect().bottom',
    label: 'short panes contain Updates',
  })
  await screenshot({ name: 'cards-short-pane.png' })
  await browser({
    args: [
      'resize',
      '1440',
      '900',
    ],
  })
  await click({ selector: '[aria-label="New task in In progress"]' })
  await check({
    condition: '!!document.querySelector(".task-create") && document.activeElement.getAttribute("aria-label") === "Task title"',
    label: 'plus creates a task inline and focuses its title',
  })
  const before = Object.keys(state().cards).length
  await fill({
    label: 'Task title',
    value: 'Inspect the canary',
  }); await fill({
    label: 'Initial prompt',
    value: 'Check the canary gate before rollout.',
  })
  assert.equal(
    Object.keys(state().cards).length,
    before,
  )
  await text({ label: 'Save task' })
  await eventually({
    condition: 'document.querySelector(".card.selected")?.textContent.includes("Inspect the canary") && !!document.querySelector(".task-updates")',
    label: 'saving opens the task and focuses Updates without starting it',
  })
  const created = Object.values(state().cards).find(c => c.title === 'Inspect the canary')!
  assert.equal(
    created.brief,
    'Check the canary gate before rollout.',
  )
  assert.equal(
    created.parentId,
    undefined,
  )
  assert.equal(
    created.agent,
    undefined,
  )
  await click({ selector: `[data-task="${created.id}"] .card-state` })
  await click({ selector: '[aria-label="New task in Parked"]' }); await text({ label: 'Cancel' })
  assert.equal(
    Object.keys(state().cards).length,
    before + 1,
  )
  await text({ label: 'Add column' }); await browser({
    args: [
      'wait',
      'New column',
    ],
  })
  await fill({
    label: 'Rename New column column',
    value: 'Research',
  }); await text({ label: 'Save title' })
  await click({ selector: '[aria-label="Research column menu"]' }); await text({ label: 'Edit description' })
  await fill({
    label: 'Research description',
    value: 'Gather evidence before rollout.',
  }); await text({ label: 'Save description' })
  await eventually({
    condition: 'document.querySelector("[aria-label=Research] h2").title === "Gather evidence before rollout."',
    label: 'column descriptions remain editable',
  })
  await evaluate({ code: 'const columns = [...document.querySelectorAll(".column")]; const dt = new DataTransfer(); columns.at(-1).querySelector(".column-header").dispatchEvent(new DragEvent("dragstart", { bubbles: true, dataTransfer: dt })); columns[0].dispatchEvent(new DragEvent("drop", { bubbles: true, dataTransfer: dt })); return true;' })
  await eventually({
    condition: 'document.querySelector(".column").getAttribute("aria-label") === "Research"',
    label: 'columns still move by dragging the header',
  })
  await evaluate({ code: `const task = document.querySelector('[data-task="${created.id}"]'); const dt = new DataTransfer(); task.dispatchEvent(new DragEvent('dragstart', {bubbles:true, dataTransfer:dt})); document.querySelector('[aria-label=Research]').dispatchEvent(new DragEvent('drop', {bubbles:true, dataTransfer:dt})); return true;` })
  await eventually({
    condition: 'document.querySelector("[aria-label=Research] .card")?.textContent.includes("Inspect the canary")',
    label: 'fixed cards still move by dragging',
  })
  await click({ selector: '[aria-label="Research column menu"]' }); await text({ label: 'Delete column' })
  await check({
    condition: '!!document.querySelector(".delete-confirm") && !document.querySelector("[role=dialog]")',
    label: 'column deletion still confirms inline',
  })
  await text({ label: 'No' }); await text({ label: 'Delete column' }); await text({ label: 'Yes' })
  await eventually({
    condition: '!document.querySelector("[aria-label=Research]")',
    label: 'confirmed deletion removes the column',
  })
  assert.equal(
    state().config?.columns.length,
    5,
  )
  await click({ selector: `[data-task="${state().keys.long}"] [aria-label="Edit"]` })
  await fill({
    label: 'Task title',
    value: 'Review the longer migration plan',
  })
  await text({ label: 'Save title' })
  await eventually({
    condition: `document.querySelector('[data-task="${state().keys.long}"] .card-open')?.textContent.trim() === 'Review the longer migration plan'`,
    label: 'Edit renames the task inline',
  })
  await click({ selector: `[data-task="${state().keys.long}"] [aria-label="Hide"]` })
  await eventually({
    condition: `!document.querySelector('[data-task="${state().keys.long}"]')`,
    label: 'Hide removes the task from its column',
  })
  process.stdout.write('Task cards, factual Updates, inline actions and columns browser smoke passed.\n')
} finally {
  await server.close(); await close(); rmSync(
    home,
    {
      recursive: true,
      force: true,
    },
  )
}
