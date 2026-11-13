import assert from 'node:assert/strict'
import fs from 'node:fs'
import { ServerResponse } from 'node:http'
import { join } from 'node:path'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { HYDRA_CARD } from '#hydra/identity.ts'
import { withWriter } from '#app/writer.ts'
import { declareTask } from '#tasks/declarations.ts'
import { hydraDir } from '#app/home-migration.ts'
import { spoolWrite } from '#app/spool.ts'
import { QUIET_MS, logLines, openPage, until } from '#test-harness/harness.ts'
import { pnyx } from '#test-harness/pnyx.ts'
import { MAX_RESUMES, WORKER_RESUME } from '#workers/host.ts'

test(
  'an owner message while Hydra is down tries the start again; once it works Hydra answers it, then recaps only what no turn took',
  async () => {
    const s = await pnyx.scenario()
    let page = await openPage({
      port: pnyx.port(),
      hydraId: s.hydraId,
    })
    await page.command({
      name: 'hydra-agent',
      args: [JSON.stringify({ harness: 'codex' })],
    })
    const say = ({ text }: { text: string }) => page.command({
      name: 'hydra',
      args: [
        'send',
        `--text=${text}`,
      ],
    })
    const finished = () => s.state().cards[HYDRA_CARD]?.sessionActivity === 'finished'
    const unanswered = `Inspect the synthetic export. ${'Keep the current worker paused. '.repeat(12)}\nOnly report the findings; do not resume it.`
    await say({ text: 'Hello' })
    await until({
      what: 'Hydra to answer its first message',
      check: finished,
    })
    page.close()
    await pnyx.restart()
    page = await openPage({
      port: pnyx.port(),
      hydraId: s.hydraId,
    })
    pnyx.codex.control.refuse = 'thread/resume'

    try {
      await say({ text: unanswered })
      await until({
        what: 'Hydra down',
        check: () => s.state().hydraStatus?.state === 'down',
      })
    } finally {
      // The server is shared, so a failure here must not leave later flows refused.
      pnyx.codex.control.refuse = undefined
    }

    await s.owner({
      args: [
        'task',
        'create',
        '--title',
        'Export notes',
        '--key',
        'export',
      ],
    })
    await s.owner({
      args: [
        'reply',
        'export',
        '--text',
        'Note the export while Hydra is down',
        '--idempotency-key',
        'export-note',
        '--task-message',
      ],
    })
    const exportTask = s.task({ key: 'export' }).id
    // The task's own thread, open on the page, follows its Hydra part.
    await page.command({
      name: 'thread',
      args: [exportTask],
    })
    await say({ text: 'back yet?' })
    // The resumed session only exists once a start works.
    await until({
      what: 'Hydra up',
      check: () => s.state().hydraStatus?.state === 'up',
    })
    const hydra = await s.agent({ hydra: true })
    const recap = await until({
      what: 'the recap after the owner’s turn',
      check: () => hydra.received.find(text => text.includes('back after outage')),
    })
    assert.ok(hydra.received[0]!.includes('back yet?'))
    assert.ok(recap.includes(unanswered))
    assert.equal(
      recap.includes('back yet?'),
      false,
    )
    await until({
      what: 'Hydra to finish the recap',
      check: finished,
    })
    assert.equal(
      hydra.received.filter(text => text.includes('back after outage')).length,
      1,
    )
    // The recap lists the owner's words no turn took, so taking the recap receives them, the task message among them.
    assert.ok(recap.includes('Note the export while Hydra is down'))
    const receivedAt = ({ id }: { id: string }) =>
      s.state().hydraMessages?.find(message => message.id === id)?.received
    const backYet = s.state().hydraMessages?.find(message => message.text === 'back yet?')
    const missed = s.state().hydraMessages?.find(message => message.text === unanswered)
    assert.ok(backYet?.received && missed)
    const recapTaken = receivedAt({ id: missed.id })
    assert.ok(recapTaken && recapTaken >= backYet.received)
    assert.equal(
      receivedAt({ id: `task-context:${exportTask}:export-note` }),
      recapTaken,
    )
    await until({
      what: 'the task thread to show Hydra received the task message',
      check: () => page.threads.findLast(thread => thread.card === exportTask)?.entries
        .find(entry => entry.replyId === 'export-note')?.delivery?.hydra?.received === recapTaken,
    })
    page.close()
  },
)

