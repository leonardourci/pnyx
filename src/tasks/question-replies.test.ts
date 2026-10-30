import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { commands, task as taskHandler } from '#app/cli.ts'
import { loadHydra } from '#app/store.ts'
import { readEvents } from '#app/event-log.ts'
import { emptyHydra, replay } from '#app/reducer.ts'
import { withWriter } from '#app/writer.ts'
import { hydraConfig } from '#hydra/config.ts'
import { reply } from '#workers/reply.ts'
import { base } from '#app/command-meta.ts'
import type { HydraEvent } from '#app/model.ts'
import { acquireLock } from '#store/storage.ts'
import { decidePush } from './push.ts'
import { findCard } from './push-rules.ts'
import { answerDelivery, cardQuestion, mergeApproval, openAsks, ownerQuestions } from './questions.ts'
import { ownerGates } from './owner-gates.ts'
import { relevantUpdate } from './updates.ts'

const hydraId = 'question-lab'
const reason = 'Synthetic question regression'

type Change = {
  [Kind in HydraEvent['type']]: Pick<Extract<HydraEvent, { type: Kind }>, 'type' | 'data'>
}[HydraEvent['type']]

type Mode = 'delivered' | 'failed' | 'queued' | 'unknown' | 'record-error' | 'failed-record-error'

async function lab({ t }: { t: TestContext }) {
  const root = mkdtempSync(join(
    tmpdir(),
    'pnyx-question-replies-',
  ))
  const saved = {
    PNYX_HOME: process.env.PNYX_HOME,
    PNYX_ACTOR: process.env.PNYX_ACTOR,
    PNYX_TASK: process.env.PNYX_TASK,
    PNYX_HYDRA: process.env.PNYX_HYDRA,
    PNYX_STEERING_WORKER: process.env.PNYX_STEERING_WORKER,
    PNYX_SEMANTIC: process.env.PNYX_SEMANTIC,
  }
  process.env.PNYX_HOME = root
  process.env.PNYX_SEMANTIC = 'off'
  delete process.env.PNYX_ACTOR
  delete process.env.PNYX_TASK
  delete process.env.PNYX_HYDRA
  delete process.env.PNYX_STEERING_WORKER
  let releaseLock: (() => void) | undefined
  let mode: Mode = 'delivered'
  const received: {
    card: string
    text: string
  }[] = []
  const state = () => loadHydra({ hydraId }).state
  const card = ({ ref }: { ref: string }) => findCard({
    state: state(),
    ref,
  })
  const task = async ({
    args,
    actor = 'hydra',
  }: {
    args: string[]
    actor?: string
  }) => commands.task([
    ...args,
    '--hydra',
    hydraId,
    '--actor',
    actor,
    '--reason',
    reason,
  ])
  const event = ({
    ref,
    change,
    actor = 'pnyx',
    at = new Date().toISOString(),
  }: {
    ref: string
    change: Change
    actor?: string
    at?: string
  }) => withWriter({
    hydraId,
    fn: ({ writer }) => {
      const event = {
        ...base({
          state: writer.state,
          cardId: card({ ref }).id,
          meta: {
            at,
            actor,
          },
        }),
        ...change,
      }
      writer.append({ event })

      return event.id
    },
  })
  const chat = ({
    ref,
    text = 'Use the existing cache.',
    actor = 'web',
    at = new Date(Date.now() + 1000).toISOString(),
  }: {
    ref: string
    text?: string
    actor?: string
    at?: string
  }) => event({
    ref,
    actor,
    at,
    change: {
      type: 'hydra.message',
      data: {
        hydra: hydraId,
        action: 'send',
        text,
      },
    },
  })
  const attach = ({ ref }: { ref: string }) => withWriter({
    hydraId,
    fn: ({ writer }) => {
      const current = card({ ref })
      const decided = decidePush({
        state: writer.state,
        key: current.key,
        input: {
          agent: {
            provider: 'codex',
            sessionId: `synthetic-${current.id}`,
            host: 'pnyx',
          },
        },
        meta: {
          at: new Date().toISOString(),
          actor: 'pnyx',
        },
      })
      assert.ok('event' in decided)
      writer.append({ event: decided.event })
    },
  })

  const create = async ({
    key,
    hold = false,
    worker = true,
  }: {
    key: string
    hold?: boolean
    worker?: boolean
  }) => {
    const args = [
      'create',
      '--title',
      `Synthetic ${key}`,
      '--key',
      key,
    ]

    if (hold) {
      args.push('--hold')
    }

    await task({ args })
    const id = card({ ref: key }).id

    if (worker) {
      attach({ ref: id })
    }

    return id
  }

  const ask = async ({
    ref,
    go = false,
    worker = false,
    origin,
  }: {
    ref: string
    go?: boolean
    worker?: boolean
    origin?: string
  }) => {
    const args = [
      'ask',
      ref,
      '--question',
      'Proceed with this task?',
    ]

    if (!worker) {
      args.push(
        '--to',
        'owner',
      )
    }

    if (go) {
      args.push(
        '--kind',
        'go',
      )
    }

    if (origin) {
      args.push(
        '--from-report',
        origin,
      )
    }

    const result = await task({
      args,
      actor: worker ? `worker:${ref}` : 'hydra',
    })
    assert.equal(
      typeof result.ask,
      'string',
    )
    const id = String(result.ask)

    if (worker) {
      await task({
        args: [
          'escalate',
          ref,
          id,
        ],
      })
    }

    return id
  }

  const relay = async ({
    ref,
    question,
    message,
    choice,
    key,
    text = 'The owner chose the existing cache.',
  }: {
    ref: string
    question?: string
    message?: string
    choice?: string
    key?: string
    text?: string
  }) => {
    const args = [
      ref,
      '--text',
      text,
      '--actor',
      'hydra',
      '--hydra',
      hydraId,
    ]

    if (question) {
      args.push(
        '--question',
        question,
      )
    }

    if (message) {
      args.push(
        '--from-message',
        message,
      )
    }

    if (choice) {
      args.push(
        '--choice',
        choice,
      )
    }

    if (key) {
      args.push(
        '--idempotency-key',
        key,
      )
    }

    const output = await reply(args)
    assert.ok(output.reply && typeof output.reply === 'object' && 'state' in output.reply)

    return {
      reply: output.reply,
      help: output.help,
    }
  }

  const server = createServer(async (
    request,
    response,
  ) => {
    response.setHeader(
      'content-type',
      'application/json',
    )

    if (request.url?.endsWith('/health')) {
      response.end(JSON.stringify({
        hydraId,
        pid: process.pid,
      }))

      return
    }

    let raw = ''

    for await (const chunk of request) {
      raw += chunk
    }

    const body = JSON.parse(raw)

    if (body.action !== 'send') {
      response.end(JSON.stringify({ state: 'queued' }))

      return
    }

    received.push(body)

    if (mode === 'failed' || mode === 'failed-record-error') {
      if (mode === 'failed-record-error') {
        releaseLock = acquireLock({
          dir: join(
            root,
            'hydras',
            hydraId,
          ),
        })
      }

      response.statusCode = 409
      response.end(JSON.stringify({
        error: 'Synthetic worker unavailable',
        code: 'NOT_RUNNING',
      }))

      return
    }

    if (mode === 'unknown') {
      response.end('{')

      return
    }

    if (mode === 'queued') {
      response.end(JSON.stringify({ queued: true }))

      return
    }

    if (mode === 'record-error') {
      releaseLock = acquireLock({
        dir: join(
          root,
          'hydras',
          hydraId,
        ),
      })
    }

    const current = card({ ref: body.card })
    response.end(JSON.stringify(current.hold ? { deferred: true } : { accepted: true }))
  })
  t.after(async () => {
    releaseLock?.()
    await new Promise<void>(resolve => server.close(() => resolve()))

    for (const [
      name,
      value,
    ] of Object.entries(saved)) {
      if (value === undefined) {
        delete process.env[name]
      } else {
        process.env[name] = value
      }
    }

    rmSync(
      root,
      {
        recursive: true,
        force: true,
      },
    )
  })
  await commands.hydra([
    'create',
    hydraId,
  ])
  await new Promise<void>(resolve => server.listen(
    0,
    '127.0.0.1',
    resolve,
  ))
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  writeFileSync(
    join(
      root,
      'hydras',
      hydraId,
      'server.json',
    ),
    JSON.stringify({
      pid: process.pid,
      port: address.port,
      url: `http://127.0.0.1:${address.port}/hydra/${hydraId}/`,
      socket: null,
    }),
  )

  return {
    root,
    state,
    card,
    task,
    event,
    chat,
    attach,
    create,
    ask,
    relay,
    received,
    mode: ({ value }: { value: Mode }) => {
      mode = value
    },
    unlock: () => {
      releaseLock?.(); releaseLock = undefined
    },
  }
}

