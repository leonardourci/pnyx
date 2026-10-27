import assert from 'node:assert/strict'
import { once } from 'node:events'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, test, type TestContext } from 'node:test'
import { WebSocket } from 'ws'
import { commands } from '../src/cli/commands.ts'
import { decidePush } from '../src/core/decide.ts'
import { HYDRA_CARD, hydraEvent } from '../src/core/hydra.ts'
import { startTask } from '../src/cli/start.ts'
import { fakeDispatch } from './dispatch-fixture.ts'
import { loadHydra, readEvents, withWriter } from '../src/store/hydra-store.ts'
import { hostObserver } from './host-observer.ts'
import type { RunningServer } from '../src/server/server.ts'
import { localToken } from '../src/server/state.ts'
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
  // The server's own pull request follower never reaches GitHub; a test reads a pull request through follow.
  process.env.PNYX_GH_AXI = 'false'
  commands.hydra([
    'create',
    'lab',
    '--helper',
    'off',
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

const {
  startServer,
  until,
  notify,
  checkpoint,
} = hostObserver({ describe: () => loadHydra({ hydraId: 'lab' }).state })

function controlledTime({ t }: { t: TestContext }) {
  const fetch = globalThis.fetch
  t.mock.method(
    globalThis,
    'fetch',
    // eslint-disable-next-line pnyx/object-params -- Implements fetch.
    (
      input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      const headers = new Headers(init?.headers)
      headers.set(
        'connection',
        'close',
      )

      return fetch(
        input,
        {
          ...init,
          headers,
        },
      )
    },
  )
  t.mock.timers.enable({
    apis: [
      'Date',
      'setTimeout',
      'setInterval',
    ],
    now: Date.now(),
  })

  let ticking = false

  const tick = ({ ms }: { ms: number }) => {
    if (ticking) {
      return
    }

    ticking = true

    try {
      if (ms === 0) {
        t.mock.timers.tick(0)
      }

      // Node reschedules intervals from the end of a tick, so visit each domain millisecond.
      for (let elapsed = 0; elapsed < ms; elapsed++) {
        t.mock.timers.tick(1)
      }
    } finally {
      ticking = false
    }
  }

  return {
    until: ({ check }: { check(): boolean }) => until({
      check,
      progress: () => tick({ ms: 0 }),
    }),
    async advance({ ms }: { ms: number }) {
      await checkpoint()
      tick({ ms })
      await checkpoint()
      tick({ ms: 0 })
      await checkpoint()
    },
  }
}

const state = () => loadHydra({ hydraId: 'lab' }).state
const hydra = () => state().cards[HYDRA_CARD]
const finished = () => hydra()?.sessionActivity === 'finished'
// A stall check's wake, told apart from a change's wake by the stall wake's own instruction.
const stallWake = ({ text }: { text: string }) => text.startsWith('<pnyx-wake>Why you are woken:')
  && text.includes('its requests and agents show what waits') && /\) (quiet|permission|turn ended): /.test(text)
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
  'restart during automatic compaction resumes the unanswered Hydra turn',
  async () => {
    codexRule()
    const first = fakeCodex({ root: home })
    server = await startServer({
      hydraId: 'lab',
      spawnCodex: first.spawnCodex,
    })
    await send({
      text: 'AUTO_COMPACT_HOLD',
      id: 'auto-owner',
    })
    await until({ check: () => hydra()?.compaction?.operations.at(-1)?.trigger === 'auto' })
    await server.close()
    const resumed = fakeCodex({ root: home })
    server = await startServer({
      hydraId: 'lab',
      spawnCodex: resumed.spawnCodex,
    })
    await until({ check: () => resumed.messages().some(message => message.method === 'turn/start') && finished() })
    const turns = resumed.messages().filter(message => message.method === 'turn/start')
    assert.equal(
      turns.length,
      1,
    )
    assert.match(
      JSON.stringify(turns[0]!.params),
      /restart cut your last turn before you answered messages seq/,
    )
    assert.equal(
      resumed.messages().some(message => message.method === 'thread/compact/start'),
      false,
    )
    assert.equal(
      hydra()!.compaction!.operations.at(-1)!.state,
      'failed',
    )
  },
)

