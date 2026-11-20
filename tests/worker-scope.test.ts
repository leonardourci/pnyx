import { workerLine } from './setup/worker-log.ts'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, expect, test } from 'vitest'
import { parsed, pnyxAxi, startPnyx, type AgentSession, type Hydra, type Pnyx } from './setup/pnyx.ts'

let pnyx: Pnyx
let hydra: Hydra
let worker: AgentSession
let asWorker: ReturnType<Hydra['as']>
let mine: { id: string }
let other: {
  id: string
  status: string
}
let done: string

const settingsOf = async () => (await hydra.owner({
  args: [
    'settings',
    'show',
  ],
})).settings

const statusOfOther = async () => (await hydra.task({ key: 'other' })).status as string

beforeAll(async () => {
  pnyx = await startPnyx()
  hydra = await pnyx.hydra()
  ;({ worker } = await hydra.startTask({ key: 'mine' }))
  await hydra.owner({
    args: [
      'task',
      'create',
      '--no-start',
      '--title',
      'Other task',
      '--key',
      'other',
      '--folder',
      hydra.folder({ name: 'other' }),
    ],
  })
  mine = await hydra.task({ key: 'mine' })
  other = await hydra.task({ key: 'other' })
  done = await hydra.column({ role: 'done' })
  asWorker = hydra.as({ session: worker })
})

// The environment of a worker started with --via command: its task, never its actor.
const commandWorkerEnv = (): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = {
    ...worker.env,
    PNYX_TASK: mine.id,
    PNYX_ROLE: 'worker',
  }
  delete env.PNYX_ACTOR
  delete env.PNYX_STEERING_WORKER

  return env
}

test(
  'a worker\'s writes outside its own task are refused with WORKER_SCOPE and change nothing',
  async () => {
    const otherStatus = await statusOfOther()
    const { fontSize } = await settingsOf()

    const refused = {
      'question on another task': [
        'task',
        'ask',
        'other',
        '--question',
        'May I continue?',

      ],
      'question on another task by id': [
        'task',
        'ask',
        other.id,
        '--question',
        'May I continue?',
      ],
      'question on another task claiming to be Hydra': [
        'task',
        'ask',
        'other',
        '--question',
        'May I continue?',
        '--actor',
        'hydra',
        '--reason',
        'not mine',
      ],
      'question on another task claiming to be its worker': [
        'task',
        'ask',
        'other',
        '--question',
        'May I continue?',
        '--actor',
        `worker:${other.id}`,
      ],
      'question on its own task claiming to be the owner': [
        'task',
        'ask',
        'mine',
        '--question',
        'May I continue?',
        '--actor',
        'web',
      ],
      'a question through apply': [
        'apply',
        '--json',
        '{}',
      ],
      'a question on another task': [
        'task',
        'ask',
        'other',
        '--question',
        'Which one?',
      ],
      'a link on another task': [
        'link',
        'other',
        '--url',
        'https://example.test/pull/1',
      ],
      'a message about another task': [
        'hydra',
        'send',
        '--task',
        'other',
        '--kind',
        'progress',
        '--text',
        'not mine',
      ],
      'a move of another task': [
        'move',
        'other',
        done,
      ],
      'a move of its own card': [
        'move',
        'mine',
        done,
      ],
      'settings set': [
        'settings',
        'set',
        '--json',
        '{"fontSize":19}',
      ],
      'settings set claiming to be Hydra': [
        'settings',
        'set',
        '--json',
        '{"fontSize":19}',
        '--actor',
        'hydra',
        '--reason',
        'not mine',
      ],
      'a rule change': [
        'rule',
        'remove',
        'build',
      ],
      'an account change': [
        'account',
        'remove',
        'main',
      ],
      'an outcome': [
        'outcome',
        'other',
        'done',
      ],
      'creating a task': [
        'task',
        'create',
        '--title',
        'Another',
      ],
      'a report on another task': [
        'task',
        'report',
        'other',
        '--file',
        '-',
      ],
      'refreshing the plan limits': [
        'hydra',
        'usage',
        'refresh',
      ],
    }

    for (const [
      what,
      args,
    ] of Object.entries(refused)) {
      const refusal = await asWorker.refused({ args })
      expect(
        refusal.code,
        what,
      ).toBe('WORKER_SCOPE')
    }

    expect(await statusOfOther()).toBe(otherStatus)
    expect((await settingsOf()).fontSize).toBe(fontSize)
  },
)

