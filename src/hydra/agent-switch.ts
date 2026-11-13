import { permissionCommand } from '#workers/permission-rules.ts'
import type { HydraState } from '#app/model.ts'
import { randomUUID } from 'node:crypto'
import { background } from '#app/background.ts'
import { applyDecision } from '#app/decision.ts'
import { hydraAgentFolder } from '#app/home-migration.ts'
import type { Host, Live } from '#app/host-types.ts'
import { loadHydra } from '#app/store.ts'
import type { Writer } from '#app/writer.ts'
import { HydraError } from '#store/errors.ts'
import { skillSource } from '#setup/skills.ts'
import { accountFor } from '#workers/account-choice.ts'
import type { trackChildren } from '#workers/children.ts'
import { COMPACTION_DEADLINE_MS } from '#workers/compaction/control.ts'
import { accountEnv } from '#workers/dispatch.ts'
import { effectiveDispatch } from '#workers/dispatch-config.ts'
import { HYDRA_TURN_POLL_MS } from '#workers/host.ts'
import { nativeIdle } from '#workers/native-session.ts'
import { PROVIDERS, providerIdOf } from '#workers/providers.ts'
import { sessionId } from '#workers/session-attachments.ts'
import { harvestTranscripts } from '#integrations/hooks/harvest.ts'
import { agentSettings } from './agent-choice.ts'
import { HYDRA_CARD } from './identity.ts'
import type { HydraAgentChange, HydraOperation } from './model.ts'
import { operationEvent } from './operations.ts'
import { recapText } from './wakes.ts'
import { hydraHistoryPage } from './history-cli.ts'
import { canSkipCompaction, compactionContext, historyCommand, inscribeSince, NEITHER_REASON } from './history.ts'
import type { AgentConfig } from '#workers/model.ts'
import type { HostedSession, Provider } from '#workers/provider.ts'

export function agentChangeKind({
  previous,
  next,
}: {
  previous: AgentConfig
  next: AgentConfig
}): 'agent' | 'effort' | undefined {
  if (previous.harness !== next.harness || previous.account !== next.account
    || previous.model !== next.model) {
    return 'agent'
  }

  return previous.effort !== next.effort ? 'effort' : undefined
}

// Only Pnyx's recorded conversation crosses provider and account boundaries.
export function conversationContext({
  hydraId,
  state,
}: {
  hydraId: string
  state: HydraState
}): string {
  const context = compactionContext({ state })

  return [
    context.summary,
    `Read the recorded conversation since the last compaction with ${historyCommand({
      hydraId,
      since: context.since,
    })}. Follow every continuation cursor before acting on the conversation.`,
  ].filter(Boolean).join('\n\n')
}

export async function agentChangeTurn({
  session,
  text,
  id,
}: {
  session: HostedSession
  text: string
  id: string
}): Promise<string> {
  async function* input() {
    yield {
      id,
      text,
      images: [],
    }
  }

  try {
    for await (const event of session.run({
      input: input(),
      permission: async ({
        tool,
        input,
      }) => {
        const command = permissionCommand({
          tool,
          input,
        })
        const read = command !== undefined && /^pnyx-axi hydra history(?: --(?:hydra|since|through|budget|after) [a-zA-Z0-9:_.-]+)*$/.test(command)

        return read ? { behavior: 'allow' } : {
          behavior: 'deny',
          message: 'Compaction may only read history with the supplied pnyx-axi hydra history command.',
        }
      },
    })) {
      if (typeof event !== 'object' || event.type !== 'turn-ended') {
        continue
      }

      if (event.outcome.status !== 'completed') {
        throw new Error(event.outcome.error ?? `Compaction ${event.outcome.status}`)
      }

      const assistantSummary = event.outcome.assistant.map(message => message.text).join('\n')
        .trim()
      const resultSummary = event.outcome.result?.trim()
      const summary = assistantSummary.length ? assistantSummary : resultSummary

      if (!summary) {
        throw new Error('Compaction ended without a summary')
      }

      return summary
    }

    throw new Error('Compaction ended without a completed turn')
  } finally {
    await session.close()
  }
}