test(
  'owner chat and ordinary feedback do not answer questions; an explicit Go relay saves the answer before delivery',
  async t => {
    const l = await lab({ t })
    const ref = await l.create({
      key: 'go',
      hold: true,
    })
    const question = await l.ask({
      ref,
      go: true,
    })
    const other = await l.ask({ ref })
    const message = l.chat({
      ref,
      text: 'Proceed with the investigation; report inline.',
    })
    assert.equal(
      ownerQuestions({ card: l.card({ ref }) }).length,
      2,
    )
    const before = l.state().seq
    await assert.rejects(
      l.relay({
        ref,
        question,
        message,
      }),
      /go question with --choice Go or Hold/,
    )
    assert.equal(
      l.state().seq,
      before,
    )
    const ordinary = await l.relay({ ref })
    assert.equal(
      ordinary.reply.state,
      'delivery_unknown',
    )
    assert.equal(
      l.card({ ref }).asks?.[0]?.answered,
      undefined,
    )
    const linked = await l.relay({
      ref,
      question,
      message,
      choice: 'Go',
      key: 'go-relay',
    })
    assert.equal(
      linked.reply.state,
      'delivered',
    )
    assert.equal(
      l.card({ ref }).hold,
      undefined,
    )
    assert.equal(
      l.card({ ref }).asks?.[0]?.answered,
      'go-relay',
    )
    assert.equal(
      l.card({ ref }).asks?.[0]?.choice,
      'Go',
    )
    assert.equal(
      l.card({ ref }).asks?.[0]?.fromMessage?.id,
      message,
    )
    assert.equal(
      l.card({ ref }).asks?.[1]?.id,
      other,
    )
    assert.equal(
      l.card({ ref }).asks?.[1]?.answered,
      undefined,
    )
    assert.equal(
      ownerQuestions({ card: l.card({ ref }) }).length,
      1,
    )
    assert.equal(
      l.received.at(-1)?.text,
      'The owner chose the existing cache.',
    )
    const queued = readEvents({ hydraId }).find(event => event.type === 'card.replied' && event.data.reply === 'go-relay' && event.data.state === 'queued')
    assert.ok(queued?.type === 'card.replied')
    assert.equal(
      queued.data.accepted,
      true,
    )
    assert.equal(
      queued.data.decision?.answer,
      'Proceed with the investigation; report inline.',
    )
    assert.equal(
      queued.data.text,
      'The owner chose the existing cache.',
    )
    assert.equal(
      replay({
        state: emptyHydra(),
        events: readEvents({ hydraId }),
      }).cards[ref]?.asks?.[0]?.answered,
      'go-relay',
    )
  },
)

