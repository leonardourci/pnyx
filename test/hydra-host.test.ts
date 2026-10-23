import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, test } from 'node:test'
import { WebSocket } from 'ws'
import { commands } from '../src/cli/commands.ts'
import { decidePush } from '../src/core/decide.ts'
import { HYDRA_CARD, hydraEvent, wakesHydra } from '../src/core/hydra.ts'
import type { HydraEvent } from '../src/core/model.ts'
import { startTask } from '../src/cli/start.ts'
import { hydraCheck } from '../src/cli/workers.ts'
import { sendReply } from '../src/cli/reply.ts'
import { fakeDispatch } from './dispatch-fixture.ts'
import { loadHydra, readEvents, withWriter } from '../src/store/hydra-store.ts'
import { taskMention } from '../src/mentions/mentions.ts'
import { createHost } from '../src/server/host.ts'
import { startServer, type RunningServer } from '../src/server/server.ts'
import { askHost, localToken } from '../src/server/state.ts'
import { readThread } from '../src/thread/read.ts'
import { hydraSdk } from './hydra-host-fixture.ts'
import { fakeCodex } from './codex-fixture.ts'
import { configPath, writeConfig } from '../src/dispatch/config.ts'

let server: RunningServer | undefined
let home = ''

// Each test gets its own home with Hydra lab; the login folders stay missing so no real login is read.
beforeEach(() => {
  home = realpathSync(mkdtempSync(join(
    tmpdir(),
    'pnyx-hydra-host-',
  )))
  process.env.PNYX_HOME = join(
    home,
    'pnyx',
  )
  process.env.CLAUDE_CONFIG_DIR = join(
    home,
    'claude',
  )
  process.env.CODEX_HOME = join(
    home,
    'codex',
  )
  process.env.PNYX_SEMANTIC = 'off'
  commands.hydra([
    'create',
    'lab',
  ])
})

afterEach(async () => {
  await server?.close()
  server = undefined
  rmSync(
    home,
    {
      recursive: true,
      force: true,
    },
  )
})

async function until({ check }: { check(): boolean }) {
  for (let i = 0; i < 200; i++) {
    if (check()) {
      return
    }

    await new Promise(resolve => setTimeout(
      resolve,
      10,
    ))
  }

  assert.fail('Hydra did not finish its turn')
}

const sleep = ({ ms }: { ms: number }) => new Promise(resolve => setTimeout(
  resolve,
  ms,
))
const state = () => loadHydra({ hydraId: 'lab' }).state
const hydra = () => state().cards[HYDRA_CARD]
const finished = () => hydra()?.sessionActivity === 'finished'
const interrupted = () => hydra()?.attention.some(a => a.kind === 'interrupted') ?? false
const send = ({
  text,
  id,
}: {
  text: string
  id?: string
}) => commands.hydra([
  'send',
  '--hydra',
  'lab',
  '--text',
  text,
  ...(id ? [
    '--event-id',
    id,
  ] : []),
])

const choose = ({ agent }: { agent: Record<string, string> }) => withWriter({
  hydraId: 'lab',
  fn: ({ writer }) => {
    const config = writer.state.config!
    const decision = hydraEvent({
      state: writer.state,
      meta: {
        at: new Date().toISOString(),
        actor: 'test',
      },
      cardId: HYDRA_CARD,
      change: {
        type: 'board.configured',
        data: {
          ...config,
          hydra: {
            ...config.hydra,
            agent: agent as { harness: 'claude' },
          },
        },
      },
    })
    assert.ok('event' in decision); writer.append({ event: decision.event })
  },
})

const codexRule = () => writeConfig({
  path: configPath({ hydraId: 'lab' }),
  value: {
    default: [
      {
        harness: 'codex',
        model: 'gpt-6-luna',
      },
    ],
  },
})

test(
  'Hydra starts in its own folder, replies, resumes after restart and deduplicates sends',
  async () => {
    const sdk = hydraSdk()
    server = await startServer({
      hydraId: 'lab',
      query: sdk.query,
    })
    await send({
      text: 'Hello Hydra',
      id: 'hello',
    })
    await until({ check: finished })
    const agent = hydra()!.agent!
    assert.equal(
      agent.host,
      'pnyx',
    )
    assert.equal(
      agent.cwd,
      join(
        process.env.PNYX_HOME!,
        'hydras',
        'lab',
        'agent',
      ),
    )
    const read = ({ path }: { path: string }) => readFileSync(
      join(
        agent.cwd!,
        path,
      ),
      'utf8',
    )
    assert.equal(
      read({ path: 'CLAUDE.md' }),
      '@AGENTS.md\n',
    )
    assert.match(
      read({ path: 'AGENTS.md' }),
      /^# Hydra\n[\s\S]*## Load before/,
    )
    assert.match(
      read({ path: '.claude/skills/inscribe/SKILL.md' }),
      /^---\nname: inscribe/,
    )
    assert.ok(!existsSync(join(
      agent.cwd!,
      '.agents/skills/pnyx-hydra',
    )))
    const {
      options,
      raw,
    } = sdk.calls[0]!
    assert.match(
      raw[0]!,
      /^<pnyx-digest hydra="lab"[\s\S]*<\/pnyx-digest>\n\nHello Hydra$/,
    )
    assert.match(
      JSON.stringify(options.systemPrompt),
      /You are Hydra.*lab/,
    )

    // After a compaction Claude Code reads a current digest from the SessionStart hook.
    const {
      matcher,
      hooks,
    } = options.hooks!.SessionStart![0]!
    assert.equal(
      matcher,
      'compact',
    )
    commands.owner([
      'memory',
      'set',
      '--key',
      'preferences',
      '--text',
      'Hydra owner preference.',
    ])
    const compacted = await (hooks[0] as unknown as () => Promise<{
      hookSpecificOutput: { additionalContext: string }
    }>)()
    assert.match(
      compacted.hookSpecificOutput.additionalContext,
      /^<pnyx-digest hydra="lab" through="\d+">[\s\S]*Hydra owner preference/,
    )
    assert.doesNotMatch(
      raw[0]!,
      /Hydra owner preference/,
    )

    assert.ok(readThread({
      hydraId: 'lab',
      state: state(),
      card: hydra()!,
      homes: [],
    }).entries.some(e => e.role === 'assistant' && e.text.includes('Hello Hydra')))
    await send({
      text: 'Hello Hydra',
      id: 'hello',
    })
    assert.equal(
      sdk.calls[0]!.messages.length,
      1,
    )
    await server.close()
    server = await startServer({
      hydraId: 'lab',
      query: sdk.query,
    })
    await send({
      text: 'After restart',
      id: 'restart',
    })
    await until({ check: () => sdk.calls.length === 2 && finished() })
    assert.equal(
      sdk.calls[1]!.options.resume,
      agent.sessionId,
    )
    assert.equal(
      state().config?.hydra.session,
      `claude-code:${agent.sessionId}`,
    )
  },
)

