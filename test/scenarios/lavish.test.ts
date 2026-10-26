import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, mock, test } from 'node:test'
import { format } from 'node:util'
import { emptyHydra, replay } from '../../src/core/reducer.ts'
import { armLavish } from '../../src/external-sources/lavish.ts'
import { withWriter } from '../../src/store/hydra-store.ts'
import { steeringClaim } from '../../src/task-inbox/state.ts'
import { scenarioGroup, until } from './harness.ts'
import { claimFlags, lavishFixture, readAndAck } from './lavish-fixture.ts'

const pnyx = scenarioGroup()
type Scenario = Awaited<ReturnType<typeof pnyx.scenario>>
const serverLog: string[] = []
const printError = console.error
const errors = mock.method(
  console,
  'error',
  // Preserve console.error's variadic logging contract.
  // eslint-disable-next-line pnyx/object-params
  (...args: unknown[]) => {
    serverLog.push(`${new Date().toISOString()} ${format(...args)}`)
    printError(...args)
  },
)
after(() => errors.mock.restore())

async function setup({ s }: { s: Scenario }) {
  const folder = s.folder({ name: 'review' })
  const fixture = lavishFixture({ folder })
  await s.owner({
    args: [
      'task',
      'create',
      '--key',
      'page',
      '--title',
      'Review the page',
      '--folder',
      folder,
    ],
  })
  await s.owner({
    args: [
      'task',
      'start',
      'page',
    ],
  })
  const agent = await s.agent({ cwd: folder })
  await until({
    what: 'opening turn completed',
    check: () => s.task({ key: 'page' }).sessionActivity === 'finished',
  })

  return {
    folder,
    fixture,
    worker: s.as({ agent }),
    agent,
  }
}

function source({
  s,
  id,
}: {
  s: Scenario
  id: string
}) {
  const source = s.task({ key: 'page' }).externalSources?.find(source => source.id === id)
  assert.ok(source)

  return source
}

async function captured({
  s,
  id,
  retainFailure = false,
}: {
  s: Scenario
  id: string
  retainFailure?: boolean
}) {
  return until({
    what: `${id} round captured and enqueued`,
    check: () => {
      const result = source({
        s,
        id,
      }).results[0]

      return result && s.task({ key: 'page' }).steering?.some(message => message.id === result.message) && result
    },
  }).catch(error => {
    if (!retainFailure) {
      throw error
    }

    // The scenario root is deleted on teardown; keep failure evidence outside it.
    const path = join(
      mkdtempSync(join(
        tmpdir(),
        'pnyx-lavish-failure-',
      )),
      'successor-capture.json',
    )
    const folder = s.folder({ name: 'review' })
    writeFileSync(
      path,
      JSON.stringify(
        {
          failure: String(error),
          hydra: s.hydraId,
          source: source({
            s,
            id,
          }),
          task: s.task({ key: 'page' }),
          eventTail: s.events().slice(-100),
          serverLog,
          fixture: [
            'calls.jsonl',
            'listening',
            'deliver.toon',
          ].map(name => {
            const file = join(
              folder,
              name,
            )

            return {
              name,
              text: existsSync(file) ? readFileSync(
                file,
                'utf8',
              ) : null,
            }
          }),
        },
        null,
        2,
      ),
    )
    throw new Error(
      `${String(error)}; failure evidence: ${path}`,
      { cause: error },
    )
  })
}

