import { collectingNotices, commandNotices, inform } from './command-notices.ts'
import { applyObservation, type SourceObservation } from '#tasks/observations.ts'
import type { Output } from './cli-support.ts'
import { transactionReceipt } from './transactions.ts'
import type { TitanState, TitanEvent } from './model.ts'
import { TitanError } from '#store/errors.ts'
import { LABEL_COLORS } from '#tasks/model.ts'
import { requireTitan, writableTitan, reloadTitan } from './store.ts'
import { nativeHome, bindNativeTask, type NativeHeld } from './native-home.ts'
import { nativeChanges, nativeDecision, nativeFact, nativeInscribe, nativeSessionSource, nativeJson, nativeReferences, nativeId, projectNative, reduceNative, type NativeFact, type NativeState } from './native-state.ts'
import { taskRuntimeDir } from '#store/paths.ts'
import { agentActor } from '#titan/titan.ts'
import { isHelper, guardTaskLease, deliveringMessage } from '#routine-helper/leases.ts'
import { helperGrant } from '#routine-helper/route.ts'
import { labelsForEvent } from '#tasks/labels.ts'
import { randomInt } from 'node:crypto'
import { replayOwned } from './reducer.ts'
import { draft } from './draft.ts'
import { reconcileAsks, retireableReviewQuestions } from '#tasks/delivery/merge-questions.ts'
import { log } from './diagnostics.ts'
import { durableEvent } from './event-policy.ts'
import { enqueueSteering } from '#workers/inbox.ts'
import { TITAN_CARD } from '#titan/identity.ts'
import { sessionFields } from '#workers/session-facts.ts'
import { sessionId } from '#workers/session-attachments.ts'
import { requireHandoffAvailable } from '#workers/handoff-checkout.ts'

const RECENT_CHANGES = 50_000
const MESSAGE_EVENTS = new Set<string>([
  'card.replied',
  'task.steering.queued',
  'task.steering.notified',
])

export interface Writer {
  readonly state: TitanState
  readonly dir: string
  observe({ observation }: { observation: SourceObservation }): void
  afterCommit({ run }: { run(): void }): void
  append({
    event,
    effects,
    receipt,
  }: {
    event: TitanEvent
    effects?: boolean
    receipt?: boolean
  }): void
}

interface WriterOptions<T> {
  titanId: string
  create?: boolean
  removal?: boolean
  also?: string[]
  transaction?: {
    id: string
    digest: string
  }
  migrate?: boolean
  fn({
    writer,
    writers,
  }: {
    writer: Writer
    writers: ReadonlyMap<string, Writer>
  }): T
}

interface Stage {
  id: string
  held: NativeHeld
  initial: TitanState
  writer: Writer
  pending: TitanEvent[]
  committed: (() => void)[]
  facts: Map<string, NativeFact[]>
  incoming: Map<string, NativeState>
  outgoing: Map<string, NativeState>
  projections: Map<string, NativeState>
}

export function withWriter<T>({ fn }: WriterOptions<T> & { transaction?: undefined }): Promise<T>
export function withWriter({ fn }: WriterOptions<Output> & {
  transaction: {
    id: string
    digest: string
  }
}): Promise<Output>

