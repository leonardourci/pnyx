import { readEvents } from '#app/event-log.ts'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { WAIT_MS } from './setup/until.ts'
import { workerLine } from './setup/worker-log.ts'
import { beforeAll, expect, test } from 'vitest'
import { CLI, operation, startOthrys, until, type AgentSession, type Titan, type Othrys } from './setup/othrys.ts'

let othrys: Othrys
let hydra: Titan
let worker: AgentSession
let asWorker: ReturnType<Titan['as']>
let mine: { id: string }

const settingsOf = async () => (await hydra.owner({
  args: [
    'settings',
    'show',
  ],
})).settings

const statusOfOther = async () => (await hydra.task({ key: 'other' })).status as string

beforeAll(async () => {
  othrys = await startOthrys()
  hydra = await othrys.hydra()
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
  asWorker = hydra.as({ session: worker })
})

// The environment of a worker started with --via command: its task, never its actor.
const commandWorkerEnv = (): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = {
    ...worker.env,
    OTHRYS_TASK: mine.id,
    OTHRYS_ROLE: 'worker',
  }
  delete env.OTHRYS_ACTOR
  delete env.OTHRYS_STEERING_WORKER

  return env
}

test(
  'workers change other tasks and settings, with notices instead of scope refusals',
  async () => {
    const hydra = await othrys.hydra()
    const { worker } = await hydra.startTask({ key: 'writer' })
    await hydra.owner({
      args: [
        'task',
        'create',
        '--no-start',
        '--key',
        'target',
        '--title',
        'Other work',
      ],
    })
    const target = await hydra.task({ key: 'target' })
    const asWorker = hydra.as({ session: worker })

    for (const args of [
      [
        'task',
        'ask',
        '--question',
        'Which parser?',
        'target',
      ],
      [
        'link',
        '--url',
        'https://example.test/change',
        'target',
      ],
      [
        'task',
        'owner-ask',
        'target',
        '--text',
        'Keep this visible',
      ],
      [
        'task',
        'arrange',
        'target',
      ],
      [
        'settings',
        'set',
        '--json',
        '{"fontSize":19}',
      ],
      [
        'task',
        'create',
        '--no-start',
        '--title',
        'Follow up',
        '--key',
        'follow-up',
      ],
      [
        'outcome',
        'target',
        'done',
      ],
    ]) {
      const output = await asWorker.run({ args })
      expect(
        output.notices,
        args.join(' '),
      ).toEqual(expect.arrayContaining([
        expect.objectContaining({
          reason: expect.any(String),
          clear: expect.stringMatching(/\S/),
        }),
      ]))

      for (const notice of output.notices) {
        expect(notice.clear).not.toMatch(/\bothrys-axi\b/)
      }
    }

    const retryArgs = [
      'task',
      'brief',
      'target',
      '--brief',
      'Retried guidance',
      '--event-id',
      'notice-retry',
    ]
    const firstReceipt = await asWorker.run({ args: retryArgs })
    const retriedReceipt = await asWorker.run({ args: retryArgs })
    expect(firstReceipt.notices).toContainEqual(expect.objectContaining({
      reason: expect.stringContaining('task brief is outside'),
    }))
    expect(retriedReceipt.notices).toEqual(firstReceipt.notices)
    expect(readEvents({
      hydraId: hydra.id,
      types: ['task.brief'],
    }).filter(event => event.type === 'task.brief' && event.data.after === 'Retried guidance')).toHaveLength(1)

    expect((await hydra.task({ key: 'target' })).status).toBe('done')
    expect((await hydra.task({ key: 'target' })).notices).toBeDefined()
    expect((await settingsOf()).fontSize).toBe(19)
    expect((await hydra.task({ key: 'follow-up' })).title).toBe('Follow up')
    const history = await hydra.owner({
      args: [
        'task',
        'history',
        target.id,
      ],
    })
    expect(history.events).toContainEqual(expect.objectContaining({
      actor: worker.env.OTHRYS_ACTOR,
    }))
    const dispatchBefore = await hydra.owner({
      args: [
        'rule',
        'show',
      ],
    })
    const dispatchArgs = [
      'rule',
      'apply',
      '--propose',
      '--event-id',
      'dispatch-guidance-retry',
      '--actor',
      'hydra',
      '--json',
      JSON.stringify({
        version: 1,
        expected: { revision: dispatchBefore.revision },
        patch: {
          rules: {
            'direct-agent': {
              when: 'Explicit agent selection',
              candidates: [
                {
                  harness: 'claude',
                  mode: 'bypassPermissions',
                },
              ],
            },
          },
        },
      }),
    ]
    const dispatch = await asWorker.run({ args: dispatchArgs })
    expect(dispatch).not.toHaveProperty('confirmation')
    expect(dispatch.notices).toContainEqual(expect.objectContaining({ reason: expect.stringContaining('permission level increased') }))
    const dispatchRetry = await asWorker.run({ args: dispatchArgs })
    expect(dispatchRetry.notices).toEqual(dispatch.notices)
    expect(dispatchRetry.revision).toBe(dispatch.revision)
    expect(JSON.stringify(await hydra.owner({
      args: [
        'rule',
        'show',
      ],
    }))).toContain('bypassPermissions')

    const inboxTarget = await hydra.startTask({ key: 'inbox-target' })
    await hydra.owner({
      args: [
        'task',
        'hide',
        'inbox-target',
      ],
    })
    await hydra.owner({
      args: [
        'task',
        'inbox',
        'enqueue',
        'inbox-target',
        'older-instruction',
        '--text',
        'Review the first instruction',
      ],
    })
    await hydra.owner({
      args: [
        'task',
        'inbox',
        'enqueue',
        'inbox-target',
        'newer-instruction',
        '--text',
        'Record the blocker',
      ],
    })
    const pending = await hydra.owner({
      args: [
        'task',
        'inbox',
        'read',
        'inbox-target',
      ],
    })
    const acknowledgement = await asWorker.run({
      args: [
        'task',
        'inbox',
        'ack',
        'inbox-target',
        'newer-instruction',
        '--session',
        pending.claim.session,
        '--generation',
        String(pending.claim.generation),
        '--outcome',
        'blocked',
      ],
    })
    expect(acknowledgement.notices).toContainEqual(expect.objectContaining({ reason: expect.stringContaining('older pending instruction') }))
    expect(acknowledgement.message.ack.note).toBe('Marked blocked by the explicit acknowledgement')
    expect((await hydra.owner({
      args: [
        'task',
        'inbox',
        'read',
        'inbox-target',
      ],
    })).messages).toContainEqual(expect.objectContaining({ id: 'older-instruction' }))
    await hydra.owner({
      args: [
        'reply',
        'inbox-target',
        '--text',
        'Continue the hidden task',
      ],
    })
    await until({
      what: 'the current hidden worker to receive its reply',
      check: async () => {
        const current = await hydra.agent({ cwd: inboxTarget.folder })

        return current.received.some(text => text.includes('Continue the hidden task'))
      },
    })
    const directMessage = await hydra.owner({
      args: [
        'reply',
        'inbox-target',
        '--task-message',
        '--text',
        'Keep the hidden task context',
      ],
    })
    expect(directMessage.notices).toBeDefined()

    await hydra.owner({
      args: [
        'task',
        'hold',
        'inbox-target',
        '--reason',
        'Inspect the source result before delivery',
      ],
    })
    await asWorker.run({
      args: [
        'task',
        'source',
        'register',
        'inbox-target',
        'manual-result',
        '--executable',
        '/usr/bin/true',
        '--argv',
        '[]',
        '--cwd',
        hydra.folder({ name: 'source-cwd' }),
      ],
    })
    const stoppedSource = await hydra.owner({
      args: [
        'task',
        'source',
        'stop',
        'inbox-target',
        'manual-result',
      ],
    })
    await othrys.restart()
    const unread = await hydra.owner({
      args: [
        'task',
        'source',
        'read',
        'inbox-target',
        'manual-result',
      ],
    })
    expect(unread.results).toContainEqual(expect.objectContaining({
      sequence: stoppedSource.source.results[0].sequence,
    }))
    const handledSource = await asWorker.run({
      args: [
        'task',
        'source',
        'handled',
        'inbox-target',
        'manual-result',
        String(stoppedSource.source.results[0].sequence),
        '--session',
        unread.claim.session,
        '--generation',
        String(unread.claim.generation),
      ],
    })
    expect(handledSource.result.handled).toBeDefined()
    expect(handledSource.notices).toContainEqual(expect.objectContaining({ reason: expect.stringContaining('before its steering message') }))
    await othrys.restart()
    expect((await hydra.owner({
      args: [
        'task',
        'source',
        'read',
        'inbox-target',
        'manual-result',
      ],
    })).results).toBe('none: no unread results')
    expect((await hydra.owner({
      args: [
        'task',
        'source',
        'read',
        'inbox-target',
        'manual-result',
        '--all',
      ],
    })).results).toContainEqual(expect.objectContaining({
      sequence: stoppedSource.source.results[0].sequence,
      handled: handledSource.result.handled,
    }))

    const {
      folder: sourceFolder,
      worker: sourceWorker,
    } = await hydra.startTask({ key: 'source-notice' })
    const sourceTask = await hydra.task({ key: 'source-notice' })
    await hydra.as({ session: sourceWorker }).run({
      args: [
        'task',
        'source',
        'register',
        sourceTask.id,
        'delivered-result',
        '--executable',
        process.execPath,
        '--argv',
        JSON.stringify([
          '-e',
          "process.stdout.write('SOURCE-CALLER-PAYLOAD')",
        ]),
        '--cwd',
        sourceFolder,
      ],
    })
    const taskLog = join(
      process.env.OTHRYS_HOME!,
      'hydras',
      hydra.id,
      'tasks',
      sourceTask.id,
      'task.log',
    )
    const records = () => readFileSync(
      taskLog,
      'utf8',
    ).trimEnd()
      .split('\n')
      .map(line => JSON.parse(line))
    const result = await until({
      what: 'the visible source result in the native task log',
      check: () => records().find(record => record.event?.type === 'task.source.result'
        && record.event.data.source === 'delivered-result')?.event.data.result,
    })
    expect(result.stdout).toBe('SOURCE-CALLER-PAYLOAD')
    const notice = await until({
      what: 'the source caller to save its ID-only notification',
      check: () => records().find(record => record.event?.type === 'card.replied'
        && record.event.data.reply.startsWith(`source-notice:${result.message}:`))?.event.data.text,
    })
    expect(notice).toContain('Othrys steering inbox has pending instruction IDs ')
    expect(notice).toContain(result.message)
    expect(notice).not.toContain('SOURCE-CALLER-PAYLOAD')
    await until({
      what: 'the source notification to reach its assigned worker',
      check: () => sourceWorker.received.some(text => text.includes(notice)),
    })
    const command = notice.match(/^othrys task ack .+$/m)?.[0]

    if (!command) {
      throw new Error(`The source notice has no acknowledgement command: ${notice}`)
    }

    const acknowledge = () => promisify(execFile)(
      '/bin/sh',
      [
        '-c',
        `othrys() { "$OTHRYS_TEST_NODE" "$OTHRYS_TEST_CLI" "$@"; }\n${command} --json`,
      ],
      {
        env: {
          ...sourceWorker.env,
          OTHRYS_TEST_NODE: process.execPath,
          OTHRYS_TEST_CLI: CLI,
        },
        timeout: WAIT_MS,
      },
    )
    expect(JSON.parse((await acknowledge()).stdout)).toMatchObject({
      instruction: result.message,
      acknowledged: 'read',
    })
    const instructionRecords = () => records().filter(record =>
      record.event?.type?.startsWith('task.steering.')
      && record.event.data.message === result.message)
    const savedInstructionRecords = instructionRecords()
    expect(JSON.parse((await acknowledge()).stdout)).toMatchObject({
      instruction: result.message,
      acknowledged: 'read',
    })
    expect(instructionRecords()).toEqual(savedInstructionRecords)
    expect(records().some(record => record.event?.type === 'task.source.handled'
      && record.event.data.source === 'delivered-result')).toBe(false)
  },
)