test(
  'plain and merge relays require a named question and owner source; Merge and Hold stay explicit',
  async t => {
    const l = await lab({ t })
    const plain = await l.create({ key: 'plain' })
    const question = await l.ask({ ref: plain })
    const message = l.chat({ ref: plain })
    await l.relay({ ref: plain })
    assert.equal(
      ownerQuestions({ card: l.card({ ref: plain }) }).length,
      1,
    )
    await l.relay({
      ref: plain,
      question,
      message,
    })
    assert.equal(
      cardQuestion({ card: l.card({ ref: plain }) }),
      undefined,
    )
    const merge = await l.create({ key: 'merge' })
    l.event({
      ref: merge,
      change: {
        type: 'task.asked',
        data: {
          id: 'synthetic-merge',
          audience: 'owner',
          kind: 'merge',
          question: 'Merge this pull request?',
          url: 'https://github.com/synthetic/question-lab/pull/1',
          options: [
            { label: 'Merge' },
            { label: 'Hold' },
          ],
        },
      },
    })
    const source = l.chat({
      ref: merge,
      text: 'Merge when its checks pass.',
    })
    await assert.rejects(
      l.relay({
        ref: merge,
        question: 'synthetic-merge',
        message: source,
      }),
      /merge question with --choice Merge or Hold/,
    )
    await l.relay({
      ref: merge,
      question: 'synthetic-merge',
      message: source,
      choice: 'Merge',
    })
    assert.equal(
      l.card({ ref: merge }).asks?.[0]?.choice,
      'Merge',
    )
    assert.equal(
      l.card({ ref: merge }).links.length,
      0,
    )
    const held = await l.create({
      key: 'hold',
      hold: true,
    })
    const go = await l.ask({
      ref: held,
      go: true,
    })
    const holdMessage = l.chat({
      ref: held,
      text: 'Keep discussing this.',
    })
    await l.relay({
      ref: held,
      question: go,
      message: holdMessage,
      choice: 'Hold',
    })
    assert.ok(l.card({ ref: held }).hold)
    assert.equal(
      l.card({ ref: held }).asks?.[0]?.choice,
      'Hold',
    )
    assert.equal(
      openAsks({ card: l.card({ ref: held }) }).length,
      0,
    )
  },
)

for (const mode of [
  'failed',
  'queued',
  'unknown',
] as const) {
  test(
    `an escalated worker answer is accepted despite ${mode} delivery; same-key retries preserve the answer`,
    async t => {
      const l = await lab({ t })
      const ref = await l.create({ key: mode })
      const question = await l.ask({
        ref,
        worker: true,
      })
      const message = l.chat({ ref })
      l.mode({ value: mode })
      const result = await l.task({
        args: [
          'answer',
          ref,
          question,
          '--from-message',
          message,
          '--event-id',
          'saved-answer',
        ],
      })
      assert.equal(
        result.state,
        mode === 'unknown' ? 'delivery_unknown' : mode,
      )
      assert.equal(
        ownerQuestions({ card: l.card({ ref }) }).length,
        0,
      )
      assert.equal(
        ownerGates({ card: l.card({ ref }) }).length,
        0,
      )
      assert.equal(
        l.card({ ref }).asks?.[0]?.answered,
        'saved-answer',
      )
      assert.equal(
        l.card({ ref }).replies?.at(-1)?.decision?.fromMessage?.id,
        message,
      )
      l.mode({ value: 'delivered' })
      const sends = l.received.length
      await l.task({
        args: [
          'answer',
          ref,
          question,
          '--from-message',
          message,
          '--event-id',
          'saved-answer',
        ],
      })
      assert.equal(
        l.received.length,
        mode === 'failed' ? sends + 1 : sends,
      )
      assert.equal(
        l.card({ ref }).asks?.[0]?.answered,
        'saved-answer',
      )
      await assert.rejects(
        l.task({
          args: [
            'answer',
            ref,
            question,
            '--from-message',
            message,
          ],
        }),
        /already answered/,
      )
      assert.equal(
        replay({
          state: emptyHydra(),
          events: readEvents({ hydraId }),
        }).cards[ref]?.asks?.[0]?.answered,
        'saved-answer',
      )
    },
  )
}

test(
  'a delivered answer survives a lost receipt write, while a failed acceptance sends nothing',
  async t => {
    const l = await lab({ t })
    const ref = await l.create({ key: 'receipt' })
    const question = await l.ask({
      ref,
      worker: true,
    })
    const message = l.chat({ ref })
    l.mode({ value: 'record-error' })
    const result = await taskHandler([
      'answer',
      ref,
      question,
      '--from-message',
      message,
      '--actor',
      'hydra',
      '--reason',
      reason,
      '--hydra',
      hydraId,
    ])
    l.unlock()
    assert.equal(
      result.state,
      'delivered',
    )
    assert.match(
      String(result.recordError),
      /locked/,
    )
    assert.equal(
      ownerQuestions({ card: l.card({ ref }) }).length,
      0,
    )
    assert.equal(
      l.card({ ref }).replies?.at(-1)?.state,
      'queued',
    )
    const second = await l.ask({ ref })
    const source = l.chat({ ref })
    const sends = l.received.length
    const unlock = acquireLock({
      dir: join(
        l.root,
        'hydras',
        hydraId,
      ),
    })

    try {
      await assert.rejects(
        l.relay({
          ref,
          question: second,
          message: source,
        }),
        /locked/,
      )
    } finally {
      unlock()
    }

    assert.equal(
      l.received.length,
      sends,
    )
    assert.equal(
      l.card({ ref }).asks?.[1]?.answered,
      undefined,
    )
  },
)

test(
  'a missing worker route retains the accepted answer and outgoing text for a later delivery retry',
  async t => {
    const l = await lab({ t })
    const ref = await l.create({
      key: 'missing',
      worker: false,
    })
    const question = await l.ask({
      ref,
      worker: true,
    })
    const message = l.chat({ ref })
    const result = await l.task({
      args: [
        'answer',
        ref,
        question,
        '--from-message',
        message,
        '--event-id',
        'no-route',
      ],
    })
    assert.equal(
      result.state,
      'failed',
    )
    assert.match(
      String(result.detail),
      /no reply route/,
    )
    assert.equal(
      cardQuestion({ card: l.card({ ref }) }),
      undefined,
    )
    assert.equal(
      l.card({ ref }).replies?.[0]?.decision?.fromMessage?.id,
      message,
    )
    const failure = readEvents({ hydraId }).findLast(event => event.type === 'card.replied' && event.data.reply === 'no-route')
    assert.ok(failure?.type === 'card.replied')
    assert.equal(
      relevantUpdate({
        event: {
          ...failure,
          summary: '',
        },
        columns: [],
      })?.state,
      'Answer delivery failed',
    )
    const savedText = l.card({ ref }).replies?.[0]?.text
    assert.ok(savedText?.includes('Use the existing cache.'))
    l.attach({ ref })
    await l.relay({
      ref,
      key: 'no-route',
      text: 'An unrelated replacement must not replace the saved answer.',
    })
    assert.equal(
      l.received.at(-1)?.text,
      savedText,
    )
    assert.equal(
      l.card({ ref }).asks?.[0]?.answered,
      'no-route',
    )
  },
)