test(
  'ordinary and decision rounds survive restart, preserve reply identity, and conclude Send & End once',
  async () => {
    const s = await pnyx.scenario()
    const {
      folder,
      fixture,
      worker,
    } = await setup({ s })
    await worker.run({
      args: fixture.arm({
        task: 'page',
        id: 'first',
      }),
    })
    await until({
      what: 'first poll listening',
      check: () => existsSync(join(
        folder,
        'listening',
      )),
    })
    const ordinary = 'session:\n  status: feedback\nprompts[1]{tag,text}:\n  message,"Use a larger chart and keep the legend."\n'
    fixture.deliver({ body: ordinary })
    const first = await captured({
      s,
      id: 'first',
    })
    assert.equal(
      first.terminal,
      false,
    )
    await pnyx.restart()
    assert.equal(
      source({
        s,
        id: 'first',
      }).results[0]!.stdout,
      ordinary,
    )
    await readAndAck({
      s,
      worker,
      task: 'page',
      id: 'first',
    })
    const secondArgs = fixture.arm({
      task: 'page',
      id: 'second',
      after: 'first',
      card: s.task({ key: 'page' }),
    })
    rmSync(join(
      folder,
      'listening',
    ))
    await worker.run({ args: secondArgs })
    await until({
      what: 'accepted reply and next poll',
      check: () => source({
        s,
        id: 'second',
      }).lavish?.reply?.accepted && existsSync(join(
        folder,
        'listening',
      )),
    })
    await worker.run({ args: secondArgs })
    assert.equal(
      fixture.calls().filter(call => call.action === 'reply').length,
      1,
    )
    assert.equal(
      fixture.calls().filter(call => call.action === 'poll').length,
      2,
    )
    assert.equal(
      source({
        s,
        id: 'first',
      }).state,
      'retired',
    )
    assert.equal(
      source({
        s,
        id: 'second',
      }).lavish?.reply?.text,
      'Applied the requested changes.\nKept the labels.',
    )
    const replyIdentity = source({
      s,
      id: 'second',
    }).lavish!.reply!.id

    const decisionBody = 'session:\n  status: feedback\nprompts[2]{tag,text}:\n  choice,"Choose whether to publish the chart."\n  choice,"Choose whether to include the private dataset."\n'
    fixture.deliver({ body: decisionBody })
    await captured({
      s,
      id: 'second',
    })
    const decisions = [
      {
        key: 'publish',
        question: 'May we publish the chart?',
      },
      {
        key: 'dataset',
        question: 'May we include the private dataset?',
      },
    ]
    const registration = source({
      s,
      id: 'second',
    }).registration

    for (const decision of decisions) {
      const args = [
        'task',
        'ask',
        'page',
        '--question',
        decision.question,
        '--event-id',
        `${registration}:${decision.key}`,
      ]
      await worker.run({ args })
      const ownerQuestion = s.task({ key: 'page' }).asks!.find(ask => ask.question === decision.question)!
      await s.owner({
        args: [
          'task',
          'escalate',
          'page',
          ownerQuestion.id,
          '--reason',
          'Publication requires the owner',
          '--actor',
          'hydra',
        ],
      })
    }

    await pnyx.restart()

    for (const decision of decisions) {
      await worker.run({
        args: [
          'task',
          'ask',
          'page',
          '--question',
          decision.question,
          '--event-id',
          `${registration}:${decision.key}`,
        ],
      })
    }

    assert.deepEqual(
      s.task({ key: 'page' }).asks!.map(ask => ({
        question: ask.question,
        audience: ask.audience,
      })),
      decisions.map(decision => ({
        question: decision.question,
        audience: 'owner',
      })),
    )
    assert.equal(
      source({
        s,
        id: 'second',
      }).lavish!.reply!.id,
      replyIdentity,
    )
    await readAndAck({
      s,
      worker,
      task: 'page',
      id: 'second',
    })
    rmSync(join(
      folder,
      'listening',
    ))
    await worker.run({
      args: fixture.arm({
        task: 'page',
        id: 'final',
        after: 'second',
        card: s.task({ key: 'page' }),
      }),
    })
    await until({
      what: 'final poll listening',
      check: () => existsSync(join(
        folder,
        'listening',
      )),
    })
    const finalBody = 'session:\n  status: feedback\n  session_ended: true\nprompts[1]{tag,text}:\n  message,"Keep the chart private; this is my final comment."\n'
    fixture.deliver({ body: finalBody })
    const final = await captured({
      s,
      id: 'final',
    })
    assert.equal(
      final.terminal,
      true,
    )
    assert.equal(
      source({
        s,
        id: 'final',
      }).state,
      'ended',
    )
    await pnyx.restart()
    await readAndAck({
      s,
      worker,
      task: 'page',
      id: 'final',
    })
    const handledArgs = [
      'task',
      'source',
      'handled',
      'page',
      'final',
      '1',
      ...claimFlags({ card: s.task({ key: 'page' }) }),
    ]
    await worker.run({ args: handledArgs })
    await worker.run({ args: handledArgs })
    await worker.refused({
      args: fixture.arm({
        task: 'page',
        id: 'forbidden',
        after: 'final',
        card: s.task({ key: 'page' }),
      }),
    })
    assert.equal(
      source({
        s,
        id: 'final',
      }).state,
      'retired',
    )
    assert.equal(
      s.task({ key: 'page' }).asks?.length,
      2,
    )
    assert.equal(
      fixture.calls().filter(call => call.action === 'poll').length,
      3,
    )
    assert.equal(
      fixture.calls().filter(call => call.action === 'reply').length,
      2,
    )
    assert.equal(
      s.events().filter(event => event.type === 'task.source.handled').length,
      3,
    )
    assert.equal(
      s.state().hydraMessages?.some(message => message.text.includes(finalBody)) ?? false,
      false,
    )
    assert.equal(
      s.state().hydraMessages?.some(message => message.text.includes(decisionBody)) ?? false,
      false,
    )
    assert.ok(s.task({ key: 'page' }).asks!.every(ask => !ask.answered && !ask.closed))
    const replayed = replay({
      state: emptyHydra(),
      events: s.events(),
    })
    assert.deepEqual(
      replayed.cards[s.task({ key: 'page' }).id]!.externalSources,
      s.task({ key: 'page' }).externalSources,
    )
  },
)