test(
  'Hydra hosts Codex and resumes its thread after restart',
  async () => {
    codexRule()
    const codex = fakeCodex({ root: home })
    server = await startServer({
      hydraId: 'lab',
      spawnCodex: codex.spawnCodex,
    })
    await send({ text: 'Hello Codex' })
    await until({ check: finished })
    const session = state().config!.hydra.session
    assert.match(
      String(codex.messages().find(m => m.method === 'thread/start')?.params?.developerInstructions),
      /You are Hydra/,
    )
    await server.close()
    server = await startServer({
      hydraId: 'lab',
      spawnCodex: codex.spawnCodex,
    })
    await send({ text: 'Continue Codex' })
    await until({ check: () => codex.messages().some(m => m.method === 'thread/resume') && finished() })
    assert.equal(
      state().config!.hydra.session,
      session,
    )
    // The digest leads the first turn of each opened thread and the turn after a compaction.
    const inputs = () => codex.messages().filter(m => m.method === 'turn/start')
      .map(m => (m.params!.input as { text: string }[])[0]!.text)
    assert.match(
      inputs()[0]!,
      /^<pnyx-digest hydra="lab"[\s\S]*<\/pnyx-digest>\n\nHello Codex$/,
    )
    assert.match(
      inputs()[1]!,
      /^<pnyx-digest hydra="lab"[\s\S]*\n\nContinue Codex$/,
    )
    await send({ text: 'COMPACT' })
    await until({ check: () => inputs().length === 3 && finished() })
    assert.equal(
      inputs()[2],
      'COMPACT',
    )
    await send({ text: 'After compaction' })
    await until({ check: () => inputs().length === 4 && finished() })
    assert.match(
      inputs()[3]!,
      /^<pnyx-digest hydra="lab"[\s\S]*\n\nAfter compaction$/,
    )
  },
)

test(
  'Hydra exposes provider failures and Firstmate Hydras never start a hosted agent',
  async () => {
    const sdk = hydraSdk(); sdk.control.fail = true
    server = await startServer({
      hydraId: 'lab',
      query: sdk.query,
    })
    await send({ text: 'Hello' })
    await until({ check: interrupted })
    assert.match(
      hydra()!.attention[0]!.text ?? '',
      /Harness login is missing/,
    )
    sdk.control.fail = false
    const session = hydra()!.agent!.sessionId
    await send({ text: 'Retry after sign-in' })
    await until({ check: () => sdk.calls[1]?.messages.length === 1 && finished() })
    assert.deepEqual(
      [
        sdk.calls[1]!.options.resume,
        sdk.calls[1]!.options.sessionId,
      ],
      [
        undefined,
        session,
      ],
    )
    assert.ok(!interrupted())
    commands.hydra([
      'set',
      '--hydra',
      'lab',
      '--firstmate',
      join(
        home,
        'firstmate',
      ),
    ])
    await send({ text: 'Firstmate message' })
    assert.equal(
      sdk.calls.length,
      2,
    )
    assert.equal(
      state().hydraMessages?.at(-1)?.text,
      'Firstmate message',
    )
  },
)

test(
  'queued Hydra messages wait for the running turn, deduplicate and keep the settings selected when sent',
  async () => {
    const sdk = hydraSdk(); sdk.control.hold = true
    server = await startServer({
      hydraId: 'lab',
      query: sdk.query,
    })
    choose({
      agent: {
        harness: 'claude',
        model: 'sonnet',
      },
    })
    await send({ text: 'First' })
    await until({ check: () => sdk.calls[0]?.messages.length === 1 })

    for (let i = 0; i < 2; i++) {
      await send({
        text: 'Second',
        id: 'second',
      })
    }

    assert.deepEqual(
      sdk.calls[0]?.messages,
      ['First'],
    )
    choose({
      agent: {
        harness: 'claude',
        model: 'opus',
      },
    })
    await send({ text: 'Third' })
    choose({
      agent: {
        harness: 'claude',
        model: 'haiku',
      },
    })
    sdk.release()
    await until({ check: () => sdk.calls.some(c => c.messages.includes('Third')) })
    assert.equal(
      sdk.calls.flatMap(c => c.messages).filter(m => m === 'Second').length,
      1,
    )
    assert.equal(
      sdk.calls.find(c => c.messages.includes('Second'))?.options.model,
      'sonnet',
    )
    assert.equal(
      sdk.calls.find(c => c.messages.includes('Third'))?.options.model,
      'opus',
    )
  },
)

test(
  'each tagged reply pairs with the message its turn answered, and only the owner’s chat becomes an ask',
  async () => {
    const home = mkdtempSync(join(
      tmpdir(),
      'pnyx-hydra-tag-turns-',
    ))
    process.env.PNYX_HOME = home
    process.env.CLAUDE_CONFIG_DIR = join(
      home,
      'claude',
    )
    process.env.PNYX_SEMANTIC = 'off'
    commands.hydra([
      'create',
      'lab',
    ])
    commands.task([
      'create',
      '--key',
      'quick',
      '--title',
      'Task quick',
      '--hydra',
      'lab',
    ])
    const state = () => loadHydra({ hydraId: 'lab' }).state
    const quick = state().keys.quick!
    const sdk = hydraSdk()
    sdk.control.stream = true
    sdk.control.hold = true
    sdk.control.reply = `${taskMention({
      id: quick,
      title: 'Task quick',
    })} Noted.`
    const server = await startServer({
      hydraId: 'lab',
      query: sdk.query,
      wakeDelay: 50,
    })
    const notes = ({ source }: { source: string }) => readEvents({ hydraId: 'lab' })
      .flatMap(event => event.type === 'card.noted' && event.cardId === quick && event.data.source === source ? [event.data.text] : [])
    const send = ({ args }: { args: string[] }) => commands.hydra([
      'send',
      '--hydra',
      'lab',
      ...args,
    ])

    try {
      await send({
        args: [
          '--text',
          'First',
        ],
      })
      await until({ check: () => sdk.calls[0]?.messages.length === 1 })

      for (const args of [
        [
          '--text',
          'Second',
        ],
        [
          '--task',
          quick,
          '--text',
          'A worker question',
          '--actor',
          `worker:${quick}`,
        ],
        [
          '--task',
          quick,
          '--text',
          'Already on the task',
        ],
      ]) {
        await send({ args })
      }

      sdk.control.hold = false
      sdk.release()
      await until({ check: () => notes({ source: 'hydra' }).length === 4 })
      assert.deepEqual(
        notes({ source: 'hydra' }),
        Array(4).fill('Noted.'),
      )
      assert.deepEqual(
        notes({ source: 'owner' }),
        [
          'First',
          'Second',
        ],
      )
      const received = sdk.calls.flatMap(call => call.messages)
      // The report waits for the owner's turns and reaches Hydra in its own check turn, with no check to run.
      const reports = received.filter(text => text.includes('A worker question')).map(text => text.replace(
        / message="[^"]+"/,
        '',
      ))
      assert.equal(
        reports.length,
        1,
      )
      assert.ok(reports[0]!.startsWith('<pnyx-wake>A worker report arrived while you were busy.'))
      assert.ok(reports[0]!.includes(`<pnyx-report from="worker:${quick}" task="${quick}">\nA worker question\n</pnyx-report>`))
      assert.ok(!reports[0]!.includes('hydra check'))
      assert.ok(received.includes('Second'))
    } finally {
      sdk.release(); await server.close(); rmSync(
        home,
        {
          recursive: true,
          force: true,
        },
      )
    }
  },
)

test(
  'changing Hydra harness preserves the earlier conversation',
  async () => {
    const sdk = hydraSdk(), codex = fakeCodex({ root: home })
    server = await startServer({
      hydraId: 'lab',
      query: sdk.query,
      spawnCodex: codex.spawnCodex,
    })
    await send({ text: 'Earlier message' })
    await until({ check: finished })
    choose({ agent: { harness: 'codex' } })
    await send({ text: 'Later message' })
    await until({ check: () => hydra()?.agent?.provider === 'codex' && finished() })
    const texts = readThread({
      hydraId: 'lab',
      state: state(),
      card: hydra()!,
      homes: [],
    }).entries.filter(e => e.role === 'assistant').map(e => e.text)
    assert.ok(texts.includes('Hydra: Earlier message'))
    assert.ok(texts.includes('Codex: Later message'))
  },
)