test(
  'release records the bound Go answer, including report-linked questions, and Undo restores the hold',
  async t => {
    const l = await lab({ t })
    const origin = await l.create({
      key: 'origin',
      worker: false,
    })
    const file = join(
      l.root,
      'report.md',
    )
    writeFileSync(
      file,
      'Synthetic recommendation.',
    )
    await l.task({
      args: [
        'report',
        origin,
        '--file',
        file,
      ],
      actor: `worker:${origin}`,
    })
    const ref = await l.create({
      key: 'release',
      hold: true,
    })
    const question = await l.ask({
      ref,
      go: true,
      origin,
    })
    const other = await l.ask({ ref })
    const source = l.chat({
      ref,
      text: 'Proceed with the recommendation.',
    })
    await l.task({
      args: [
        'release',
        ref,
        '--from-message',
        source,
      ],
    })
    const accepted = l.card({ ref }).asks?.[0]
    assert.ok(accepted?.answered)
    assert.equal(
      accepted.closed,
      undefined,
    )
    assert.equal(
      accepted.choice,
      'Go',
    )
    assert.equal(
      accepted.fromMessage?.id,
      source,
    )
    assert.equal(
      l.card({ ref }).hold,
      undefined,
    )
    assert.equal(
      l.card({ ref }).asks?.[1]?.id,
      other,
    )
    assert.equal(
      l.card({ ref }).asks?.[1]?.answered,
      undefined,
    )
    await l.task({
      args: [
        'reopen-question',
        ref,
        question,
        '--answer',
        accepted.answered,
      ],
      actor: 'web',
    })
    assert.ok(l.card({ ref }).hold)
    assert.equal(
      l.card({ ref }).asks?.[0]?.answered,
      undefined,
    )
    const plain = await l.create({
      key: 'ordinary-release',
      hold: true,
    })
    await l.ask({
      ref: plain,
      go: true,
    })
    const message = l.chat({ ref: plain })
    await l.task({
      args: [
        'release',
        plain,
        '--from-message',
        message,
      ],
    })
    assert.equal(
      l.card({ ref: plain }).asks?.[0]?.choice,
      'Go',
    )
    assert.equal(
      ownerQuestions({ card: l.card({ ref: plain }) }).length,
      0,
    )
  },
)

test(
  'invalid sources and incompatible reply modes cannot write an answer or deliver a message',
  async t => {
    const l = await lab({ t })
    const ref = await l.create({
      key: 'validation',
      hold: true,
    })
    const question = await l.ask({
      ref,
      go: true,
    })
    const stale = l.chat({
      ref,
      at: '2020-01-01T00:00:00Z',
    })
    const report = l.chat({
      ref,
      actor: `worker:${ref}`,
    })
    const oversized = l.chat({
      ref,
      text: 'x'.repeat(4001),
    })
    const valid = l.chat({ ref })
    const before = l.state().seq
    await assert.rejects(
      l.relay({
        ref,
        question,
        message: stale,
        choice: 'Go',
      }),
      /after the question/,
    )
    await assert.rejects(
      l.relay({
        ref,
        question,
        message: report,
        choice: 'Go',
      }),
      /owner’s own message/,
    )
    await assert.rejects(
      l.relay({
        ref,
        question,
        message: oversized,
        choice: 'Go',
      }),
      /4000/,
    )
    await assert.rejects(
      l.relay({
        ref,
        question,
        message: valid,
        choice: 'Wrong',
      }),
      /choice takes/,
    )
    await assert.rejects(
      l.relay({
        ref,
        question,
      }),
      /required together/,
    )
    await assert.rejects(
      l.relay({
        ref,
        message: valid,
      }),
      /required together/,
    )
    await assert.rejects(
      l.relay({
        ref,
        question,
        message: valid,
        choice: 'Go',
        text: '/compact',
      }),
      /native command/,
    )
    await assert.rejects(
      reply([
        ref,
        '--question',
        question,
        '--from-message',
        valid,
        '--task-message',
        '--text',
        'Context',
        '--hydra',
        hydraId,
      ]),
      /cannot be combined/,
    )
    await assert.rejects(
      l.task({
        args: [
          'release',
          ref,
          '--from-message',
          stale,
        ],
      }),
      /after the current hold/,
    )
    assert.equal(
      l.state().seq,
      before,
    )
    assert.equal(
      l.received.length,
      0,
    )
    assert.ok(l.card({ ref }).hold)
  },
)