test(
  'empty End is retained until handled, never posts a reply or reopens after restart',
  async () => {
    const s = await pnyx.scenario()
    const {
      folder,
      fixture,
      worker,
    } = await setup({ s })
    await worker.run({
      args: fixture.arm({
        task: 'page',
        id: 'empty',
      }),
    })
    await until({
      what: 'empty End poll listening',
      check: () => existsSync(join(
        folder,
        'listening',
      )),
    })
    fixture.deliver({ body: 'session:\n  status: ended\n' })
    const result = await captured({
      s,
      id: 'empty',
    })
    assert.equal(
      result.terminal,
      true,
    )
    assert.equal(
      result.handled,
      undefined,
    )
    await readAndAck({
      s,
      worker,
      task: 'page',
      id: 'empty',
    })
    await worker.run({
      args: [
        'task',
        'source',
        'handled',
        'page',
        'empty',
        '1',
        ...claimFlags({ card: s.task({ key: 'page' }) }),
      ],
    })
    await pnyx.restart()
    await worker.refused({
      args: fixture.arm({
        task: 'page',
        id: 'reopened',
      }),
    })
    assert.equal(
      fixture.calls().length,
      1,
    )
    assert.equal(
      source({
        s,
        id: 'empty',
      }).state,
      'retired',
    )
  },
)