test(
  'a worker\'s own question, link, progress message, report, report review and sources work, and it reads any task, Hydra and setting',
  async () => {
    await workerLine({
      hydra,
      key: 'mine',
      line: 'note: On it',
    })
    expect((await hydra.task({ key: 'mine' })).status).toBe('idle')
    await workerLine({
      hydra,
      key: 'mine',
      line: 'note: Still on it',
    })
    await asWorker.run({
      args: [
        'task',
        'ask',
        'mine',
        '--question',
        'Which parser?',
      ],
    })
    expect((await hydra.task({ key: 'mine' })).questionCount).toBe(1)
    await asWorker.run({
      args: [
        'link',
        'mine',
        '--url',
        'https://github.com/example/repo/pull/1',
      ],
    })
    await asWorker.run({
      args: [
        'hydra',
        'send',
        '--task',
        'mine',
        '--kind',
        'progress',
        '--text',
        'Halfway',
      ],
    })
    const file = join(
      hydra.folder({ name: 'mine' }),
      'report.md',
    )
    writeFileSync(
      file,
      '# Findings\n\nNothing to fix.\n',
    )
    await asWorker.run({
      args: [
        'task',
        'report',
        'mine',
        '--file',
        file,
      ],
    })
    const stored = await asWorker.run({
      args: [
        'task',
        'report',
        'mine',
      ],
    })
    await asWorker.run({
      args: [
        'task',
        'report-review',
        'mine',
        '--report',
        stored.id,
        '--none',
      ],
    })
    await asWorker.run({
      args: [
        'task',
        'refresh-links',
        'mine',
      ],
    })
    await asWorker.run({
      args: [
        'task',
        'source',
        'list',
        'mine',
      ],
    })
    await asWorker.run({
      args: [
        'task',
        'inbox',
        'read',
        'mine',
      ],
    })

    for (const args of [
      [
        'task',
        'show',
        'other',
      ],
      [
        'task',
        'report',
        'other',
      ],
      [
        'task',
        'reminders',
      ],
      [
        'settings',
        'show',
      ],
      [
        'hydra',
        'usage',
      ],
      [
        'hydra',
        'digest',
      ],
      [
        'hydra',
        'memory',
        'list',
      ],
    ]) {
      const run = await pnyxAxi({
        args: [
          ...args,
          '--hydra',
          hydra.id,
        ],
        env: worker.env,
      })
      expect(
        run.status,
        `${args.join(' ')}:\n${run.stdout}`,
      ).toBe(0)
    }
  },
)

test(
  'a flag before the task never changes which task a worker\'s command is checked against',
  async () => {
    await asWorker.run({
      args: [
        'task',
        'source',
        'list',
        '--page',
        '1',
        'mine',
      ],
    })
    await asWorker.run({
      args: [
        'task',
        'inbox',
        'read',
        '--session',
        'session',
        'mine',
      ],
    })

    for (const args of [
      [
        'task',
        'source',
        'register',
        '--page',
        mine.id,
        'other',
        'source-1',
        '--executable',
        '/bin/echo',
        '--argv',
        '[]',
        '--cwd',
        hydra.folder({ name: 'other' }),
      ],
      [
        'task',
        'inbox',
        'ack',
        '--session',
        'session',
        '--generation',
        mine.id,
        'other',
        'message-1',
      ],
      [
        'link',
        '--number',
        '1',
        'other',
        '--url',
        'https://example.test/pull/1',
      ],
    ]) {
      const refusal = await asWorker.refused({ args })
      expect(
        refusal.code,
        args.join(' '),
      ).toBe('WORKER_SCOPE')
      expect(refusal.error).toContain(other.id)
    }
  },
)

test(
  'a worker that leaves out --hydra is checked against the Hydra its command writes to',
  async () => {
    const fallback = await pnyx.hydra({ id: 'default' })
    await fallback.owner({
      args: [
        'task',
        'create',
        '--no-start',
        '--title',
        'The default Hydra\'s task',
        '--key',
        'mine',
        '--folder',
        fallback.folder({ name: 'mine' }),
      ],
    })
    const before = (await fallback.task({ key: 'mine' })).status as string
    const run = await pnyxAxi({
      args: [
        'task',
        'ask',
        'mine',
        '--question',
        'May I continue?',

      ],
      env: worker.env,
    })

    expect(run.status).toBe(1)
    expect(parsed(run).code).toBe('WORKER_SCOPE')
    expect((await fallback.task({ key: 'mine' })).status).toBe(before)
  },
)

test(
  'a worker started with --via command is held to its own task, and records as that worker',
  async () => {
    const env = commandWorkerEnv()
    const asCommand = hydra.as({
      session: worker,
      env,
    })
    const otherStatus = await statusOfOther()

    for (const args of [
      [
        'task',
        'ask',
        'other',
        '--question',
        'May I continue?',
      ],
      [
        'settings',
        'set',
        '--json',
        '{"fontSize":19}',
      ],
    ]) {
      expect((await asCommand.refused({ args })).code).toBe('WORKER_SCOPE')
    }

    expect((await asCommand.refused({
      args: [
        'task',
        'tools',
        'mine',
        '--grant',
        'browser',
      ],
    })).code).toBe('HYDRA_ONLY')

    for (const args of [
      [
        'task',
        'stop',
        'mine',
      ],
      [
        'task',
        'move',
        'mine',
        '--to-hydra',
        'default',
      ],
      ['upgrade'],
    ]) {
      expect(
        (await asCommand.refused({ args })).code,
        args.join(' '),
      ).toBe('OWNER_ONLY')
    }

    const restart = await pnyxAxi({
      args: ['restart'],
      env,
    })
    expect(parsed(restart).code).toBe('OWNER_ONLY')
    expect(await statusOfOther()).toBe(otherStatus)

    await asCommand.run({
      args: [
        'link',
        'mine',
        '--url',
        'https://example.com/command',
      ],
    })
    const history = await hydra.owner({
      args: [
        'task',
        'history',
        'mine',
      ],
    })
    expect(history.events).toContainEqual(expect.objectContaining({
      type: 'card.linked',
      actor: `worker:${mine.id}`,
    }))
  },
)