test(
  'a command-route worker keeps its identity while changing another task',
  async () => {
    const asCommand = hydra.as({
      session: worker,
      env: commandWorkerEnv(),
    })
    const output = await asCommand.run({
      args: [
        'link',
        'other',
        '--url',
        'https://example.test/command-worker',
      ],
    })
    expect(output.notices).toBeDefined()
    const history = await hydra.owner({
      args: [
        'task',
        'history',
        'other',
      ],
    })
    expect(history.events).toContainEqual(expect.objectContaining({ actor: `worker:${mine.id}` }))
  },
)

test(
  'a worker without a task identity proceeds with a notice and can record an explicit worker actor',
  async () => {
    const env = { ...worker.env }
    delete env.OTHRYS_ACTOR
    const asUnnamed = hydra.as({
      session: worker,
      env,
    })
    const output = await asUnnamed.run({
      args: [
        'link',
        'other',
        '--url',
        'https://example.test/unnamed-worker',
        '--actor',
        'cli',
      ],
    })
    expect(output.notices).toEqual(expect.arrayContaining([expect.objectContaining({ reason: expect.stringContaining('no recorded task identity') })]))
    const own = await asUnnamed.run({
      args: [
        'link',
        'mine',
        '--url',
        'https://example.test/default-worker',
        '--actor',
        `worker:${mine.id}`,
      ],
    })
    expect(own.event).toBeDefined()
    const history = await hydra.owner({
      args: [
        'task',
        'history',
        'mine',
      ],
    })
    expect(history.events).toContainEqual(expect.objectContaining({ actor: `worker:${mine.id}` }))
  },
)