test(
  'failed publication and failed re-arm retain one outcome without claiming another listener',
  async () => {
    const s = await pnyx.scenario()
    const {
      folder,
      fixture,
      worker,
    } = await setup({ s })
    await worker.run({
      args: [
        ...fixture.arm({
          task: 'page',
          id: 'post-failure',
        }),
        '--agent-reply-file',
        fixture.reply,
      ],
    })
    await until({
      what: 'initial reply and poll',
      check: () => existsSync(join(
        folder,
        'listening',
      )),
    })
    fixture.deliver({ body: 'session:\n  status: feedback\nprompts[1]{tag,text}:\n  message,"Fix the label"\n' })
    await captured({
      s,
      id: 'post-failure',
    })
    const args = fixture.arm({
      task: 'page',
      id: 'failed-next',
      after: 'post-failure',
      card: s.task({ key: 'page' }),
    })
    await worker.refused({ args })
    assert.equal(
      source({
        s,
        id: 'post-failure',
      }).results[0]!.handled,
      undefined,
    )
    await readAndAck({
      s,
      worker,
      task: 'page',
      id: 'post-failure',
    })
    const invalid = args.map(arg => arg === fixture.executable ? join(
      folder,
      'missing-executable',
    ) : arg)
    await worker.refused({ args: invalid })
    assert.equal(
      source({
        s,
        id: 'post-failure',
      }).results[0]!.handled,
      undefined,
    )
    writeFileSync(
      join(
        folder,
        'fail-post',
      ),
      '',
    )
    await worker.run({ args })
    const failed = await captured({
      s,
      id: 'failed-next',
    })
    assert.equal(
      failed.outcome,
      'failed',
    )
    assert.equal(
      source({
        s,
        id: 'failed-next',
      }).lavish!.reply!.accepted,
      undefined,
    )
    assert.equal(
      source({
        s,
        id: 'failed-next',
      }).state,
      'ended',
    )
    await pnyx.restart()
    await worker.run({ args })
    await worker.refused({
      args: fixture.arm({
        task: 'page',
        id: 'duplicate-successor',
        after: 'post-failure',
        card: s.task({ key: 'page' }),
      }),
    })
    assert.equal(
      fixture.calls().filter(call => call.action === 'poll').length,
      1,
    )
    assert.equal(
      fixture.calls().filter(call => call.action === 'reply').length,
      2,
    )
    assert.equal(
      source({
        s,
        id: 'failed-next',
      }).results.length,
      1,
    )
    await readAndAck({
      s,
      worker,
      task: 'page',
      id: 'failed-next',
    })
    rmSync(join(
      folder,
      'fail-post',
    ))
    writeFileSync(
      join(
        folder,
        'fail-poll',
      ),
      '',
    )
    await worker.run({
      args: fixture.arm({
        task: 'page',
        id: 'failed-poll',
        after: 'failed-next',
        card: s.task({ key: 'page' }),
      }),
    })
    const failedPoll = await captured({
      s,
      id: 'failed-poll',
    })
    assert.equal(
      failedPoll.outcome,
      'failed',
    )
    assert.ok(source({
      s,
      id: 'failed-poll',
    }).lavish!.reply!.accepted)
    await pnyx.restart()
    assert.equal(
      fixture.calls().filter(call => call.action === 'poll').length,
      2,
    )
    assert.equal(
      source({
        s,
        id: 'failed-poll',
      }).results.length,
      1,
    )
    const acceptedReply = structuredClone(source({
      s,
      id: 'failed-poll',
    }).lavish!.reply!)
    await readAndAck({
      s,
      worker,
      task: 'page',
      id: 'failed-poll',
    })
    rmSync(join(
      folder,
      'fail-poll',
    ))
    rmSync(join(
      folder,
      'listening',
    ))
    writeFileSync(
      fixture.reply,
      'Verified the accepted reply; restoring the listener.',
    )
    const recoveryArgs = fixture.arm({
      task: 'page',
      id: 'poll-recovered',
      after: 'failed-poll',
      card: s.task({ key: 'page' }),
    })
    await worker.run({ args: recoveryArgs })
    await until({
      what: 'recovery after accepted reply and failed poll',
      check: () => existsSync(join(
        folder,
        'listening',
      )),
    })
    await worker.run({ args: recoveryArgs })
    assert.deepEqual(
      source({
        s,
        id: 'failed-poll',
      }).lavish!.reply,
      acceptedReply,
    )
    assert.equal(
      fixture.calls().filter(call => call.action === 'reply').length,
      4,
    )
    assert.equal(
      fixture.calls().filter(call => call.action === 'poll').length,
      3,
    )
    fixture.deliver({ body: 'session:\n  status: ended\n' })
    await captured({
      s,
      id: 'poll-recovered',
    })
  },
)