test(
  'a failed background snapshot is logged without killing the daemon or losing a completed helper batch',
  async t => {
    const s = await pnyx.scenario()
    await s.owner({
      args: [
        'task',
        'create',
        '--key',
        'work',
        '--title',
        'Work',
      ],
    })
    await s.chat({ text: 'Keep routine work quiet.' })
    await until({
      what: 'main to finish',
      check: () => s.state().cards[HYDRA_CARD]?.sessionActivity === 'finished',
    })
    await s.owner({
      args: [
        'hydra',
        'set',
        '--helper',
        'claude',
        '--helper-model',
        'sonnet',
      ],
    })
    const task = s.task({ key: 'work' })
    pnyx.claude.plan({
      text: '',
      reply: JSON.stringify({
        outcomes: [
          {
            task: task.id,
            audience: 'routine',
            summary: 'Progress checked.',
          },
        ],
      }),
    })
    withWriter({
      hydraId: s.hydraId,
      fn: ({ writer }) => {
        const decision = declareTask({
          state: writer.state,
          ref: task.id,
          status: 'blocked',
          note: 'Blocked behind a busy writer.',
          meta: {
            at: new Date().toISOString(),
            actor: 'cli',
          },
        })
        assert.ok('event' in decision)
        writer.append({ event: decision.event })
      },
    })
    await until({
      what: 'the helper outcome to persist',
      check: () => s.state().helper?.outcomes.some(outcome => outcome.task === task.id && outcome.summary === 'Progress checked.'),
    })
    await until({
      what: 'the helper lease to release',
      check: () => !fs.existsSync(`${process.env.PNYX_HOME}/hydras/${s.hydraId}/helper-lease-${encodeURIComponent(task.id)}.json`),
    })
    await pnyx.restart()
    const cache = join(
      hydraDir({ hydraId: s.hydraId }),
      'snapshot.json',
    )
    assert.ok(fs.existsSync(cache))
    fs.rmSync(cache)
    fs.mkdirSync(cache)
    t.after(() => fs.rmSync(
      cache,
      {
        recursive: true,
        force: true,
      },
    ))
    t.mock.timers.enable({ apis: ['setTimeout'] })
    withWriter({
      hydraId: s.hydraId,
      fn: ({ writer }) => writer.append({
        event: {
          v: 1,
          seq: writer.state.seq + 1,
          id: 'snapshot-checkpoint',
          cardId: task.id,
          at: new Date().toISOString(),
          actor: 'cli',
          type: 'card.noted',
          data: {
            text: 'Snapshot checkpoint.',
            kind: 'context',
            source: 'test',
          },
        },
      }),
    })
    t.mock.timers.tick(60_000)
    t.mock.timers.reset()
    await until({
      what: 'the background snapshot failure to be logged',
      check: () => logLines().some(record => record.operation === 'snapshot' && record.hydraId === s.hydraId),
    })
    fs.rmSync(
      cache,
      { recursive: true },
    )
    assert.equal(
      s.events().filter(event => event.type === 'hydra.helper-started').length,
      1,
    )
    const grants = s.events().filter(event => event.type === 'hydra.helper-started')
    const finishes = s.events().filter(event => event.type === 'hydra.helper-finished')
    assert.equal(
      finishes.length,
      1,
    )
    assert.equal(
      finishes[0]!.data.batch,
      grants[0]!.data.id,
    )
    const declared = s.events().find(event => event.type === 'task.declared' && event.data.note === 'Blocked behind a busy writer.')!
    assert.ok(grants[0]!.data.seqs.includes(declared.seq))
    const snapshotFailure = logLines()
      .find(record => record.level === 'error' && record.operation === 'snapshot' && record.hydraId === s.hydraId)
    assert.ok(
      snapshotFailure,
      'the snapshot failure must identify its Hydra in a log line',
    )
    assert.equal(
      snapshotFailure.error?.code,
      'EISDIR',
    )
    assert.equal(
      Number.isNaN(Date.parse(snapshotFailure.at)),
      false,
    )
    assert.equal(
      typeof snapshotFailure.operationId,
      'string',
    )
    assert.ok(Number(snapshotFailure.eventSeq) >= grants[0]!.seq)
    assert.equal(
      (await fetch(`http://127.0.0.1:${pnyx.port()}/health`)).status,
      200,
    )
  },
)

