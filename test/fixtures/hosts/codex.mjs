import { incorporateInboxNotice } from '../../inbox-fixture.ts'
import { appendFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

// active is the turn still running, the only one a steer may join.
let turn = 0, threadId, waiting, held, active, heldCompact = false
let compactStart
const path = process.env.FAKE_CODEX_TRANSCRIPT
const send = ({ ...message }) => process.stdout.write(`${JSON.stringify(message)}\n`)

const finish = ({
  id,
  text,
}) => {
  if (text === 'CRASH') {
    process.exit(9)
  }

  if (text === 'HOLD') {
    held = id

    return
  }

  if (text.includes('AUTO_COMPACT_HOLD')) {
    held = id
    send({
      method: 'item/started',
      params: {
        threadId,
        turnId: id,
        item: {
          type: 'contextCompaction',
          id: 'auto-compact-item',
        },
      },
    })

    return
  }

  if (text === 'STREAM') {
    held = id
    send({
      method: 'item/agentMessage/delta',
      params: {
        threadId: 'unrelated',
        turnId: id,
        itemId: 'other',
        delta: 'Hidden',
      },
    })
    send({
      method: 'item/agentMessage/delta',
      params: {
        threadId,
        turnId: id,
        itemId: 'answer',
        delta: 'Hello',
      },
    })
    send({
      method: 'item/agentMessage/delta',
      params: {
        threadId,
        turnId: id,
        itemId: 'answer',
        delta: ' world',
      },
    })

    return
  }

  if (text === 'USAGE') {
    for (const thread of [
      'unrelated',
      threadId,
    ]) {
      send({
        method: 'thread/tokenUsage/updated',
        params: {
          threadId: thread,
          turnId: id,
          tokenUsage: {
            last: { totalTokens: thread === threadId ? 5_000 : 1 },
            total: { totalTokens: 90_000 },
            modelContextWindow: 258_000,
          },
        },
      })
    }

    send({
      method: 'account/rateLimits/updated',
      params: {
        rateLimits: {
          primary: {
            usedPercent: 12,
            windowDurationMins: 300,
          },
        },
      },
    })
  }

  if (text === 'COMPACT') {
    send({
      method: 'item/completed',
      params: {
        threadId,
        turnId: id,
        item: {
          type: 'contextCompaction',
          id: 'compaction',
        },
      },
    })
  }

  const status = text === 'FAIL' ? 'failed' : 'completed'
  active = undefined
  appendFileSync(
    path,
    `${JSON.stringify({
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        content: [
          {
            type: 'output_text',
            text: `Codex: ${text}`,
          },
        ],
      },
    })}\n`,
  )
  send({
    method: 'turn/completed',
    params: {
      threadId,
      turn: {
        id,
        status,
        error: status === 'failed' ? { message: 'fixture failure' } : null,
      },
    },
  })
}

process.on(
  'SIGUSR1',
  () => {
    if (compactStart) {
      const start = compactStart
      compactStart = undefined
      start()

      return
    }

    if (heldCompact) {
      heldCompact = false
      send({
        method: 'item/completed',
        params: {
          threadId,
          turnId: held,
          item: {
            type: 'contextCompaction',
            id: 'compact-item',
          },
        },
      })
    }

    finish({
      id: held,
      text: 'released',
    })
  },
)
process.on(
  'SIGUSR2',
  () => {
    send({
      method: 'serverRequest/resolved',
      params: {
        threadId,
        requestId: 'approval',
      },
    })
    finish(waiting)
  },
)

// Listening from the start, as the test may send SIGHUP as soon as the thread request is logged; one held open per process.
const hangup = process.env.FAKE_CODEX_HOLD_OPEN
  ? new Promise(resolve => process.once(
    'SIGHUP',
    resolve,
  ))
  : undefined

createInterface({ input: process.stdin }).on(
  'line',
  line => {
    const message = JSON.parse(line)
    appendFileSync(
      process.env.FAKE_CODEX_LOG,
      `${line}\n`,
    )
    const {
      id,
      method,
      params,
    } = message

    if (method === 'initialize') {
      if (process.env.FAKE_CODEX_REFUSE === 'initialize') {
        send({ method: 'fixture/initializing' })

        return
      }

      const response = JSON.stringify({
        id,
        result: {},
      })
      process.stdout.write(response.slice(
        0,
        4,
      ))
      setImmediate(() => process.stdout.write(`${response.slice(4)}\n`))
    } else if (method === 'config/read') {
      send({
        id,
        result: {
          config: {
            approval_policy: 'never',
            sandbox_mode: 'danger-full-access',
          },
          origins: {},
        },
      })
    } else if (method === 'model/list') {
      send({
        id,
        result: {
          data: params.cursor
            ? [
              {
                id: 'catalog-id-two',
                model: 'gpt-catalog-two',
                displayName: 'Catalog Two',
                defaultReasoningEffort: 'medium',
              },
              ...(process.env.FAKE_CODEX_MODELS ?? '').split(',').filter(Boolean)
                .map(model => ({
                  id: model,
                  model,
                  displayName: model,
                })),
            ]
            : [
              {
                id: 'catalog-id-one',
                model: 'gpt-catalog-one',
                displayName: 'Catalog One',
                isDefault: true,
                defaultReasoningEffort: 'low',
              },
            ],
          nextCursor: params.cursor ? null : 'second-page',
        },
      })
    } else if (method === 'thread/start' || method === 'thread/resume') {
      if (process.env.FAKE_CODEX_REFUSE === method) {
        send({
          id,
          error: {
            code: -32000,
            message: 'fixture refused thread',
          },
        })

        return
      }

      threadId = params.threadId ?? '0199f00d-1111-7000-8000-000000000001'
      const opened = () => send({
        id,
        result: {
          thread: {
            id: threadId,
            path,
          },
        },
      })

      // A slow open, such as one starting many MCP servers, answers when the test sends SIGHUP.
      if (hangup) {
        void hangup.then(opened)
      } else {
        opened()
      }
    } else if (method === 'thread/compact/start') {
      const compactTurn = `turn-${++turn}`
      send({
        id,
        result: {},
      })

      const start = () => {
        send({
          method: 'turn/started',
          params: {
            threadId,
            turn: {
              id: compactTurn,
              status: 'inProgress',
              items: [],
              error: null,
            },
          },
        })

        if ([
          'hold',
          'hold-start',
        ].includes(process.env.FAKE_CODEX_COMPACT)) {
          heldCompact = true
          active = held = compactTurn
          send({
            method: 'item/started',
            params: {
              threadId,
              turnId: compactTurn,
              item: {
                type: 'contextCompaction',
                id: 'compact-item',
              },
            },
          })

          return
        }

        for (const method of [
          'item/started',
          'item/completed',
        ]) {
          send({
            method,
            params: {
              threadId,
              turnId: compactTurn,
              item: {
                type: 'contextCompaction',
                id: 'compact-item',
              },
            },
          })
        }

        const failed = process.env.FAKE_CODEX_COMPACT === 'fail'
        send({
          method: 'turn/completed',
          params: {
            threadId,
            turn: {
              id: compactTurn,
              status: failed ? 'failed' : 'completed',
              error: failed ? { message: 'Compaction fixture failure' } : null,
            },
          },
        })
      }

      if (process.env.FAKE_CODEX_COMPACT === 'hold-start') {
        compactStart = start
        send({ method: 'fixture/compact-ready' })
      } else {
        start()
      }
    } else if (method === 'turn/start') {
      const turnId = `turn-${++turn}`
      active = turnId
      // The turn answers the message, past the digest Pnyx puts first.
      const rawText = params.input[0].text.replace(
        /^<pnyx-digest[\s\S]*?<\/pnyx-digest>\n\n/,
        '',
      )
      const text = incorporateInboxNotice({
        text: rawText,
        env: process.env,
      })
      appendFileSync(
        path,
        `${JSON.stringify({
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [
              {
                type: 'input_text',
                text,
              },
            ],
          },
        })}\n`,
      )

      if (text === 'QUESTION' || text === 'ELICIT') {
        waiting = {
          id: turnId,
          text,
        }
        send(text === 'QUESTION'
          ? {
            id: 'approval',
            method: 'item/tool/requestUserInput',
            params: {
              threadId,
              turnId,
              itemId: 'ask-item',
              isBlocking: true,
              questions: [
                {
                  id: 'scheme',
                  header: 'Scheme',
                  question: 'Cover http links?',
                  options: [
                    {
                      label: 'Yes',
                      description: 'Test both schemes',
                    },
                    {
                      label: 'No',
                      description: 'Only https',
                    },
                  ],
                },
                {
                  id: 'name',
                  header: 'Name',
                  question: 'What should the test be called?',
                  isSecret: true,
                  options: null,
                },
              ],
            },
          }
          : {
            id: 'approval',
            method: 'mcpServer/elicitation/request',
            params: {
              threadId,
              turnId,
              serverName: 'tracker',
              mode: 'form',
              message: 'Pick a priority',
              requestedSchema: {
                type: 'object',
                properties: {
                  priority: {
                    type: 'string',
                    enum: [
                      'low',
                      'high',
                    ],
                  },
                },
                required: ['priority'],
              },
            },
          })
      } else if ([
        'DENY',
        'ALLOW',
        'FILE',
        'CANCEL',
        'PERMISSIONS_ALLOW',
        'PERMISSIONS_DENY',
      ].includes(text)) {
        waiting = {
          id: turnId,
          text,
        }

        if (text === 'FILE') {
          send({
            method: 'item/started',
            params: {
              threadId,
              turnId,
              item: {
                id: 'file-item',
                type: 'fileChange',
                changes: [
                  {
                    path: 'allowed.txt',
                    diff: '+approved',
                    kind: { type: 'add' },
                  },
                ],
              },
            },
          })
        }

        send({
          id: 'approval',
          method: text.startsWith('PERMISSIONS_') ? 'item/permissions/requestApproval' : text === 'FILE' ? 'item/fileChange/requestApproval' : 'item/commandExecution/requestApproval',
          params: {
            threadId,
            turnId,
            itemId: text === 'FILE' ? 'file-item' : 'command-item',
            ...(text.startsWith('PERMISSIONS_') ? {
              permissions: {
                network: { enabled: true },
                fileSystem: null,
              },
              reason: 'Network access for this turn',
            } : text === 'FILE' ? { reason: 'Write a file' } : {
              command: 'touch allowed.txt',
              cwd: process.cwd(),
              reason: 'Run a command',
            }),
          },
        })
      } else {
        // A command runs inside the turn before it answers.
        if (text === 'THINKING') {
          for (const method of [
            'item/started',
            'item/reasoning/textDelta',
            'item/completed',
          ]) {
            send({
              method,
              params: {
                threadId,
                turnId,
                item: {
                  id: 'reason-1',
                  type: 'reasoning',
                },
                delta: 'private reasoning',
              },
            })
          }
        }

        if (text === 'COMMAND') {
          const item = {
            id: 'command-run',
            type: 'commandExecution',
            command: 'pnpm test',
          }
          send({
            method: 'item/started',
            params: {
              threadId,
              turnId,
              item,
            },
          })
          send({
            method: 'item/completed',
            params: {
              threadId,
              turnId,
              item,
            },
          })
        }

        // Completion can arrive before the response to turn/start.
        finish({
          id: turnId,
          text,
        })
      }

      send({
        id,
        result: { turn: { id: turnId } },
      })
    } else if (method === 'turn/steer') {
      if (params.expectedTurnId !== active) {
        send({
          id,
          error: {
            code: -32600,
            message: 'no active turn to steer',
          },
        })

        return
      }

      appendFileSync(
        path,
        `${JSON.stringify({
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [
              {
                type: 'input_text',
                text: incorporateInboxNotice({
                  text: params.input[0].text,
                  env: process.env,
                }),
              },
            ],
          },
        })}\n`,
      )
      send({
        id,
        result: { turnId: active },
      })
    } else if (method === 'turn/interrupt') {
      if (process.env.FAKE_CODEX_REFUSE === 'interrupt') {
        send({
          id,
          error: {
            code: -32000,
            message: 'fixture refused interrupt',
          },
        })

        return
      }

      send({
        id,
        result: {},
      })
      send({
        method: 'turn/completed',
        params: {
          threadId,
          turn: {
            id: held,
            status: 'interrupted',
            error: null,
          },
        },
      })
    } else if (id === 'approval') {
      if (waiting.text === 'QUESTION' || waiting.text === 'ELICIT') {
        finish(waiting)

        return
      }

      if (waiting.text.startsWith('PERMISSIONS_')) {
        const expected = waiting.text === 'PERMISSIONS_ALLOW' ? { network: { enabled: true } } : {}

        if (message.result?.scope !== 'turn' || JSON.stringify(message.result?.permissions) !== JSON.stringify(expected)) {
          process.exit(8)
        }

        finish(waiting)

        return
      }

      const expected = [
        'ALLOW',
        'FILE',
      ].includes(waiting.text) ? 'accept' : 'decline'

      if (message.result?.decision !== expected) {
        process.exit(8)
      }

      finish(waiting)
    }
  },
)