test(
  'a worker report wakes Hydra after its last start failed and the server restarted',
  async t => {
    const {
      until,
      advance,
    } = controlledTime({ t })
    codexRule()
    commands.task([
      'create',
      '--key',
      'quick',
      '--title',
      'Task quick',
      '--hydra',
      'lab',
    ])
    const quick = state().keys.quick!
    const first = fakeCodex({ root: home })
    server = await startServer({
      hydraId: 'lab',
      spawnCodex: first.spawnCodex,
    })
    await send({ text: 'Hello Codex' })
    await until({ check: finished })
    await server.close()
    const refusing = fakeCodex({
      root: home,
      refuse: 'thread/resume',
    })
    server = await startServer({
      hydraId: 'lab',
      spawnCodex: refusing.spawnCodex,
      stallDelay: 200,
    })
    const failures = () => (state().hydraMessages ?? []).filter(m => /Hydra could not start/.test(m.text))
    await send({ text: 'Lost to the failed resume' })
    await until({ check: () => failures().length === 1 })
    // A wait that ends while starts fail keeps its alarm for a start that works.
    await commands.task([
      'status',
      'quick',
      'paused',
      '--until',
      new Date(Date.now() + 100).toISOString(),
      '--hydra',
      'lab',
    ])
    await advance({ ms: 600 })
    assert.equal(
      failures().length,
      1,
    )
    await server.close()
    const fixed = fakeCodex({ root: home })
    server = await startServer({
      hydraId: 'lab',
      spawnCodex: fixed.spawnCodex,
      wakeDelay: 0,
    })
    await commands.hydra([
      'send',
      '--hydra',
      'lab',
      '--task',
      quick,
      '--text',
      'A worker question',
      '--actor',
      `worker:${quick}`,
    ])
    const inputs = () => fixed.messages().filter(m => m.method === 'turn/start')
      .map(m => (m.params!.input as { text: string }[])[0]!.text)
    await until({ check: () => inputs().some(text => text.includes('A worker question')) && finished() })
  },
)

