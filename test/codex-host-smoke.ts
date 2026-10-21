import assert from 'node:assert/strict'
import { hydraSdk } from './hydra-host-fixture.ts'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { decidePush, decideSession } from '../src/core/decide.ts'
import { commands } from '../src/cli/commands.ts'
import { dispatchCommands } from '../src/dispatch/cli.ts'
import { fakeDispatch } from './dispatch-fixture.ts'
import { startServer } from '../src/server/server.ts'
import { loadHydra, withWriter } from '../src/store/hydra-store.ts'
import { smokeBrowser } from './browser.ts'
import { fakeCodex } from './codex-fixture.ts'

const root = realpathSync(mkdtempSync(join(
  tmpdir(),
  'pnyx-codex-smoke-',
)))
process.env.PNYX_HOME = join(
  root,
  'pnyx',
)
process.env.CODEX_HOME = join(
  root,
  'codex',
)
process.env.CLAUDE_CONFIG_DIR = join(
  root,
  'claude',
)
process.env.PNYX_SEMANTIC = 'off'
await commands.hydra([
  'create',
  'default',
])
fakeDispatch({
  root: process.env.PNYX_HOME!,
  hydraId: 'default',
})
await dispatchCommands.rule([
  'set',
  'hydra',
  '--harness',
  'claude',
  '--model',
  'sonnet',
])
await dispatchCommands.rule([
  'set',
  'default',
  '--harness',
  'codex',
  '--model',
  'gpt-6.1-sol',
  '--effort',
  'high',
  '--mode',
  'on-request',
])
await commands.task([
  'create',
  '--title',
  'Hosted Codex smoke',
  '--key',
  'smoke',
  '--folder',
  root,
])
await commands.task([
  'brief',
  'smoke',
  '--brief',
  'Explain the provider boundary.',
])
await commands.task([
  'create',
  '--title',
  'Outside Codex smoke',
  '--key',
  'outside',
  '--folder',
  root,
])
const fixture = fakeCodex({
  root,
  models: ['gpt-6.1-sol'],
})
withWriter({
  hydraId: 'default',
  fn: ({ writer }) => {
    const meta = {
      actor: 'fixture',
      at: new Date().toISOString(),
    }
    const pushed = decidePush({
      state: writer.state,
      newCardId: `c${writer.state.seq + 1}`,
      key: 'codex:outside-thread',
      input: {
        agent: {
          provider: 'codex',
          sessionId: 'outside-thread',
          cwd: root,
          transcriptPath: fixture.transcript,
        },
        terminal: { tty: '/dev/ttys123' },
        activity: 'ended',
        source: {
          adapter: 'hooks',
          instanceId: 'codex',
          objectId: 'outside-thread',
          observedAt: meta.at,
        },
      },
      meta,
    })
    assert.ok('event' in pushed); writer.append({ event: pushed.event })
    const attached = decideSession({
      state: writer.state,
      ref: 'codex:outside-thread',
      task: writer.state.keys.outside!,
      meta,
    })
    assert.ok('event' in attached); writer.append({ event: attached.event })
  },
})
const server = await startServer({
  query: hydraSdk().query,
  hydraId: 'default',
  spawnCodex: fixture.spawnCodex,
})
const {
  browser,
  click,
  evaluate,
  eventually,
  screenshot,
  close,
} = smokeBrowser({
  home: root,
  session: 'pnyx-codex',
})

const task = () => {
  const state = loadHydra({ hydraId: 'default' }).state

  return state.cards[state.keys.smoke!]!
}

const threads = () => fixture.messages().filter(message => [
  'thread/start',
  'thread/resume',
].includes(message.method ?? '')).length

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
      '1440',
      '1000',
    ],
  })
  await browser({
    args: [
      'wait',
      'Hosted Codex smoke',
    ],
  })
  await click({ selector: `[data-task="${task().id}"] .card-open` })
  await commands.task([
    'start',
    'smoke',
    '--actor',
    'hydra',
    '--reason',
    'Use the project’s default agent',
  ])
  await eventually({
    condition: '!!document.querySelector(".card.selected .card-agent[aria-label=Codex]")',
    label: 'Codex attaches as a hosted agent',
  })
  await commands.task([
    'status',
    'smoke',
    'done',
    '--note',
    'Provider boundary explained.',
  ])
  await eventually({
    condition: 'document.querySelector(".task-updates")?.textContent.includes("Provider boundary explained")',
    label: 'hosted Codex task shows factual Updates',
  })
  assert.equal(
    task().agent?.host,
    'pnyx',
  )
  await evaluate({ code: 'document.querySelector(".card.selected .card-agent").focus(); return true;' })
  await eventually({
    condition: 'document.querySelector("[role=tooltip]")?.textContent === "Codex · Pnyx"',
    label: 'hosted Codex tooltip shows its provider and host',
  })
  await screenshot({ name: 'codex-hosted.png' })
  await click({ selector: `[data-task="${task().id}"] .card-state` })
  await click({ selector: '[aria-label="Open task Outside Codex smoke"]' })
  await commands.task([
    'continue',
    'outside',
    '--actor',
    'hydra',
    '--reason',
    'Resume the recorded session',
  ])
  await eventually({
    condition: '!!document.querySelector(".card.selected .card-agent[aria-label=Codex]")',
    label: 'continued Codex task retains its provider badge',
  })
  const continued = loadHydra({ hydraId: 'default' }).state
  assert.equal(
    continued.cards[continued.keys.outside!]?.agent?.host,
    'pnyx',
  )
  assert.equal(
    threads(),
    1,
  )
  await commands.task([
    'status',
    'outside',
    'working',
    '--note',
    'Resumed the outside thread.',
  ])
  await eventually({
    condition: 'document.querySelector(".task-updates")?.textContent.includes("Resumed the outside thread")',
    label: 'continued task shows recorded Updates',
  })
  await screenshot({ name: 'codex-continue-after.png' })
  process.stdout.write('Hosted Codex and outside continuation browser smoke passed.\n')
} finally {
  await server.close()
  await close()
  rmSync(
    root,
    {
      recursive: true,
      force: true,
    },
  )
}
