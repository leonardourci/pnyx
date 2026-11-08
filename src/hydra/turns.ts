import { nativeIdle } from '#workers/native-session.ts'
import { createDigestContext } from './digest-context.ts'
import { agentChangeKind, conversationContext } from './agent-switch.ts'
import { agentSettings, hydraCandidate } from './agent-choice.ts'
import { hydraConfig } from './config.ts'
import { hydraDigest } from './digest.ts'
import { QUIET_REPLY, hydraEvent, reportActor } from './hydra.ts'
import { HYDRA_CARD } from './identity.ts'
import { taskMention } from './mentions.ts'
import type { HydraMessage } from './model.ts'
import type { createHydraOperations, createHydraOutage } from './operations.ts'
import type { createWakeQueue } from './wake-queue.ts'
import { REPLY_RULES, WAKE_HANDLED, sealed, wakesThrough } from './wakes.ts'
import { ownerActor } from '#app/actors.ts'
import { HYDRA_COMMANDS } from '#app/command-registry.ts'
import { applyDecision } from '#app/decision.ts'
import { hydraAgentFolder } from '#app/home-migration.ts'
import type { Host, Live } from '#app/host-types.ts'
import { loadHydra } from '#app/store.ts'
import type { Writer } from '#app/writer.ts'
import { harvestTranscripts } from '#integrations/hooks/harvest.ts'
import { memoryConditions } from '#memory/conditions.ts'
import { ownerMemory } from '#memory/owner-memory.ts'
import { projectDigest } from '#projects/context.ts'
import { activeHelperBatches, failedBatches, helperLeases, outcomeLines, ownerOutcomes } from '#routine-helper/state.ts'
import { setupCheck, setupDigest } from '#setup/check.ts'
import { prepareHydraFolder } from '#setup/skills.ts'
import { HydraError } from '#store/errors.ts'
import type { Card } from '#tasks/model.ts'
import { decidePush } from '#tasks/push.ts'
import { restartCommand, upgradeCommand } from '#upgrade/model.ts'
import type { upgradeQueue } from '#upgrade/queue.ts'
import { accountFor, harnessAccount } from '#workers/account-choice.ts'
import type { trackChildren } from '#workers/children.ts'
import { compactCommand } from '#workers/compaction/state.ts'
import { accountEnvironment } from '#workers/dispatch.ts'
import { effectiveDispatch, loginFolder } from '#workers/dispatch-config.ts'
import { HYDRA_TURN_POLL_MS, sameChosenSettings } from '#workers/host.ts'
import type { AgentRef } from '#workers/model.ts'
import type { HostedSession, Provider } from '#workers/provider.ts'
import { harnessOf, providerIdOf } from '#workers/providers.ts'
import { sessionId, withoutInterrupted } from '#workers/session-attachments.ts'
import { copyTagged } from '#workers/tagged-updates.ts'

const HYDRA_CONTEXT_TOKENS = 200_000