export function withWriter<T>({ ...options }: WriterOptions<T>): Promise<T | Output> {
  const home = nativeHome()

  return home.run({
    fn: async () => {
      const {
        titanId,
        fn,
        create = false,
        removal = false,
        also = [],
        transaction,
        migrate = true,
      } = options

      if (!create) {
        requireTitan({ titanId })
      }

      await home.ensure({ titan: titanId })
      const initial = writableTitan({ titanId })

      if (transaction) {
        const previous = transactionReceipt({
          titanId,
          ...transaction,
          eventIds: initial.state.eventIds,
        })

        if (previous) {
          return previous
        }
      }

      const stages: Stage[] = [
        ...new Set([
          titanId,
          ...also,
        ]),
      ].sort().map(id => {
        requireTitan({ titanId: id })
        const held = writableTitan({ titanId: id })

        if (held.state.config?.removing && !removal) {
          throw new TitanError({
            code: 'CONFLICT',
            message: `Titan removal is pending: ${id}`,
          })
        }

        if (held.state.config?.removed) {
          throw new TitanError({
            code: 'NOT_FOUND',
            message: `Titan was removed: ${id}`,
          })
        }

        const stage: Omit<Stage, 'writer'> = {
          id,
          held,
          initial: held.state,
          pending: [],
          committed: [],
          facts: new Map(),
          incoming: new Map(),
          outgoing: new Map(),
          projections: new Map(),
        }

        const basis = ({ scope }: { scope: string }): NativeState => {
          let current = stage.projections.get(scope)

          if (!current) {
            current = home.files.value({
              titan: id,
              task: scope === TITAN_CARD ? undefined : scope,
            })?.state ?? {}
            stage.projections.set(
              scope,
              current,
            )
          }

          return current
        }

        const add = ({
          scope,
          fact,
        }: {
          scope: string
          fact: NativeFact
        }) => {
          const facts = stage.facts.get(scope) ?? []
          facts.push(fact)
          stage.facts.set(
            scope,
            facts,
          )
          stage.projections.set(
            scope,
            reduceNative({
              state: structuredClone(basis({ scope })),
              entry: {
                ...fact,
                n: 0,
              },
              id: scope,
            }),
          )
        }

        const writer = eventWriter({
          state: held.state,
          dir: held.dir,
          titanId: id,
          transaction: id === titanId ? transaction?.id : undefined,
          committed: stage.committed,
          onAppend: ({ event }) => {
            home.position({
              titan: id,
              scope: event.cardId.startsWith('$') || event.type.startsWith('titan.') ? id : event.cardId,
              id: event.id,
              seq: event.seq,
            })
            stage.pending.push(event)
          },
          onApplied: ({
            event,
            before,
            after,
          }) => {
            if (event.type === 'session.observed' || (event.type === 'task.edited' && event.data.source)) {
              const agent = sessionFields({
                event,
                state: after,
              })?.agent
              const session = agent && after.sessions?.[sessionId({ agent })]

              if (session && session.agent.host !== 'othrys') {
                const owner = session.taskId ?? session.originCardId
                const scope = after.cards[owner] ? owner : TITAN_CARD
                const source = nativeSessionSource({
                  session,
                  previous: basis({ scope }).sessions?.[session.id],
                  event,
                })

                if (source) {
                  add({
                    scope,
                    fact: source,
                  })
                }
              }
            }

            if (event.type === 'titan.operation' && event.data.kind === 'inscribe') {
              add({
                scope: TITAN_CARD,
                fact: nativeInscribe({
                  event,
                  ids: home.references({ titan: id }),
                  basis: basis({ scope: TITAN_CARD }),
                  beforeSeq: before.seq,
                }),
              })

              return
            }

            if (!durableEvent({ event }) || event.type === 'apply.recorded') {
              return
            }

            const metadata = nativeFact({
              event,
              before,
              after,
              ids: home.references({ titan: id }),
              basis: basis({ scope: TITAN_CARD }),
            })
            const scoped = before.cards[event.cardId] ?? after.cards[event.cardId]
            const titanEvent = event.type.startsWith('titan.')
            || event.cardId === TITAN_CARD || !scoped

            if (metadata.change?.length || titanEvent) {
              if (!titanEvent) {
                delete metadata.event
                metadata.t = 'config'
                metadata.id = `native-metadata:${event.id}`
              }

              add({
                scope: TITAN_CARD,
                fact: metadata,
              })
            }

            if (event.type === 'task.moved-out') {
              stage.outgoing.set(
                event.cardId,
                projectNative({
                  state: before,
                  task: event.cardId,
                  ids: home.references({ titan: id }),
                }),
              )
            }

            if (event.type === 'task.moved-in') {
              stage.incoming.set(
                event.cardId,
                projectNative({
                  state: after,
                  task: event.cardId,
                  ids: home.references({ titan: id }),
                }),
              )
              stage.projections.set(
                event.cardId,
                stage.incoming.get(event.cardId)!,
              )
            }

            const tasks = new Set<string>()

            for (const task of new Set([
              ...Object.keys(before.cards),
              ...Object.keys(after.cards),
            ])) {
              if (before.cards[task] !== after.cards[task]) {
                tasks.add(task)
              }
            }

            for (const key of new Set([
              ...Object.keys(before.sessions ?? {}),
              ...Object.keys(after.sessions ?? {}),
            ])) {
              const prior = before.sessions?.[key]
              const next = after.sessions?.[key]

              if (prior !== next) {
                for (const session of [
                  prior,
                  next,
                ]) {
                  const task = session?.taskId ?? session?.originCardId

                  if (task) {
                    tasks.add(task)
                  }
                }
              }
            }

            if (scoped && event.cardId !== TITAN_CARD) {
              tasks.add(event.cardId)
            }

            tasks.delete(TITAN_CARD)

            for (const task of tasks) {
              if (task === event.cardId && (event.type === 'task.moved-in' || event.type === 'task.moved-out')) {
                continue
              }

              const issue = home.files.positions({ titan: id })?.tasks.get(task)?.issue

              if (issue) {
                if (event.cardId === task) {
                  throw issue
                }

                continue
              }

              const fact = nativeFact({
                event,
                before,
                after,
                task,
                ids: home.references({ titan: id }),
                basis: basis({ scope: task }),
              })
              const fresh = !home.files.locateTask({ task }) && !stage.facts.has(task)

              if (fresh) {
                fact.t = 'created'
                fact.change = nativeChanges({
                  before: {},
                  after: projectNative({
                    state: after,
                    task,
                    ids: home.references({ titan: id }),
                  }),
                })
              }

              if (fact.change?.length || task === event.cardId) {
                add({
                  scope: task,
                  fact,
                })
              }
            }
          },
        })

        return {
          ...stage,
          writer,
        }
      })
      const writers = new Map(stages.map(stage => [
        stage.id,
        stage.writer,
      ]))
      const primary = writers.get(titanId)!
      let result: T
      let attemptedWrite = false

      try {
        for (const stage of stages) {
          if (migrate) {
            retireReviewQuestions({ writer: stage.writer })
          }
        }

        result = fn({
          writer: primary,
          writers,
        })
        const moves = stages.flatMap(stage => stage.pending.flatMap(event => event.type === 'task.moved-in'
          ? [
            {
              event,
              stage,
            },
          ] : []))
        const moving = new Map(moves.map(({
          event,
          stage,
        }) => [
          event.cardId,
          stage.id,
        ]))
        const changes = stages.flatMap(stage => [...stage.facts].flatMap(([
          scope,
          facts,
        ]) => {
          if (moving.get(scope) === stage.id) {
            return []
          }

          return [
            {
              titan: stage.id,
              task: scope === TITAN_CARD ? undefined : scope,
              create: scope !== TITAN_CARD && !home.files.locateTask({ task: scope }),
              facts,
            },
          ]
        }))

        if (changes.length) {
          attemptedWrite = true
          await home.files.change({ decide: () => changes })
        }

        for (const {
          event,
          stage,
        } of moves) {
          const source = stages.find(candidate => candidate.id === event.data.from)
          const before = source?.outgoing.get(event.cardId)
          const after = stage.incoming.get(event.cardId)

          if (!before || !after) {
            throw new TitanError({
              code: 'INVALID_MOVE',
              message: 'task move has no matching source and destination',
            })
          }

          attemptedWrite = true
          await home.files.moveTask({
            from: event.data.from,
            to: stage.id,
            task: event.cardId,
            id: event.id,
            at: event.at,
            by: 'daemon',
            data: {
              event: nativeDecision({
                event,
                ids: home.references({ titan: stage.id }),
              }),
              key: before.card?.key ?? event.cardId,
              change: nativeChanges({
                before: source?.projections.get(event.cardId)
                  ?? home.files.value({
                    titan: event.data.from,
                    task: event.cardId,
                  })?.state ?? {},
                after: {
                  ...source?.projections.get(event.cardId)
                    ?? home.files.value({
                      titan: event.data.from,
                      task: event.cardId,
                    })?.state,
                  ...after,
                },
              }),
            },
          })
          const remaining = stage.facts.get(event.cardId)

          if (remaining?.length) {
            await home.files.changeTask({
              titan: stage.id,
              task: event.cardId,
              decide: () => remaining,
            })
          }
        }

        if (transaction) {
          attemptedWrite = true
          const value = nativeReferences({
            value: nativeJson({ value: result as Output }),
            ids: home.references({ titan: titanId }),
            kind: 'receipt',
          }) as Output
          await home.files.changeTitan({
            titan: titanId,
            decide: () => [
              {
                t: 'config',
                id: transaction.id,
                at: primary.state.changedAt ?? new Date().toISOString(),
                by: 'daemon',
                receipt: {
                  ...transaction,
                  value,
                },
              },
            ],
          })
        }

        if (transaction) {
          const receipts = home.receipts.get(titanId) ?? new Map()
          receipts.set(
            transaction.id,
            {
              digest: transaction.digest,
              value: nativeJson({ value: result as Output }),
            },
          )
          home.receipts.set(
            titanId,
            receipts,
          )
        }

        for (const stage of stages) {
          const state = stage.writer.state
          const receiptChanged = transaction !== undefined && stage.id === titanId
          home.remember({
            titan: stage.id,
            state,
            events: stage.pending,
            dirty: stage.facts.size > 0 || stage.incoming.size > 0 || receiptChanged,
          })
          const observations = stage.pending.filter(event => !durableEvent({ event }))
          stage.held.changes = stage.held.changes.concat(observations).slice(-RECENT_CHANGES)

          for (const [
            task,
            facts,
          ] of stage.facts) {
            if (task !== TITAN_CARD && state.cards[task] && facts.length) {
              bindNativeTask({
                home: home.path,
                titan: stage.id,
                card: state.cards[task]!,
              })
            }
          }

          for (const task of stage.incoming.keys()) {
            bindNativeTask({
              home: home.path,
              titan: stage.id,
              card: state.cards[task]!,
            })
          }
        }
      } catch (error) {
        for (const stage of stages) {
          for (const event of stage.pending) {
            const root = event.cardId.startsWith('$') || event.type.startsWith('titan.')
            const holder = root ? undefined : home.files.locateTask({ task: event.cardId })
            const scope = root ? stage.id : event.cardId
            const accepted = home.files.has({
              titan: holder?.titan ?? stage.id,
              task: root ? undefined : event.cardId,
              id: event.id,
            })

            if (!accepted) {
              home.references({ titan: stage.id }).delete(nativeId({
                scope,
                id: event.id,
              }))
            }
          }

          if (!attemptedWrite) {
            continue
          }

          const pending = stage.held.pending
          const changes = stage.held.changes
          reloadTitan({ titanId: stage.id })
          stage.held.state.eventIds = {
            ...stage.initial.eventIds,
            ...stage.held.state.eventIds,
          }
          stage.held.state.seq = Math.max(
            stage.initial.seq,
            stage.held.state.seq,
          )
          stage.held.pending = pending
          stage.held.changes = changes
        }

        if (attemptedWrite) {
          home.restoreMoves()
        }

        throw error
      }

      for (const stage of stages) {
        for (const run of stage.committed) {
          try {
            run()
          } catch (error) {
            log({
              level: 'error',
              operation: 'events.after-commit',
              titanId: stage.id,
              error,
            })
          }
        }
      }

      for (const stage of stages) {
        if (stage.pending.length) {
          stage.held.changed()
        }
      }

      return result
    },
  })
}