test(
  'an owner message reaches Hydra while the server is too busy to answer for over a second',
  async t => {
    const { until } = controlledTime({ t })
    const sdk = hydraSdk({ now: () => Date.now() })
    server = await startServer({
      hydraId: 'lab',
      query: sdk.query,
    })
    let entered = false, resume = () => {}
    const release = new Promise<void>(resolve => {
      resume = resolve
    })
    const fetch = globalThis.fetch
    t.mock.method(
      globalThis,
      'fetch',
      // eslint-disable-next-line pnyx/object-params -- Implements fetch.
      async (...args: Parameters<typeof fetch>) => {
        if (String(args[0]) === `${server!.url}health`) {
          entered = true
          notify()
          await release
        }

        return fetch(...args)
      },
    )
    t.mock.method(
      AbortSignal,
      'timeout',
      // eslint-disable-next-line pnyx/object-params -- Implements AbortSignal.timeout.
      (ms: number) => {
        const controller = new AbortController()
        setTimeout(
          () => controller.abort(),
          ms,
        )

        return controller.signal
      },
    )
    const sent = send({ text: 'Hello while busy' })

    try {
      await until({ check: () => entered })
      t.mock.timers.tick(1500)
      assert.equal(
        sdk.calls.length,
        0,
      )
    } finally {
      resume()
    }

    await sent
    await until({ check: () => sdk.calls.length === 1 && finished() })
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
      const closed = once(
        ws,
        'close',
      )
      ws.close()
      await closed
    }
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
  'a hold the owner asked for never wakes Hydra on a timer, while an open-ended worker pause still does',
  async t => {
    const {
      until,
      advance,
    } = controlledTime({ t })
    fakeDispatch({ root: home })
    const folder = join(
      home,
      'work',
    )
    mkdirSync(folder)
    await commands.task([
      'create',
      '--title',
      'Rework the schema',
      '--key',
      'schema',
      '--folder',
      folder,
      '--hydra',
      'lab',
    ])
    const sdk = hydraSdk({ now: () => Date.now() })
    server = await startServer({
      hydraId: 'lab',
      query: sdk.query,
      wakeDelay: 0,
      stallDelay: 200,
      pauseDelay: 300,
    })
    const hydraTurns = () => sdk.calls.filter(c => c.options.cwd !== folder)
      .flatMap(c => c.messages)
    const waits = () => hydraTurns().filter(m => m.includes(') wait ended: '))
    const id = state().keys.schema!
    const pause = ({ args }: { args: string[] }) => commands.task([
      'status',
      id,
      'paused',
      ...args,
      '--actor',
      `worker:${id}`,
      '--hydra',
      'lab',
    ])

    await send({ text: 'Start the schema work' })
    await until({ check: finished })
    await startTask({
      hydraId: 'lab',
      task: 'schema',
      meta: {
        at: new Date().toISOString(),
        actor: 'hydra',
        reason: 'start it',
        id: 'start-schema',
      },
    })
    await until({ check: () => Boolean(state().cards[id]!.sessionIds?.length) })
    // The worker's first turn ends without a declaration, which wakes Hydra once before the hold.
    await until({ check: () => hydraTurns().some(m => m.includes(') turn ended: ')) && finished() })

    await pause({
      args: [
        '--hold',
        '--note',
        'Stopped at the owner\'s request',
      ],
    })
    assert.match(
      String((await commands.task([
        'show',
        id,
        '--hydra',
        'lab',
      ]) as { task: { status: string } }).task.status),
      /^paused on hold: Stopped at the owner's request/,
    )
    const turnsBeforeHold = hydraTurns().length
    await advance({ ms: 900 })
    assert.equal(
      hydraTurns().length,
      turnsBeforeHold,
      'a hold wakes Hydra for neither an ended wait nor a stall',
    )

    await pause({
      args: [
        '--note',
        'Waiting on the migration window',
      ],
    })
    await advance({ ms: 299 })
    assert.equal(
      waits().length,
      0,
    )
    await advance({ ms: 1 })
    await until({ check: () => waits().length === 1 })
    assert.match(
      waits()[0]!,
      /wait ended: the worker paused since .*: Waiting on the migration window/,
    )
  },
)

test(
  'a repeated stall counts its gap from when Hydra got the last alarm, so a slow delivery never shortens it',
  async t => {
    const {
      until,
      advance,
    } = controlledTime({ t })
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
    const sdk = hydraSdk({ now: () => Date.now() })
    server = await startServer({
      hydraId: 'lab',
      query: sdk.query,
      wakeDelay: 50,
      stallDelay: 200,
      busyDelay: 5000,
      stallRepeatMax: 5000,
    })
    const stalls = () => sdk.calls.filter(c => c.options.cwd !== folder).flatMap(c => c.messages)
      .filter(m => stallWake({ text: m }))

    await send({ text: 'Watch the suite' })
    await until({ check: finished })

    // The worker can deliver its first alarm before startTask resolves.
    const received: number[] = []

    sdk.control.onInput = ({ text }) => {
      if (stallWake({ text })) {
        received.push(Date.now())
      }
    }

    let slowDelivery = true
    const writeSync = fs.writeSync
    t.mock.method(
      fs,
      'writeSync',
      // eslint-disable-next-line pnyx/object-params -- Implements node:fs writeSync.
      (
        fd: number,
        data: Buffer,
        ...rest: []
      ) => {
        const text = String(data)

        if (slowDelivery && /"id":"stall:[^"]*:hosted"/.test(text)) {
          slowDelivery = false
          t.mock.timers.setTime(Date.now() + 250)
        }

        return writeSync(
          fd,
          data,
          ...rest,
        )
      },
    )
    syncBuiltinESMExports()

    try {
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

      t.mock.timers.tick(200)
      await until({ check: () => received.length === 1 && finished() })

      assert.ok(
        !slowDelivery,
        'the first alarm\'s delivery was slowed',
      )
      await advance({ ms: 399 })
      assert.equal(
        received.length,
        1,
        'the repeat waits the full backoff after delivery',
      )
      t.mock.timers.tick(1)
      await until({ check: () => received.length === 2 && finished() })
      assert.match(
        stalls()[1] ?? '',
        /\(alarm 2\)/,
      )
      const gap = received[1]! - received[0]!
      assert.equal(
        gap,
        400,
        'Hydra receives the second alarm exactly one backoff after the first',
      )
    } finally {
      sdk.control.onInput = undefined
      sdk.release()
      t.mock.restoreAll()
      syncBuiltinESMExports()
    }
  },
)

