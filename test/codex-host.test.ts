import assert from 'node:assert/strict'
import { appendFileSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, mock, test } from 'node:test'
import { commands } from '../src/cli/commands.ts'
import { sendReply } from '../src/cli/reply.ts'
import { startTask } from '../src/cli/start.ts'
import { dispatchCommands } from '../src/dispatch/cli.ts'
import { fakeDispatch } from './dispatch-fixture.ts'
import { harvestTranscripts } from '../src/integrations/hooks/harvest.ts'
import { ingestSpool } from '../src/integrations/hooks/ingest.ts'
import type { RunningServer } from '../src/server/server.ts'
import { hostObserver } from './host-observer.ts'
import { askHost } from '../src/server/state.ts'
import { loadHydra, spoolWrite, withWriter } from '../src/store/hydra-store.ts'
import { fakeCodex } from './codex-fixture.ts'
import { stopProcess } from './processes.ts'
import { hydraSdk } from './hydra-host-fixture.ts'
import { codexProvider } from '../src/server/codex.ts'
import type { HostedEvent } from '../src/server/provider.ts'

const meta = {
  at: '2026-10-15T00:00:00Z',
  actor: 'test',
  id: 'start-1',
}
let server: RunningServer | undefined

afterEach(async () => {
  await server?.close(); server = undefined
})

const {
  startServer,
  until,
} = hostObserver({ describe: () => loadHydra({ hydraId: 'lab' }).state })

async function lab({ refuse }: { refuse?: string } = {}) {
  const root = realpathSync(mkdtempSync(join(
    tmpdir(),
    'pnyx-codex-',
  )))
  process.env.PNYX_HOME = join(
    root,
    'pnyx',
  )
  fakeDispatch({ root })
  process.env.CODEX_HOME = join(
    root,
    'codex',
  )
  await commands.hydra([
    'create',
    'lab',
    '--hydra',
    'lab',
  ])
  await commands.task([
    'create',
    '--title',
    'Ship it',
    '--key',
    'ship',
    '--folder',
    root,
    '--hydra',
    'lab',
  ])
  await commands.task([
    'brief',
    'ship',
    '--brief',
    'Release the canary.',
    '--hydra',
    'lab',
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
    '--hydra',
    'lab',
  ])
  const fixture = fakeCodex({
    root,
    refuse,
    models: [
      'gpt-6.1-sol',
      'gpt-6-luna',
      'gpt-6-astra',
    ],
  })
  server = await startServer({
    hydraId: 'lab',
    spawnCodex: fixture.spawnCodex,
    query: hydraSdk().query,
  })

  // A start checks the model against the catalog, read once per server; the thread processes come after it.
  if (refuse !== 'initialize') {
    await askHost({
      hydraId: 'lab',
      body: {
        action: 'models',
        harness: 'codex',
      },
    })
    fixture.children.splice(0)
    fixture.environments.splice(0)
  }

  const state = () => loadHydra({ hydraId: 'lab' }).state
  const task = () => state().cards[state().keys.ship!]!
  const send = ({ text }: { text: string }) => sendReply({
    hydraId: 'lab',
    request: {
      card: 'ship',
      text,
      homes: [],
      actor: 'test',
    },
  })
  // The picker's own route; the agent CLI adds a fixed read-back wait on top of it.
  const set = ({
    setting,
    value,
  }: {
    setting: string
    value: string
  }) => askHost({
    hydraId: 'lab',
    body: {
      action: 'set',
      card: 'ship',
      setting,
      value,
    },
  })
  const turns = () => fixture.messages().filter(m => m.method === 'turn/start')
  const approvals = () => fixture.messages().filter(m => m.id === 'approval')
  const answer = ({
    id,
    args,
  }: {
    id: string
    args: string[]
  }) => commands.task([
    'permission',
    'ship',
    id,
    ...args,
    '--hydra',
    'lab',
  ])

  return {
    root,
    fixture,
    task,
    send,
    set,
    turns,
    approvals,
    answer,
  }
}