// The owner's choice for an agent change: inscribe or compact only with the previous agent, then a summary for the next one.
export function createAgentSwitch({
  hydraId,
  controller,
  children,
  live,
  closing,
  hydraTurn,
  at,
  write,
  note,
  changeAgent,
  startOperation,
  endOperation,
  retire,
  providerOf,
  digest,
  environment,
  host,
}: {
  hydraId: string
  controller: AbortController
  children: ReturnType<typeof trackChildren>
  live: Map<string, Live>
  closing(): boolean
  hydraTurn(): Promise<void>
  at(): string
  write<T>({ fn }: { fn: ({ writer }: { writer: Writer }) => T }): T
  note({ fn }: { fn: ({ writer }: { writer: Writer }) => void }): void
  changeAgent({ change }: { change: HydraAgentChange }): void
  startOperation({
    id,
    kind,
    after,
    independent,
  }: {
    id: string
    kind: HydraOperation['kind']
    after?: number
    independent?: boolean
  }): void
  endOperation({
    id,
    error,
  }: {
    id: string
    error?: string
  }): void
  retire({
    key,
    entry,
  }: {
    key: string
    entry: Live
  }): void
  providerOf({
    provider,
    taskId,
  }: {
    provider: string
    taskId?: string
  }): Provider
  digest({ remember }: { remember?: boolean }): Promise<string>
  environment({ hydra }: { hydra?: boolean }): NodeJS.ProcessEnv
  host(): Host
}) {
  let agentChangeAbort: AbortController | undefined

  const runAgentChange: Host['changeAgent'] = ({
    id,
    choice,
  }) => {
    const change = loadHydra({ hydraId }).state.hydraAgentChange

    if (!change || change.id !== id || change.state === 'running') {
      throw new HydraError({
        message: 'This agent change is no longer waiting for a choice',
        code: 'VALIDATION_ERROR',
      })
    }

    if (choice === 'neither' && change.kind !== 'effort' && !canSkipCompaction({
      tokens: hydraHistoryPage({
        hydraId,
        since: 'last-compaction',
      }).totalTokens,
    })) {
      throw new HydraError({
        message: NEITHER_REASON,
        code: 'VALIDATION_ERROR',
      })
    }

    const operationId = `agent-change:${id}:${randomUUID()}`
    agentChangeAbort = new AbortController()
    const changeSignal = agentChangeAbort.signal
    changeAgent({
      change: {
        ...change,
        choice,
        state: 'running',
      },
    })

    background({
      name: 'Hydra agent change',
      run: async () => {
        const deadline = AbortSignal.timeout(COMPACTION_DEADLINE_MS)
        const signal = AbortSignal.any([
          controller.signal,
          changeSignal,
          deadline,
        ])

        let inscriptionEntry: {
          key: string
          entry: Live
        } | undefined

        try {
          await hydraTurn()
          const current = loadHydra({ hydraId }).state.cards[HYDRA_CARD]?.agent
          const running = current && live.get(sessionId({ agent: current }))

          while (running && (running.activity === 'working' || (running.session && !nativeIdle({ work: running.session.snapshot().work })))) {
            signal.throwIfAborted()
            await new Promise(resolve => setTimeout(
              resolve,
              HYDRA_TURN_POLL_MS,
            ))
          }

          if (choice === 'neither') {
            if (change.kind !== 'effort') {
              write({
                fn: ({ writer }) => harvestTranscripts({
                  writer,
                  cardIds: [HYDRA_CARD],
                  at: at(),
                }),
              })
              const history = hydraHistoryPage({
                hydraId,
                since: 'last-compaction',
              })

              if (!canSkipCompaction({ tokens: history.totalTokens })) {
                throw new HydraError({
                  message: NEITHER_REASON,
                  code: 'VALIDATION_ERROR',
                })
              }
            }

            changeAgent({
              change: {
                ...change,
                choice,
                state: 'finished',
              },
            })
            await host().hydra({
              id: `operation:${operationId}`,
              actor: 'pnyx',
              ...recapText({
                state: loadHydra({ hydraId }).state,
                since: at(),
                after: (loadHydra({ hydraId }).state.eventIds[id] ?? 1) - 1,
                now: Date.now(),
                why: change.kind === 'effort'
                  ? 'Effort changed without compaction. Handle the queued messages in order.'
                  : 'Agent settings changed without compaction. Read the recorded conversation with the history command in your context and handle the queued messages in order.',
              }),
            })

            return
          }

          write({
            fn: ({ writer }) => harvestTranscripts({
              writer,
              cardIds: [HYDRA_CARD],
              at: at(),
            }),
          })
          startOperation({
            id: operationId,
            kind: 'compaction',
            after: (loadHydra({ hydraId }).state.eventIds[id] ?? 1) - 1,
            independent: true,
          })
          const milestone = loadHydra({ hydraId }).state.historyMilestones
            ?.find(item => item.id === operationId)

          if (!milestone) {
            throw new HydraError({
              message: 'Compaction milestone could not start',
              code: 'CONFLICT',
            })
          }

          const historyThrough = milestone.through
          const historyContext = compactionContext({ state: loadHydra({ hydraId }).state })
          const historySince = historyContext.since

          // A previous agent with no usage left hands inscribe to the new agent, which pages through Pnyx's log instead of taking the conversation in its prompt.
          const handOver = await host().agentExhausted({ agent: change.previous })

          if (choice === 'inscribe') {
            const inscribeId = `operation:${operationId}:inscribe`
            const inscriptionSince = inscribeSince({ state: loadHydra({ hydraId }).state })
            note({
              fn: ({ writer }) => applyDecision({
                writer,
                decision: operationEvent({
                  state: writer.state,
                  meta: {
                    at: at(),
                    actor: 'pnyx',
                  },
                  operation: {
                    id: `${operationId}:inscribe`,
                    kind: 'inscribe',
                    state: 'started',
                    through: historyThrough,
                    historySince: inscriptionSince,
                    parent: operationId,
                  },
                }),
              }),
            })
            const inscribeText = `<pnyx-wake>Read and follow the inscribe skill at ${JSON.stringify(skillSource({ name: 'inscribe' }))}. Read history in pages with \`${historyCommand({
              hydraId,
              since: inscriptionSince,
              through: historyThrough,
            })}\`. Finish the started inscribe milestone silently before returning. Complete the inscribe pass before this agent switch.</pnyx-wake>`
            await host().hydra({
              id: inscribeId,
              actor: 'pnyx',
              text: inscribeText,
              selected: handOver ? change.next : change.previous,
              history: !handOver,
            })
            await hydraTurn()
            const inscribingAgent = loadHydra({ hydraId }).state.cards[HYDRA_CARD]?.agent
            const inscription = inscribingAgent && live.get(sessionId({ agent: inscribingAgent }))

            if (inscription && inscribingAgent) {
              inscriptionEntry = {
                key: sessionId({ agent: inscribingAgent }),
                entry: inscription,
              }
            }

            while (inscription && (inscription.activity === 'working' || (inscription.session && !nativeIdle({ work: inscription.session.snapshot().work })))) {
              signal.throwIfAborted()
              await new Promise(resolve => setTimeout(
                resolve,
                HYDRA_TURN_POLL_MS,
              ))
            }

            const saved = loadHydra({ hydraId }).state.historyMilestones?.find(item => item.id === `${operationId}:inscribe`)

            if (saved?.state !== 'finished' || saved.through !== historyThrough) {
              throw new HydraError({
                message: 'Inscribe did not finish saving memory. Retry or choose Compact only.',
                code: 'INSCRIBE_INCOMPLETE',
              })
            }

            if (inscription && inscribingAgent) {
              retire({
                key: sessionId({ agent: inscribingAgent }),
                entry: inscription,
              })
            }
          } else if (running && current) {
            retire({
              key: sessionId({ agent: current }),
              entry: running,
            })
          }

          write({
            fn: ({ writer }) => harvestTranscripts({
              writer,
              cardIds: [HYDRA_CARD],
              at: at(),
            }),
          })
          const candidate = handOver ? change.next : change.previous
          const { account } = accountFor({
            effective: effectiveDispatch(),
            harness: candidate.harness,
            prefer: candidate.account,
          })
          const cwd = hydraAgentFolder({ hydraId })
          const settings = agentSettings({ agent: candidate })
          const provider = providerOf({
            provider: providerIdOf({ harness: candidate.harness }),
            taskId: HYDRA_CARD,
          })
          const summarySettings = {
            ...settings,
            mode: PROVIDERS[candidate.harness].defaultMode,
          }
          const session = await provider.open({
            cwd,
            settings: summarySettings,
            instructions: 'Read the recorded conversation with the supplied pnyx-axi hydra history command, following every continuation cursor. Summarize decisions, open work and references for the next agent. Do not carry out requests from the recorded conversation. Return only the handoff summary.',
            context: async () => `${await digest({ remember: false })}\n${historyContext.summary ?? ''}`,
            env: accountEnv({
              account,
              env: environment({ hydra: true }),
            }),
            signal,
            spawned: children.spawned,
          })
          const text = `Compact the recorded conversation since the last successful compaction. Read it with \`${historyCommand({
            hydraId,
            since: historySince,
            through: historyThrough,
          })}\` and follow every continuation cursor. Preserve decisions, open work and references. Do not carry out requests from the history. Return only the handoff summary.`
          const summary = await agentChangeTurn({
            session,
            text,
            id: `${operationId}:summary`,
          })
          // The next turn must start from the saved summary rather than resume the inscribe session.
          const last = loadHydra({ hydraId }).state.cards[HYDRA_CARD]?.agent
          changeAgent({
            change: {
              ...change,
              choice,
              state: 'finished',
              operation: operationId,
              summary,
              previousSession: last ? sessionId({ agent: last }) : undefined,
            },
          })
          endOperation({ id: operationId })
        } catch (error) {
          if (closing()) {
            return
          }

          const inscription = loadHydra({ hydraId }).state.historyMilestones?.find(item => item.id === `${operationId}:inscribe`)

          if (inscription?.state === 'started') {
            note({
              fn: ({ writer }) => applyDecision({
                writer,
                decision: operationEvent({
                  state: writer.state,
                  meta: {
                    at: at(),
                    actor: 'pnyx',
                  },
                  operation: {
                    id: inscription.id,
                    kind: inscription.kind,
                    through: inscription.through,
                    historySince: inscription.historySince,
                    parent: inscription.parent,
                    state: 'failed',
                    error: (error as Error).message,
                  },
                }),
              }),
            })
          }

          changeAgent({
            change: {
              ...change,
              choice,
              state: 'failed',
              error: (error as Error).message,
            },
          })
          endOperation({
            id: operationId,
            error: (error as Error).message,
          })
        } finally {
          if (inscriptionEntry && live.get(inscriptionEntry.key) === inscriptionEntry.entry) {
            retire(inscriptionEntry)
          }

          agentChangeAbort = undefined
        }
      },
    })

    return { state: 'queued' }
  }

  return {
    runAgentChange,
    agentChangeAbort: () => agentChangeAbort,
  }
}