test(
  'a worker whose PNYX_ACTOR is missing still cannot write to another task, and is told how to name its own',
  async () => {
    const env = { ...worker.env }
    delete env.PNYX_ACTOR
    const asUnnamed = hydra.as({
      session: worker,
      env,
    })
    const otherStatus = await statusOfOther()

    const elsewhere = await asUnnamed.refused({
      args: [
        'task',
        'ask',
        'other',
        '--question',
        'May I continue?',
        '--actor',
        'cli',
      ],
    })
    expect(elsewhere.code).toBe('WORKER_SCOPE')
    const unnamed = await asUnnamed.refused({
      args: [
        'task',
        'ask',
        'mine',
        '--question',
        'May I continue?',
      ],
    })
    expect(unnamed.code).toBe('WORKER_SCOPE')
    expect(unnamed.error).toContain('PNYX_ACTOR is missing')
    expect(await statusOfOther()).toBe(otherStatus)

    await asUnnamed.run({
      args: [
        'link',
        'mine',
        '--url',
        'https://example.com/unnamed',
        '--actor',
        `worker:${mine.id}`,
      ],
    })
  },
)

test(
  'a worker\'s refusal keeps the command\'s own error code and says what was refused',
  async () => {
    const unknown = await asWorker.refused({
      args: [
        'task',
        'ask',
        'nope',
        '--question',
        'May I continue?',
      ],
    })
    expect(unknown.code).toBe('NOT_FOUND')
    expect(unknown.help?.length).toBeGreaterThan(0)

    expect((await asWorker.refused({
      args: [
        'reply',
        'mine',
        '--text',
        'hello',
      ],
    })).error).toBe('reply is not a worker\'s command')

    expect((await asWorker.refused({
      args: [
        'hydra',
        'send',
        '--task',
        'mine',
        '--action',
        'send',
        '--text',
        'hello',
      ],
    })).error).toContain('hydra send --action is Hydra\'s')

    const logs = await asWorker.refused({
      args: [
        'logs',
        'clean',
      ],
    })
    expect(logs.code).toBe('WORKER_SCOPE')
    expect(logs.error).toContain('refused for a worker')
    expect(logs.help?.[0]).toContain('A worker may run on its own task: task ask, ')
  },
)

test(
  'a worker\'s refusal of a Stop keeps the owner-only error, for the task and for the Hydra',
  async () => {
    for (const args of [
      [
        'task',
        'stop',
        'other',
      ],
      [
        'hydra',
        'stop',
      ],
      [
        'hydra',
        'cancel',
        'message-1',
      ],
    ]) {
      expect(
        (await asWorker.refused({ args })).code,
        args.join(' '),
      ).toBe('OWNER_ONLY')
    }
  },
)

test(
  'a worker in a scratch home of its own may run a server there, while its own home still refuses it',
  async () => {
    const scratch = mkdtempSync(join(
      tmpdir(),
      'pnyx-scratch-',
    ))
    const refused = await pnyxAxi({
      args: ['stop'],
      env: worker.env,
    })
    expect(parsed(refused).code).toBe('WORKER_SCOPE')

    const elsewhere = await pnyxAxi({
      args: ['stop'],
      env: {
        ...worker.env,
        PNYX_HOME: scratch,
      },
    })
    expect(elsewhere.status).toBe(0)
    expect((await fetch(`http://127.0.0.1:${pnyx.port()}/hydra/${hydra.id}/health`)).status).toBe(200)
  },
)

test(
  'Hydra and the owner keep their rights over other tasks and settings',
  async () => {
    const session = await hydra.chat({ text: 'Pause the other task and make the text bigger.' })
    const asHydra = hydra.as({ session })
    await asHydra.run({
      args: [
        'task',
        'hold',
        'other',
        '--reason',
        'Hydra paused it',
      ],
    })
    expect(await statusOfOther()).toBe('on hold')
    await asHydra.run({
      args: [
        'settings',
        'set',
        '--json',
        '{"fontSize":19}',
        '--reason',
        'the owner asked',
      ],
    })
    expect((await settingsOf()).fontSize).toBe(19)
    await hydra.owner({
      args: [
        'task',
        'hold',
        'other',
        '--reason',
        'Owner paused it',
      ],
    })
    expect(await statusOfOther()).toBe('on hold')
  },
)