test(
  'Undo is not reversed by a later receipt or retry, and historical queued replies remain unanswered',
  async t => {
    const l = await lab({ t })
    const ref = await l.create({
      key: 'undo',
      hold: true,
    })
    const question = await l.ask({
      ref,
      go: true,
    })
    const message = l.chat({ ref })
    l.mode({ value: 'failed' })
    await l.relay({
      ref,
      question,
      message,
      choice: 'Go',
      key: 'undo-relay',
    })
    await l.task({
      args: [
        'reopen-question',
        ref,
        question,
        '--answer',
        'undo-relay',
      ],
      actor: 'web',
    })
    l.mode({ value: 'delivered' })
    await assert.rejects(
      l.relay({
        ref,
        key: 'undo-relay',
      }),
      /undone or replaced/,
    )
    l.event({
      ref,
      change: {
        type: 'card.replied',
        data: {
          reply: 'undo-relay',
          route: 'pnyx',
          state: 'delivered',
          accepted: true,
          answers: question,
        },
      },
    })
    assert.equal(
      l.card({ ref }).asks?.[0]?.answered,
      undefined,
    )
    assert.ok(l.card({ ref }).hold)
    const legacy = await l.create({ key: 'legacy' })
    const oldQuestion = await l.ask({
      ref: legacy,
      worker: true,
    })
    l.event({
      ref: legacy,
      change: {
        type: 'card.replied',
        data: {
          reply: 'historical-answer',
          state: 'queued',
          route: 'pnyx',
          answers: oldQuestion,
          decision: {
            questionId: oldQuestion,
            question: 'Which cache?',
            answer: 'Use cache',
            fromMessage: {
              id: message,
              text: 'Use cache',
              at: new Date().toISOString(),
            },
          },
        },
      },
    })
    assert.equal(
      l.card({ ref: legacy }).asks?.[0]?.answered,
      undefined,
    )
    assert.equal(
      replay({
        state: emptyHydra(),
        events: readEvents({ hydraId }),
      }).cards[legacy]?.asks?.[0]?.answered,
      undefined,
    )
  },
)

test(
  'recording a worker answer preserves unrelated permissions and refuses a different question under the same key',
  async t => {
    const l = await lab({ t })
    const ref = await l.create({ key: 'permission' })
    const question = await l.ask({
      ref,
      worker: true,
    })
    const other = await l.ask({ ref })
    l.event({
      ref,
      change: {
        type: 'task.permission',
        data: {
          id: 'synthetic-permission',
          session: 'synthetic-session',
          tool: 'Bash',
          input: { command: 'make release' },
          status: 'pending',
        },
      },
    })
    const message = l.chat({ ref })
    l.mode({ value: 'failed' })
    await l.relay({
      ref,
      question,
      message,
      key: 'permission-answer',
    })
    assert.equal(
      l.card({ ref }).permissions?.[0]?.status,
      'pending',
    )
    assert.equal(
      ownerQuestions({ card: l.card({ ref }) }).length,
      2,
    )
    assert.equal(
      l.card({ ref }).column,
      hydraConfig({
        state: l.state(),
        id: hydraId,
      }).columns.find(column => column.role === 'needs_you')?.id,
    )
    await assert.rejects(
      l.relay({
        ref,
        question: other,
        message,
        key: 'permission-answer',
      }),
      /different question/,
    )
    assert.equal(
      l.card({ ref }).asks?.[1]?.answered,
      undefined,
    )
  },
)

test(
  'release rejects a message newer than its hold but older than the bound question',
  async t => {
    const l = await lab({ t })
    const ref = await l.create({
      key: 'stale-release',
      hold: true,
    })
    const source = l.chat({ ref })
    const hold = l.card({ ref }).hold
    l.event({
      ref,
      actor: 'hydra',
      at: new Date(Date.now() + 2000).toISOString(),
      change: {
        type: 'task.asked',
        data: {
          id: 'later-go',
          kind: 'go',
          audience: 'owner',
          hold,
          question: 'Proceed?',
          options: [
            { label: 'Go' },
            { label: 'Hold' },
          ],
        },
      },
    })
    const before = l.state().seq
    await assert.rejects(
      l.task({
        args: [
          'release',
          ref,
          '--from-message',
          source,
        ],
      }),
      /after the question/,
    )
    assert.equal(
      l.state().seq,
      before,
    )
    assert.ok(l.card({ ref }).hold)
    assert.equal(
      l.card({ ref }).asks?.[0]?.answered,
      undefined,
    )
  },
)

test(
  'task answer retains its Hydra-authored source route and native worker answers remain delivery-gated',
  async t => {
    const l = await lab({ t })
    const ref = await l.create({
      key: 'hydra-route',
      hold: true,
    })
    const go = await l.ask({
      ref,
      go: true,
    })
    const message = l.chat({ ref })
    await l.task({
      args: [
        'answer',
        ref,
        go,
        '--from-message',
        message,
        '--choice',
        'Go',
      ],
    })
    assert.equal(
      l.card({ ref }).asks?.[0]?.choice,
      'Go',
    )
    assert.equal(
      l.card({ ref }).hold,
      undefined,
    )
    const plain = await l.ask({ ref })
    const source = l.chat({ ref })
    await l.task({
      args: [
        'answer',
        ref,
        plain,
        '--from-message',
        source,
      ],
    })
    assert.ok(l.card({ ref }).asks?.[1]?.answered)
    const worker = await l.ask({
      ref,
      worker: true,
    })
    l.mode({ value: 'failed' })
    await l.task({
      args: [
        'answer',
        ref,
        worker,
        '--text',
        'Use cache.',
      ],
      actor: 'web',
    })
    assert.equal(
      l.card({ ref }).asks?.[2]?.answered,
      undefined,
    )
    l.mode({ value: 'delivered' })
    await l.task({
      args: [
        'answer',
        ref,
        worker,
        '--text',
        'Use cache.',
      ],
      actor: 'web',
    })
    assert.ok(l.card({ ref }).asks?.[2]?.answered)
  },
)

test(
  'a checked undelivered retry keeps the accepted decision and sends the original answer once more',
  async t => {
    const l = await lab({ t })
    const ref = await l.create({ key: 'checked-retry' })
    const question = await l.ask({
      ref,
      worker: true,
    })
    const message = l.chat({ ref })
    l.mode({ value: 'unknown' })
    await l.task({
      args: [
        'answer',
        ref,
        question,
        '--from-message',
        message,
        '--event-id',
        'checked-answer',
      ],
    })
    const text = l.received[0]?.text
    l.mode({ value: 'delivered' })
    const result = await l.task({
      args: [
        'answer',
        ref,
        question,
        '--from-message',
        message,
        '--event-id',
        'checked-answer',
        '--undelivered',
      ],
    })
    assert.equal(
      result.state,
      'delivered',
    )
    assert.equal(
      l.received.length,
      2,
    )
    assert.equal(
      l.received[1]?.text,
      text,
    )
    assert.equal(
      l.card({ ref }).asks?.[0]?.answered,
      'checked-answer',
    )
    assert.equal(
      readEvents({ hydraId }).filter(event => event.type === 'card.replied' && event.data.accepted && event.data.text !== undefined).length,
      1,
    )
  },
)