test(
  'a handler error after headers closes only its response and keeps running workers',
  async t => {
    const s = await pnyx.scenario()
    const folder = s.folder({ name: 'running' })
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
    const held = pnyx.codex.plan({
      text: '; silence changes nothing.',
      hold: true,
    })

    try {
      await s.owner({
        args: [
          'task',
          'start',
          'work',
          '--harness',
          'codex',
        ],
      })
      const agent = await s.agent({ cwd: folder })
      await until({
        what: 'worker opening turn',
        check: () => agent.received.length === 1,
      })
      const original = ServerResponse.prototype.writeHead
      const path = `/hydra/${s.hydraId}/health`
      let injected = false
      t.mock.method(
        ServerResponse.prototype,
        'writeHead',
        // eslint-disable-next-line pnyx/object-params -- Node owns ServerResponse.writeHead's signature.
        function (
          this: ServerResponse,
          ...args: Parameters<typeof original>
        ) {
          const result = original.apply(
            this,
            args,
          )

          if (this.req.url === path && !injected) {
            injected = true
            this.flushHeaders()
            throw new Error('failed after headers')
          }

          return result
        },
      )
      await assert.rejects(async () => {
        const response = await fetch(`http://127.0.0.1:${pnyx.port()}${path}`)
        await response.text()
      })
      assert.ok(logLines().some(record => record.operation === 'http.request' && record.error?.message === 'failed after headers'))
      assert.equal(
        (await fetch(`http://127.0.0.1:${pnyx.port()}/health`)).status,
        200,
      )
      assert.equal(
        s.task({ key: 'work' }).sessionActivity,
        'working',
      )
      assert.equal(
        s.received({ cwd: folder }).length,
        1,
      )
    } finally {
      held.release()
    }
  },
)

test(
  'a quiet hooked worker repeating itself logs each observation compactly, so it never looks stalled, and a late older event stays stale after a restart',
  async () => {
    const s = await pnyx.scenario()
    const session = crypto.randomUUID()
    const start = Date.now() - 330_000
    const hook = ({
      second,
      event,
    }: {
      second: number
      event: string
    }) => spoolWrite({
      hydraId: s.hydraId,
      entry: {
        v: 1,
        id: `hook-quiet-${event}-${second}`,
        at: new Date(start + second * 1000).toISOString(),
        harness: 'claude',
        event,
        payload: {
          session_id: session,
          transcript_path: `/work/home/.claude/projects/-work-repo/${session}.jsonl`,
          cwd: '/work/repo',
          permission_mode: 'default',
          hook_event_name: event,
          tool_name: 'Bash',
          tool_input: { command: 'sleep 600' },
          tool_use_id: 'toolu_quiet',
        },
      },
    })
    const logged = () => s.events()
      .filter(event => (event.type === 'card.pushed' || event.type === 'card.observed')
        && event.data.source?.objectId === session)
      .map(event => ({
        type: event.type,
        second: (Date.parse(event.at) - start) / 1000,
      }))
    const lastSeen = () => Object.values(s.state().sessions ?? {})
      .find(agent => agent.agent.sessionId === session)?.lastSeen

    for (let second = 0; second <= 300; second += 20) {
      hook({
        second,
        event: 'PreToolUse',
      })
    }

    await until({
      what: 'every repeat to be logged',
      check: () => logged().length === 16,
    })
    assert.deepEqual(
      logged(),
      [
        {
          type: 'card.pushed',
          second: 0,
        },
        ...Array.from(
          { length: 15 },
          (
            _,
            index,
          ) => ({
            type: 'card.observed',
            second: (index + 1) * 20,
          }),
        ),
      ],
      'the first report is logged in full and each repeat as its observation time',
    )
    assert.equal(
      lastSeen(),
      new Date(start + 300_000).toISOString(),
      'the worker\'s last sign of life is its newest observation',
    )

    await pnyx.restart()
    hook({
      second: 290,
      event: 'Stop',
    })
    hook({
      second: 320,
      event: 'Stop',
    })
    await until({
      what: 'the worker\'s Stop to be logged',
      check: () => logged().at(-1)?.second === 320,
    })
    assert.deepEqual(
      logged().slice(16),
      [
        {
          type: 'card.pushed',
          second: 320,
        },
      ],
      'the Stop stamped before the newest repeat is stale across the restart',
    )
  },
)

