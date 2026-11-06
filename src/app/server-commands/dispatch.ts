import { AxiError } from 'axi-sdk-js'
import { hydraConfig } from '#hydra/config.ts'
import { hydraEvent } from '#hydra/hydra.ts'
import { HYDRA_CARD } from '#hydra/identity.ts'
import type { Catalog } from '#hydra/transcripts-catalog.ts'
import type { createCatalogIndex } from '#hydra/transcripts-catalog-index.ts'
import { THREAD_CURSOR } from '#hydra/transcripts-read.ts'
import { PASEO_HISTORY_CURSOR } from '#integrations/paseo/history.ts'
import { workerError, type createIndexSync } from '#oracle/index-sync.ts'
import { search as oracleSearch } from '#oracle/search.ts'
import { indexedThrough } from '#oracle/status.ts'
import { HydraError } from '#store/errors.ts'
import { nonblockingLocks } from '#store/storage.ts'
import type { Card } from '#tasks/model.ts'
import { findCard } from '#tasks/push-rules.ts'
import { harnessAccount } from '#workers/account-choice.ts'
import { candidates, effectiveDispatch } from '#workers/dispatch-config.ts'
import { knownHarness, providerIdOf } from '#workers/providers.ts'
import { replyRoute } from '#workers/reply-route.ts'
import type { createHost } from '#app/host.ts'
import type { HydraState } from '#app/model.ts'
import { saveEventId, savedReceipt, type SaveCommand } from '#app/save-receipts.ts'
import type { createServerClients } from '#app/server-clients.ts'
import { createHydra, editHydra, listHydras } from '#app/server-hydras.ts'
import { commandTimeout } from '#app/server-protocol.ts'
import { CLI_COMMANDS, type HydraClient } from '#app/server-transport.ts'
import { COMMAND_WORKER, type createServerWorkers } from '#app/server-workers.ts'
import { loadHydra } from '#app/store.ts'
import { withWriter } from '#app/writer.ts'
import type { createThreadSubscriptions } from '#app/thread-subscriptions.ts'

const ORACLE_LIMIT = 100

type ThreadSubscriptions = ReturnType<typeof createThreadSubscriptions>