test(
  'a running Hydra takes bypass permissions from its composer during the turn and keeps it',
  async () => {
    const sdk = hydraSdk(); sdk.control.hold = true
    server = await startServer({
      hydraId: 'lab',
      query: sdk.query,
    })
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/hydra/lab/ws?token=${localToken()}`)

    const composer = ({ mode }: { mode: string }) => new Promise<void>((
      resolve,
      reject,
    ) => {
      const id = `agent-${mode}`

      // eslint-disable-next-line pnyx/object-params -- ws owns this listener signature.
      const receipt = (data: unknown) => {
        const message = JSON.parse(String(data)) as {
          id?: string
          type: string
        }

        if (message.id === id) {
          ws.off(
            'message',
            receipt,
          )
          void (message.type === 'receipt' ? resolve() : reject(new Error(String(data))))
        }
      }

      ws.on(
        'message',
        receipt,
      )
      ws.send(JSON.stringify({
        type: 'command',
        id,
        name: 'hydra-agent',
        args: [
          JSON.stringify({
            harness: 'claude',
            model: 'sonnet',
            effort: 'high',
            mode,
          }),
        ],
      }))
    })

    try {
      await new Promise(resolve => ws.once(
        'open',
        resolve,
      ))
      await composer({ mode: 'default' })
      await send({ text: 'First' })
      await until({ check: () => sdk.calls[0]?.messages.length === 1 })
      assert.deepEqual(
        [
          sdk.calls[0]!.options.permissionMode,
          sdk.calls[0]!.options.allowDangerouslySkipPermissions,
        ],
        [
          'default',
          true,
        ],
      )
      await composer({ mode: 'bypassPermissions' })
      await until({ check: () => sdk.sets.includes('mode bypassPermissions') })
      assert.deepEqual(
        sdk.sets,
        ['mode bypassPermissions'],
      )
      assert.equal(
        hydra()?.settings?.mode,
        'bypassPermissions',
      )
      sdk.release()
      await until({ check: finished })
      await send({ text: 'Second' })
      await until({ check: () => sdk.calls.some(c => c.messages.includes('Second')) })
      assert.deepEqual(
        sdk.calls.map(c => c.messages),
        [
          [
            'First',
            'Second',
          ],
        ],
      )
    } finally {
      ws.close()
    }
  },
)

test(
  'a hosted Hydra wakes once for worker changes, never for its own, and after a restart',
  async () => {
    fakeDispatch({ root: home })
    const folder = join(
      home,
      'work',
    )
    mkdirSync(folder)
    await commands.task([
      'create',
      '--title',
      'Fix add',
      '--key',
      'fix',
      '--folder',
      folder,
      '--hydra',
      'lab',
    ])
    const sdk = hydraSdk()
    server = await startServer({
      hydraId: 'lab',
      query: sdk.query,
      wakeDelay: 300,
    })
    const wakes = () => sdk.calls.filter(c => c.options.cwd !== folder).flatMap(c => c.messages)
      .filter(m => m.includes('<pnyx-wake>'))
    const declare = ({
      status,
      actor = 'cli',
    }: {
      status: string
      actor?: string
    }) => commands.task([
      'status',
      'fix',
      status,
      '--note',
      status,
      '--actor',
      actor,
      '--reason',
      'testing',
      '--hydra',
      'lab',
    ])

    await send({ text: 'Watch the fix' })
    await until({ check: finished })
    const before = state().seq

    // The worker's finished turn and plain working wait on the card; a memory change and done share one check turn.
    await startTask({
      hydraId: 'lab',
      task: 'fix',
      meta: {
        at: new Date().toISOString(),
        actor: 'hydra',
        reason: 'start it',
        id: 'start-fix',
      },
    })
    await until({ check: () => state().cards[state().keys.fix!]?.sessionActivity === 'finished' })
    commands.owner([
      'memory',
      'set',
      '--key',
      'learnings',
      '--text',
      'Releases ship on Fridays.',
    ])
    declare({ status: 'working' })
    declare({ status: 'done' })
    await until({ check: () => wakes().length === 1 && finished() })
    // It starts just before the first change it covers, and names the memory change without its text.
    const first = Number(/hydra check --after (\d+) --hydra lab/.exec(wakes()[0]!)![1])
    assert.ok(first >= before)
    assert.match(
      wakes()[0]!,
      / Memory changed; load owner memory[^\n]*<\/pnyx-wake>$/,
    )
    assert.doesNotMatch(
      wakes()[0]!,
      /Releases ship on Fridays|<pnyx-digest|Owner preferences/,
    )
    declare({ status: 'blocked' })
    await until({ check: () => wakes().length === 2 && finished() })
    assert.doesNotMatch(
      wakes()[1]!,
      /Memory changed|<pnyx-digest/,
    )
    const through = state().seq

    // Hydra's own writes and turns never wake it.
    declare({
      status: 'working',
      actor: 'hydra',
    })
    await sleep({ ms: 500 })
    assert.equal(
      wakes().length,
      2,
    )

    // The wake prompt is not an owner message in Hydra's chat.
    const thread = readThread({
      hydraId: 'lab',
      state: state(),
      card: hydra()!,
      homes: [],
    })
    assert.ok(!thread.entries.some(e => e.text.includes('pnyx-wake') || e.text.includes('hydra check --after')))

    // A change while the server is stopped wakes Hydra when it is back, after the last wake.
    await server.close()
    declare({ status: 'done' })
    server = await startServer({
      hydraId: 'lab',
      query: sdk.query,
      wakeDelay: 300,
    })
    await until({ check: () => wakes().length === 3 })
    const after = Number(/--after (\d+)/.exec(wakes()[2]!)![1])
    assert.ok(
      after > first && after < through,
      `${after} resumes after the first wake`,
    )
  },
)

test(
  'wakes come from new questions, judgment declarations, pending permissions, merges and due reminders, never from plain progress',
  async () => {
    await commands.task([
      'create',
      '--title',
      'Fix add',
      '--key',
      'fix',
      '--hydra',
      'lab',
    ])
    const id = state().keys.fix!
    const event = ({
      change,
      actor = 'pnyx',
      cardId = id,
    }: {
      change: object
      actor?: string
      cardId?: string
    }) => ({
      v: 1,
      seq: 999,
      id: 'e',
      at: new Date().toISOString(),
      actor,
      cardId,
      ...change,
    }) as HydraEvent
    const ask = {
      key: 'q',
      kind: 'question',
      blocking: true,
      text: 'Which schema?',
    }
    const pushed = ({
      data,
      actor,
    }: {
      data: object
      actor?: string
    }) => event({
      change: {
        type: 'card.pushed',
        data: {
          key: 'fix',
          ...data,
        },
      },
      actor,
    })
    const permission = ({ status }: { status: string }) => ({
      type: 'task.permission',
      data: {
        id: 'p',
        session: 's',
        tool: 'Bash',
        input: {},
        status,
      },
    })
    const due = {
      type: 'task.reminder-due',
      data: {
        reminder: 'r',
        column: 'needs_you',
        message: {},
      },
    }
    // A Hydra the server does not run is never woken.
    assert.equal(
      wakesHydra({
        state: state(),
        event: event({ change: due }),
      }),
      false,
    )
    server = await startServer({
      hydraId: 'lab',
      query: hydraSdk().query,
    })
    await send({ text: 'Hello' })
    await until({ check: finished })
    const hosted = state()
    const finishedBy = ({ actor }: { actor: string }) => pushed({
      data: {
        activity: 'finished',
        before: { activity: 'working' },
      },
      actor,
    })
    const declared = ({ status }: { status: string }) => event({
      change: {
        type: 'task.declared',
        data: {
          state: status,
          note: status,
        },
      },
      actor: 'worker:fix',
    })
    const linked = ({
      before,
      after,
    }: {
      before?: string
      after: string
    }) => event({
      change: {
        type: 'card.linked',
        data: {
          url: 'https://github.com/o/r/pull/1',
          before: before ? {
            kind: 'github_pr',
            url: 'https://github.com/o/r/pull/1',
            state: before,
          } : null,
          after: {
            kind: 'github_pr',
            url: 'https://github.com/o/r/pull/1',
            state: after,
          },
        },
      },
    })

    for (const [
      e,
      wakes,
    ] of [
        [
          pushed({
            data: {
              attention: [ask],
              before: { attention: [] },
            },
          }),
          true,
        ],
        [
          pushed({
            data: {
              attention: [ask],
              before: { attention: [ask] },
            },
          }),
          false,
        ],
        [
          pushed({ data: { attention: [ask] } }),
          false,
        ],
        [
          event({ change: permission({ status: 'pending' }) }),
          true,
        ],
        [
          event({ change: permission({ status: 'expired' }) }),
          false,
        ],
        [
          event({
            change: permission({ status: 'pending' }),
            cardId: HYDRA_CARD,
          }),
          false,
        ],
        [
          event({ change: due }),
          true,
        ],
        [
          event({
            change: due,
            actor: 'hydra',
          }),
          false,
        ],
        // A finished turn with no new question waits for the stall check instead.
        [
          finishedBy({ actor: 'pnyx' }),
          false,
        ],
        [
          finishedBy({ actor: 'hook:claude' }),
          false,
        ],
        [
          declared({ status: 'working' }),
          false,
        ],
        [
          declared({ status: 'paused' }),
          false,
        ],
        [
          declared({ status: 'needs_you' }),
          true,
        ],
        [
          declared({ status: 'blocked' }),
          true,
        ],
        [
          declared({ status: 'done' }),
          true,
        ],
        [
          linked({
            before: 'open',
            after: 'merged',
          }),
          true,
        ],
        [
          linked({ after: 'open' }),
          false,
        ],
        [
          linked({
            before: 'merged',
            after: 'merged',
          }),
          false,
        ],
      ] as const) {
      assert.equal(
        wakesHydra({
          state: hosted,
          event: e,
        }),
        wakes,
        JSON.stringify(e),
      )
    }
  },
)

test(
  'a busy Hydra gets one wake after its turn, and a failed wake is offered again once the owner continues',
  async () => {
    await commands.task([
      'create',
      '--title',
      'Fix add',
      '--key',
      'fix',
      '--hydra',
      'lab',
    ])
    const sdk = hydraSdk()
    server = await startServer({
      hydraId: 'lab',
      query: sdk.query,
      wakeDelay: 50,
    })
    const wakes = () => sdk.calls.flatMap(c => c.messages).filter(m => m.includes('<pnyx-wake>'))
    const declare = ({ status }: { status: string }) => commands.task([
      'status',
      'fix',
      status,
      '--note',
      status,
      '--hydra',
      'lab',
    ])

    await send({ text: 'Hello' })
    await until({ check: finished })

    // Changes during a held wake turn wait for it, then share one more wake.
    sdk.control.hold = true
    declare({ status: 'needs_you' })
    await until({ check: () => wakes().length === 1 })
    assert.ok(
      !Object.keys(state().eventIds).some(id => id.endsWith(':handled')),
      'a wake is not handled while its turn runs',
    )
    const first = state().seq
    declare({ status: 'blocked' })
    declare({ status: 'working' })
    await sleep({ ms: 300 })
    assert.equal(
      wakes().length,
      1,
    )
    sdk.release()
    await until({ check: () => wakes().length === 2 && finished() })
    assert.ok(Number(/--after (\d+)/.exec(wakes()[1]!)![1]) < first)

    // A wake whose turn fails leaves Hydra interrupted: later changes wait for the owner's
    // next message, and the wake after it offers the failed wake's changes again.
    const handled = () => Math.max(...Object.keys(state().eventIds)
      .flatMap(id => /^wake:(\d+):handled$/.exec(id)?.[1] ?? [])
      .map(Number))
    await server.close()
    sdk.control.fail = true
    declare({ status: 'done' })
    const failed = state().seq
    server = await startServer({
      hydraId: 'lab',
      query: sdk.query,
      wakeDelay: 50,
    })
    await until({ check: interrupted })
    const calls = sdk.calls.length, through = handled()
    // The failed wake started its turn, yet the cursor stays before it.
    const startedAfter = Object.keys(state().eventIds)
      .some(id => Number(/^wake:(\d+):hosted$/.exec(id)?.[1] ?? 0) > through)
    assert.ok(through < failed && startedAfter)
    declare({ status: 'blocked' })
    await sleep({ ms: 300 })
    assert.equal(
      sdk.calls.length,
      calls,
    )
    sdk.control.fail = false
    await send({ text: 'Carry on' })
    await until({ check: () => wakes().length === 3 })
    assert.match(
      wakes()[2]!,
      new RegExp(`--after ${through} `),
    )
  },
)

test(
  'a stalled request or a quiet working worker wakes Hydra once, and hydra check lists what waits',
  async () => {
    fakeDispatch({ root: home })
    const folder = join(
      home,
      'work',
    )
    mkdirSync(folder)
    await commands.task([
      'create',
      '--title',
      'Fix add',
      '--key',
      'fix',
      '--folder',
      folder,
      '--hydra',
      'lab',
    ])
    const sdk = hydraSdk()
    server = await startServer({
      hydraId: 'lab',
      query: sdk.query,
      wakeDelay: 50,
      stallDelay: 400,
    })
    const task = () => state().cards[state().keys.fix!]!
    const stalls = () => sdk.calls.filter(c => c.options.cwd !== folder).flatMap(c => c.messages)
      .filter(m => m.startsWith('<pnyx-wake>Stalled'))

    await send({ text: 'Watch the fix' })
    await until({ check: finished })

    // The worker's request stays pending; its own wake comes first, the stall wake later.
    sdk.control.ask = true
    await startTask({
      hydraId: 'lab',
      task: 'fix',
      meta: {
        at: new Date().toISOString(),
        actor: 'hydra',
        reason: 'start it',
        id: 'start-fix',
      },
    })
    await until({ check: () => task().permissions?.some(p => p.status === 'pending') ?? false })
    sdk.control.ask = false
    const worker = sdk.calls.find(c => c.options.cwd === folder)!
    assert.equal(
      worker.options.env?.PNYX_ACTOR,
      `worker:${task().id}`,
    )
    const request = task().permissions![0]!
    assert.ok(request.at)

    const check = await hydraCheck({
      args: [
        'check',
        '--after',
        '0',
        '--hydra',
        'lab',
      ],
    }) as {
      requests: {
        id: string
        task: string
        tool: string
        command: string
      }[]
      changes: { actor: string }[]
      agents: {
        task: string
        quiet: string
      }[]
    }
    assert.deepEqual(
      check.requests.map(r => [
        r.id,
        r.task,
        r.tool,
        r.command,
      ]),
      [
        [
          request.id,
          task().id,
          'Bash',
          'ls',
        ],
      ],
    )
    assert.ok(check.changes.some(c => c.actor === 'owner (cli)'))
    assert.match(
      check.agents.find(a => a.task === task().id)!.quiet,
      /^\d+s$/,
    )

    for (let i = 0; i < 150 && !(stalls().length && finished()); i++) {
      await sleep({ ms: 10 })
    }

    assert.equal(
      stalls().length,
      1,
    )
    assert.match(
      stalls()[0]!,
      /Bash on .* has waited \d+ s for an answer/,
    )
    await sleep({ ms: 500 })
    assert.equal(
      stalls().length,
      1,
      'one wake per stalled request',
    )

    // Answered, the worker finishes; a later turn that goes quiet wakes Hydra again.
    await commands.task([
      'permission',
      'fix',
      request.id,
      'allow',
      '--hydra',
      'lab',
    ])
    await until({ check: () => task().sessionActivity === 'finished' })
    await sleep({ ms: 300 })
    await until({ check: finished })
    sdk.control.hold = true
    await sendReply({
      hydraId: 'lab',
      request: {
        card: 'fix',
        text: 'Keep going',
        homes: [],
        actor: 'test',
      },
    })

    for (let i = 0; i < 150 && stalls().length < 2; i++) {
      await sleep({ ms: 10 })
    }

    assert.match(
      stalls()[1] ?? '',
      /working with no sign of life/,
    )
    sdk.release()
  },
)

test(
  'a worker that ends its turn still declaring working stalls, though plain progress never wakes Hydra',
  async () => {
    fakeDispatch({ root: home })
    const folder = join(
      home,
      'work',
    )
    mkdirSync(folder)
    await commands.task([
      'create',
      '--title',
      'Fix add',
      '--key',
      'fix',
      '--folder',
      folder,
      '--hydra',
      'lab',
    ])
    const sdk = hydraSdk()
    server = await startServer({
      hydraId: 'lab',
      query: sdk.query,
      wakeDelay: 50,
      stallDelay: 300,
    })
    const task = () => state().cards[state().keys.fix!]!
    const wakes = () => sdk.calls.filter(c => c.options.cwd !== folder).flatMap(c => c.messages)
      .filter(m => m.startsWith('<pnyx-wake>'))

    await send({ text: 'Watch the fix' })
    await until({ check: finished })
    await startTask({
      hydraId: 'lab',
      task: 'fix',
      meta: {
        at: new Date().toISOString(),
        actor: 'hydra',
        reason: 'start it',
        id: 'start-fix',
      },
    })
    await until({ check: () => task().sessionActivity === 'finished' })
    await commands.task([
      'status',
      'fix',
      'working',
      '--note',
      'on it',
      '--actor',
      `worker:${task().id}`,
      '--hydra',
      'lab',
    ])
    await sleep({ ms: 200 })
    assert.equal(
      wakes().length,
      0,
      'a finished turn and a plain working declaration stay on the card',
    )

    for (let i = 0; i < 150 && !wakes().length; i++) {
      await sleep({ ms: 10 })
    }

    assert.match(
      wakes()[0] ?? '',
      /ended its turn .* still declares working/,
    )
  },
)

test(
  'a worker inside a tool call is busy, not stalled; a stall comes back counted; an ended wait wakes Hydra once',
  async () => {
    fakeDispatch({ root: home })
    const folder = join(
      home,
      'work',
    )
    mkdirSync(folder)
    await commands.task([
      'create',
      '--title',
      'Run the suite',
      '--key',
      'suite',
      '--folder',
      folder,
      '--hydra',
      'lab',
    ])
    const sdk = hydraSdk()
    server = await startServer({
      hydraId: 'lab',
      query: sdk.query,
      wakeDelay: 50,
      stallDelay: 200,
      busyDelay: 1200,
      stallRepeatMax: 450,
    })
    const wakes = () => sdk.calls.filter(c => c.options.cwd !== folder).flatMap(c => c.messages)
    const stalls = () => wakes().filter(m => m.startsWith('<pnyx-wake>Stalled'))
    const waits = () => wakes().filter(m => m.includes('Wait ended:'))

    await send({ text: 'Watch the suite' })
    await until({ check: finished })
    sdk.control.hold = true
    sdk.control.tool = true
    await startTask({
      hydraId: 'lab',
      task: 'suite',
      meta: {
        at: new Date().toISOString(),
        actor: 'hydra',
        reason: 'start it',
        id: 'start-suite',
      },
    })
    sdk.control.hold = false
    sdk.control.tool = false

    // Quiet well past the stall delay, but inside its tool call.
    await sleep({ ms: 800 })
    assert.equal(
      stalls().length,
      0,
      'a running tool call is not a stall',
    )

    // Each alarm comes after twice the last gap, up to the cap: 400 ms, then 450 rather than 800.
    const alarmTimes: number[] = []

    for (let i = 0; i < 400 && alarmTimes.length < 3; i++) {
      while (stalls().length > alarmTimes.length) {
        alarmTimes.push(Date.now())
      }

      await sleep({ ms: 10 })
    }

    assert.match(
      stalls()[0] ?? '',
      /inside one tool call for \d+ s/,
    )
    assert.match(
      stalls()[1] ?? '',
      /\(alarm 2\)/,
      'a stall still there after Hydra\'s turn comes back',
    )
    assert.match(
      stalls()[2] ?? '',
      /\(alarm 3\)/,
    )
    // Flat gaps would span about 400 ms in all, uncapped ones about 1200.
    const firstGap = alarmTimes[1]! - alarmTimes[0]!
    const span = alarmTimes[2]! - alarmTimes[0]!
    assert.ok(
      firstGap >= 300 && span >= 750 && span < 1100,
      `first alarm gap ${firstGap} ms, three alarms over ${span} ms`,
    )

    // A declared wait silences the stall until it ends, then wakes Hydra once.
    const until1 = new Date(Date.now() + 1500).toISOString()
    await commands.task([
      'status',
      'suite',
      'paused',
      '--until',
      until1,
      '--note',
      'waiting on CI',
      '--hydra',
      'lab',
    ])
    assert.match(
      String((await commands.task([
        'show',
        'suite',
        '--hydra',
        'lab',
      ]) as { task: { status: string } }).task.status),
      new RegExp(`^paused until ${until1}: waiting on CI`),
    )
    await sleep({ ms: 200 })
    const stallsWhilePaused = stalls().length
    // Unpaused, the stall would come back every 450 ms.
    await sleep({ ms: 900 })
    assert.equal(
      stalls().length,
      stallsWhilePaused,
      'no stall during a declared wait',
    )

    for (let i = 0; i < 200 && !waits().length; i++) {
      await sleep({ ms: 10 })
    }

    assert.match(
      waits()[0] ?? '',
      /the worker on .* paused until .*: waiting on CI/,
    )
    await sleep({ ms: 600 })
    assert.equal(
      waits().length,
      1,
      'an ended wait wakes Hydra once',
    )
    sdk.release()
  },
)

test(
  'only a paused declaration takes --until, and a relative time becomes its end',
  async () => {
    await commands.task([
      'create',
      '--title',
      'Wait on CI',
      '--key',
      'ci',
      '--hydra',
      'lab',
    ])
    const declarations = () => readEvents({ hydraId: 'lab' }).filter(event => event.type === 'task.declared').length
    await assert.rejects(
      async () => commands.task([
        'status',
        'ci',
        'working',
        '--until',
        'in 1 hour',
        '--hydra',
        'lab',
      ]),
      /--until goes only with paused/,
    )
    assert.equal(
      declarations(),
      0,
    )
    await commands.task([
      'status',
      'ci',
      'paused',
      '--until',
      'in 2 hours',
      '--note',
      'checks run',
      '--hydra',
      'lab',
    ])
    const declared = state().cards[state().keys.ci!]!.status!
    const waitMs = Date.parse(declared.until!) - Date.parse(declared.at)
    assert.ok(
      Math.abs(waitMs - 2 * 60 * 60 * 1000) < 60_000,
      `waits ${waitMs} ms`,
    )
  },
)

test(
  'a worker whose tool call returned and then went quiet stalls before the busy limit',
  async () => {
    fakeDispatch({ root: home })
    const folder = join(
      home,
      'work',
    )
    mkdirSync(folder)
    await commands.task([
      'create',
      '--title',
      'Run the suite',
      '--key',
      'suite',
      '--folder',
      folder,
      '--hydra',
      'lab',
    ])
    const sdk = hydraSdk()
    server = await startServer({
      hydraId: 'lab',
      query: sdk.query,
      wakeDelay: 50,
      stallDelay: 200,
      busyDelay: 5000,
    })
    const stalls = () => sdk.calls.filter(c => c.options.cwd !== folder).flatMap(c => c.messages)
      .filter(m => m.startsWith('<pnyx-wake>Stalled'))

    await send({ text: 'Watch the suite' })
    await until({ check: finished })
    sdk.control.hold = true
    sdk.control.tool = true
    sdk.control.toolDone = true
    await startTask({
      hydraId: 'lab',
      task: 'suite',
      meta: {
        at: new Date().toISOString(),
        actor: 'hydra',
        reason: 'start it',
        id: 'start-suite',
      },
    })
    sdk.control.hold = false
    sdk.control.tool = false
    sdk.control.toolDone = false

    for (let i = 0; i < 200 && !stalls().length; i++) {
      await sleep({ ms: 10 })
    }

    assert.match(
      stalls()[0] ?? '',
      /working with no sign of life/,
    )
    sdk.release()
  },
)

test(
  'a reply never confirmed after its resends wakes Hydra once',
  async () => {
    const sdk = hydraSdk()
    const host = createHost({
      hydraId: 'lab',
      query: sdk.query,
      changed: () => {},
      stallDelay: 200,
    })
    const notConfirmed = () => sdk.calls.flatMap(c => c.messages).filter(m => m.includes('Not confirmed:'))

    try {
      await host.hydra({
        id: 'hello',
        text: 'Hello',
        actor: 'owner',
      })
      await until({ check: finished })
      const unconfirmed = {
        card: 'task-1',
        reply: 'r1',
        text: 'Rebase   onto\nmain',
      }
      host.unconfirmed(unconfirmed)
      await until({ check: () => notConfirmed().length === 1 && finished() })
      assert.match(
        notConfirmed()[0]!,
        /Not confirmed: on task-1, the message "Rebase onto main" never showed up in the worker's session after 2 resends/,
      )

      // The server reports it again on each check; Hydra already heard.
      host.unconfirmed(unconfirmed)
      await sleep({ ms: 400 })
      assert.equal(
        notConfirmed().length,
        1,
      )
    } finally {
      host.close()
    }
  },
)

test(
  'a cut Hydra turn resumes once with fresh memory and the unanswered message range',
  async () => {
    const first = hydraSdk()
    server = await startServer({
      hydraId: 'lab',
      query: first.query,
    })
    await send({ text: 'Already answered' })
    await until({ check: finished })
    const after = state().seq
    const session = hydra()!.agent!.sessionId
    first.control.hold = true
    first.control.leaveTurnUnfinishedOnClose = true
    await send({
      text: 'I just merged the PR',
      id: 'merged',
    })
    await until({ check: () => first.calls[0]?.messages.length === 2 })
    await send({
      text: 'Please finish the reply',
      id: 'follow-up',
    })
    await server.close()
    // An unrelated event id that looks like a resume does not count as one.
    commands.hydra([
      'memory',
      'set',
      '--hydra',
      'lab',
      '--key',
      'context',
      '--text',
      'New Hydra memory after shutdown',
      '--event-id',
      'resume:unrelated:hosted',
    ])
    const second = hydraSdk()
    second.control.hold = true
    second.control.leaveTurnUnfinishedOnClose = true
    server = await startServer({
      hydraId: 'lab',
      query: second.query,
    })
    await until({ check: () => second.calls[0]?.messages.length === 1 })
    const prompt = second.calls[0]!.messages[0]!
    assert.match(
      prompt,
      /restart cut your last turn/,
    )
    assert.ok(prompt.includes(`messages seq ${state().eventIds.merged} to ${state().eventIds['follow-up']}`))
    assert.ok(prompt.includes(`hydra messages --after ${after} --hydra lab`))
    assert.ok(prompt.includes(`hydra check --after ${after} --hydra lab`))
    assert.equal(
      second.calls[0]!.options.resume,
      session,
    )
    const raw = second.calls[0]!.raw[0]!
    assert.match(
      raw,
      /^<pnyx-digest hydra="lab"[\s\S]*New Hydra memory after shutdown/,
    )
    assert.equal(
      raw.match(/<pnyx-digest /g)?.length,
      1,
    )
    assert.ok(!interrupted())
    await server.close()

    // The resume turn is cut too: it is not resumed again and waits for the owner.
    const third = hydraSdk()
    server = await startServer({
      hydraId: 'lab',
      query: third.query,
      wakeDelay: 50,
    })
    await until({ check: interrupted })
    await sleep({ ms: 200 })
    assert.equal(
      third.calls.length,
      0,
    )
    await send({ text: 'Continue after the second cut' })
    await until({ check: finished })
    assert.deepEqual(
      third.calls[0]!.messages,
      ['Continue after the second cut'],
    )
    assert.ok(!interrupted())
  },
)

for (const resumeFails of [
  false,
  true,
]) {
  test(
    resumeFails ? 'a failed wake resume waits for an owner message' : 'a cut wake resumes with the change cursor',
    async () => {
      await commands.task([
        'create',
        '--hydra',
        'lab',
        '--key',
        'fix',
        '--title',
        'Fix',
      ])
      const first = hydraSdk()
      server = await startServer({
        hydraId: 'lab',
        query: first.query,
        wakeDelay: 10,
      })
      await send({ text: 'Watch the worker' })
      await until({ check: finished })
      await commands.task([
        'status',
        'fix',
        'blocked',
        '--hydra',
        'lab',
      ])
      await until({ check: () => first.calls[0]?.messages.length === 2 && finished() })
      first.control.hold = true
      first.control.leaveTurnUnfinishedOnClose = true
      await commands.task([
        'status',
        'fix',
        'needs_you',
        '--hydra',
        'lab',
      ])
      await until({ check: () => first.calls[0]?.messages.length === 3 })
      const handledThrough = Object.keys(state().eventIds).find(turnId => /^wake:\d+:handled$/.test(turnId))!.split(':')[1]!
      const cutWakeTurnId = Object.keys(state().eventIds).findLast(turnId => /^wake:\d+:hosted$/.test(turnId))!
      const wakeThroughSeq = cutWakeTurnId.split(':')[1]!
      await server.close()
      const second = hydraSdk()
      second.control.fail = resumeFails
      server = await startServer({
        hydraId: 'lab',
        query: second.query,
        wakeDelay: 50,
      })

      if (!resumeFails) {
        await until({ check: finished })
        await sleep({ ms: 300 })
        assert.ok(second.calls[0]!.messages[0]!.includes(`a wake check through seq ${wakeThroughSeq}`))
        assert.equal(
          second.calls[0]!.messages.length,
          1,
        )
        // The resumed turn answered the cut wake, so its changes are not offered again.
        assert.ok(`wake:${wakeThroughSeq}:handled` in state().eventIds)

        return
      }

      await until({ check: () => hydra()?.attention.some(a => a.text?.includes('Harness login is missing')) ?? false })
      assert.equal(
        Object.keys(state().eventIds).filter(turnId => /^resume:.*:hosted$/.test(turnId)).length,
        1,
      )
      await server.close()
      const third = hydraSdk()
      server = await startServer({
        hydraId: 'lab',
        query: third.query,
        wakeDelay: 10,
      })
      await sleep({ ms: 100 })
      assert.equal(
        third.calls.length,
        0,
      )
      assert.equal(
        hydra()!.sessionActivity,
        'interrupted',
      )
      await send({ text: 'Try again after sign-in' })
      // The cut wake was never handled, so its changes come back after the owner's turn.
      await until({ check: () => third.calls[0]?.messages.length === 2 && finished() })
      assert.equal(
        third.calls[0]!.messages[0],
        'Try again after sign-in',
      )
      assert.match(
        third.calls[0]!.messages[1]!,
        new RegExp(`^<pnyx-wake>[\\s\\S]*--after ${handledThrough} `),
      )
    },
  )
}

test(
  'startup leaves Firstmate Hydras and Hydras without hosted sessions alone',
  async () => {
    const first = hydraSdk()
    server = await startServer({
      hydraId: 'lab',
      query: first.query,
    })
    await send({ text: 'Finish normally' })
    await until({ check: finished })
    first.control.hold = true
    first.control.leaveTurnUnfinishedOnClose = true
    await send({ text: 'Cut before Firstmate switch' })
    await until({ check: () => first.calls[0]?.messages.length === 2 })
    await server.close()
    commands.hydra([
      'set',
      '--hydra',
      'lab',
      '--firstmate',
      join(
        home,
        'firstmate',
      ),
    ])
    const second = hydraSdk()
    server = await startServer({
      hydraId: 'lab',
      query: second.query,
    })
    assert.equal(
      hydra()!.sessionActivity,
      'interrupted',
    )
    await sleep({ ms: 100 })
    assert.equal(
      second.calls.length,
      0,
    )
    await server.close()
    commands.hydra([
      'create',
      'empty',
      '--hydra',
      'empty',
    ])
    server = await startServer({
      hydraId: 'empty',
      query: second.query,
    })
    await sleep({ ms: 100 })
    assert.equal(
      second.calls.length,
      0,
    )
    assert.equal(
      loadHydra({ hydraId: 'empty' }).state.config?.hydra.session,
      undefined,
    )
  },
)

test(
  'a cut turn without unanswered messages or a wake or stall names the unrecorded work',
  async () => {
    const first = hydraSdk()
    server = await startServer({
      hydraId: 'lab',
      query: first.query,
    })
    await send({ text: 'Already answered' })
    await until({ check: finished })
    const lastFinishedTurnSeq = state().seq
    first.control.hold = true
    first.control.leaveTurnUnfinishedOnClose = true
    await askHost({
      hydraId: 'lab',
      body: {
        action: 'hydra',
        id: 'internal-check',
        text: 'Check previous work',
        actor: 'pnyx',
      },
    })
    await until({ check: () => first.calls[0]?.messages.length === 2 })
    await server.close()
    const second = hydraSdk()
    server = await startServer({
      hydraId: 'lab',
      query: second.query,
    })
    await until({ check: () => second.calls[0]?.messages.length === 1 && finished() })
    const resumeMessage = second.calls[0]!.messages[0]!
    assert.match(
      resumeMessage,
      /before you answered a turn\. Run/,
    )
    assert.ok(resumeMessage.includes(`hydra messages --after ${lastFinishedTurnSeq} --hydra lab`))
    assert.doesNotMatch(
      resumeMessage,
      /messages seq|a wake check|a stall check/,
    )
  },
)

test(
  'a worker report sent while the server is down reaches a Hydra that never ran once the server is back',
  async () => {
    commands.task([
      'create',
      '--title',
      'Fix add',
      '--key',
      'fix',
      '--hydra',
      'lab',
    ])
    const fix = state().keys.fix!
    await commands.hydra([
      'send',
      '--hydra',
      'lab',
      '--task',
      fix,
      '--text',
      'Report while the server was down',
      '--actor',
      `worker:${fix}`,
    ])
    const sdk = hydraSdk()
    server = await startServer({
      hydraId: 'lab',
      query: sdk.query,
      wakeDelay: 50,
    })
    await until({ check: () => finished() && sdk.calls.length > 0 })
    const said = sdk.calls.flatMap(call => call.messages)
    assert.ok(said.some(text => text.startsWith('<pnyx-wake>')
      && text.includes('\nReport while the server was down\n</pnyx-report>')))
  },
)

test(
  'a setting a hook adds to Hydra’s session, such as its client version, keeps the session running',
  async () => {
    const sdk = hydraSdk()
    server = await startServer({
      hydraId: 'lab',
      query: sdk.query,
    })
    await send({ text: 'First' })
    await until({ check: finished })
    withWriter({
      hydraId: 'lab',
      fn: ({ writer }) => {
        const decision = decidePush({
          state: writer.state,
          key: writer.state.cards[HYDRA_CARD]!.key,
          input: { settings: { version: '2.1.308' } },
          meta: {
            at: new Date().toISOString(),
            actor: 'hook:claude',
          },
        })
        assert.ok('event' in decision); writer.append({ event: decision.event })
      },
    })
    assert.equal(
      hydra()!.settings?.version,
      '2.1.308',
    )
    await send({ text: 'Second' })
    await until({ check: () => sdk.calls[0]?.messages.includes('Second') ?? false })
    assert.equal(
      sdk.calls.length,
      1,
    )
  },
)

test(
  'the owner’s message joins Hydra’s running turn, and worker reports wait to reach it as one batch after the turn',
  async () => {
    codexRule()
    const codex = fakeCodex({ root: home })
    commands.task([
      'create',
      '--title',
      'Fix add',
      '--key',
      'fix',
      '--hydra',
      'lab',
    ])
    const fix = state().keys.fix!
    server = await startServer({
      hydraId: 'lab',
      spawnCodex: codex.spawnCodex,
      wakeDelay: 50,
    })
    const queues: {
      waiting: { card: string }[]
      reading: { card: string }[]
    }[] = []
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/hydra/lab/ws?token=${localToken()}`)
    ws.on(
      'message',
      data => {
        const message = JSON.parse(String(data)) as {
          type: string
          queue?: typeof queues[number]
        }

        if (message.type === 'hydraQueue' && message.queue) {
          queues.push(message.queue)
        }
      },
    )
    const turns = () => codex.messages().filter(m => m.method === 'turn/start')
      .map(m => (m.params!.input as { text: string }[])[0]!.text)
    const steers = () => codex.messages().filter(m => m.method === 'turn/steer')

    try {
      await send({ text: 'HOLD' })
      await until({ check: () => turns().length === 1 })
      await send({ text: 'Also check the docs' })
      await until({ check: () => steers().length === 1 })
      assert.deepEqual(
        [
          steers()[0]!.params!.expectedTurnId,
          (steers()[0]!.params!.input as { text: string }[])[0]!.text,
        ],
        [
          'turn-1',
          'Also check the docs',
        ],
      )

      for (const report of [
        'Report one',
        'Report two',
        'Report three',
      ]) {
        await commands.hydra([
          'send',
          '--hydra',
          'lab',
          '--task',
          fix,
          '--text',
          report,
          '--actor',
          `worker:${fix}`,
        ])
      }

      // A worker's status change waits in the same batch, which then also asks for a check.
      commands.task([
        'status',
        fix,
        'blocked',
        '--note',
        'Reports sent',
        '--actor',
        `worker:${fix}`,
        '--hydra',
        'lab',
      ])
      await until({ check: () => queues.at(-1)?.waiting.length === 4 })
      await sleep({ ms: 200 })
      assert.deepEqual(
        [
          turns().length,
          steers().length,
          queues.at(-1)!.waiting.map(update => update.card),
        ],
        [
          1,
          1,
          [
            fix,
            fix,
            fix,
            fix,
          ],
        ],
      )

      codex.children[0]!.kill('SIGUSR1')
      await until({
        check: () => turns().length === 2 && finished()
        && queues.at(-1)?.reading.length === 0,
      })
      const batch = turns()[1]!
      assert.ok(batch.startsWith('<pnyx-wake>3 worker reports arrived while you were busy.'))
      assert.deepEqual(
        [
          'Report one',
          'Report two',
          'Report three',
        ].map(report => batch.includes(`\n${report}\n</pnyx-report>`)),
        [
          true,
          true,
          true,
        ],
      )
      assert.match(
        batch,
        /hydra check --after \d+ --hydra lab/,
      )
      assert.ok(queues.some(queue => queue.reading.length === 4 && queue.waiting.length === 0))
      assert.deepEqual(
        queues.at(-1),
        {
          waiting: [],
          reading: [],
        },
      )
    } finally {
      ws.close()
    }
  },
)