// Hydra's turns: admitting and starting one, the context its session opens with, and what Hydra's live session does as a turn starts, finishes or ends.
export function createHydraTurns({
  hydraId,
  live,
  queuedHydra,
  closing,
  changed,
  queued,
  controller,
  children,
  upgrades,
  at,
  write,
  note,
  record,
  stoppedFor,
  helperPending,
  providerOf,
  environment,
  sessionKey,
  open,
  retire,
  back,
  takeRecap,
  startFailed,
  mainTasks,
  wakeTasks,
  readWake,
  finishReading,
  turnEnded,
  readThrough,
  handBack,
  armWake,
}: {
  hydraId: string
  live: Map<string, Live>
  queuedHydra: Set<string>
  closing(): boolean
  changed(): void
  queued(): void
  controller: AbortController
  children: ReturnType<typeof trackChildren>
  upgrades: ReturnType<typeof upgradeQueue>
  at(): string
  write<T>({ fn }: { fn: ({ writer }: { writer: Writer }) => T }): T
  note({ fn }: { fn: ({ writer }: { writer: Writer }) => void }): void
  record({
    writer,
    agent,
    input,
    actor,
  }: {
    writer: Writer
    agent: AgentRef
    input: Record<string, unknown>
    actor: string
  }): void
  stoppedFor: ReturnType<typeof createHydraOperations>['stoppedFor']
  helperPending(): boolean
  providerOf({ provider }: { provider: string }): Provider
  environment({ hydra }: { hydra?: boolean }): NodeJS.ProcessEnv
  sessionKey({ agent }: { agent: AgentRef }): string
  open({
    card,
    session,
  }: {
    card: Card & { agent: AgentRef }
    session?: HostedSession
  }): Live
  retire({
    key,
    entry,
  }: {
    key: string
    entry: Live
  }): void
  back: ReturnType<typeof createHydraOutage>['back']
  takeRecap: ReturnType<typeof createHydraOutage>['takeRecap']
  startFailed: ReturnType<typeof createHydraOutage>['startFailed']
  mainTasks: ReturnType<typeof createWakeQueue>['mainTasks']
  wakeTasks: ReturnType<typeof createWakeQueue>['wakeTasks']
  readWake: ReturnType<typeof createWakeQueue>['readWake']
  finishReading: ReturnType<typeof createWakeQueue>['finishReading']
  turnEnded: ReturnType<typeof createWakeQueue>['turnEnded']
  readThrough: ReturnType<typeof createWakeQueue>['readThrough']
  handBack: ReturnType<typeof createWakeQueue>['handBack']
  armWake: ReturnType<typeof createWakeQueue>['armWake']
}) {
  let hydraTurn = Promise.resolve()
  const automaticCompactions = new Set<string>()
  let outcomesPresented = 0
  const helperBatchesPresented = new Set<string>()
  const hydraInstructions = () =>
    `You are Hydra for Pnyx Hydra "${hydraId}". Your contract is AGENTS.md in your current folder; follow it. Use pnyx-axi with --hydra ${hydraId}; PNYX_ACTOR=hydra is already set. Projects attach later; your current folder belongs to Hydra.`

  let memoryStamp: string | undefined

  const digest = async ({
    remember = true,
    previousDigest,
    checkpointed = false,
    onlyTasks,
  }: {
    remember?: boolean
    previousDigest?: string
    checkpointed?: boolean
    onlyTasks?: string[]
  } = {}) => {
    const owner = ownerMemory()
    const state = loadHydra({ hydraId }).state

    if (onlyTasks) {
      return hydraDigest({
        hydraId,
        state,
        owner,
        onlyTasks,
        previousDigest,
        checkpointed,
        conditions: memoryConditions(),
      })
    }

    const [
      projects,
      items,
    ] = await Promise.all([
      projectDigest({ state }),
      setupCheck({
        hydraId,
        state,
      }),
    ])

    if (remember) {
      memoryStamp = JSON.stringify({
        owner,
        hydra: state.hydraMemory,
        projects,
      })
    }

    return hydraDigest({
      previousDigest,
      checkpointed,
      conditions: memoryConditions(),
      hydraId,
      state,
      owner,
      projects,
      setup: setupDigest({ items }),
    })
  }

  const memoryChangeNote = async () => {
    const owner = ownerMemory()
    const state = loadHydra({ hydraId }).state
    const stamp = JSON.stringify({
      owner,
      hydra: state.hydraMemory,
      projects: await projectDigest({ state }),
    })
    const changed = memoryStamp !== undefined && memoryStamp !== stamp
    memoryStamp = stamp

    return changed ? ' Memory changed; load owner memory with owner memory list, Hydra memory with hydra memory list or project memory with project show <name|path> when needed.' : ''
  }

  // Hydra runs Pnyx's own CLI without asking; every other prompt waits in Hydra's chat.
  const hydraSession = ({
    history = false,
    agent,
  }: {
    history?: boolean
    agent?: AgentRef
  } = {}) => {
    let contextSent = false

    return {
      instructions: hydraInstructions(),
      allow: HYDRA_COMMANDS,
      context: createDigestContext({
        agent,
        render: async ({
          previousDigest,
          compacted,
        }) => {
          const state = loadHydra({ hydraId }).state
          const conversation = compacted || history && !contextSent ? conversationContext({
            hydraId,
            state,
          }) : ''
          contextSent = true

          const memory = await digest({
            previousDigest,
            checkpointed: true,
          })

          return conversation ? memory.replace(
            '</pnyx-digest>',
            `\nConversation context:\n${sealed({ text: conversation })}\n</pnyx-digest>`,
          ) : memory
        },
      }),
    }
  }

  const hydra: Host['hydra'] = ({
    text,
    original,
    actor,
    id,
    release = false,
    selected,
    history = true,
  }) => {
    if (reportActor({ actor })) {
      changed()

      return Promise.resolve({ state: 'queued' })
    }

    if (ownerActor({ actor }) && restartCommand({ text })) {
      upgrades.restart({ id })
      queued()

      return Promise.resolve({ state: 'queued' })
    }

    if (ownerActor({ actor }) && upgradeCommand({ text })) {
      upgrades.request({ id })
      queued()

      return Promise.resolve({ state: 'queued' })
    }

    // While a restart, an upgrade or a compaction stops Hydra, everything for it waits in its queue; the recap when it ends tells Hydra.
    if (stoppedFor({ id })) {
      queued()

      return Promise.resolve({ state: 'queued' })
    }

    const queuedState = loadHydra({ hydraId }).state
    const queuedDispatch = effectiveDispatch().dispatch
    const desiredAgent = selected ?? (!ownerActor({ actor }) ? queuedState.hydraAgent : undefined)
      ?? hydraCandidate({
        state: queuedState,
        dispatch: queuedDispatch,
      })
    const requestedAgent = {
      ...desiredAgent,
      account: harnessAccount({
        effective: effectiveDispatch(),
        harness: desiredAgent.harness,
        prefer: desiredAgent.account,
      }),
    }
    const deliveryId = release ? `${id}:compact:hosted` : `${id}:hosted`

    if (queuedHydra.has(id)) {
      return Promise.resolve({ state: 'queued' })
    }

    queuedHydra.add(id)
    const turn = hydraTurn.then(async () => {
      if (closing()) {
        return { state: 'queued' }
      }

      let state = loadHydra({ hydraId }).state

      if (stoppedFor({ id })) {
        return { state: 'queued' }
      }

      if (id.startsWith('helper-outcomes:') && !helperPending()) {
        return { state: 'queued' }
      }

      const config = hydraConfig({
        state,
        id: hydraId,
      })

      if (config.hydra.kind === 'firstmate') {
        return { state: 'queued' }
      }

      if (deliveryId in state.eventIds) {
        return { state: 'queued' }
      }

      const previous = state.cards[HYDRA_CARD]
      const used = state.hydraAgent ?? (previous?.agent ? {
        harness: harnessOf({ provider: previous.agent.provider }),
        account: previous.agent.account ?? harnessAccount({
          effective: effectiveDispatch(),
          harness: harnessOf({ provider: previous.agent.provider }),
        }),
        model: previous.settings?.model,
        effort: previous.settings?.effort,
        mode: previous.settings?.mode,
        fast: previous.settings?.fast === 'true',
      } : undefined)
      const kind = used && agentChangeKind({
        previous: used,
        next: requestedAgent,
      })

      if (used && kind && ownerActor({ actor })) {
        write({
          fn: ({ writer }) => applyDecision({
            writer,
            decision: hydraEvent({
              state: writer.state,
              cardId: HYDRA_CARD,
              meta: {
                at: at(),
                actor: 'pnyx',
              },
              change: {
                type: 'hydra.agent-change',
                data: {
                  id,
                  previous: used,
                  next: requestedAgent,
                  kind,
                  state: 'requested',
                },
              },
            }),
          }),
        })
        queued()

        return { state: 'queued' }
      }

      write({
        fn: ({ writer }) => {
          if (previous?.agent?.host === 'pnyx') {
            record({
              writer,
              agent: previous.agent,
              input: { activity: 'working' },
              actor,
            })
          } else {
            applyDecision({
              writer,
              decision: decidePush({
                state: writer.state,
                key: HYDRA_CARD,
                input: { activity: 'working' },
                meta: {
                  at: at(),
                  actor,
                },
              }),
            })
          }
        },
      })
      let prepared: HostedSession | undefined

      try {
        if (previous?.agent && previous.agent.host !== 'pnyx') {
          throw new HydraError({
            message: 'This Hydra already has an outside agent. Continue it in its own harness.',
            code: 'NO_ROUTE',
          })
        }

        const candidate = requestedAgent
        const {
          name: main,
          account,
        } = accountFor({
          effective: effectiveDispatch(),
          harness: candidate.harness,
          prefer: candidate.account,
        })
        const provider = providerIdOf({ harness: candidate.harness })
        const dispatch = account && main ? {
          account: main,
          provider: account.provider,
          folder: loginFolder({ account }),
        } : undefined
        const settings = agentSettings({ agent: candidate })
        const cwd = hydraAgentFolder({ hydraId })
        prepareHydraFolder({ folder: cwd })
        let card = previous
        const previousAgent = card?.agent
        const running = previousAgent && live.get(sessionId({ agent: previousAgent }))
        // A person's message joins Hydra's running turn when the same session takes it; Pnyx's own wakes wait for the turn to end.
        const sameSession = previousAgent?.provider === provider
          && sameChosenSettings({
            current: card?.settings,
            chosen: settings,
          })
        const stopping = Boolean(running && running.stopping)
        const joinsTurn = actor !== 'pnyx' && sameSession && !stopping

        while (!joinsTurn && previousAgent && running?.activity === 'working'
          && live.get(sessionId({ agent: previousAgent })) === running && !closing()) {
          await new Promise(resolve => setTimeout(
            resolve,
            HYDRA_TURN_POLL_MS,
          ))
        }

        if (closing()) {
          throw new Error('Pnyx is stopping')
        }

        state = loadHydra({ hydraId }).state
        card = state.cards[HYDRA_CARD]
        const sameIdentity = history && card?.agent?.provider === provider
          && card.agent.account === main
          && state.hydraContext?.previousSession !== sessionId({ agent: card.agent })
          && card.settings?.model === candidate.model
        const agent = sameIdentity ? card?.agent : undefined
        const changedSettings = !sameChosenSettings({
          current: card?.settings,
          chosen: settings,
        })

        if (running && previousAgent && (!agent || changedSettings)) {
          retire({
            key: sessionId({ agent: previousAgent }),
            entry: running,
          })
        }

        if (!agent || !live.has(sessionId({ agent }))) {
          prepared = await providerOf({ provider }).open({
            cwd,
            agent,
            settings,
            ...hydraSession({
              history: history && !agent,
              agent,
            }),
            env: agent?.loginFolder ? accountEnvironment({
              account: {
                provider: candidate.harness,
                folder: agent.loginFolder,
              },
              env: environment({ hydra: true }),
            }) : dispatch ? accountEnvironment({
              account: {
                provider: dispatch.provider,
                folder: dispatch.folder,
              },
              env: environment({ hydra: true }),
            }) : environment({ hydra: true }),
            signal: controller.signal,
            spawned: children.spawned,
          })
        }

        const ref: AgentRef = agent ?? {
          provider,
          sessionId: prepared!.id,
          cwd,
          host: 'pnyx',
          ...(prepared?.path ? { transcriptPath: prepared.path } : {}),
          ...(dispatch ? {
            account: dispatch.account,
            loginFolder: dispatch.folder,
          } : {}),
        }
        const claimed = write({
          fn: ({ writer }) => {
            const meta = {
              at: at(),
              actor,
            }

            if (previousAgent && !agent) {
              harvestTranscripts({
                writer,
                cardIds: [HYDRA_CARD],
                at: meta.at,
              })
            }

            applyDecision({
              writer,
              decision: decidePush({
                state: writer.state,
                key: HYDRA_CARD,
                input: {
                  attention: withoutInterrupted({
                    attention: writer.state.cards[HYDRA_CARD]?.attention ?? [],
                  }),
                },
                meta,
              }),
            })
            applyDecision({
              writer,
              decision: decidePush({
                state: writer.state,
                key: sessionKey({ agent: ref }),
                input: {
                  agent: ref,
                  title: 'Hydra',
                  settings: {
                    ...Object.fromEntries(Object.keys(card?.settings ?? {})
                      .map(key => [
                        key,
                        null,
                      ])),
                    ...settings,
                  },
                  activity: 'working',
                  attention: [],
                  source: {
                    adapter: 'pnyx',
                    objectId: ref.sessionId,
                    observedAt: at(),
                  },
                },
                meta,
              }),
            })
            const current = hydraConfig({
              state: writer.state,
              id: hydraId,
            })
            const delivery = hydraEvent({
              state: writer.state,
              meta: {
                ...meta,
                id: deliveryId,
              },
              cardId: HYDRA_CARD,
              change: {
                type: 'board.configured',
                data: {
                  ...current,
                  hydra: {
                    ...current.hydra,
                    session: sessionId({ agent: ref }),
                  },
                },
              },
            })

            applyDecision({
              writer,
              decision: delivery,
            })

            applyDecision({
              writer,
              decision: hydraEvent({
                state: writer.state,
                cardId: HYDRA_CARD,
                meta,
                change: {
                  type: 'hydra.agent-used',
                  data: requestedAgent,
                },
              }),
            })

            return writer.state.cards[HYDRA_CARD] as Card & { agent: AgentRef }
          },
        })
        // Reopened sessions receive full context; a running wake only notes memory changes.
        const opened = Boolean(prepared)
        const entry = open({
          card: claimed,
          session: prepared,
        })
        prepared = undefined
        const down = loadHydra({ hydraId }).state.hydraStatus

        if (down?.state === 'down') {
          back({
            down,
            turn: id,
            hydra: config.hydra.id,
          })
        }

        const waking = /^(wake|stall|wait|unconfirmed):/.test(id) && !opened && Boolean(entry.session)
        const memoryNote = waking ? await memoryChangeNote() : ''
        const recap = takeRecap({ id })

        const helperState = loadHydra({ hydraId }).state
        const helperLines = outcomeLines({ state: helperState })
        let helperText = ''
        // Main holds the tasks whose outcomes or hand-backs it is given, as it holds a wake's tasks.
        const presentedTasks = [
          ...ownerOutcomes({ state: helperState }).map(outcome => outcome.task),
          ...failedBatches({ state: helperState }).flatMap(batch => batch.tasks),
        ]

        if (activeHelperBatches({ state: helperState }).length) {
          helperText = `\n<pnyx-wake>${sealed({ text: helperLeases({ state: helperState }).join('\n') })}</pnyx-wake>`
        }

        if (helperLines.length) {
          outcomesPresented = Math.max(
            outcomesPresented,
            ...helperState.helper!.outcomes.map(outcome => outcome.seq),
          )
          helperText += `\n<pnyx-wake>Helper outcomes to relay or resolve, one line each:\n${sealed({ text: helperLines.join('\n') })}\nResolve new decisions, changed scope and uncertainty. Do not repeat an existing automated result or owner wait.\n${REPLY_RULES}</pnyx-wake>`
        }

        const pendingBatches = failedBatches({ state: helperState })

        // Every failed batch reaches main as one notice naming its tasks, not one wake each.
        if (pendingBatches.length) {
          const tasks = [...new Set(pendingBatches.flatMap(batch => batch.tasks))]
            .map(task => taskMention({
              id: task,
              title: helperState.cards[task]?.title ?? task,
            }))
          const errors = [...new Set(pendingBatches.map(batch => batch.error ?? 'interrupted'))]

          for (const batch of pendingBatches) {
            helperBatchesPresented.add(batch.id)
          }

          const handedBack = pendingBatches.length === 1 ? 'a batch' : `${pendingBatches.length} batches`
          const notice = `The routine helper handed back ${handedBack} for ${tasks.join(', ')}: ${errors.join('; ')}`
          const wakes = pendingBatches.map(batch => sealed({ text: batch.prompt })).join('\n')
          helperText += `\n<pnyx-wake>${sealed({ text: notice })}. These tasks are yours now: check their current state before acting, because earlier actions may have completed. The wakes it was given:\n${wakes}</pnyx-wake>`
        }

        const inputText = recap ?? (memoryNote ? text.replace(
          REPLY_RULES,
          `${memoryNote}\n${REPLY_RULES}`,
        ) : text)
        entry.activity = 'working'

        for (const task of [
          ...wakeTasks.get(id) ?? [],
          ...presentedTasks,
        ]) {
          mainTasks.add(task)
        }

        entry.input.push({
          text: compactCommand({ text }) ? text : inputText + helperText,
          original: original ?? text,
          id,
          agent: requestedAgent,
        })
        readWake({ id })

        return { state: 'queued' }
      } catch (error) {
        prepared?.close()

        if (closing()) {
          return { state: 'failed' }
        }

        return startFailed({
          error,
          previous,
          id,
          actor,
          hydra: config.hydra.id,
        })
      }
    })
    hydraTurn = turn.then(
      () => {},
      () => {},
    ).finally(() => queuedHydra.delete(id))

    return Promise.resolve({ state: 'queued' })
  }

  const startedByOwner = ({ answers }: { answers: string[] }) => {
    const messages = loadHydra({ hydraId }).state.hydraMessages ?? []
    const opener = ({ message }: { message: HydraMessage }) =>
      answers.includes(message.id)
    const ownerMessage = ({ message }: { message: HydraMessage }) =>
      ownerActor({ actor: message.actor })

    return messages.some(message => opener({ message })
    && ownerMessage({ message }))
  }

  const turnFinished = ({
    entry,
    answering,
  }: {
    entry: Live
    answering: string[]
  }) => {
    const texts = entry.replies.texts()
    const asks = answering
    note({
      fn: ({ writer }) => copyTagged({
        writer,
        texts,
        asks,
        at: at(),
        turn: entry.session?.snapshot().outcome?.turn,
      }),
    })
    finishReading()
    const messages = loadHydra({ hydraId }).state.hydraMessages ?? []
    const ownerInput = messages.some(message => answering.includes(message.id)
    && ownerActor({ actor: message.actor }))

    if (ownerInput && texts.at(-1)?.trim() === QUIET_REPLY) {
      entry.input.push({
        text: `<pnyx-wake>The owner wrote to you; reply to them in one standalone message.\n${REPLY_RULES}</pnyx-wake>`,
      })
    }

    const snapshot = entry.session?.snapshot()
    const outcome = snapshot?.outcome
    const used = outcome?.usage?.used
    const session = entry.session?.id

    if (!session || used === undefined) {
      return
    }

    if (used < HYDRA_CONTEXT_TOKENS) {
      automaticCompactions.delete(session)

      return
    }

    const idle = snapshot && nativeIdle({ work: snapshot.work })
    const pendingWork = queuedHydra.size > 0 || entry.input.pending() > 0
    const available = idle && !entry.stopping
    const alreadyRequested = automaticCompactions.has(session)

    if (outcome?.status !== 'completed' || !available || pendingWork || alreadyRequested) {
      return
    }

    automaticCompactions.add(session)
    // Drain the provider's trailing completion events before starting another control.
    setImmediate(() => {
      const current = entry.session?.snapshot()
      const currentUsed = current?.outcome?.usage?.used
      const contextStillLarge = currentUsed !== undefined && currentUsed >= HYDRA_CONTEXT_TOKENS
      const idle = current && nativeIdle({ work: current.work })
      const eligible = current?.outcome?.status === 'completed' && contextStillLarge && idle
      const pendingWork = queuedHydra.size > 0 || entry.input.pending() > 0
      const stopped = closing() || entry.stopping

      if (stopped || pendingWork || !eligible) {
        automaticCompactions.delete(session)

        return
      }

      entry.input.push({
        id: `context-compact:${outcome.turn}`,
        text: '/compact',
      })
    })
  }

  const activityEventId = ({
    writer,
    card,
    activity,
  }: {
    writer: Writer
    card: Card
    activity: string
  }) => {
    const handledThrough = wakesThrough({
      state: writer.state,
      pattern: WAKE_HANDLED,
    })
    // The wake this turn read counts as handled only now that the turn finished.
    const handledWake = card.id === HYDRA_CARD && activity === 'finished' && readThrough() > handledThrough
    let eventId: string | undefined

    if (handledWake) {
      eventId = `wake:${readThrough()}:handled`
    }

    if (card.id === HYDRA_CARD && activity === 'finished') {
      const batches = [...helperBatchesPresented]

      if (batches.length || outcomesPresented > (writer.state.helper?.delivered ?? 0)) {
        applyDecision({
          writer,
          decision: hydraEvent({
            state: writer.state,
            cardId: HYDRA_CARD,
            meta: {
              at: at(),
              actor: 'pnyx',
            },
            change: {
              type: 'hydra.helper-acknowledged',
              data: {
                batches,
                through: outcomesPresented,
              },
            },
          }),
        })
      }
    }

    if (card.id === HYDRA_CARD && activity === 'finished') {
      helperBatchesPresented.clear()
    }

    return eventId
  }

  const sessionEnded = ({ entry }: { entry: Live }) => {
    // A check turn cut before it finished hands its updates back; they reach Hydra once the owner continues it.
    if (entry.activity === 'working') {
      handBack()
    } else {
      finishReading()
    }
  }

  return {
    hydraTurn: () => hydraTurn,
    digest,
    hydraSession,
    hydra,
    startedByOwner,
    turnFinished,
    activityChanged: turnEnded,
    activityEventId,
    turnRecorded: armWake,
    sessionEnded,
  }
}