test(
  'a worker turn a restart cuts resumes from its saved session, up to three restarts in a row, and never gets the owner\'s message twice',
  async () => {
    const s = await pnyx.scenario()
    const folder = s.folder({ name: 'long' })
    await s.owner({
      args: [
        'task',
        'create',
        '--title',
        'Long work',
        '--key',
        'long',
        '--folder',
        folder,
      ],
    })
    const holds = [
      pnyx.claude.plan({
        text: 'Run the long job',
        hold: true,
      }),
      ...Array.from(
        { length: MAX_RESUMES },
        () => pnyx.claude.plan({
          text: WORKER_RESUME,
          hold: true,
        }),
      ),
    ]

    try {
      await s.owner({
        args: [
          'task',
          'start',
          'long',
          '--harness',
          'claude',
          '--prompt',
          'Run the long job',
        ],
      })
      const first = await s.agent({ cwd: folder })
      const resumes = () => s.received({ cwd: folder })
        .filter(text => text.endsWith(WORKER_RESUME)).length

      for (let restart = 1; restart <= MAX_RESUMES + 1; restart++) {
        await until({
          what: 'the worker to be mid-turn',
          check: () => s.task({ key: 'long' }).sessionActivity === 'working',
        })
        await pnyx.restart()

        if (restart <= MAX_RESUMES) {
          await until({
            what: `resume ${restart} to reach the worker`,
            check: () => resumes() === restart,
          })
        }
      }

      await until({
        what: 'the fourth cut turn to stay interrupted',
        check: () => s.task({ key: 'long' }).sessionActivity === 'interrupted',
      })
      const resumed = await s.agent({ cwd: folder })
      assert.deepEqual(
        [
          resumed.id,
          resumed.resumed,
          resumes(),
          s.received({ cwd: folder }).filter(text => text.endsWith('Run the long job')).length,
        ],
        [
          first.id,
          true,
          MAX_RESUMES,
          1,
        ],
      )
    } finally {
      for (const held of holds) {
        held.release()
      }
    }
  },
)

// Long past the wake delay the flows run with, so a wake about the worker would have come.
const SETTLE_MS = 500

// Hydra's received messages, in every session it has had.
const hydraHeard = ({ s }: { s: Awaited<ReturnType<typeof pnyx.scenario>> }) => s.received({
  cwd: join(
    hydraDir({ hydraId: s.hydraId }),
    'agent',
  ),
}).length

// Waits until Hydra has handled the changes so far and nothing more reaches it for a settle period.
async function hydraSettled({ s }: { s: Awaited<ReturnType<typeof pnyx.scenario>> }) {
  const deadline = Date.now() + QUIET_MS * 4
  let heard = -1

  while (heard !== hydraHeard({ s })) {
    assert.ok(
      Date.now() < deadline,
      'Hydra kept hearing new messages',
    )
    heard = hydraHeard({ s })
    await delay(SETTLE_MS)
  }
}

const startLongTurn = async ({
  s,
  key,
  folder,
}: {
  s: Awaited<ReturnType<typeof pnyx.scenario>>
  key: string
  folder: string
}) => {
  // Hydra has a session, so a wake about the worker would reach it.
  await s.chat({ text: 'Warm up' })
  await s.owner({
    args: [
      'task',
      'create',
      '--title',
      `Slow ${key}`,
      '--key',
      key,
      '--folder',
      folder,
    ],
  })
  await s.owner({
    args: [
      'task',
      'start',
      key,
      '--harness',
      'claude',
      '--prompt',
      `Run the ${key} job`,
    ],
  })
  await until({
    what: 'the worker to be mid-turn',
    check: () => s.task({ key }).sessionActivity === 'working',
  })
  await hydraSettled({ s })
}