test(
  'workers retain malformed-input and missing-target validation',
  async () => {
    expect((await asWorker.refused({
      args: [
        'task',
        'ask',
        'nope',
        '--question',
        'Which parser?',
      ],
    })).code).toBe('NOT_FOUND')
    expect((await asWorker.refused({
      args: [
        'apply',
        '--json',
        '{}',
      ],
    })).code).toBe('VALIDATION_ERROR')
    expect((await asWorker.refused({
      args: [
        'task',
        'create',
        '--unknown-option',
      ],
    })).code).toBe('VALIDATION_ERROR')
  },
)

test(
  'a worker can stop another worker or Titan and receives the result with a notice',
  async () => {
    const hydra = await othrys.hydra()
    const { worker: caller } = await hydra.startTask({ key: 'caller' })
    othrys.claude.plan({
      hydra: hydra.id,
      match: ({ text }) => text.includes('<othrys-worker'),
      partial: 'Working',
      hold: true,
    })
    const folder = hydra.folder({ name: 'target' })
    await hydra.owner({
      args: [
        'task',
        'create',
        '--no-start',
        '--key',
        'target',
        '--title',
        'Target',
        '--folder',
        folder,
        '--brief',
        'Work until stopped',
      ],
    })
    await hydra.owner({
      args: [
        'task',
        'start',
        'target',
      ],
    })
    const target = await hydra.agent({ cwd: folder })
    await until({
      what: 'target to start its turn',
      check: () => target.received.length === 1,
    })
    const asCaller = hydra.as({ session: caller })
    const stopped = await asCaller.run({
      args: [
        'task',
        'stop',
        'target',
      ],
    })
    expect(stopped.stopped).toMatch(/^task-/)
    expect(stopped.notices).toBeDefined()
    expect((await hydra.task({ key: 'target' })).status).toBe('ended')
    othrys.claude.plan({
      hydra: hydra.id,
      text: 'Look at the result',
      partial: 'Looking',
      hold: true,
    })
    await hydra.chat({ text: 'Look at the result' })
    const hydraStopped = await asCaller.run({
      args: [
        'hydra',
        'stop',
      ],
    })
    expect(hydraStopped.stopped).toBe('hydra')
    expect(hydraStopped.notices).toBeDefined()
  },
)

test(
  'a worker\'s own question, link, progress message and sources work, and it reads any task, Titan and setting',
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
        '--text',
        'Halfway',
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
        'memory',
        'list',
      ],
    ]) {
      const run = await operation({
        args: [
          ...args,
          '--titan',
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
  'Titan and the owner keep their rights over other tasks and settings',
  async () => {
    const session = await hydra.chat({ text: 'Pause the other task and make the text bigger.' })
    const asTitan = hydra.as({ session })
    await asTitan.run({
      args: [
        'task',
        'hold',
        'other',
        '--reason',
        'Titan paused it',
      ],
    })
    expect(await statusOfOther()).toBe('on hold')
    await asTitan.run({
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