test(
  'a question relay rejects the key of an ordinary delivered reply without accepting or sending anything',
  async t => {
    const l = await lab({ t })
    const ref = await l.create({ key: 'ordinary-collision' })
    const ordinary = await l.relay({
      ref,
      key: 'ordinary-feedback',
    })
    assert.equal(
      ordinary.reply.state,
      'delivered',
    )
    const question = await l.ask({ ref })
    const message = l.chat({ ref })
    const before = l.state().seq
    const sends = l.received.length
    await assert.rejects(
      l.relay({
        ref,
        question,
        message,
        key: 'ordinary-feedback',
      }),
      /different question/,
    )
    assert.equal(
      l.state().seq,
      before,
    )
    assert.equal(
      l.received.length,
      sends,
    )
    assert.equal(
      ownerQuestions({ card: l.card({ ref }) }).length,
      1,
    )
  },
)

test(
  'a checked retry of a Go relay sends its saved message after the hold has been released',
  async t => {
    const l = await lab({ t })
    const ref = await l.create({
      key: 'go-retry',
      hold: true,
    })
    const question = await l.ask({
      ref,
      go: true,
    })
    const message = l.chat({
      ref,
      text: 'Proceed with the cache change.',
    })
    l.mode({ value: 'unknown' })
    await l.relay({
      ref,
      question,
      message,
      choice: 'Go',
      key: 'saved-go',
      text: 'Proceed with the cache.',
    })
    assert.equal(
      l.card({ ref }).hold,
      undefined,
    )
    l.mode({ value: 'delivered' })
    const result = await l.task({
      args: [
        'answer',
        ref,
        question,
        '--from-message',
        message,
        '--event-id',
        'saved-go',
        '--undelivered',
      ],
    })
    assert.equal(
      result.state,
      'delivered',
    )
    assert.equal(
      l.received.length,
      2,
    )
    assert.equal(
      l.received[1]?.text,
      'Proceed with the cache.',
    )
    assert.equal(
      l.card({ ref }).asks?.[0]?.answered,
      'saved-go',
    )
    assert.equal(
      l.card({ ref }).asks?.[0]?.choice,
      'Go',
    )
  },
)

test(
  'failed delivery plus a lost receipt keeps the reply key in its recovery help and can resend a Hydra relay',
  async t => {
    const l = await lab({ t })
    const ref = await l.create({ key: 'failed-receipt' })
    const question = await l.ask({ ref })
    const message = l.chat({ ref })
    l.mode({ value: 'failed-record-error' })
    const result = await l.relay({
      ref,
      question,
      message,
      key: 'failed-receipt-answer',
      text: 'Keep the existing cache.',
    })
    l.unlock()
    assert.equal(
      result.reply.state,
      'failed',
    )
    assert.ok('recordError' in result.reply)
    assert.match(
      String(result.reply.recordError),
      /locked/,
    )
    assert.ok(Array.isArray(result.help))
    assert.match(
      result.help.join(' '),
      /--event-id failed-receipt-answer --undelivered/,
    )
    assert.doesNotMatch(
      result.help.join(' '),
      /without --idempotency-key/,
    )
    assert.equal(
      l.card({ ref }).replies?.[0]?.state,
      'queued',
    )
    l.mode({ value: 'delivered' })
    const retried = await l.task({
      args: [
        'answer',
        ref,
        question,
        '--from-message',
        message,
        '--event-id',
        'failed-receipt-answer',
        '--undelivered',
      ],
    })
    assert.equal(
      retried.state,
      'delivered',
    )
    assert.equal(
      l.received.length,
      2,
    )
    assert.equal(
      l.received[1]?.text,
      'Keep the existing cache.',
    )
    assert.equal(
      l.card({ ref }).asks?.[0]?.answered,
      'failed-receipt-answer',
    )
  },
)

test(
  'task answer also preserves checked recovery guidance after failed delivery and a lost receipt',
  async t => {
    const l = await lab({ t })
    const ref = await l.create({ key: 'worker-failed-receipt' })
    const question = await l.ask({
      ref,
      worker: true,
    })
    const message = l.chat({ ref })
    l.mode({ value: 'failed-record-error' })
    const result = await taskHandler([
      'answer',
      ref,
      question,
      '--from-message',
      message,
      '--event-id',
      'worker-lost-receipt',
      '--actor',
      'hydra',
      '--reason',
      reason,
      '--hydra',
      hydraId,
    ])
    l.unlock()
    assert.equal(
      result.state,
      'failed',
    )
    assert.match(
      String(result.recordError),
      /locked/,
    )
    assert.ok(Array.isArray(result.help))
    assert.match(
      result.help.join(' '),
      /--event-id worker-lost-receipt --undelivered/,
    )
    assert.equal(
      l.card({ ref }).replies?.[0]?.state,
      'queued',
    )
    l.mode({ value: 'delivered' })
    const retried = await l.task({
      args: [
        'answer',
        ref,
        question,
        '--from-message',
        message,
        '--event-id',
        'worker-lost-receipt',
        '--undelivered',
      ],
    })
    assert.equal(
      retried.state,
      'delivered',
    )
    assert.equal(
      l.received.length,
      2,
    )
    assert.equal(
      l.card({ ref }).asks?.[0]?.answered,
      'worker-lost-receipt',
    )
  },
)