test(
  'hydra stop ends only Hydra’s running turn and keeps its session for the next message',
  async () => {
    const home = mkdtempSync(join(
      tmpdir(),
      'pnyx-hydra-stop-',
    ))
    process.env.PNYX_HOME = home
    process.env.CLAUDE_CONFIG_DIR = join(
      home,
      'claude',
    )
    process.env.PNYX_SEMANTIC = 'off'
    fakeDispatch({ root: home })
    const folder = join(
      home,
      'work',
    )
    mkdirSync(folder)
    commands.hydra([
      'create',
      'lab',
    ])
    await commands.task([
      'create',
      '--title',
      'Fix add',
      '--key',
      'fix',
      '--folder',
      folder,
      '--hydra',
      'lab',
    ])
    const state = () => loadHydra({ hydraId: 'lab' }).state
    const sdk = hydraSdk()
    const server = await startServer({
      hydraId: 'lab',
      query: sdk.query,
    })

    try {
      assert.deepEqual(
        await commands.hydra([
          'stop',
          '--hydra',
          'lab',
        ]),
        { stopped: 'none: Hydra is not working on a turn' },
      )
      sdk.control.hold = true
      await commands.hydra([
        'send',
        '--hydra',
        'lab',
        '--text',
        'Take a long look',
      ])
      await until({ check: () => sdk.calls[0]?.messages.length === 1 && state().cards[HYDRA_CARD]?.sessionActivity === 'working' })
      await startTask({
        hydraId: 'lab',
        task: 'fix',
        meta: {
          at: new Date().toISOString(),
          actor: 'hydra',
          reason: 'start it',
          id: 'start-fix',
        },
      })
      const worker = () => state().cards[state().keys.fix!]
      await until({ check: () => worker()?.sessionActivity === 'working' })
      const since = state().cards[HYDRA_CARD]!.workingSince
      assert.ok(since && Date.parse(since) <= Date.now())
      assert.deepEqual(
        await commands.hydra([
          'stop',
          '--hydra',
          'lab',
        ]),
        { stopped: 'hydra' },
      )
      await until({ check: () => state().cards[HYDRA_CARD]?.sessionActivity === 'finished' })
      // Only Hydra's own turn stops; its worker keeps going.
      assert.deepEqual(
        sdk.interrupts,
        [sdk.calls[0]],
      )
      assert.equal(
        worker()?.sessionActivity,
        'working',
      )
      assert.equal(
        state().cards[HYDRA_CARD]!.workingSince,
        undefined,
      )
      assert.ok(!state().cards[HYDRA_CARD]!.attention.some(a => a.kind === 'interrupted'))
      sdk.control.hold = false
      await commands.hydra([
        'send',
        '--hydra',
        'lab',
        '--text',
        'Carry on',
      ])
      await until({ check: () => sdk.calls[0]?.messages.length === 2 && state().cards[HYDRA_CARD]?.sessionActivity === 'finished' })
      // The next message resumes Hydra's session; the other one is the worker's.
      assert.equal(
        sdk.calls.length,
        2,
      )
      // A stop covers only its own turn: a later turn's failure still shows.
      sdk.control.turnError = 'Overloaded'
      await commands.hydra([
        'send',
        '--hydra',
        'lab',
        '--text',
        'Once more',
      ])
      await until({ check: () => state().cards[HYDRA_CARD]?.attention.some(a => a.kind === 'interrupted') ?? false })
      assert.match(
        state().cards[HYDRA_CARD]!.attention.find(a => a.kind === 'interrupted')!.text ?? '',
        /Overloaded/,
      )
    } finally {
      await server.close()
      sdk.release()
      rmSync(
        home,
        {
          recursive: true,
          force: true,
        },
      )
    }
  },
)

