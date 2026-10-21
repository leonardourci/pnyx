import { fakeDispatch } from './dispatch-fixture.ts'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Options, PermissionResult } from '@anthropic-ai/claude-agent-sdk'
import { commands } from '../src/cli/commands.ts'
import { sendReply } from '../src/cli/reply.ts'
import { startTask } from '../src/cli/start.ts'
import type { QueryFn } from '../src/server/host.ts'
import { startServer } from '../src/server/server.ts'
import { loadHydra } from '../src/store/hydra-store.ts'
import { smokeBrowser } from './browser.ts'

const home = mkdtempSync(join(
  tmpdir(),
  'pnyx-permission-smoke-',
))
process.env.PNYX_HOME = home
process.env.CLAUDE_CONFIG_DIR = join(
  home,
  'claude',
)
process.env.PNYX_SEMANTIC = 'off'
const results: PermissionResult[] = []
let release: (() => void) | undefined
const gate = new Promise<void>(resolve => {
  release = resolve
})
const query = (({
  prompt,
  options,
}: {
  prompt: AsyncIterable<unknown>
  options: Options
}) => {
  async function* run() {
    for await (const message of prompt) {
      assert.ok(message)
      await gate
      const asking = results.length === 2
      const result = await options.canUseTool!(
        asking ? 'AskUserQuestion' : 'Bash',
        asking ? {
          questions: [
            {
              question: 'Which layout should ship?',
              options: [
                {label: 'Updates above chat'},
                {label: 'Tabs'},
              ],
            },
          ],
        } : { command: 'touch allowed.txt' },
        {
          signal: new AbortController().signal,
          toolUseID: 'smoke-tool',
          requestId: 'smoke-request',
        },
      )
      assert.ok(result)
      results.push(result)
      yield {
        type: 'system',
        subtype: 'session_state_changed',
        state: 'idle',
      }
    }
  }

  return Object.assign(
    run(),
    { close() {} },
  )
}) as unknown as QueryFn

await commands.hydra([
  'create',
  'default',
  '--hydra',
  'default',
])

for (let n=0;n<8;n++) {
  await commands.task([
    'create',
    '--title',
    `Earlier task ${n}`,
    '--column',
    'in_progress',
  ])
}

await commands.task([
  'create',
  '--title',
  'Permission example',
  '--key',
  'permission',
  '--folder',
  home,
  '--column',
  'in_progress',
])
let server = await startServer({
  hydraId: 'default',
  query,
})
const state = () => loadHydra({ hydraId: 'default' }).state
const task = () => state().cards[state().keys.permission!]!
const column = task().column
const {
  browser,
  eventually,
  check,
  click,
  text,
  screenshot,
  close,
} = smokeBrowser({
  home,
  session: 'pnyx-permissions',
})
fakeDispatch({
  root: process.env.PNYX_HOME!,
  hydraId: 'default',
})
await startTask({
  hydraId: 'default',
  task: 'permission',
  meta: {
    at: new Date().toISOString(),
    actor: 'fixture',
  },
})

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
      '1400',
      '1000',
    ],
  })
  await browser({
    args: [
      'wait',
      'Permission example',
    ],
  })
  await click({ selector: `[data-task="${task().id}"] .card-open` })
  await screenshot({ name: 'permission-before.png' })
  release?.()
  await eventually({
    condition: '!!document.querySelector(".ask button")',
    label: 'permission buttons appear',
  })
  await check({
    condition: `document.querySelector('[data-column="${column}"] .activity-asks')?.textContent === 'Needs you' && document.querySelector('.permission-input').textContent.includes('touch allowed.txt')`,
    label: 'request shows tool input and asks in the original column',
  })
  await screenshot({ name: 'permission-pending.png' })
  await text({ label: 'Allow' })
  await eventually({
    condition: '!document.querySelector(".ask button")',
    label: 'Allow resolves the request',
  })
  assert.equal(
    task().permissions?.[0]?.status,
    'allow',
  )
  assert.deepEqual(
    results,
    [{ behavior: 'allow' }],
  )
  assert.equal(
    task().column,
    column,
  )
  await sendReply({
    hydraId: 'default',
    request: {
      card: task().id,
      text: 'Ask again',
      homes: [],
      actor: 'fixture',
    },
  })
  await eventually({
    condition: '!!document.querySelector(".ask button")',
    label: 'second request appears',
  })
  await text({ label: 'Deny' })
  await eventually({
    condition: '!document.querySelector(".ask button")',
    label: 'Deny resolves the request',
  })
  assert.equal(
    task().permissions?.[1]?.status,
    'deny',
  )
  assert.equal(
    results[1]?.behavior,
    'deny',
  )
  await sendReply({
    hydraId: 'default',
    request: {
      card: task().id,
      text: 'Ask which layout should ship',
      homes: [],
      actor: 'fixture',
    },
  })
  await eventually({
    condition: '!!document.querySelector(".ask-question")',
    label: 'hosted structured question offers answer choices',
  })
  await click({selector:`[data-task="${task().id}"] .card-open`})
  await eventually({
    condition:`!document.querySelector('[data-task="${task().id}"].selected')`,
    label:'structured question closes before its Answer shortcut',
  })
  await browser({
    args:[
      'eval',
      `()=>{ document.querySelector('[data-task="${task().id}"]').closest('.column-cards').scrollTop=0; return true; }`,
    ],
  })
  await click({selector:`[data-task="${task().id}"] .card-question button`})
  await eventually({
    condition:`document.activeElement?.matches('[data-task="${task().id}"] .ask button')`,
    label:'Answer opens the scrolled task and focuses its mounted first choice',
  })
  await text({ label: 'Updates above chat' })
  await click({ selector: '.ask form button[type=submit]' })
  await eventually({
    condition: '!document.querySelector(".ask-question") && [...document.querySelectorAll(".decision")].some(row => !row.open && row.textContent.includes("Which layout should ship?") && row.textContent.includes("Updates above chat"))',
    label: 'submitting the hosted answer replaces its pending question with a folded decision',
  })
  assert.equal(
    task().permissions?.[2]?.status,
    'allow',
  )
  assert.deepEqual(
    task().permissions?.[2]?.answers,
    [['Updates above chat']],
  )
  assert.equal(
    results[2]?.behavior,
    'allow',
  )
  await sendReply({
    hydraId: 'default',
    request: {
      card: task().id,
      text: 'Ask before restart',
      homes: [],
      actor: 'fixture',
    },
  })
  await eventually({
    condition: '!!document.querySelector(".ask button")',
    label: 'request before restart appears',
  })
  await server.close()
  server = await startServer({
    hydraId: 'default',
    query,
  })
  await browser({
    args: [
      'open',
      server.url,
    ],
  })
  await browser({
    args: [
      'wait',
      'Permission example',
    ],
  })
  await click({ selector: `[data-task="${task().id}"] .card-open` })
  await eventually({
    condition: '!!document.querySelector(".task-updates") && !document.querySelector(".ask button")',
    label: 'restart retains the task and removes expired answer controls',
  })
  await check({
    condition: '!document.querySelector(".ask button") && !!document.querySelector(".decision")',
    label: 'expired request has no answer controls',
  })
  assert.deepEqual(
    task().permissions?.map(request => request.status),
    [
      'allow',
      'deny',
      'allow',
      'expired',
    ],
  )
  assert.deepEqual(
    task().permissions?.[2]?.answers,
    [['Updates above chat']],
  )
  assert.equal(
    results[3]?.behavior,
    'deny',
  )
  await screenshot({ name: 'permission-expired.png' })
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
