import { recordContext } from './file-context.ts'
import { projectsFor } from '#projects/read.ts'

import { createDigestContext } from './digest-context.ts'
import { stopTitanInputs } from './stop-inputs.ts'
import { titanDeliveryId } from './received.ts'
import type { createPermissionBridge } from '#workers/permission-bridge.ts'
import { contextNoteBlock, contextTurnNotes, contextReportStatus, type ContextNote } from './context-notes.ts'
import { agentSettings, titanCandidate, runsDifferently, startsFromSummary, withAccount } from './agent-choice.ts'
import { compactionContext } from './history.ts'
import { titanConfig } from './config.ts'
import { titanDigest } from './digest.ts'
import { QUIET_REPLY, titanEvent, reportActor } from './titan.ts'
import { TITAN_CARD } from './identity.ts'
import { taskMention } from './mentions.ts'
import type { TitanMessage } from './model.ts'
import type { createTitanOperations, createTitanOutage } from './operations.ts'
import type { createWakeQueue } from './wake-queue.ts'
import { REPLY_RULES, sealed, wakesThrough } from './wakes.ts'
import { WAKE_HANDLED } from './wake-ids.ts'
import { ownerActor } from '#app/actors.ts'
import { log } from '#app/diagnostics.ts'
import { TITAN_COMMANDS } from '#app/command-registry.ts'
import { applyDecision } from '#app/decision.ts'
import { titanAgentFolder } from '#app/home-migration.ts'
import type { Host, Live } from '#app/host-types.ts'
import { loadTitan } from '#app/store.ts'
import { readEvents } from '#app/event-log.ts'
import type { TitanState } from '#app/model.ts'
import type { Writer } from '#app/writer.ts'
import { harvestTranscripts } from '#integrations/hooks/harvest.ts'
import { memoryConditions } from '#memory/conditions.ts'
import { ownerMemory, writableOwnerMemory } from '#memory/owner-memory.ts'
import { projectDigest } from '#projects/context.ts'
import { activeHelperBatches, failedBatches, helperLeases, outcomeLines, ownerOutcomes } from '#routine-helper/state.ts'
import { setupCheck, setupDigest } from '#setup/check.ts'
import { prepareTitanFolder } from '#setup/skills.ts'
import { TitanError } from '#store/errors.ts'
import type { Card } from '#tasks/model.ts'
import { decidePush } from '#tasks/push.ts'
import { restartCommand, upgradeCommand } from '#upgrade/model.ts'
import type { upgradeQueue } from '#upgrade/queue.ts'
import { accountFor, harnessAccount } from '#workers/account-choice.ts'
import type { trackChildren } from '#workers/children.ts'
import { compactCommand } from '#workers/compaction/state.ts'
import { accountEnvironment } from '#workers/dispatch.ts'
import { effectiveDispatch, loginFolder } from '#workers/dispatch-config.ts'
import { TITAN_TURN_POLL_MS, sameChosenSettings } from '#workers/host.ts'
import { decideSessionFacts } from '#workers/session-facts.ts'
import type { AgentRef, SessionObservation } from '#workers/model.ts'
import type { HostedSession, Provider } from '#workers/provider.ts'
import { harnessOf, providerIdOf } from '#workers/providers.ts'
import { sessionId, withoutInterrupted } from '#workers/session-attachments.ts'
import { copyTagged } from '#workers/tagged-updates.ts'

function conversationContext({
  titanId,
  state,
}: {
  titanId: string
  state: TitanState
}): string {
  const context = compactionContext({ state })

  return [
    context.summary,
    recordContext({ titanId }),
    'Read the recorded conversation after the saved summary before acting. Preserve message identities and order.',
  ].filter(Boolean).join('\n\n')
}