// The page's WebSocket commands: the ones the server answers itself, then any CLI command the page may run.
export function createServerCommands({
  hydraId,
  url,
  open,
  state,
  homes,
  closed,
  send,
  kick,
  agents,
  catalogIndex,
  catalogCard,
  historyIndex,
  hydraSubscribers,
  subscriptionMap,
  bindThread,
  threadPage,
  startWorker,
}: {
  hydraId: string
  url: string
  open({ id }: { id: string }): Promise<string>
  state(): HydraState
  homes(): string[]
  closed(): boolean
  send: ReturnType<typeof createServerClients>['send']
  kick(): void
  agents: ReturnType<typeof createHost>
  catalogIndex: ReturnType<typeof createCatalogIndex>
  catalogCard({
    card,
    provider,
  }: {
    card: Card
    provider?: string
  }): Card
  historyIndex: ReturnType<typeof createIndexSync>
  hydraSubscribers: WeakSet<HydraClient>
  subscriptionMap: ThreadSubscriptions['subscriptionMap']
  bindThread: ThreadSubscriptions['bindThread']
  threadPage: ThreadSubscriptions['threadPage']
  startWorker: ReturnType<typeof createServerWorkers>['startWorker']
}) {
  const catalogReads = new WeakMap<HydraClient, {
    scope: string
    read: Promise<Catalog>
  }>()

  const runCommand = ({
    ws,
    message,
  }: Parameters<typeof attemptCommand>[0]) => nonblockingLocks.run(
    true,
    () => attemptCommand({
      ws,
      message,
    }),
  )

  const attemptCommand = ({
    ws,
    message,
  }: {
    ws: HydraClient
    message: {
      id?: unknown
      name?: unknown
      args?: unknown
    }
  }) => {
    const id = typeof message.id === 'string' ? message.id : null

    const fail = ({
      error,
      code,
      help,
    }: {
      error: string
      code: string
      help?: string[]
    }) => {
      let saved: boolean | undefined

      if (id && typeof message.name === 'string' && Array.isArray(message.args) && message.args.every(arg => typeof arg === 'string')) {
        const command: SaveCommand = {
          type: 'command',
          id,
          name: message.name,
          args: message.args,
        }

        if (saveEventId({ command })) {
          try {
            const receipt = savedReceipt({
              command,
              state: loadHydra({ hydraId }).state,
            })

            if (receipt) {
              send({
                ws,
                message: {
                  ...receipt,
                  type: 'receipt',
                  id,
                },
              })

              return
            }

            // A concurrent request may still commit after a lock or I/O failure.
            saved = code === 'VALIDATION_ERROR' || code === 'NO_ROUTE' ? false : undefined
          } catch { /* An unreadable log cannot establish whether the save committed. */ }
        }
      }

      send({
        ws,
        message: {
          type: 'error',
          id,
          error,
          code,
          help,
          saved,
        },
      })
    }

    const {
      name,
      args,
    } = message

    if (id === null) {
      return fail({
        error: 'command needs a string id',
        code: 'VALIDATION_ERROR',
      })
    }

    if ([
      'thread',
      'oracle',
      'reply',
      'task-message',
      'answer',
      'agent',
      'catalog',
      'hydras',
      'hydra-agent',
      'hydra-agent-change',
      'models',
      'compact',
    ].includes(String(name))) {
      if (!Array.isArray(args) || !args.every(a => typeof a === 'string')) {
        return fail({
          error: 'args must be strings',
          code: 'VALIDATION_ERROR',
        })
      }

      try {
        if (name === 'compact') {
          if (args.length < 1 || args.length > 2) {
            throw new HydraError({
              message: 'compact expects a card and an optional queued message ID',
              code: 'VALIDATION_ERROR',
            })
          }

          void agents.compact({
            card: args[0]!,
            sendNow: args[1],
          }).then(
            result => send({
              ws,
              message: {
                type: 'receipt',
                id,
                ...result,
              },
            }),
            (error: Error) => fail({
              error: error.message,
              code: error instanceof HydraError ? error.code : 'UNKNOWN',
            }),
          )
        } else if (name === 'models') {
          const harness = knownHarness({ name: args[0] })

          if (args.length < 1 || args.length > 2 || !harness) {
            throw new HydraError({
              message: 'models expects claude or codex and an optional account name',
              code: 'VALIDATION_ERROR',
            })
          }

          void agents.models({
            harness,
            account: args[1],
          })
            .then(models => send({
              ws,
              message: {
                type: 'receipt',
                id,
                models,
              },
            }))
            .catch((error: Error) => fail({
              error: error instanceof HydraError ? error.message : 'Harness model catalog unavailable. Reopen the picker to retry.',
              code: error instanceof HydraError ? error.code : 'CATALOG_UNAVAILABLE',
            }))
        } else if (name === 'catalog') {
          if (args.length !== 1) {
            throw new HydraError({
              message: 'catalog expects a card',
              code: 'VALIDATION_ERROR',
            })
          }

          const card = findCard({
            state: state(),
            ref: args[0],
          })
          const config = hydraConfig({ state: state() })
          const effective = effectiveDispatch()
          const receiving = card.id === HYDRA_CARD
            ? config.hydra.agent?.harness
              ?? effective.dispatch.rules.hydra?.candidates[0]?.harness
              ?? effective.dispatch.default[0]?.harness
            : card.agent?.provider
          const currentCard = catalogCard({
            card,
            provider: receiving,
          })
          const scope = JSON.stringify([
            card.id,
            receiving,
            state().projectsRevision,
          ])
          let entry = catalogReads.get(ws)

          if (entry?.scope !== scope) {
            const previous = entry?.read.catch(() => undefined)
            const next = {
              scope,
              read: Promise.resolve(previous).then(async () => {
                const native = await agents.catalogCommands({
                  card,
                  provider: receiving,
                })
                const catalog = await catalogIndex.read({
                  card: currentCard,
                  projects: state().projects,
                })

                return {
                  ...catalog,
                  suggestions: [
                    ...catalog.suggestions,
                    ...native,
                  ],
                  provider: receiving,
                }
              }),
            }
            catalogReads.set(
              ws,
              entry = next,
            )
            void next.read.catch(() => undefined).finally(() => {
              if (catalogReads.get(ws) === next) {
                catalogReads.delete(ws)
              }
            })
          }

          void entry.read.then(catalog => send({
            ws,
            message: {
              type: 'receipt',
              id,
              catalog,
            },
          })).catch(() => fail({
            error: 'Local catalog unavailable',
            code: 'CATALOG_UNAVAILABLE',
          }))
        } else if (name === 'oracle') {
          if (args.length > 3 || (args[2] !== undefined && args[2] !== 'hydra')) {
            throw new HydraError({
              message: 'oracle expects text, optional workspace and optional Hydra scope',
              code: 'VALIDATION_ERROR',
            })
          }

          const query = {
            text: args[0] ?? '',
            ...(args[1] ? { workspace: args[1] } : {}),
            ...(args[2] === 'hydra' ? { live: true } : {}),
            limit: ORACLE_LIMIT,
            highlight: false,
          }

          // Never rejects, so nothing is lost by not awaiting it.
          const answer = async () => {
            try {
              const indexed = indexedThrough({ hydraId })
              const behind = indexed === null || indexed < state().seq

              if (behind) {
                const failure = await historyIndex.ready()

                if (failure) {
                  return fail({
                    error: `Oracle index could not catch up: ${failure.message}`,
                    code: failure.code,
                  })
                }
              } else {
                historyIndex.changed()
              }

              send({
                ws,
                message: {
                  type: 'receipt',
                  id,
                  ...oracleSearch({
                    hydraId,
                    query,
                  }),
                },
              })
            } catch (error) {
              fail({
                error: (error as Error).message,
                code: error instanceof HydraError ? error.code : 'UNKNOWN',
              })
            }
          }

          answer()
        } else if (name === 'hydra-agent-change') {
          const choice = args[1]

          if (args.length !== 2 || (choice !== 'inscribe' && choice !== 'compact' && choice !== 'neither')) {
            throw new HydraError({
              message: 'Choose inscribe, compact or neither for the held message',
              code: 'VALIDATION_ERROR',
            })
          }

          const result = agents.changeAgent({
            id: args[0]!,
            choice,
          })
          kick()
          send({
            ws,
            message: {
              type: 'receipt',
              id,
              ...result,
            },
          })
        } else if (name === 'hydra-agent') {
          if (args.length !== 1) {
            throw new HydraError({
              message: 'hydra-agent expects one agent configuration',
              code: 'VALIDATION_ERROR',
            })
          }

          const agent = candidates({ value: [JSON.parse(args[0]!)] })[0]!

          if (agent.account) {
            // Refuses an account not registered for this harness.
            harnessAccount({
              effective: effectiveDispatch(),
              harness: agent.harness,
              prefer: agent.account,
            })
          }

          const {
            previous,
            running,
          } = withWriter({
            hydraId,
            fn: ({ writer }) => {
              const config = hydraConfig({
                state: writer.state,
                id: hydraId,
              })

              if (Object.hasOwn(
                writer.state.eventIds,
                id,
              )) {
                return {
                  previous: config.hydra.agent,
                  running: undefined,
                }
              }

              if (config.hydra.kind === 'firstmate') {
                throw new HydraError({
                  message: 'Firstmate manages this Hydra’s agent',
                  code: 'NO_ROUTE',
                })
              }

              const decision = hydraEvent({
                state: writer.state,
                cardId: HYDRA_CARD,
                meta: {
                  id,
                  at: new Date().toISOString(),
                  actor: 'web',
                },
                change: {
                  type: 'board.configured',
                  data: {
                    ...config,
                    hydra: {
                      ...config.hydra,
                      agent,
                    },
                  },
                },
              })

              if ('event' in decision) {
                writer.append({ event: decision.event })
              }

              const running = writer.state.cards[HYDRA_CARD]?.agent

              return {
                previous: config.hydra.agent,
                running,
              }
            },
          })
          kick()

          // A new permission mode reaches Hydra's running turn at once; other settings wait for the next message.
          if (agent.mode && agent.mode !== previous?.mode && running?.host === 'pnyx'
            && running.provider === providerIdOf({ harness: agent.harness })) {
            void agents.set({
              card: HYDRA_CARD,
              setting: 'mode',
              value: agent.mode,
              actor: 'web',
            })
              .catch((error: Error) => console.error(`pnyx-axi serve: Hydra kept its mode: ${error.message}`))
          }

          send({
            ws,
            message: {
              type: 'receipt',
              id,
              saved: true,
            },
          })
        } else if (name === 'hydras') {
          hydraSubscribers.add(ws)
          const [
            action,
            first,
            second,
            third,
          ] = args
          const reply = ({
            open,
            creation,
          }: {
            open?: string
            creation?: {
              attempt: string
              hydraId: string
              status: 'saved'
              mount: 'pending'
            }
          } = {}) => send({
            ws,
            message: {
              type: 'receipt',
              id,
              hydraId,
              hydras: listHydras(),
              ...(open ? { url: open } : {}),
              ...(creation ? { creation } : {}),
            },
          })

          if (action === 'create') {
            if (args.length > 4 || (second !== undefined && !/^[a-zA-Z0-9._:-]{1,128}$/.test(second))) {
              throw new HydraError({
                message: 'Invalid Hydra creation attempt',
                code: 'VALIDATION_ERROR',
              })
            }

            const created = createHydra({
              name: first?.trim().slice(
                0,
                100,
              ) ?? '',
              icon: third || undefined,
              attempt: second,
            })
            const opening = open({ id: created })

            if (second) {
              reply({
                open: new URL(
                  `/hydra/${created}/`,
                  url,
                ).href,
                creation: {
                  attempt: second,
                  hydraId: created,
                  status: 'saved',
                  mount: 'pending',
                },
              })
              void opening.catch(() => {})
            } else {
              void opening.then(
                open => reply({ open }),
                (error: Error) => fail({
                  error: error.message,
                  code: error instanceof HydraError ? error.code : 'UNKNOWN',
                }),
              )
            }
          } else if (action === 'open' && first) {
            void open({ id: first }).then(
              open => reply({ open }),
              (error: Error) => fail({
                error: error.message,
                code: error instanceof HydraError ? error.code : 'UNKNOWN',
              }),
            )
          } else if (action === 'edit' && first && (second?.trim() || third) && listHydras().some(b => b.id === first)) {
            editHydra({
              id: first,
              name: second?.trim().slice(
                0,
                100,
              ),
              icon: third || undefined,
            })
            reply()
          } else if (action === 'move' && first && second && listHydras().some(b => b.id === first)) {
            editHydra({
              id: first,
              position: Number(second),
            })
            reply()
          } else if (action === undefined) {
            reply()
          } else {
            throw new HydraError({
              message: 'Hydras expects nothing, open <id>, create <name> [<attempt> <icon>], edit <id> <name> [<icon>] or move <id> <position>',
              code: 'VALIDATION_ERROR',
            })
          }
        } else if (name === 'thread') {
          const map = subscriptionMap({ card: args[0] ?? '' })
          const old = map.get(ws); old?.watcher?.close(); map.delete(ws)

          if (!args[0]) {
            send({
              ws,
              message: {
                type: 'receipt',
                id,
              },
            })

            return
          }

          const card = findCard({
            state: state(),
            ref: args[0],
          })

          const cursor = card.agent?.paseoAgentId ? PASEO_HISTORY_CURSOR : THREAD_CURSOR
          const cursorLimit = card.agent?.paseoAgentId ? 600 : 200

          if (args[1] !== undefined && (args[1].length > cursorLimit || !cursor.test(args[1]))) {
            throw new HydraError({
              message: 'invalid thread cursor',
              code: 'VALIDATION_ERROR',
            })
          }

          bindThread({
            ws,
            card,
          })
          const sub = map.get(ws)!
          void threadPage({
            sub,
            card,
            before: args[1],
          }).then(
            thread => {
              if (ws.readyState === ws.OPEN) {
                send({
                  ws,
                  message: {
                    type: 'receipt',
                    id,
                    thread,
                  },
                })
              }
            },
            (error: Error) => fail({
              error: error.message,
              code: error instanceof HydraError ? error.code : 'UNKNOWN',
            }),
          )
        } else {
          const agent = name === 'agent'
          const answering = name === 'answer'

          const valid = agent
            ? args.length === 4 && !!args[3]
            : answering
              ? args.length === 5 && args.every(Boolean) && args[2].length <= 32000
              : args.length === 3 && !!args[2] && args[1].length <= 32000

          if (!valid) {
            throw new HydraError({
              message: agent
                ? 'agent expects card, setting, value and idempotency key'
                : answering ? 'answer expects card, request key, answer, idempotency key and request id' : 'reply expects card, text and idempotency key',
              code: 'VALIDATION_ERROR',
            })
          }

          const card = findCard({
            state: state(),
            ref: args[0],
          })

          const found = replyRoute({
            card,
            homes: homes(),
          })

          if ('reason' in found && name !== 'task-message') {
            throw new HydraError({
              message: `${found.reason}${agent ? '' : ' Your draft stays here.'}`,
              code: 'NO_ROUTE',
            })
          }

          // A setting change is sent like a reply: `pnyx-axi agent` picks the harness's command and reads
          // it back. Its setting and value come last, after --, so neither can read as a flag.
          // An answer's values are passed as --name=value, so none can read as a flag.
          const [
            command,
            rest,
          ] = agent
            ? [
              [
                'agent',
                card.id,
                '--idempotency-key',
                args[3]!,
              ],
              [
                '--',
                args[1]!,
                args[2]!,
              ],
            ]
            : answering
              ? [
                [
                  'reply',
                  card.id,
                  `--answer=${args[1]}`,
                  `--json=${args[2]}`,
                  `--idempotency-key=${args[3]}`,
                  `--seen=${args[4]}`,
                ],
                [],
              ]
              : [
                [
                  'reply',
                  card.id,
                  '--text',
                  args[1],
                  '--idempotency-key',
                  args[2],
                  ...(name === 'task-message' ? ['--task-message'] : []),
                ],
                [],
              ]

          if (closed()) {
            return fail({
              error: 'Pnyx is shutting down',
              code: 'UNAVAILABLE',
            })
          }

          startWorker({
            args: [
              ...command,
              '--hydra',
              hydraId,
              '--actor',
              'web',
              ...homes().flatMap(h => [
                '--home',
                h,
              ]),
              ...rest,
            ],
            done: ({
              error,
              stdout,
            }) => {
              kick()

              if (error) {
                const known = workerError({ stdout })

                if (known) {
                  fail({
                    error: known.message,
                    code: known.code,
                    help: known.help,
                  })
                } else {
                  fail({
                    error: 'Reply could not be confirmed; check receipts before sending again',
                    code: 'DELIVERY_UNKNOWN',
                  })
                }
              } else {
                try {
                  send({
                    ws,
                    message: {
                      type: 'receipt',
                      id,
                      ...JSON.parse(stdout),
                    },
                  })
                } catch {
                  fail({
                    error: 'Reply receipt unavailable; check history',
                    code: 'DELIVERY_UNKNOWN',
                  })
                }
              }
            },
          })
        }
      } catch (error) {
        fail({
          error: (error as Error).message,
          code: error instanceof HydraError || error instanceof AxiError ? error.code : 'UNKNOWN',
        })
      }

      return
    }

    if (typeof name !== 'string' || !(CLI_COMMANDS as readonly string[]).includes(name)) {
      return fail({
        error: `unknown command: ${String(name)}`,
        code: 'NOT_FOUND',
        help: [`Use one of ${CLI_COMMANDS.join(', ')}`],
      })
    }

    if (!Array.isArray(args) || !args.every(a => typeof a === 'string')) {
      return fail({
        error: 'args must be [string, ...]',
        code: 'VALIDATION_ERROR',
      })
    }

    if (args.some(a => a === '--hydra' || a.startsWith('--hydra='))) {
      return fail({
        error: `--hydra is not allowed; this server writes Hydra ${hydraId}`,
        code: 'VALIDATION_ERROR',
      })
    }

    const actor = name === 'history' || name === 'card' || name === 'integrations' || args.some(a => a === '--actor' || a.startsWith('--actor=')) ? [] : [
      '--actor',
      'web',
    ]

    startWorker({
      file: COMMAND_WORKER,
      timeout: commandTimeout({
        name,
        args,
      }),
      args: [
        name,
        ...args,
        ...actor,
        '--hydra',
        hydraId,
      ],
      done: ({
        error,
        stdout,
      }) => {
        kick()

        try {
          const result = JSON.parse(stdout)

          if (error) {
            if (typeof result.error?.message === 'string' && typeof result.error.code === 'string') {
              fail({
                error: result.error.message,
                code: result.error.code,
                help: result.error.help,
              })

              return
            }

            throw error
          }

          send({
            ws,
            message: {
              ...result,
              type: 'receipt',
              id,
            },
          })
        } catch {
          fail({
            error: 'Command could not be confirmed; check history before sending again',
            code: 'DELIVERY_UNKNOWN',
          })
        }
      },
    })
  }

  return {
    runCommand,
    catalogReads,
  }
}