test(
  'a crash after successor registration cannot post or poll before the predecessor handling is durable',
  async () => {
    const s = await pnyx.scenario()
    const {
      folder,
      fixture,
      worker,
      agent,
    } = await setup({ s })
    await worker.run({
      args: fixture.arm({
        task: 'page',
        id: 'prior',
      }),
    })
    await until({
      what: 'prior poll listening',
      check: () => existsSync(join(
        folder,
        'listening',
      )),
    })
    fixture.deliver({ body: 'session:\n  status: feedback\nprompts[1]{tag,text}:\n  message,"Apply the annotation"\n' })
    await captured({
      s,
      id: 'prior',
    })
    await readAndAck({
      s,
      worker,
      task: 'page',
      id: 'prior',
    })
    const card = s.task({ key: 'page' })
    assert.throws(
      () => withWriter({
        hydraId: s.hydraId,
        fn: ({ writer }) => armLavish({
          writer: {
            get state() {
              return writer.state
            },
            dir: writer.dir,
            append({ event }) {
              if (event.type === 'task.source.handled') {
                throw new Error('Injected interruption before handling append')
              }

              writer.append({ event })
            },
          },
          ref: 'page',
          id: 'successor',
          page: fixture.page,
          executable: fixture.executable,
          replyFile: fixture.reply,
          after: 'prior',
          sequence: 1,
          claim: steeringClaim({ card }),
          meta: {
            actor: `worker:${card.id}`,
            at: new Date().toISOString(),
          },
          worker: agent.env.PNYX_STEERING_WORKER,
        }),
      }),
      /Injected interruption/,
    )
    await pnyx.restart()
    assert.equal(
      source({
        s,
        id: 'successor',
      }).state,
      'registered',
    )
    assert.equal(
      source({
        s,
        id: 'prior',
      }).results[0]!.handled,
      undefined,
    )
    assert.equal(
      fixture.calls().length,
      1,
    )
    rmSync(join(
      folder,
      'listening',
    ))
    await worker.run({
      args: fixture.arm({
        task: 'page',
        id: 'successor',
        after: 'prior',
        card: s.task({ key: 'page' }),
      }),
    })
    await until({
      what: 'successor after completed handling',
      check: () => existsSync(join(
        folder,
        'listening',
      )),
    })
    fixture.deliver({ body: 'session:\n  status: ended\n' })
    await captured({
      s,
      id: 'successor',
      retainFailure: true,
    })
    assert.equal(
      fixture.calls().filter(call => call.action === 'reply').length,
      1,
    )
  },
)

test(
  'a lost running poll yields uncertainty and the current worker explicitly restores listening',
  async () => {
    const s = await pnyx.scenario()
    const {
      folder,
      fixture,
      worker,
    } = await setup({ s })
    await worker.run({
      args: fixture.arm({
        task: 'page',
        id: 'lost',
      }),
    })
    await until({
      what: 'poll before restart',
      check: () => existsSync(join(
        folder,
        'listening',
      )),
    })
    await pnyx.restart()
    assert.equal(
      (await captured({
        s,
        id: 'lost',
      })).outcome,
      'interrupted',
    )
    assert.equal(
      fixture.calls().length,
      1,
    )
    await readAndAck({
      s,
      worker,
      task: 'page',
      id: 'lost',
    })
    rmSync(join(
      folder,
      'listening',
    ))
    await worker.run({
      args: fixture.arm({
        task: 'page',
        id: 'restored',
        after: 'lost',
        card: s.task({ key: 'page' }),
      }),
    })
    await until({
      what: 'restored listener',
      check: () => existsSync(join(
        folder,
        'listening',
      )),
    })
    fixture.deliver({ body: 'session:\n  status: ended\n' })
    await captured({
      s,
      id: 'restored',
    })
    assert.equal(
      fixture.calls().filter(call => call.action === 'poll').length,
      2,
    )
  },
)