// Titan's turns: admitting and starting one, the context its session opens with, and what Titan's live session does as a turn starts, finishes or ends.
export function createTitanTurns({
  titanId,
  live,
  queuedTitan,
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
  denyForMessage,
  helperPending,
  providerOf,
  environment,
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
  models,
}: {
  titanId: string
  live: Map<string, Live>
  queuedTitan: Set<string>
  closing(): boolean
  changed(): void
  queued(): void
  controller: AbortController
  children: ReturnType<typeof trackChildren>
  upgrades: ReturnType<typeof upgradeQueue>
  at(): string
  write<T>({ fn }: { fn: ({ writer }: { writer: Writer }) => T }): Promise<T>
  note({ fn }: { fn: ({ writer }: { writer: Writer }) => void }): void
  record({
    writer,
    agent,
    input,
    actor,
  }: {
    writer: Writer
    agent: AgentRef
    input: SessionObservation
    actor: string
  }): void
  stoppedFor: ReturnType<typeof createTitanOperations>['stoppedFor']
  denyForMessage: ReturnType<typeof createPermissionBridge>['denyForMessage']
  helperPending(): boolean
  providerOf({
    provider,
    taskId,
  }: {
    provider: string
    taskId?: string
  }): Provider
  environment({ titan }: { titan?: boolean }): NodeJS.ProcessEnv
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
  back: ReturnType<typeof createTitanOutage>['back']
  takeRecap: ReturnType<typeof createTitanOutage>['takeRecap']
  startFailed: ReturnType<typeof createTitanOutage>['startFailed']
  mainTasks: ReturnType<typeof createWakeQueue>['mainTasks']
  wakeTasks: ReturnType<typeof createWakeQueue>['wakeTasks']
  readWake: ReturnType<typeof createWakeQueue>['readWake']
  finishReading: ReturnType<typeof createWakeQueue>['finishReading']
  turnEnded: ReturnType<typeof createWakeQueue>['turnEnded']
  readThrough: ReturnType<typeof createWakeQueue>['readThrough']
  handBack: ReturnType<typeof createWakeQueue>['handBack']
  armWake: ReturnType<typeof createWakeQueue>['armWake']
  models: Host['models']
}) {
  let titanTurn = Promise.resolve()
  let wakeTurn = Promise.resolve()
  let waitingWakes = 0
  // Inputs in the chain: one may still be opening Titan's session before its turn counts as working.
  let entering = 0

  const titanBusy = () => {
    const agent = loadTitan({ titanId }).state.cards[TITAN_CARD]?.agent

    return entering > 0 || Boolean(agent && live.get(sessionId({ agent }))?.activity === 'working')
  }

  // No deadline: a turn has none, and like the wait inside the chain this one ends only when the turn does or Othrys stops.
  const turnEnd = async () => {
    while (!closing() && titanBusy()) {
      await new Promise(resolve => setTimeout(
        resolve,
        TITAN_TURN_POLL_MS,
      ))
    }
  }

  let outcomesPresented = 0
  const contextPresented = new Set<string>()

  const readContextNote = ({
    note,
    state,
  }: {
    note: ContextNote
    state: TitanState
  }) => {
    if (note.report) {
      const status = contextReportStatus({
        note,
        state,
      })

      if (status === 'helper handling') {
        return
      }

      if (note.task && status === 'unhandled') {
        mainTasks.add(note.task)
      }
    }

    contextPresented.add(note.id)
  }

  const helperBatchesPresented = new Set<string>()
  const titanInstructions = () =>
    `You are Titan for Othrys Titan "${titanId}". Your contract is AGENTS.md in your current folder; follow it. Use othrys with --titan ${titanId}; OTHRYS_ACTOR=titan is already set. Projects attach later; your current folder belongs to Titan.`

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
    const owner = await ownerMemory({})
    const ownerWrite = writableOwnerMemory({ titanId }).memory
    const state = loadTitan({ titanId }).state
    const readable = projectsFor({ state })

    if (onlyTasks) {
      return titanDigest({
        records: recordContext({ titanId }),
        titanId,
        state,
        owner,
        ownerWrite,
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
      projectDigest({
        titanId,
        readable,
      }),
      setupCheck({
        titanId,
        readable,
      }),
    ])

    if (remember) {
      memoryStamp = JSON.stringify({
        owner,
        ownerWrite,
        titan: state.titanMemory,
        projects,
      })
    }

    return titanDigest({
      records: recordContext({ titanId }),
      previousDigest,
      checkpointed,
      conditions: memoryConditions(),
      titanId,
      state,
      owner,
      ownerWrite,
      projects,
      setup: setupDigest({ items }),
    })
  }

  const memoryChangeNote = async () => {
    const owner = await ownerMemory({})
    const ownerWrite = writableOwnerMemory({ titanId }).memory
    const state = loadTitan({ titanId }).state
    const readable = projectsFor({ state })
    const projects = await projectDigest({
      titanId,
      readable,
    })
    const stamp = JSON.stringify({
      owner,
      ownerWrite,
      titan: state.titanMemory,
      projects,
    })
    const changed = memoryStamp !== undefined && memoryStamp !== stamp
    memoryStamp = stamp

    return changed ? ' Memory changed; reread the saved owner memory logs, this Titan’s titan.log and the project memory logs named in your context when needed.' : ''
  }

  // Titan runs Othrys's own CLI without asking; every other prompt waits in Titan's chat.
  const titanSession = ({ agent }: { agent?: AgentRef }) => {
    const opensNewSession = agent === undefined
    let contextSent = false

    return {
      instructions: titanInstructions(),
      allow: TITAN_COMMANDS,
      context: createDigestContext({
        agent,
        render: async ({
          previousDigest,
          compacted,
        }) => {
          const state = loadTitan({ titanId }).state
          const sendsConversation = compacted || (opensNewSession && !contextSent)
          const conversation = sendsConversation ? conversationContext({
            titanId,
            state,
          }) : ''
          contextSent = true

          const memory = await digest({
            previousDigest,
            checkpointed: true,
          })

          return conversation ? memory.replace(
            '</othrys-digest>',
            `\nConversation context:\n${sealed({ text: conversation })}\n</othrys-digest>`,
          ) : memory
        },
      }),
    }
  }

  let stopGeneration = 0

  // A turn that a Stop overtook never reaches the agent, so the owner's messages it carried read as stopped.
  const stoppedBefore = ({
    id,
    carried,
  }: {
    id: string
    carried: readonly string[]
  }) => {
    note({
      fn: ({ writer }) => stopTitanInputs({
        writer,
        ids: [
          id,
          ...carried,
        ],
        at: at(),
      }),
    })

    return { state: 'cancelled' as const }
  }

  const titan: Host['titan'] = async ({
    text,
    original,
    actor,
    id,
    release = false,
    selected,
    carried = [],
  }) => {
    if (reportActor({ actor })) {
      changed()

      return Promise.resolve({ state: 'queued' })
    }

    if (ownerActor({ actor }) && restartCommand({ text })) {
      await upgrades.restart({ id })
      queued()

      return { state: 'queued' }
    }

    if (ownerActor({ actor }) && upgradeCommand({ text })) {
      await upgrades.request({ id })
      queued()

      return { state: 'queued' }
    }

    // The owner's message answers a prompt Titan waits on; a compaction's release repeats a message already answered.
    if (ownerActor({ actor }) && !release) {
      await denyForMessage({
        task: TITAN_CARD,
        actor,
      })
    }

    // While a restart, an upgrade or a compaction stops Titan, everything for it waits in its queue; the recap when it ends tells Titan.
    if (stoppedFor({ id })) {
      queued()

      return Promise.resolve({ state: 'queued' })
    }

    const queuedState = loadTitan({ titanId }).state

    if (queuedState.titanMessages?.find(message => message.id === id)?.stopped) {
      return Promise.resolve({ state: 'cancelled' })
    }

    const keepsLastAgent = !ownerActor({ actor }) && !startsFromSummary({ state: queuedState })
    const chosenAgent = withAccount({
      agent: selected ?? (keepsLastAgent ? queuedState.titanAgent : undefined) ?? titanCandidate({
        state: queuedState,
        dispatch: effectiveDispatch().dispatch,
      }),
    })
    const message = queuedState.titanMessages?.find(message => message.id === id) ?? { id }
    const deliveryId = titanDeliveryId({
      message,
      release,
    })

    if (queuedTitan.has(id)) {
      return Promise.resolve({ state: 'queued' })
    }

    const generation = stopGeneration
    queuedTitan.add(id)

    const run = async () => {
      if (closing()) {
        return { state: 'queued' }
      }

      let state = loadTitan({ titanId }).state

      if (generation !== stopGeneration) {
        return stoppedBefore({
          id,
          carried,
        })
      }

      if (stoppedFor({ id })) {
        return { state: 'queued' }
      }

      // Removed from the queue while it waited in the chain.
      if (state.titanMessages?.find(message => message.id === id)?.stopped) {
        return { state: 'cancelled' }
      }

      if (id.startsWith('helper-outcomes:') && !helperPending()) {
        return { state: 'queued' }
      }

      const config = titanConfig({
        state,
        id: titanId,
      })

      if (deliveryId in state.eventIds) {
        return { state: 'queued' }
      }

      const previous = state.cards[TITAN_CARD]
      const ranWith = state.titanAgent ?? (previous?.agent ? {
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
      const used = startsFromSummary({ state }) ? undefined : ranWith
      const settingsChanged = used && await runsDifferently({
        previous: used,
        next: chosenAgent,
        models: () => models({
          harness: chosenAgent.harness,
          account: chosenAgent.account,
        }),
      })

      if (generation !== stopGeneration) {
        return stoppedBefore({
          id,
          carried,
        })
      }

      // A model or effort named as what the session already runs with keeps that session.
      const requestedAgent = used && !settingsChanged ? {
        ...chosenAgent,
        model: used.model,
        effort: used.effort,
      } : chosenAgent

      await write({
        fn: ({ writer }) => {
          if (previous?.agent?.host === 'othrys') {
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
                key: TITAN_CARD,
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
        if (previous?.agent && previous.agent.host !== 'othrys') {
          throw new TitanError({
            message: 'This Titan already has an outside agent. Continue it in its own harness.',
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
        const cwd = titanAgentFolder({ titanId })
        prepareTitanFolder({ folder: cwd })
        let card = previous
        const previousAgent = card?.agent
        const running = previousAgent && live.get(sessionId({ agent: previousAgent }))
        // A person's message joins Titan's running turn when the same session takes it; Othrys's own wakes wait for the turn to end.
        const sameSession = previousAgent?.provider === provider
          && sameChosenSettings({
            current: card?.settings,
            chosen: settings,
          })
        const stopping = Boolean(running && running.stopping)
        const joinsTurn = actor !== 'othrys' && sameSession && !stopping

        while (!joinsTurn && previousAgent && running?.activity === 'working'
          && live.get(sessionId({ agent: previousAgent })) === running && !closing()) {
          await new Promise(resolve => setTimeout(
            resolve,
            TITAN_TURN_POLL_MS,
          ))
        }

        if (closing()) {
          throw new Error('Othrys is stopping')
        }

        if (generation !== stopGeneration) {
          return stoppedBefore({
            id,
            carried,
          })
        }

        state = loadTitan({ titanId }).state
        card = state.cards[TITAN_CARD]
        const sameIdentity = card?.agent?.provider === provider
          && card.agent.account === main
          && !startsFromSummary({ state })
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
          prepared = await providerOf({
            provider,
            taskId: TITAN_CARD,
          }).open({
            cwd,
            agent,
            settings,
            ...titanSession({ agent }),
            env: agent?.loginFolder ? accountEnvironment({
              account: {
                provider: candidate.harness,
                folder: agent.loginFolder,
              },
              env: environment({ titan: true }),
            }) : dispatch ? accountEnvironment({
              account: {
                provider: dispatch.provider,
                folder: dispatch.folder,
              },
              env: environment({ titan: true }),
            }) : environment({ titan: true }),
            signal: controller.signal,
            spawned: children.spawned,
          })
        }

        if (generation !== stopGeneration) {
          prepared?.close()

          return stoppedBefore({
            id,
            carried,
          })
        }

        const ref: AgentRef = agent ?? {
          provider,
          sessionId: prepared!.id,
          cwd,
          host: 'othrys',
          ...(prepared?.path ? { transcriptPath: prepared.path } : {}),
          ...(dispatch ? {
            account: dispatch.account,
            loginFolder: dispatch.folder,
          } : {}),
        }
        const claimed = await write({
          fn: ({ writer }) => {
            const meta = {
              at: at(),
              actor,
            }

            if (previousAgent && !agent) {
              harvestTranscripts({
                writer,
                cardIds: [TITAN_CARD],
                at: meta.at,
              })
            }

            applyDecision({
              writer,
              decision: decidePush({
                state: writer.state,
                key: TITAN_CARD,
                input: {
                  attention: withoutInterrupted({
                    attention: writer.state.cards[TITAN_CARD]?.attention ?? [],
                  }),
                },
                meta,
              }),
            })
            applyDecision({
              writer,
              decision: decideSessionFacts({
                state: writer.state,
                session: writer.state.sessions?.[sessionId({ agent: ref })],
                fields: {
                  agent: ref,
                  title: 'Titan',
                  settings,
                  activity: 'working',
                  attention: [],
                },
                source: {
                  adapter: 'othrys',
                  objectId: ref.sessionId,
                  observedAt: at(),
                },
                meta,
              }),
            })
            const current = titanConfig({
              state: writer.state,
              id: titanId,
            })
            const session = sessionId({ agent: ref })
            // The configuration changes only when Titan's session does; otherwise a small event marks the turn.
            const delivery = titanEvent({
              state: writer.state,
              meta: {
                ...meta,
                id: deliveryId,
              },
              cardId: TITAN_CARD,
              change: writer.state.config?.titan.session === session ? {
                type: 'titan.delivered',
                data: { session },
              } : {
                type: 'titan.configured',
                data: {
                  ...current,
                  titan: {
                    ...current.titan,
                    session,
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
              decision: titanEvent({
                state: writer.state,
                cardId: TITAN_CARD,
                meta,
                change: {
                  type: 'titan.agent-used',
                  data: requestedAgent,
                },
              }),
            })

            return writer.state.cards[TITAN_CARD] as Card & { agent: AgentRef }
          },
        })
        // Reopened sessions receive full context; a running wake only notes memory changes.
        const opened = Boolean(prepared)
        const entry = open({
          card: claimed,
          session: prepared,
        })
        prepared = undefined
        const down = loadTitan({ titanId }).state.titanStatus

        if (down?.state === 'down') {
          await back({
            down,
            turn: id,
            titan: config.titan.id,
          })
        }

        const waking = /^(wake|stall|wait|unconfirmed):/.test(id) && !opened && Boolean(entry.session)
        const memoryNote = waking ? await memoryChangeNote() : ''
        const recap = takeRecap({ id })

        const helperState = loadTitan({ titanId }).state
        const helperLines = outcomeLines({ state: helperState })
        let helperText = ''
        // Main holds the tasks whose outcomes or hand-backs it is given, as it holds a wake's tasks.
        const presentedTasks = [
          ...ownerOutcomes({ state: helperState }).map(outcome => outcome.task),
          ...failedBatches({ state: helperState }).flatMap(batch => batch.tasks),
        ]

        if (activeHelperBatches({ state: helperState }).length) {
          helperText = `\n<othrys-wake>${sealed({ text: helperLeases({ state: helperState }).join('\n') })}</othrys-wake>`
        }

        if (helperLines.length) {
          outcomesPresented = Math.max(
            outcomesPresented,
            ...helperState.helper!.outcomes.map(outcome => outcome.seq),
          )
          helperText += `\n<othrys-wake>Helper outcomes to relay or resolve, one line each:\n${sealed({ text: helperLines.join('\n') })}\nResolve new decisions, changed scope and uncertainty. Do not repeat an existing automated result or owner wait.\n${REPLY_RULES}</othrys-wake>`
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
          helperText += `\n<othrys-wake>${sealed({ text: notice })}. These tasks are yours now: check their current state before acting, because earlier actions may have completed. The wakes it was given:\n${wakes}</othrys-wake>`
        }

        const inputText = recap?.text ?? (memoryNote ? text.replace(
          REPLY_RULES,
          `${memoryNote}\n${REPLY_RULES}`,
        ) : text)
        const continuingTurn = joinsTurn && running?.activity === 'working'
        const contextState = loadTitan({ titanId }).state
        const pendingNotes = contextState.contextNotes ?? []
        const notes = continuingTurn || compactCommand({ text }) ? [] : pendingNotes
        const context = contextNoteBlock({
          notes,
          records: recordContext({ titanId }),
          state: contextState,
        })

        for (const note of contextTurnNotes({ notes })) {
          readContextNote({
            note,
            state: contextState,
          })
        }

        entry.activity = 'working'

        for (const task of [
          ...wakeTasks.get(id) ?? [],
          ...presentedTasks,
        ]) {
          mainTasks.add(task)
        }

        if (generation !== stopGeneration) {
          return stoppedBefore({
            id,
            carried,
          })
        }

        entry.input.push({
          text: compactCommand({ text }) ? text : [
            context,
            inputText + helperText,
          ].filter(Boolean).join('\n'),
          original: original ?? text,
          id,
          agent: requestedAgent,
          carried: recap?.carried ?? carried,
        })
        readWake({ id })

        return { state: 'queued' }
      } catch (error) {
        prepared?.close()

        if (closing()) {
          return { state: 'failed' }
        }

        return await startFailed({
          error,
          previous,
          id,
          actor,
          titan: config.titan.id,
        })
      }
    }

    const enter = () => {
      const previous = titanTurn
      entering += 1
      titanTurn = (async () => {
        try {
          await previous
          await run()
        } catch (error) {
          log({
            level: 'error',
            operation: 'titan.turn',
            titanId,
            correlationId: id,
            error,
          })
        } finally {
          entering -= 1
          queuedTitan.delete(id)
        }
      })()
    }

    // An Othrys wake waits for the running turn outside the chain, so owner messages sent meanwhile still join that turn.
    if (actor === 'othrys' && (waitingWakes > 0 || titanBusy())) {
      waitingWakes += 1
      const previous = wakeTurn
      wakeTurn = (async () => {
        await previous

        try {
          await turnEnd()
        } catch (error) {
          log({
            level: 'error',
            operation: 'titan.wake-wait',
            titanId,
            correlationId: id,
            error,
          })
        }

        waitingWakes -= 1
        enter()
      })()
    } else {
      enter()
    }

    return Promise.resolve({ state: 'queued' })
  }

  const startedByOwner = ({ answers }: { answers: string[] }) => {
    const messages = loadTitan({ titanId }).state.titanMessages ?? []
    const opener = ({ message }: { message: TitanMessage }) =>
      answers.includes(message.id)
    const ownerMessage = ({ message }: { message: TitanMessage }) =>
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
    const messages = loadTitan({ titanId }).state.titanMessages ?? []
    const ownerInput = messages.some(message => answering.includes(message.id)
    && ownerActor({ actor: message.actor }))

    if (ownerInput && texts.at(-1)?.trim() === QUIET_REPLY) {
      entry.input.push({
        text: `<othrys-wake>The owner wrote to you; reply to them in one standalone message.\n${REPLY_RULES}</othrys-wake>`,
      })
    }
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
    const handledWake = card.id === TITAN_CARD && activity === 'finished' && readThrough() > handledThrough
    let eventId: string | undefined

    if (handledWake) {
      eventId = `wake:${readThrough()}:handled`
    }

    if (card.id === TITAN_CARD && activity === 'finished') {
      const session = card.agent && live.get(sessionId({ agent: card.agent }))?.session
      const outcome = session?.snapshot().outcome

      if (outcome && outcome.status !== 'completed') {
        contextPresented.clear()
      }

      for (const note of writer.state.contextNotes ?? []) {
        if (note.report && contextReportStatus({
          note,
          state: writer.state,
        }) === 'helper handling') {
          contextPresented.delete(note.id)
        }
      }

      const delivered = contextPresented.size > 0 && outcome?.status === 'completed'

      if (delivered || handledWake) {
        // Only saved changes have a place after a restart, so the wake is anchored on the last one it covers.
        const through = handledWake ? readEvents({
          titanId,
          before: readThrough() + 1,
          descending: true,
          limit: 1,
        })[0]?.seq ?? 0 : 0
        applyDecision({
          writer,
          decision: titanEvent({
            state: writer.state,
            cardId: TITAN_CARD,
            meta: {
              at: at(),
              actor: 'othrys',
            },
            change: {
              type: 'titan.context-delivered',
              data: {
                through,
                ids: delivered ? [...contextPresented] : [],
              },
            },
          }),
        })
      }

      if (delivered) {
        contextPresented.clear()
      }

      const batches = [...helperBatchesPresented]

      if (batches.length || outcomesPresented > (writer.state.helper?.delivered ?? 0)) {
        applyDecision({
          writer,
          decision: titanEvent({
            state: writer.state,
            cardId: TITAN_CARD,
            meta: {
              at: at(),
              actor: 'othrys',
            },
            change: {
              type: 'titan.helper-acknowledged',
              data: {
                batches,
                through: outcomesPresented,
              },
            },
          }),
        })
      }
    }

    if (card.id === TITAN_CARD && activity === 'finished') {
      helperBatchesPresented.clear()
    }

    return eventId
  }

  const sessionEnded = ({ entry }: { entry: Live }) => {
    contextPresented.clear()

    // A check turn cut before it finished hands its updates back; they reach Titan once the owner continues it.
    if (entry.activity === 'working') {
      handBack()
    } else {
      finishReading()
    }
  }

  return {
    cancel: () => {
      stopGeneration += 1
    },
    digest,
    titanSession,
    titan,
    startedByOwner,
    turnFinished,
    activityChanged: turnEnded,
    activityEventId,
    turnRecorded: armWake,
    sessionEnded,
  }
}