test(
  'native hook and transcript settings preserve hosted picker changes across restart',
  async () => {
    const {
      root,
      fixture,
      task,
      send,
      set,
      turns,
    } = await lab()
    await startTask({
      hydraId: 'lab',
      task: 'ship',
      meta,
    })
    await until({ check: () => task().sessionActivity === 'finished' })
    await send({ text: 'HOLD' })
    await until({
      check: () => turns().length === 2
        && task().steering?.every(message => message.ack !== undefined) === true,
    })
    const id = task().agent!.sessionId
    await set({
      setting: 'model',
      value: 'gpt-6-luna',
    })
    await set({
      setting: 'effort',
      value: 'low',
    })
    await set({
      setting: 'mode',
      value: 'never',
    })
    const desired = {
      model: 'gpt-6-luna',
      effort: 'low',
      mode: 'never',
    }
    spoolWrite({
      hydraId: 'lab',
      entry: {
        v: 1,
        id: 'native-settings',
        at: new Date().toISOString(),
        harness: 'codex',
        event: 'PreToolUse',
        payload: {
          session_id: id,
          cwd: root,
          model: 'gpt-6.1-sol',
          effort: 'high',
          permission_mode: 'on-request',
          tool_name: 'shell',
          tool_input: { command: 'true' },
        },
      },
    })
    ingestSpool({ hydraId: 'lab' })
    assert.deepEqual(
      task().settings,
      desired,
    )
    appendFileSync(
      fixture.transcript,
      `${JSON.stringify({
        type: 'turn_context',
        timestamp: new Date().toISOString(),
        payload: {
          model: 'gpt-6.1-sol',
          effort: 'high',
          approval_policy: 'on-request',
        },
      })}\n`,
    )
    withWriter({
      hydraId: 'lab',
      fn: ({ writer }) => harvestTranscripts({
        writer,
        cardIds: [task().id],
        at: new Date().toISOString(),
      }),
    })
    const harvested = task().settings!
    assert.deepEqual(
      {
        model: harvested.model,
        effort: harvested.effort,
        mode: harvested.mode,
      },
      desired,
    )

    // The server closes the held turn; the restart continues it once in the same thread.
    await server!.close()
    server = await startServer({
      hydraId: 'lab',
      spawnCodex: fixture.spawnCodex,
    })
    await until({ check: () => fixture.children.length === 2 && task().sessionActivity === 'finished' })
    assert.equal(
      fixture.messages().find(m => m.method === 'thread/resume')?.params?.threadId,
      id,
    )
    assert.equal(
      task().attention.some(a => a.key === 'pnyx:interrupted'),
      false,
    )
    const {
      model,
      effort,
      approvalPolicy,
    } = turns().at(-1)!.params!
    assert.deepEqual(
      {
        model,
        effort,
        mode: approvalPolicy,
      },
      desired,
    )
  },
)

test(
  'a Codex thread that takes longer than a request\'s 30 seconds to open still opens',
  async () => {
    const root = realpathSync(mkdtempSync(join(
      tmpdir(),
      'pnyx-codex-slow-',
    )))
    const codex = fakeCodex({
      root,
      holdOpen: true,
    })
    // Only setTimeout is faked, so the fixture's pipes and setImmediate run for real.
    mock.timers.enable({ apis: ['setTimeout'] })

    try {
      const opening = codexProvider({ spawnCodex: codex.spawnCodex }).open({
        cwd: root,
        settings: {},
        env: {
          ...process.env,
          CODEX_HOME: root,
        },
        signal: new AbortController().signal,
      })
      let failure: Error | undefined
      void opening.catch((error: Error) => {
        failure = error
      })

      await codex.waitForRequest({
        method: 'thread/start',
        failure: () => failure,
      })

      mock.timers.tick(60_000)
      await new Promise(resolve => setImmediate(resolve))
      assert.equal(
        failure,
        undefined,
      )
      codex.children[0]!.kill('SIGHUP')
      const session = await opening
      assert.equal(
        session.id,
        '0199f00d-1111-7000-8000-000000000001',
      )
      session.close()
    } finally {
      mock.timers.reset()
      await Promise.all(codex.children.map(child => child.pid && child.exitCode === null
        ? stopProcess({ pid: child.pid }) : Promise.resolve()))
      rmSync(
        root,
        {
          recursive: true,
          force: true,
        },
      )
    }
  },
)

test(
  'a Codex command item reports its tool call running, then done, inside the turn',
  async () => {
    const root = realpathSync(mkdtempSync(join(
      tmpdir(),
      'pnyx-codex-tool-',
    )))
    const codex = fakeCodex({ root })
    const session = await codexProvider({ spawnCodex: codex.spawnCodex }).open({
      cwd: root,
      settings: {},
      env: {
        ...process.env,
        CODEX_HOME: root,
      },
      signal: new AbortController().signal,
    })

    const input = async function* () {
      yield 'COMMAND'
    }

    const events: HostedEvent[] = []

    for await (const event of session.run({
      input: input(),
      permission: async () => ({
        behavior: 'deny',
        message: 'no',
      }),
    })) {
      events.push(event)
    }

    session.close()
    rmSync(
      root,
      {
        recursive: true,
        force: true,
      },
    )
    assert.deepEqual(
      events.filter(event => typeof event !== 'string' && event.type === 'tool'),
      [
        {
          type: 'tool',
          id: 'command-run',
          running: true,
        },
        {
          type: 'tool',
          id: 'command-run',
          running: false,
        },
      ],
    )
  },
)

test(
  'Codex permission profiles grant only the requested turn scope and denial grants nothing',
  async () => {
    const {
      task,
      send,
      approvals,
      answer,
    } = await lab()
    await startTask({
      hydraId: 'lab',
      task: 'ship',
      meta,
    })
    await until({ check: () => task().sessionActivity === 'finished' })

    for (const [
      index,
      choice,
    ] of ([
        'allow',
        'deny',
      ] as const).entries()) {
      await send({ text: `PERMISSIONS_${choice.toUpperCase()}` })
      await until({ check: () => task().permissions?.length === index + 1 })
      const request = task().permissions![index]!
      assert.deepEqual(
        [
          request.tool,
          request.input.scope,
        ],
        [
          'Turn permissions',
          'turn',
        ],
      )
      await answer({
        id: request.id,
        args: [choice],
      })
      await until({ check: () => task().sessionActivity === 'finished' })
      assert.deepEqual(
        approvals()[index]!.result,
        {
          permissions: choice === 'allow' ? { network: { enabled: true } } : {},
          scope: 'turn',
        },
      )
    }
  },
)