test(
  'Hydra lifts a merge Hold from the owner’s later message and Undo restores Hold',
  async t => {
    const l = await lab({ t })
    const ref = await l.create({ key: 'later-merge' })
    const question = 'synthetic-held-merge'
    const url = 'https://github.com/synthetic/question-lab/pull/281'
    l.event({
      ref,
      change: {
        type: 'task.asked',
        data: {
          id: question,
          audience: 'owner',
          kind: 'merge',
          question: 'Review and merge PR #281?',
          url,
          options: [
            { label: 'Merge' },
            { label: 'Hold' },
          ],
        },
      },
    })
    await l.task({
      args: [
        'answer',
        ref,
        question,
        '--choice',
        'Hold',
      ],
      actor: 'web',
    })
    const held = l.card({ ref }).asks?.[0]
    assert.ok(held?.answered)
    const message = l.chat({
      ref,
      text: 'Merge PR #281 now.',
    })
    await l.task({
      args: [
        'answer',
        ref,
        question,
        '--from-message',
        message,
        '--choice',
        'Merge',
      ],
    })
    const approved = l.card({ ref }).asks?.[0]
    assert.equal(
      mergeApproval({
        card: l.card({ ref }),
        url,
      })?.id,
      question,
    )
    assert.equal(
      mergeApproval({
        card: l.card({ ref }),
        url: 'https://github.com/synthetic/question-lab/pull/282',
      }),
      undefined,
    )
    assert.equal(
      approved?.choice,
      'Merge',
    )
    assert.equal(
      approved?.fromMessage?.text,
      'Merge PR #281 now.',
    )
    assert.ok(approved?.answered)
    await l.task({
      args: [
        'reopen-question',
        ref,
        question,
        '--answer',
        approved.answered,
      ],
      actor: 'web',
    })
    assert.equal(
      l.card({ ref }).asks?.[0]?.choice,
      'Hold',
    )
    assert.equal(
      mergeApproval({
        card: l.card({ ref }),
        url,
      }),
      undefined,
    )
    assert.equal(
      l.card({ ref }).asks?.[0]?.answered,
      held.answered,
    )
    assert.deepEqual(
      replay({
        state: emptyHydra(),
        events: readEvents({ hydraId }),
      }).cards[ref]?.asks,
      l.card({ ref }).asks,
    )
  },
)

async function heldMerge({ t }: { t: TestContext }) {
  const l = await lab({ t })
  const ref = await l.create({ key: 'merge-refusals' })
  const question = 'synthetic-merge-hold'
  l.event({
    ref,
    at: '2026-10-01T10:00:00.000Z',
    change: {
      type: 'task.asked',
      data: {
        id: question,
        audience: 'owner',
        kind: 'merge',
        question: 'Review and merge PR #281?',
        url: 'https://github.com/synthetic/question-lab/pull/281',
        options: [
          { label: 'Merge' },
          { label: 'Hold' },
        ],
      },
    },
  })
  await l.task({
    args: [
      'answer',
      ref,
      question,
      '--choice',
      'Hold',
    ],
    actor: 'web',
  })
  const held = l.card({ ref }).asks?.[0]
  assert.ok(held?.answeredAt)
  assert.ok(held.answered)

  return {
    l,
    ref,
    question,
    held,
  }
}

test(
  'a held merge refuses older, equal, missing and non-owner sources without changing Hold',
  async t => {
    const {
      l,
      ref,
      question,
      held,
    } = await heldMerge({ t })
    const old = l.chat({
      ref,
      at: '2026-10-01T10:01:00.000Z',
      text: 'Merge PR #281.',
    })
    const equal = l.chat({
      ref,
      at: held.answeredAt,
      text: 'Merge PR #281.',
    })
    const worker = l.chat({
      ref,
      actor: `worker:${ref}`,
      text: 'Merge PR #281.',
    })
    const hydra = l.chat({
      ref,
      actor: 'hydra',
      text: 'Merge PR #281.',
    })
    const system = l.chat({
      ref,
      actor: 'pnyx',
      text: 'Merge PR #281.',
    })
    const source = l.chat({
      ref,
      text: 'Merge PR #281.',
    })
    const before = readEvents({ hydraId }).length

    for (const message of [
      old,
      equal,
      worker,
      hydra,
      system,
      'missing-message',
    ]) {
      await assert.rejects(
        l.task({
          args: [
            'answer',
            ref,
            question,
            '--from-message',
            message,
            '--choice',
            'Merge',
          ],
        }),
        /owner’s (?:message must be newer than the Hold answer|own message)/,
      )
    }

    await assert.rejects(
      l.task({
        args: [
          'answer',
          ref,
          question,
          '--choice',
          'Merge',
        ],
      }),
      /owner's own answer/,
    )
    await assert.rejects(
      l.task({
        args: [
          'answer',
          ref,
          question,
          '--from-message',
          source,
        ],
      }),
      /merge question with --choice Merge or Hold/,
    )
    await assert.rejects(
      l.task({
        args: [
          'answer',
          ref,
          question,
          '--from-message',
          source,
          '--choice',
          'Hold',
        ],
      }),
      /already answered/,
    )
    await assert.rejects(
      l.task({
        args: [
          'answer',
          ref,
          question,
          '--choice',
          'Merge',
          '--undelivered',
        ],
        actor: 'web',
      }),
      /already answered/,
    )
    await assert.rejects(
      l.task({
        args: [
          'answer',
          ref,
          question,
          '--from-message',
          source,
          '--choice',
          'Merge',
        ],
        actor: `worker:${ref}`,
      }),
      /agent cannot answer/,
    )
    assert.equal(
      readEvents({ hydraId }).length,
      before,
    )
    assert.equal(
      l.card({ ref }).asks?.[0]?.answered,
      held.answered,
    )
    assert.equal(
      l.card({ ref }).asks?.[0]?.choice,
      'Hold',
    )
  },
)