export function eventWriter({
  state: initial,
  dir,
  titanId,
  transaction,
  committed = [],
  onAppend,
  onApplied,
}: {
  state: TitanState
  dir: string
  titanId: string
  transaction?: string
  committed?: (() => void)[]
  onAppend({
    event,
    receipt,
  }: {
    event: TitanEvent
    receipt?: boolean
  }): void
  onApplied?({
    event,
    before,
    after,
    receipt,
  }: {
    event: TitanEvent
    before: TitanState
    after: TitanState
    receipt: boolean
  }): void
}): Writer {
  let state = { ...initial }
  let ownedIds: TitanState['eventIds'] | undefined
  const writer: Writer = {
    dir,
    observe({ observation }) {
      state = draft({
        state,
        change: ({ state }) => applyObservation({
          state,
          observation,
        }),
      })
      log({
        operation: 'card.observed',
        detailed: true,
        titanId,
        taskId: observation.cardId,
        name: observation.source.adapter,
      })
    },
    get state() {
      return state
    },
    afterCommit: ({ run }) => {
      committed.push(run)
    },
    append({
      event,
      effects = true,
      receipt = false,
    }) {
      if (event.type === 'task.created' && !event.data.workerLogDir) {
        event = {
          ...event,
          data: {
            ...event.data,
            workerLogDir: taskRuntimeDir({ task: event.cardId }),
          },
        }
      }

      // What a worker's transcript recorded is an observation, never another Titan session's change, so a lease never refuses it.
      const harvested = event.actor === 'harvest'
      // A message to a task's agent is never refused for the routine helper's lease; it queues like any message.
      const message = !isHelper({ actor: event.actor })
        && (MESSAGE_EVENTS.has(event.type) || deliveringMessage.getStore() === true)

      if (!agentActor({ actor: event.actor }) && !harvested && !message
        && (event.type !== 'titan.message' || isHelper({ actor: event.actor }))) {
        const task = event.type === 'titan.message' ? event.data.task : event.cardId

        if (task && state.cards[task]) {
          guardTaskLease({
            dir,
            task,
            actor: event.actor,
          })
        }

        if (isHelper({ actor: event.actor }) && (!task || !helperGrant({
          state,
          task,
          actor: event.actor,
        }))) {
          inform({
            task,
            reason: 'Helper changed a task outside its default scope',
            clear: 'Read the task’s task.log to inspect the change',
          })
        }
      }

      const notices = commandNotices({ task: event.cardId })

      if (collectingNotices() && !harvested && !event.actor.startsWith('hook:')) {
        event = {
          ...event,
          notices,
        }
      }

      const known = Object.hasOwn(
        state.eventIds,
        event.id,
      )

      if (transaction && known) {
        throw new TitanError({
          message: `event id ${event.id} already exists`,
          code: 'IDEMPOTENCY_CONFLICT',
        })
      }

      if (known) {
        return
      }

      if (event.type === 'task.session' && !event.data.handoff) {
        const current = state.sessions?.[event.data.session]
        const replaced = event.data.replaces ? state.sessions?.[event.data.replaces] : undefined
        const affected = new Set([
          event.data.before,
          event.data.after,
          current?.taskId,
          replaced?.taskId,
        ])

        for (const task of affected) {
          if (task) {
            requireHandoffAvailable({
              titanId,
              task,
            })
          }
        }
      }

      if (event.seq !== state.seq + 1) {
        throw new TitanError({
          code: 'INVALID_EVENT',
          message: `append out of sequence: ${event.seq} after ${state.seq}`,
        })
      }

      const knownLabels = new Set(state.labelColors?.map(entry => entry.label))
      const labelColors = labelsForEvent({
        state,
        event,
      })
        .filter(label => !knownLabels.has(label))
        .map(label => ({
          label,
          color: LABEL_COLORS[randomInt(LABEL_COLORS.length)] ?? 'slate',
        }))

      if (labelColors.length && !event.labelColors) {
        event = {
          ...event,
          labelColors,
        }
      }

      const card = state.cards[event.cardId]
      const parent = event.type === 'task.created' ? event.data.parentId : card?.parentId
      let session = card?.sessionIds?.[0]

      if (event.type === 'task.session') {
        session = event.data.session
      } else if (event.type === 'session.observed' && 'session' in event.data) {
        session = event.data.session
      }

      let agent = card?.agent

      if (session) {
        agent = state.sessions?.[session]?.agent
      }

      if (event.type === 'task.edited' && event.data.agent) {
        agent = event.data.agent
      } else if (event.type === 'session.observed' && 'fields' in event.data) {
        agent = event.data.fields.agent
      }

      if (event.type === 'task.session' && event.data.started) {
        agent = event.data.started.agent
      }

      let observedSession = session
      const envelope: Partial<TitanEvent> = {
        titanId: titanId,
        commandId: event.id,
      }

      if (event.cardId !== '$all' && event.cardId !== '$sessions') {
        envelope.taskId = parent ?? event.cardId
      }

      if (parent) {
        envelope.subtaskId = event.cardId
      }

      if (agent) {
        const suffix = agent.agentId ? `/${agent.agentId}` : ''
        observedSession = `${agent.provider}:${agent.sessionId}${suffix}`
        envelope.agentId = `${agent.provider}:${agent.agentId ?? agent.sessionId}`
      }

      if (observedSession) {
        envelope.sessionId = observedSession
      }

      if (event.type === 'card.replied') {
        envelope.messageId = event.data.reply
      }

      event = {
        ...envelope,
        ...event,
      }

      if (transaction) {
        event = {
          ...event,
          transaction,
        }
      }

      const before = state

      if (!ownedIds) {
        ownedIds = { ...state.eventIds }
      }

      const previousId = Object.getOwnPropertyDescriptor(
        ownedIds,
        event.id,
      )

      try {
        state = draft({
          state: {
            ...state,
            eventIds: ownedIds,
          },
          owned: [ownedIds],
          change: ({ state }) => {
            replayOwned({
              state,
              events: [event],
            })
          },
        })
      } catch (error) {
        if (previousId) {
          Object.defineProperty(
            ownedIds,
            event.id,
            previousId,
          )
        } else {
          delete ownedIds[event.id]
        }

        throw error
      }

      ownedIds = state.eventIds
      onAppend({
        event,
        receipt,
      })
      onApplied?.({
        event,
        before,
        after: state,
        receipt,
      })

      if (!effects) {
        return
      }

      if (event.type === 'task.brief' && event.data.before !== event.data.after && card?.agent) {
        enqueueSteering({
          writer,
          ref: event.cardId,
          id: `description:${event.id}`,
          text: `Description updated:\n\n${event.data.after || '(Description cleared.)'}`,
          source: event.actor,
          meta: {
            at: event.at,
            actor: event.actor,
          },
        })
      }

      for (const question of reconcileAsks({
        state,
        event,
      })) {
        writer.append({
          event: {
            ...question,
            seq: state.seq + 1,
          },
        })
      }

      switch (event.type) {
        case 'task.edited':
        case 'titan.configured':
        case 'card.linked':
        case 'card.outcome':
        case 'titan.project':
        case 'task.landing':
        case 'task.moved-in':
        case 'task.moved-out':
        case 'task.project':
          if (event.type === 'task.edited'
              && before.cards[event.cardId]?.project === state.cards[event.cardId]?.project) {
            break
          }

          retireReviewQuestions({
            writer,
            at: event.at,
          })
          break
      }
    },
  }

  return writer
}

function retireReviewQuestions({
  writer,
  at = new Date().toISOString(),
}: {
  writer: Writer
  at?: string
}): void {
  for (const review of retireableReviewQuestions({
    state: writer.state,
    at,
  })) {
    writer.append({ event: review })
  }
}