for (const outcome of [
  'expired',
  'stale',
  'stopped',
] as const) {
  test(
    `the current worker can explicitly recover an acknowledged ${outcome} registration`,
    async () => {
      const s = await pnyx.scenario()
      const {
        folder,
        fixture,
        worker,
        agent,
      } = await setup({ s })
      await worker.run({
        args: [
          'task',
          'status',
          'page',
          'paused',
          '--hold',
          '--note',
          'Register before listening',
        ],
      })
      const initialCard = s.task({ key: 'page' })
      let currentWorker = worker

      if (outcome === 'expired') {
        withWriter({
          hydraId: s.hydraId,
          fn: ({ writer }) => armLavish({
            writer,
            ref: 'page',
            id: 'administrative',
            page: fixture.page,
            executable: fixture.executable,
            meta: {
              actor: `worker:${initialCard.id}`,
              at: '2020-01-01T00:00:00.000Z',
            },
            worker: agent.env.PNYX_STEERING_WORKER,
          }),
        })
      } else {
        await worker.run({
          args: fixture.arm({
            task: 'page',
            id: 'administrative',
          }),
        })

        if (outcome === 'stale') {
          await s.owner({
            args: [
              'task',
              'detach',
              'page',
            ],
          })
          await s.owner({
            args: [
              'task',
              'status',
              'page',
              'working',
              '--note',
              'Replace the worker',
            ],
          })
          await s.owner({
            args: [
              'task',
              'start',
              'page',
            ],
          })
          currentWorker = s.as({ agent: await s.agent({ cwd: folder }) })
          assert.equal(
            await worker.refused({
              args: [
                'task',
                'source',
                'read',
                'page',
                'administrative',
              ],
            }),
            'STALE_CLAIM',
          )
        } else {
          await worker.run({
            args: [
              'task',
              'source',
              'stop',
              'page',
              'administrative',
            ],
          })
        }
      }

      const result = await captured({
        s,
        id: 'administrative',
      })
      assert.equal(
        result.outcome,
        outcome,
      )
      assert.equal(
        existsSync(join(
          folder,
          'calls.jsonl',
        )),
        false,
      )
      await readAndAck({
        s,
        worker: currentWorker,
        task: 'page',
        id: 'administrative',
      })
      await currentWorker.run({
        args: [
          'task',
          'status',
          'page',
          'working',
          '--note',
          'Verified the page; recover listening',
        ],
      })
      const args = fixture.arm({
        task: 'page',
        id: 'recovered',
        after: 'administrative',
        card: s.task({ key: 'page' }),
      })
      await currentWorker.run({ args })
      await until({
        what: 'recovered administrative stop listening',
        check: () => existsSync(join(
          folder,
          'listening',
        )),
      })
      await currentWorker.run({ args })
      assert.equal(
        source({
          s,
          id: 'administrative',
        }).state,
        'retired',
      )
      assert.equal(
        fixture.calls().filter(call => call.action === 'reply').length,
        1,
      )
      assert.equal(
        fixture.calls().filter(call => call.action === 'poll').length,
        1,
      )
      fixture.deliver({ body: 'session:\n  status: ended\n' })
      await captured({
        s,
        id: 'recovered',
      })
    },
  )
}

test(
  'a malformed final marker retains the raw round and stops rather than re-arming',
  async () => {
    const s = await pnyx.scenario()
    const {
      folder,
      fixture,
      worker,
    } = await setup({ s })
    await worker.run({
      args: fixture.arm({
        task: 'page',
        id: 'unknown',
      }),
    })
    await until({
      what: 'unknown response poll listening',
      check: () => existsSync(join(
        folder,
        'listening',
      )),
    })
    const body = 'session:\n  status: feedback\n  session_ended: "true"\nprompts[1]{tag,text}:\n  message,"Keep this content"\n'
    fixture.deliver({ body })
    const result = await captured({
      s,
      id: 'unknown',
    })
    assert.equal(
      result.terminal,
      true,
    )
    assert.equal(
      result.stdout,
      body,
    )
    await pnyx.restart()
    await readAndAck({
      s,
      worker,
      task: 'page',
      id: 'unknown',
    })
    await worker.refused({
      args: fixture.arm({
        task: 'page',
        id: 'unsafe',
        after: 'unknown',
        card: s.task({ key: 'page' }),
      }),
    })
    assert.equal(
      fixture.calls().length,
      1,
    )
    assert.equal(
      source({
        s,
        id: 'unknown',
      }).results[0]!.handled,
      undefined,
    )
  },
)
