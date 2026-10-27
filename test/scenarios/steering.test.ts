import assert from 'node:assert/strict'
import childProcess from 'node:child_process'
import { copyFileSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { join } from 'node:path'
import { test } from 'node:test'
import type { Card } from '../../src/core/model.ts'
import { emptyHydra, replay } from '../../src/core/reducer.ts'
import { hydraDir } from '../../src/app/home-migration.ts'
import { steeringNotice } from '../../src/task-inbox/notice.ts'
import { openPage, until } from '../../src/test-harness/harness.ts'
import { pnyx } from '../../src/test-harness/pnyx.ts'

const pending = ({ card }: { card: Card }) => {
  const messages = card.steering ?? []

  return messages.filter(message => !message.ack).map(message => message.id)
}

const claimFlags = ({ card }: { card: Card }) => [
  '--session',
  card.sessionIds![0]!,
  '--generation',
  String(card.steeringGeneration ?? card.createdSeq),
]

test(
  'a Codex worker’s reply shows in its task chat, and each owner message reaches it once, through a restart that resumes the same thread',
  async () => {
    const s = await pnyx.scenario()
    const folder = s.folder({ name: 'docs' })
    await s.owner({
      args: [
        'task',
        'create',
        '--title',
        'Write the changelog',
        '--key',
        'notes',
        '--folder',
        folder,
      ],
    })
    await s.owner({
      args: [
        'task',
        'start',
        'notes',
        '--harness',
        'codex',
      ],
    })
    const first = await s.agent({ cwd: folder })
    const card = s.task({ key: 'notes' })
    const finished = ({ turns }: { turns: number }) => until({
      what: `turn ${turns} to finish`,
      check: () => s.received({ cwd: folder }).length === turns && s.task({ key: 'notes' }).sessionActivity === 'finished',
    })
    await finished({ turns: 1 })
    assert.match(
      s.received({ cwd: folder })[0]!,
      /You are the Pnyx worker for task \S+ "Write the changelog"/,
    )

    const page = await openPage({
      port: pnyx.port(),
      hydraId: s.hydraId,
    })
    const thread = await page.command({
      name: 'thread',
      args: [card.id],
    }) as {
      thread: {
        entries: {
          role?: string
          text?: string
        }[]
      }
    }
    assert.deepEqual(
      thread.thread.entries.filter(e => e.role === 'assistant').map(e => e.text),
      [pnyx.codex.reply],
    )
    page.close()

    await s.owner({
      args: [
        'reply',
        card.id,
        '--text',
        'Add the release date.',
      ],
    })
    await finished({ turns: 2 })
    const instruction = s.task({ key: 'notes' }).steering![0]!
    assert.equal(
      instruction.text,
      'Add the release date.',
    )
    const worker = s.as({ agent: first })
    const current = s.task({ key: 'notes' })
    await worker.run({
      args: [
        'task',
        'inbox',
        'ack',
        card.id,
        instruction.id,
        '--session',
        current.sessionIds![0]!,
        '--generation',
        String(current.steeringGeneration),
      ],
    })

    await pnyx.restart()
    await s.owner({
      args: [
        'reply',
        card.id,
        '--text',
        'Ship it.',
      ],
    })
    await finished({ turns: 3 })
    assert.deepEqual(
      s.received({ cwd: folder }).slice(1),
      [
        steeringNotice({
          task: card.id,
          hydraId: s.hydraId,
          ids: [instruction.id],
        }),
        steeringNotice({
          task: card.id,
          hydraId: s.hydraId,
          ids: [s.task({ key: 'notes' }).steering![1]!.id],
        }),
      ],
    )
    const resumed = await s.agent({ cwd: folder })
    assert.notEqual(
      resumed,
      first,
    )
    const opened = ({ requests }: { requests?: string[] }) => requests!.filter(m => m.startsWith('thread/') || m === 'turn/start')
    assert.deepEqual(
      [
        opened(first),
        opened(resumed),
        resumed.id,
      ],
      [
        [
          'thread/start',
          'turn/start',
          'turn/start',
        ],
        [
          'thread/resume',
          'turn/start',
        ],
        first.id,
      ],
    )
    assert.deepEqual(
      [
        card.agent?.sessionId,
        s.task({ key: 'notes' }).agent?.sessionId,
      ],
      [
        first.id,
        first.id,
      ],
    )
  },
)

test(
  'ordered instructions, notification receipts and acknowledgements survive restart and replay',
  async () => {
    const s = await pnyx.scenario()
    const folder = s.folder({ name: 'worker' })
    await s.owner({
      args: [
        'task',
        'create',
        '--key',
        'work',
        '--title',
        'Work',
        '--folder',
        folder,
      ],
    })
    await s.owner({
      args: [
        'task',
        'start',
        'work',
      ],
    })
    const worker = s.as({ agent: await s.agent({ cwd: folder }) })
    await until({
      what: 'the opening worker turn to finish',
      check: () => s.task({ key: 'work' }).sessionActivity === 'finished',
    })
    const text = 'Olá 🌊\nKeep every line.\n第二行'
    await s.owner({
      args: [
        'task',
        'inbox',
        'enqueue',
        'work',
        'first',
        '--source',
        'owner',
        '--reply',
        'reply-1',
        '--file',
        '-',
      ],
      input: text,
    })
    await s.owner({
      args: [
        'task',
        'inbox',
        'enqueue',
        'work',
        'first',
        '--source',
        'owner',
        '--reply',
        'reply-1',
        '--text',
        text,
      ],
    })
    await s.owner({
      args: [
        'task',
        'inbox',
        'enqueue',
        'work',
        'second',
        '--text',
        text,
      ],
    })
    assert.equal(
      await s.ownerRefused({
        args: [
          'task',
          'inbox',
          'enqueue',
          'work',
          'first',
          '--text',
          'changed',
        ],
      }),
      'VALIDATION_ERROR',
    )
    assert.deepEqual(
      pending({ card: s.task({ key: 'work' }) }),
      [
        'first',
        'second',
      ],
    )
    assert.deepEqual(
      s.task({ key: 'work' }).steering!.map(message => message.order),
      [
        1,
        2,
      ],
    )
    assert.equal(
      s.task({ key: 'work' }).steering![0]!.text,
      text,
    )
    assert.equal(
      s.task({ key: 'work' }).steering![0]!.reply,
      'reply-1',
    )
    assert.equal(
      s.task({ key: 'work' }).steering![0]!.source,
      'owner',
    )
    assert.equal(
      await s.ownerRefused({
        args: [
          'task',
          'inbox',
          'enqueue',
          'work',
          'unsupported-event',
          '--text',
          'Unstored',
          '--event-id',
          'ignored-before-review',
        ],
      }),
      'VALIDATION_ERROR',
    )
    assert.equal(
      await s.ownerRefused({
        args: [
          'task',
          'inbox',
          'enqueue',
          'work',
          'unsupported-revision',
          '--text',
          'Unstored',
          '--if-revision',
          '0',
        ],
      }),
      'VALIDATION_ERROR',
    )
    assert.deepEqual(
      pending({ card: s.task({ key: 'work' }) }),
      [
        'first',
        'second',
      ],
    )
    const claim = claimFlags({ card: s.task({ key: 'work' }) })
    const read = await worker.run({
      args: [
        'task',
        'inbox',
        'read',
        'work',
      ],
    })
    assert.match(
      read,
      /Olá 🌊/,
    )
    assert.match(
      read,
      /pending: 2/,
    )
    assert.match(
      read,
      new RegExp(s.task({ key: 'work' }).sessionIds![0]!),
    )
    const notification = [
      'task',
      'inbox',
      'notify',
      'work',
      'first',
      ...claim,
      '--attempt',
      'doorbell-1',
      '--result',
      'delivered',
    ]
    await s.owner({ args: notification })
    await s.owner({ args: notification })
    assert.equal(
      s.task({ key: 'work' }).steering![0]!.attempts.length,
      1,
    )
    assert.deepEqual(
      pending({ card: s.task({ key: 'work' }) }),
      [
        'first',
        'second',
      ],
    )
    assert.equal(
      await worker.refused({
        args: [
          'task',
          'inbox',
          'ack',
          'work',
          'second',
          ...claim,
        ],
      }),
      'VALIDATION_ERROR',
    )
    assert.equal(
      await s.ownerRefused({
        args: [
          'task',
          'inbox',
          'ack',
          'work',
          'first',
          ...claim,
        ],
      }),
      'NOT_ALLOWED',
    )
    const ack = [
      'task',
      'inbox',
      'ack',
      'work',
      'first',
      ...claim,
    ]
    await worker.run({ args: ack })
    const handledEvents = s.events().filter(event => event.type === 'task.steering.handled').length
    await worker.run({ args: ack })
    assert.equal(
      s.events().filter(event => event.type === 'task.steering.handled').length,
      handledEvents,
    )
    assert.deepEqual(
      pending({ card: s.task({ key: 'work' }) }),
      ['second'],
    )
    assert.equal(
      s.task({ key: 'work' }).steering![0]!.ack!.actor,
      `worker:${s.task({ key: 'work' }).id}`,
    )
    await s.owner({
      args: [
        'task',
        'inbox',
        'enqueue',
        'work',
        'third',
        '--text',
        'After acknowledgement',
      ],
    })
    assert.deepEqual(
      s.task({ key: 'work' }).steering!.map(message => message.order),
      [
        1,
        2,
        3,
      ],
    )
    rmSync(
      join(
        hydraDir({ hydraId: s.hydraId }),
        'snapshot.json',
      ),
      { force: true },
    )
    await pnyx.restart()
    const restored = s.task({ key: 'work' })
    assert.deepEqual(
      pending({ card: restored }),
      [
        'second',
        'third',
      ],
    )
    const replayed = replay({
      state: emptyHydra(),
      events: s.events(),
    })
    assert.deepEqual(
      replayed.cards[restored.id]!.steering,
      restored.steering,
    )
    assert.equal(
      replayed.cards[restored.id]!.steering![0]!.source,
      'owner',
    )
    const unread = await worker.run({
      args: [
        'task',
        'inbox',
        'read',
        'work',
      ],
    })
    assert.doesNotMatch(
      unread,
      /reply-1/,
    )
    assert.match(
      await worker.run({
        args: [
          'task',
          'inbox',
          'read',
          'work',
          '--all',
        ],
      }),
      /reply-1/,
    )
  },
)

test(
  'an external source the worker registers runs its exact argv once, and its result, sent right before it exits, reaches the worker until handled',
  async t => {
    const s = await pnyx.scenario()
    const folder = s.folder({ name: 'watcher' })
    await s.owner({
      args: [
        'task',
        'create',
        '--key',
        'work',
        '--title',
        'Watch a job',
        '--folder',
        folder,
      ],
    })
    await s.owner({
      args: [
        'task',
        'start',
        'work',
      ],
    })
    const worker = s.as({ agent: await s.agent({ cwd: folder }) })
    await until({
      what: 'the opening turn to finish',
      check: () => s.task({ key: 'work' }).sessionActivity === 'finished',
    })
    const job = s.folder({ name: 'job' })
    const script = join(
      job,
      'source.mjs',
    )
    copyFileSync(
      join(
        import.meta.dirname,
        '../fixtures/external-sources/source.mjs',
      ),
      script,
    )
    // No shell reads the argv: the substitutions stay text.
    const payload = 'Olá 🌊\n第二行; $(touch should-not-exist) `echo shell`\n'
    const register = [
      'task',
      'source',
      'register',
      'work',
      'job',
      '--executable',
      process.execPath,
      '--argv',
      JSON.stringify([
        script,
        job,
        payload,
      ]),
      '--cwd',
      job,
    ]
    // 9b4a6afe: a busy server can reap the supervisor before reading its channel, so its last
    // message and the channel's end arrive after the exit; the result must still be captured.
    const fork = childProcess.fork
    let reaped = 0
    t.mock.method(
      childProcess,
      'fork',
      // eslint-disable-next-line pnyx/object-params -- Node owns fork's signature.
      (...args: Parameters<typeof fork>) => {
        const supervisor = fork(...args)
        const emit = supervisor.emit.bind(supervisor)
        const held: [string, unknown[]][] = []
        let exited = false

        // eslint-disable-next-line pnyx/object-params -- EventEmitter owns emit's signature.
        supervisor.emit = (
          event: string,
          ...rest: unknown[]
        ) => {
          if ((event === 'message' || event === 'disconnect') && !exited) {
            held.push([
              event,
              rest,
            ])

            return true
          }

          if (event !== 'exit') {
            return emit(
              event,
              ...rest,
            )
          }

          exited = true
          reaped += 1
          const result = emit(
            event,
            ...rest,
          )

          for (const [
            name,
            heldArgs,
          ] of held.splice(0)) {
            emit(
              name,
              ...heldArgs,
            )
          }

          return result
        }

        return supervisor
      },
    )
    syncBuiltinESMExports()
    t.after(() => {
      t.mock.restoreAll()
      syncBuiltinESMExports()
    })
    await worker.run({ args: register })
    await worker.run({ args: register })
    const source = () => s.task({ key: 'work' }).externalSources!.find(item => item.id === 'job')!
    const result = await until({
      what: 'the result captured and queued for the worker',
      check: () => {
        const captured = source().results[0]

        return captured && s.task({ key: 'work' }).steering?.some(message => message.id === captured.message) && captured
      },
    })
    assert.deepEqual(
      [
        reaped,
        result.outcome,
        result.stdout,
        result.stderr,
        existsSync(join(
          job,
          'should-not-exist',
        )),
        readFileSync(
          join(
            job,
            'launches',
          ),
          'utf8',
        ).trim()
          .split('\n').length,
      ],
      [
        1,
        'completed',
        payload,
        'fixture diagnostic',
        false,
        1,
      ],
    )
    await until({
      what: 'the worker told of the result',
      check: () => s.received({ cwd: folder }).some(text => text.includes(result.message)),
    })
    const claim = claimFlags({ card: s.task({ key: 'work' }) })
    const handled = [
      'task',
      'source',
      'handled',
      'work',
      'job',
      '1',
      ...claim,
    ]
    // Handled needs the result read and its instruction acknowledged first.
    assert.equal(
      await worker.refused({ args: handled }),
      'VALIDATION_ERROR',
    )
    await worker.run({
      args: [
        'task',
        'source',
        'read',
        'work',
        'job',
      ],
    })
    await worker.run({
      args: [
        'task',
        'inbox',
        'ack',
        'work',
        result.message,
        ...claim,
      ],
    })
    await worker.run({ args: handled })
    await worker.run({ args: handled })
    assert.deepEqual(
      [
        source().state,
        s.events().filter(event => event.type === 'task.source.handled').length,
      ],
      [
        'retired',
        1,
      ],
    )
  },
)
