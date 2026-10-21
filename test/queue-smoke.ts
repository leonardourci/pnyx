import { hydraSdk } from './hydra-host-fixture.ts'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { commands } from '../src/cli/commands.ts'
import { decidePush } from '../src/core/decide.ts'
import { project } from '../src/projects/cli.ts'
import { startServer } from '../src/server/server.ts'
import { loadHydra, withWriter } from '../src/store/hydra-store.ts'
import { smokeBrowser } from './browser.ts'

const home = mkdtempSync(join(
  tmpdir(),
  'pnyx-queue-smoke-',
))
process.env.PNYX_HOME = home
process.env.PNYX_SEMANTIC = 'off'
process.env.CLAUDE_CONFIG_DIR = join(
  home,
  'claude',
)
process.env.CODEX_HOME = join(
  home,
  'codex',
)
commands.hydra([
  'create',
  'default',
])
commands.hydra([
  'resize',
  '--width',
  '280',
])
const folder = join(
  home,
  'app',
)
mkdirSync(folder)
await project([
  'add',
  folder,
])
const state = () => loadHydra({ hydraId: 'default' }).state

for (const column of state().config!.columns) {
  commands.column([
    'resize',
    column.id,
    '--width',
    '240',
  ])
}

for (const [
  key,
  title,
] of [
    [
      'one',
      'Add API pagination',
    ],
    [
      'two',
      'Handle pagination retries',
    ],
    [
      'three',
      'Add cursor regression cases',
    ],
  ]) {
  commands.task([
    'create',
    '--key',
    key!,
    '--title',
    title!,
    '--brief',
    title!,
    '--project',
    'app',
  ])
}

commands.move([
  'one',
  'in_progress',
  '--actor',
  'web',
])
withWriter({
  hydraId: 'default',
  fn: ({ writer }) => {
    const decision = decidePush({
      state: writer.state,
      key: 'one',
      input: {
        activity: 'finished',
        agent: {
          provider: 'codex',
          sessionId: 'pagination-worker',
          host: 'pnyx',
          cwd: folder,
        },
      },
      meta: {
        actor: 'test',
        at: new Date().toISOString(),
      },
    })

    if ('event' in decision) {
      writer.append({ event: decision.event })
    }
  },
})
commands.task([
  'create',
  '--key',
  'other',
  '--title',
  'Fix response parser',
  '--brief',
  'Fix parser',
  '--project',
  'app',
])
commands.move([
  'other',
  'in_progress',
  '--actor',
  'web',
])
withWriter({
  hydraId: 'default',
  fn: ({ writer }) => {
    const decision = decidePush({
      state: writer.state,
      key: 'other',
      input: {
        activity: 'finished',
        agent: {
          provider: 'codex',
          sessionId: 'parser-worker',
          host: 'pnyx',
          cwd: folder,
        },
      },
      meta: {
        actor: 'test',
        at: new Date().toISOString(),
      },
    })

    if ('event' in decision) {
      writer.append({ event: decision.event })
    }
  },
})
const server = await startServer({
  hydraId: 'default',
  query: hydraSdk().query,
})
const {
  browser,
  click,
  text,
  eventually,
  screenshot,
  check,
  close,
} = smokeBrowser({
  home,
  session: 'pnyx-worker-queue',
})
const two = state().keys.two!

try {
  await browser({
    args: [
      'open',
      server.url,
    ],
  })
  await browser({
    args: [
      'resize',
      '1600',
      '900',
    ],
  })
  await browser({
    args: [
      'wait',
      'Handle pagination retries',
    ],
  })
  await screenshot({ name: 'queue-before.png' })
  await click({ selector: '[aria-label="Card menu for Handle pagination retries"]' })
  await text({ label: 'Queue behind a worker…' })
  await check({
    condition: '!!document.querySelector(".queue-editor") && !document.querySelector("[role=dialog]")',
    label: 'queue editor opens inline',
  })
  await text({ label: 'Save queue' })
  await eventually({
    condition: 'document.querySelector(".queue-label")?.textContent.includes("next for Add API pagination")',
    label: 'queued card names its worker',
  })
  commands.task([
    'queue',
    'three',
    '--behind',
    'two',
  ])
  await eventually({
    condition: 'document.querySelectorAll(".worker-queue li").length === 2',
    label: 'worker lists both tasks in order',
  })
  await screenshot({ name: 'queue-after.png' })
  await check({
    condition: '[...document.querySelectorAll(".worker-queue li")].map(el => el.textContent).join("|") === "Handle pagination retries|Add cursor regression cases"',
    label: 'queue order matches the saved order',
  })
  await click({ selector: '[aria-label="Card menu for Handle pagination retries"]' })
  await text({ label: 'Edit worker queue…' })
  await text({ label: 'Unqueue' })
  await eventually({
    condition: `!document.querySelector('[data-task="${two}"] .queue-label') && document.querySelectorAll('.worker-queue li').length === 1`,
    label: 'unqueue updates both cards',
  })
  await click({ selector: '[aria-label="Card menu for Handle pagination retries"]' })
  await text({ label: 'Queue behind a worker…' })
  await click({ selector: '[aria-label="Queue behind"]' })
  await click({ selector: '[role="option"]:nth-child(2)' })
  await text({ label: 'Save queue' })
  await eventually({
    condition: 'document.querySelectorAll(".worker-queue li")[0]?.textContent === "Add cursor regression cases"',
    label: 'After selection changes persisted order',
  })
  assert.equal(
    state().cards[two]!.queue?.rank,
    2,
  )
  await click({ selector: '[aria-label="Card menu for Handle pagination retries"]' })
  await text({ label: 'Edit worker queue…' })
  await click({ selector: '[aria-label="Queue behind"]' })
  await click({ selector: '[role="option"]:last-child' })
  await text({ label: 'Save queue' })
  await eventually({
    condition: `document.querySelector('[data-task="${two}"] .queue-label')?.textContent.includes('Fix response parser')`,
    label: 'selecting another worker changes assignment',
  })
  assert.equal(
    state().cards[two]!.queue?.session,
    'codex:parser-worker',
  )
} finally {
  await close()
  await server.close()
  rmSync(
    home,
    {
      recursive: true,
      force: true,
    },
  )
}