test(
  'hydra usage reports the context in use, its window, the session cost and plan windows, the agent\'s own first',
  async () => {
    const home = mkdtempSync(join(
      tmpdir(),
      'pnyx-hydra-usage-',
    ))
    process.env.PNYX_HOME = home
    process.env.CLAUDE_CONFIG_DIR = join(
      home,
      'claude',
    )
    process.env.PNYX_SEMANTIC = 'off'
    const { claude } = fakeDispatch({ root: home })
    writeFileSync(
      join(
        claude,
        'quota.json',
      ),
      JSON.stringify({
        provider: {
          plan: 'max',
          windows: [
            {
              label: 'Session',
              percentUsed: 90,
            },
            {
              label: 'week',
              percentRemaining: 60,
            },
          ],
        },
      }),
    )
    commands.hydra([
      'create',
      'lab',
    ])
    const state = () => loadHydra({ hydraId: 'lab' }).state
    const sdk = hydraSdk()
    sdk.control.usage = {
      context: 581_000,
      window: 1_000_000,
      cost: 1.25,
      limit: {
        rateLimitType: 'five_hour',
        utilization: 0.34,
        resetsAt: 4_000_000_000,
      },
    }
    const server = await startServer({
      hydraId: 'lab',
      query: sdk.query,
    })

    try {
      assert.deepEqual(
        await commands.hydra([
          'usage',
          '--hydra',
          'lab',
        ]),
        { usage: 'none: Hydra has not started a session' },
      )
      await commands.hydra([
        'send',
        '--hydra',
        'lab',
        '--text',
        'How big is the context?',
      ])
      await until({ check: () => state().cards[HYDRA_CARD]?.sessionActivity === 'finished' })
      const usage = await commands.hydra([
        'usage',
        '--hydra',
        'lab',
      ]) as Record<string, unknown>
      assert.equal(
        usage.harness,
        'claude',
      )
      assert.equal(
        usage.used,
        581_000,
      )
      assert.equal(
        usage.window,
        1_000_000,
      )
      assert.equal(
        usage.cost,
        1.25,
      )
      assert.equal(
        usage.account,
        'claude:test',
      )
      assert.equal(
        usage.plan,
        'max',
      )
      // The agent's own session window takes quota-axi's place; quota-axi still fills the week.
      assert.deepEqual(
        usage.windows,
        [
          {
            label: 'session',
            used: 34,
            resetsAt: new Date(4_000_000_000_000).toISOString(),
          },
          {
            label: 'week',
            used: 40,
          },
        ],
      )
    } finally {
      await server.close()
      sdk.release()
      rmSync(
        home,
        {
          recursive: true,
          force: true,
        },
      )
    }
  },
)