test(
  'Hydra can re-ask a merge Hold, but only a fresh owner answer approves it',
  async t => {
    const {
      l,
      ref,
      question,
      held,
    } = await heldMerge({ t })
    const oldSource = l.chat({
      ref,
      at: held.answeredAt,
      text: 'Merge PR #281.',
    })
    await assert.rejects(
      l.task({
        args: [
          'reask',
          ref,
          question,
        ],
        actor: `worker:${ref}`,
      }),
      /only Hydra/,
    )
    await assert.rejects(
      l.task({
        args: [
          'reask',
          ref,
          question,
        ],
        actor: 'web',
      }),
      /only Hydra/,
    )
    await l.task({
      args: [
        'reask',
        ref,
        question,
      ],
    })
    assert.equal(
      l.card({ ref }).asks?.[0]?.answered,
      undefined,
    )
    assert.equal(
      ownerQuestions({ card: l.card({ ref }) }).length,
      1,
    )
    assert.equal(
      mergeApproval({
        card: l.card({ ref }),
        url: held.url!,
      }),
      undefined,
    )
    await assert.rejects(
      l.task({
        args: [
          'answer',
          ref,
          question,
          '--from-message',
          oldSource,
          '--choice',
          'Merge',
        ],
      }),
      /owner’s own message sent after the question/,
    )
    await assert.rejects(
      l.task({
        args: [
          'answer',
          ref,
          question,
          '--choice',
          'Merge',
        ],
      }),
      /owner's own answer/,
    )
    await l.task({
      args: [
        'answer',
        ref,
        question,
        '--choice',
        'Hold',
      ],
      actor: 'web',
    })
    assert.equal(
      mergeApproval({
        card: l.card({ ref }),
        url: held.url!,
      }),
      undefined,
    )
    await l.task({
      args: [
        'reask',
        ref,
        question,
      ],
    })
    await l.task({
      args: [
        'answer',
        ref,
        question,
        '--choice',
        'Merge',
      ],
      actor: 'web',
    })
    assert.equal(
      mergeApproval({
        card: l.card({ ref }),
        url: held.url!,
      })?.id,
      question,
    )
    await assert.rejects(
      l.task({
        args: [
          'reask',
          ref,
          question,
        ],
      }),
      /answered merge Hold/,
    )
    assert.equal(
      ownerQuestions({ card: l.card({ ref }) }).length,
      0,
    )
  },
)

test(
  'Undo a lifted merge restores the original quoted Hold and rejects a stale undo',
  async t => {
    const {
      l,
      ref,
      question,
    } = await heldMerge({ t })
    await l.task({
      args: [
        'reask',
        ref,
        question,
      ],
    })
    const holdSource = l.chat({
      ref,
      text: 'Keep PR #281 on Hold.',
    })
    await l.task({
      args: [
        'answer',
        ref,
        question,
        '--from-message',
        holdSource,
        '--choice',
        'Hold',
      ],
    })
    const held = l.card({ ref }).asks?.[0]
    assert.ok(held?.answered)
    const source = l.chat({
      ref,
      at: '2099-01-01T00:00:00.000Z',
      text: 'Merge PR #281.',
    })
    await l.task({
      args: [
        'answer',
        ref,
        question,
        '--from-message',
        source,
        '--choice',
        'Merge',
      ],
    })
    const approved = l.card({ ref }).asks?.[0]
    assert.ok(approved?.answered)
    await assert.rejects(
      l.task({
        args: [
          'reopen-question',
          ref,
          question,
          '--answer',
          held.answered,
        ],
        actor: 'web',
      }),
      /current answer/,
    )
    await l.task({
      args: [
        'reopen-question',
        ref,
        question,
        '--answer',
        approved.answered,
      ],
      actor: 'web',
    })
    assert.equal(
      l.card({ ref }).asks?.[0]?.answered,
      held.answered,
    )
    assert.equal(
      l.card({ ref }).asks?.[0]?.choice,
      'Hold',
    )
    assert.equal(
      l.card({ ref }).asks?.[0]?.fromMessage?.id,
      holdSource,
    )
  },
)

test(
  'the reply path lifts a merge Hold with the same owner-source checks and Undo',
  async t => {
    const {
      l,
      ref,
      question,
      held,
    } = await heldMerge({ t })
    const old = l.chat({
      ref,
      at: held.answeredAt,
      text: 'Merge PR #281.',
    })
    await assert.rejects(
      l.relay({
        ref,
        question,
        message: old,
        choice: 'Merge',
      }),
      /newer than the Hold answer/,
    )
    const source = l.chat({
      ref,
      text: 'Merge PR #281.',
    })
    await l.relay({
      ref,
      question,
      message: source,
      choice: 'Merge',
      text: 'The owner approved merging PR #281.',
    })
    const approved = l.card({ ref }).asks?.[0]
    assert.equal(
      approved?.choice,
      'Merge',
    )
    assert.equal(
      approved?.fromMessage?.id,
      source,
    )
    assert.ok(approved?.answered)
    await l.task({
      args: [
        'reopen-question',
        ref,
        question,
        '--answer',
        approved.answered,
      ],
      actor: 'web',
    })
    assert.equal(
      l.card({ ref }).asks?.[0]?.answered,
      held.answered,
    )
    assert.equal(
      l.card({ ref }).asks?.[0]?.choice,
      'Hold',
    )
  },
)

for (const mode of [
  'queued',
  'unknown',
] as const) {
  test(
    `a re-asked merge ignores the previous Hold's ${mode} receipt`,
    async t => {
      const {
        l,
        ref,
        question,
      } = await heldMerge({ t })
      await l.task({
        args: [
          'reask',
          ref,
          question,
        ],
      })
      const source = l.chat({
        ref,
        text: 'Keep this PR on Hold.',
      })
      l.mode({ value: mode })
      await l.relay({
        ref,
        question,
        message: source,
        choice: 'Hold',
        text: 'Keep this on Hold.',
      })
      assert.equal(
        l.card({ ref }).asks?.[0]?.choice,
        'Hold',
      )
      await l.task({
        args: [
          'reask',
          ref,
          question,
        ],
      })
      assert.equal(
        answerDelivery({
          card: l.card({ ref }),
          question,
        }),
        undefined,
      )
      assert.equal(
        ownerQuestions({ card: l.card({ ref }) })[0]?.delivery,
        undefined,
      )
      await l.task({
        args: [
          'answer',
          ref,
          question,
          '--choice',
          'Merge',
        ],
        actor: 'web',
      })
      assert.equal(
        l.card({ ref }).asks?.[0]?.choice,
        'Merge',
      )
      assert.equal(
        l.card({ ref }).replies?.length,
        1,
      )
    },
  )
}