test(
  'a worker whose reopen is slow after a restart gets its resume and then an owner reply once each, Hydra hears nothing, and the server answers meanwhile',
  async () => {
    const s = await pnyx.scenario()
    const folder = s.folder({ name: 'slow' })
    const job = pnyx.claude.plan({
      text: 'Run the slow job',
      hold: true,
    })

    try {
      await startLongTurn({
        s,
        key: 'slow',
        folder,
      })
      const heard = hydraHeard({ s })
      const opening = pnyx.claude.holdOpen({ cwd: folder })

      try {
        await pnyx.restart()
        const health = await fetch(`http://127.0.0.1:${pnyx.port()}/hydra/${s.hydraId}/health`)
        assert.equal(
          health.status,
          200,
        )
        const removed = await fetch(
          `http://127.0.0.1:${pnyx.port()}/hydra/${s.hydraId}/reminders`,
          { redirect: 'manual' },
        )
        assert.equal(
          removed.status,
          302,
        )
        assert.equal(
          removed.headers.get('location'),
          `/hydra/${s.hydraId}/`,
        )
        const page = await openPage({
          port: pnyx.port(),
          hydraId: s.hydraId,
        })
        page.close()
        const other = await pnyx.scenario()
        await other.owner({
          args: [
            'task',
            'list',
          ],
        })
        await s.owner({
          args: [
            'reply',
            s.task({ key: 'slow' }).id,
            '--text',
            'Owner words during the reopen',
          ],
        })
        await delay(SETTLE_MS)
        assert.equal(
          hydraHeard({ s }),
          heard,
          'Hydra is not told about a worker Pnyx is resuming',
        )
        assert.equal(
          s.task({ key: 'slow' }).attention.some(item => item.kind === 'interrupted'),
          false,
        )
      } finally {
        opening.release()
      }

      const received = () => s.received({ cwd: folder })
      await until({
        what: 'the resume and the reply to reach the worker',
        check: () => received().some(text => text.includes('Owner words during the reopen')),
      })
      const resume = received().findIndex(text => text.endsWith(WORKER_RESUME))
      const reply = received().findIndex(text => text.includes('Owner words during the reopen'))
      assert.deepEqual(
        [
          received().filter(text => text.endsWith(WORKER_RESUME)).length,
          received().filter(text => text.includes('Owner words during the reopen')).length,
          resume >= 0 && resume < reply,
          pnyx.claude.sessions.filter(session => session.cwd === folder).length,
        ],
        [
          1,
          1,
          true,
          2,
        ],
        'one reopened session gets the resume, then the reply',
      )
    } finally {
      job.release()
    }
  },
)

test(
  'a worker whose reopen fails after a restart shows the interrupted question and wakes Hydra once',
  async () => {
    const s = await pnyx.scenario()
    const folder = s.folder({ name: 'broken' })
    const job = pnyx.claude.plan({
      text: 'Run the broken job',
      hold: true,
    })

    try {
      await startLongTurn({
        s,
        key: 'broken',
        folder,
      })
      const heard = hydraHeard({ s })
      pnyx.claude.failOpen({
        cwd: folder,
        message: 'Claude Code could not start',
      })
      await pnyx.restart()
      await until({
        what: 'the card to ask about the interrupted turn',
        check: () => s.task({ key: 'broken' }).attention.some(item => item.kind === 'interrupted'),
      })
      await until({
        what: 'Hydra to be woken',
        check: () => hydraHeard({ s }) > heard,
      })
      await hydraSettled({ s })
      assert.equal(
        hydraHeard({ s }),
        heard + 1,
      )
    } finally {
      job.release()
    }
  },
)

// A worker started with one finished turn, its folder, and its latest reply's receipt.
// A slash command goes to the agent directly, not through its inbox.
const idleWorker = async ({
  s,
  key,
  harness,
}: {
  s: Awaited<ReturnType<typeof pnyx.scenario>>
  key: string
  harness: 'claude' | 'codex'
}) => {
  const folder = s.folder({ name: key })
  await s.owner({
    args: [
      'task',
      'create',
      '--title',
      `Direct ${key}`,
      '--key',
      key,
      '--folder',
      folder,
    ],
  })
  await s.owner({
    args: [
      'task',
      'start',
      key,
      '--harness',
      harness,
      '--prompt',
      `First part of ${key}`,
    ],
  })
  await until({
    what: 'the first turn to finish',
    check: () => s.task({ key }).sessionActivity === 'finished',
  })

  return {
    folder,
    reply: () => s.task({ key }).replies?.at(-1),
    send: ({ text }: { text: string }) => s.owner({
      args: [
        'reply',
        s.task({ key }).id,
        '--text',
        text,
      ],
    }),
  }
}