test(
  'a cut Hydra turn resumes once with fresh memory and the unanswered message range',
  async t => {
    const {
      until,
      advance,
    } = controlledTime({ t })
    const first = hydraSdk({ now: () => Date.now() })
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
    const second = hydraSdk({ now: () => Date.now() })
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
    const third = hydraSdk({ now: () => Date.now() })
    server = await startServer({
      hydraId: 'lab',
      query: third.query,
      wakeDelay: 0,
    })
    await until({ check: interrupted })
    await advance({ ms: 200 })
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

test(
  'saved worker declarations wake Hydra even when filesystem notifications are lost',
  async t => {
    await commands.task([
      'create',
      '--hydra',
      'lab',
      '--key',
      'fix',
      '--title',
      'Fix',
    ])
    const watch = fs.watch
    t.mock.method(
      fs,
      'watch',
      // eslint-disable-next-line pnyx/object-params -- Implements node:fs watch.
      (path: fs.PathLike) => watch(
        path,
        () => {},
      ),
    )
    syncBuiltinESMExports()
    const sdk = hydraSdk()

    try {
      server = await startServer({
        hydraId: 'lab',
        query: sdk.query,
        wakeDelay: 10,
      })
      await send({ text: 'Watch the worker' })
      await until({ check: finished })
      await new Promise<void>(resolve => setImmediate(resolve))
      await commands.task([
        'status',
        'fix',
        'blocked',
        '--hydra',
        'lab',
      ])
      await until({ check: () => sdk.calls[0]?.messages.length === 2 && finished() })
      await new Promise<void>(resolve => setImmediate(resolve))
      await commands.task([
        'status',
        'fix',
        'needs_you',
        '--hydra',
        'lab',
      ])
      await until({ check: () => sdk.calls[0]?.messages.length === 3 && finished() })
      assert.ok(sdk.calls[0]?.messages[2]?.startsWith('<pnyx-wake>'))
    } finally {
      await server?.close()
      server = undefined
      t.mock.restoreAll()
      syncBuiltinESMExports()
    }
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
  'an owner turn ending NO_REPLY gets one standalone-reply follow-up and never loops',
  async t => {
    const {
      until,
      advance,
    } = controlledTime({ t })
    const sdk = hydraSdk({ now: () => Date.now() })
    sdk.control.reply = 'NO_REPLY'
    sdk.control.stream = true
    server = await startServer({
      hydraId: 'lab',
      query: sdk.query,
      wakeDelay: 0,
    })
    await send({
      text: 'What is ready?',
      id: 'owner-quiet',
    })
    const messages = () => sdk.calls.flatMap(call => call.messages)
    await until({ check: () => messages().length === 2 && finished() })
    assert.match(
      messages()[1]!,
      /^<pnyx-wake>The owner wrote to you; reply to them in one standalone message\./,
    )
    assert.match(
      messages()[1]!,
      /Reply rules:.*full links/,
    )
    assert.match(
      messages()[1]!,
      /what waits on the owner/,
    )
    assert.match(
      messages()[1]!,
      /second or plainly recurring snag/,
    )
    await advance({ ms: 100 })
    assert.equal(
      messages().length,
      2,
    )
    assert.equal(
      state().hydraMessages!.filter(message => message.actor === 'web' || message.actor === 'cli').length,
      1,
    )
    sdk.control.reply = 'The change is ready for review.'
    await send({
      text: 'And now?',
      id: 'owner-answer',
    })
    await until({ check: () => messages().length === 3 && finished() })
    assert.equal(
      messages().filter(message => message.includes('The owner wrote to you')).length,
      1,
    )
  },
)