test(
  'a direct message is delivered only once the agent confirms it, after a slow reopen',
  async () => {
    const s = await pnyx.scenario()
    const worker = await idleWorker({
      s,
      key: 'confirmed',
      harness: 'claude',
    })
    // After a restart the idle worker stays closed, so the next message reopens it.
    await pnyx.restart()
    const opening = pnyx.claude.holdOpen({ cwd: worker.folder })

    try {
      await worker.send({ text: '/review for a reopening agent' })
      assert.equal(
        worker.reply()?.state,
        'queued',
      )
    } finally {
      opening.release()
    }

    await until({
      what: 'the reply to be delivered once the agent takes it',
      check: () => worker.reply()?.state === 'delivered',
    })
    assert.equal(
      s.received({ cwd: worker.folder }).filter(text => text.includes('/review for a reopening agent')).length,
      1,
    )
  },
)

test(
  'a direct message a restart cut before the agent confirmed it may not have arrived and is never sent again',
  async () => {
    const s = await pnyx.scenario()
    const worker = await idleWorker({
      s,
      key: 'cut-direct',
      harness: 'claude',
    })
    await pnyx.restart()
    const opening = pnyx.claude.holdOpen({ cwd: worker.folder })

    try {
      await worker.send({ text: '/review the restart cuts' })
      assert.equal(
        worker.reply()?.state,
        'queued',
      )
      await pnyx.restart()
      await until({
        what: 'the cut reply to be marked as possibly not arrived',
        check: () => worker.reply()?.state === 'delivery_unknown',
      })
    } finally {
      opening.release()
    }

    await delay(SETTLE_MS)
    assert.ok(
      s.received({ cwd: worker.folder }).filter(text => text.includes('/review the restart cuts')).length <= 1,
      'Pnyx never sends the cut message again by itself',
    )
  },
)

test(
  'a direct message the agent refuses is failed, and stays failed across a restart',
  async () => {
    const s = await pnyx.scenario()
    const worker = await idleWorker({
      s,
      key: 'refused',
      harness: 'codex',
    })
    pnyx.codex.control.refuse = 'turn/start'

    try {
      await worker.send({ text: '/review Codex refuses' })
      await until({
        what: 'the refused reply to fail',
        check: () => worker.reply()?.state === 'failed',
      })
    } finally {
      pnyx.codex.control.refuse = undefined
    }

    await pnyx.restart()
    assert.equal(
      worker.reply()?.state,
      'failed',
    )
    assert.equal(
      s.received({ cwd: worker.folder }).filter(text => text.includes('/review Codex refuses')).length,
      0,
    )
  },
)

test(
  'a snapshot save that fails at shutdown still lets the server stop and start again with every change',
  async () => {
    const s = await pnyx.scenario()
    await s.owner({
      args: [
        'task',
        'create',
        '--title',
        'Kept through a failed snapshot',
        '--key',
        'kept-snapshot',
      ],
    })
    const cache = join(
      hydraDir({ hydraId: s.hydraId }),
      'snapshot.json',
    )
    fs.rmSync(
      cache,
      { force: true },
    )
    fs.mkdirSync(cache)

    try {
      await pnyx.restart()
    } finally {
      fs.rmSync(
        cache,
        {
          recursive: true,
          force: true,
        },
      )
    }

    const failures = logLines().filter(record => record.level === 'error' && record.hydraId === s.hydraId)
    assert.ok(failures.some(record => record.operation === 'snapshot' && record.error?.code === 'EISDIR'))
    // The rest of the Hydra's shutdown (its hold, hook socket and timers) ran after the failed save.
    assert.equal(
      logLines().some(record => record.operation === 'hydra.close' && record.hydraId === s.hydraId),
      false,
    )
    assert.equal(
      s.task({ key: 'kept-snapshot' }).title,
      'Kept through a failed snapshot',
    )
    assert.match(
      await s.owner({
        args: [
          'task',
          'show',
          'kept-snapshot',
        ],
      }),
      /Kept through a failed snapshot/,
    )
  },
)
