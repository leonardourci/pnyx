import { applyHelper } from '../helper/state.ts'
import { applySteering } from '../task-inbox/state.ts'
import {
  AUTO_TITLE_SOURCES,
  EVENT_VERSION,
  LEGACY_IN_PROGRESS,
  SESSION_TITLE,
  type AutoTitle,
  type HydraEvent,
  type HydraState,
  type Card,
  type Column,
  type Link,
  type SourceRef,
} from './model.ts'
import { applyAttachment, cardSessionId, observeSession, sessionId } from './tasks.ts'
import { applyHydra, fallbackColumn, hydraConfig, refreshTasks, roleColumn } from './hydra.ts'
import { applyPermission } from './permissions.ts'
import { applyAsk } from './asks.ts'
import { refreshDone } from './retention.ts'
import { applyReminder } from '../reminders/state.ts'
import { applyQueue } from '../queue/state.ts'
import { requestId } from './answer.ts'
import { applyLabelColors } from './labels.ts'

export function emptyHydra(): HydraState {
  return {
    v: EVENT_VERSION,
    seq: 0,
    cards: {},
    keys: {},
    eventIds: {},
    undone: {},
  }
}

// Keeps the best auto title seen: a better source replaces a worse one, a later
// session title or folder replaces an earlier one, and the first prompt stays. It
// becomes the title only while no push has set one.
function offerTitle({
  card,
  next,
}: {
  card: Card
  next: AutoTitle
}): void {
  const current = card.autoTitle

  if (current) {
    const rank = AUTO_TITLE_SOURCES.indexOf(next.from) - AUTO_TITLE_SOURCES.indexOf(current.from)

    if (rank > 0 || (rank === 0 && next.from === 'prompt')) {
      return
    }
  }

  card.autoTitle = next

  if (!card.titleSet) {
    card.title = next.text
  }
}

function sameSource({
  a,
  b,
}: {
  a: SourceRef
  b: SourceRef
}): boolean {
  return a.adapter === b.adapter && a.instanceId === b.instanceId && a.objectId === b.objectId
}

export function isStaleSource({
  card,
  source,
}: {
  card: Card | undefined
  source: SourceRef
}): boolean {
  const known = card?.sourceRefs.find(r => sameSource({
    a: r,
    b: source,
  }))

  if (!known) {
    return false
  }

  const knownGen = known.generation ?? 0
  const gen = source.generation ?? 0

  if (gen !== knownGen) {
    return gen < knownGen
  }

  // ISO-8601 UTC timestamps compare correctly as strings.
  return known.observedAt !== undefined
    && source.observedAt !== undefined
    && source.observedAt < known.observedAt
}

export function isStaleLink({
  current,
  next,
}: {
  current: Link | undefined
  next: Link
}): boolean {
  return current?.checkedAt !== undefined
    && next.checkedAt !== undefined
    && next.checkedAt < current.checkedAt
}

export function wouldCycle({
  cards,
  cardId,
  parentId,
}: {
  cards: Record<string, Card>
  cardId: string
  parentId: string
}): boolean {
  const seen = new Set<string>()

  for (let p: string | undefined = parentId; p !== undefined; p = cards[p]?.parentId) {
    if (p === cardId || seen.has(p)) {
      return true
    }

    seen.add(p)
  }

  return false
}

function newCardColumn({ state }: { state: HydraState }): Column {
  const columns = hydraConfig({ state }).columns

  return columns.some(c => c.id === LEGACY_IN_PROGRESS) ? LEGACY_IN_PROGRESS : roleColumn({
    columns,
    role: 'in_progress',
  }) ?? fallbackColumn({ columns })
}

function apply({
  state,
  event,
}: {
  state: HydraState
  event: HydraEvent
}): boolean {
  if (event.seq <= state.seq || event.id in state.eventIds) {
    return false
  }

  state.seq = event.seq
  state.eventIds[event.id] = event.seq
  applyLabelColors({
    state,
    colors: event.labelColors,
  })

  if (applySteering({
    state,
    event,
  }) || applyQueue({
    state,
    event,
  }) || applyReminder({
    state,
    event,
  })
    || applyPermission({
      state,
      event,
    })
    || applyAsk({
      state,
      event,
    })
    || applyHelper({
      state,
      event,
    })
    || applyHydra({
      state,
      event,
    })) {
    if (event.undoes) {
      state.undone[event.undoes] = event.id
    }

    return true
  }

  if (event.type === 'chat.message') {
    return true
  }

  if (event.type === 'board.view') {
    state.view = structuredClone(event.data.after)
    state.viewRevision = (state.viewRevision ?? 0) + 1

    for (const placement of event.data.placements ?? []) {
      const placed = state.cards[placement.cardId]

      if (!placed) {
        continue
      }

      if (placement.after) {
        placed.column = placement.after
      }

      placed.revision += 1
      placed.updatedSeq = event.seq
      placed.updatedAt = event.at
    }

    refreshTasks({ state })

    if (event.undoes) {
      state.undone[event.undoes] = event.id
    }

    return true
  }

  let card = state.cards[event.cardId]

  if (event.type === 'task.session') {
    const attached = state.sessions?.[event.data.session]?.taskId === event.data.before
    applyAttachment({
      state,
      event,
    })

    if (attached) {
      for (const id of [
        event.data.before,
        event.data.after,
      ]) {
        const task = id && state.cards[id]

        if (task) {
          task.steeringGeneration = event.seq
        }
      }
    }

    if (event.undoes) {
      state.undone[event.undoes] = event.id
    }

    refreshTasks({
      state,
      ids: [
        event.cardId,
        event.data.before,
        event.data.after,
      ],
    })

    if (card && event.data.before !== card.id) {
      card.revision++
      card.updatedSeq = event.seq
      card.updatedAt = event.at
    }

    return true
  }

  if (event.type === 'card.pushed') {
    const {
      key,
      source,
      ...fields
    } = event.data
    delete fields.before

    if (!card) {
      if (key in state.keys) {
        return false
      }

      card = {
        id: event.cardId,
        key,
        title: key,
        workspace: 'unassigned',
        tags: [],
        attention: [],
        links: [],
        sourceRefs: [],
        ...(fields.agent && (!source || [
          'hooks',
          'paseo',
          'pnyx',
        ].includes(source.adapter)) ? { automaticTask: true } : {}),
        column: newCardColumn({ state }),
        revision: 0,
        createdSeq: event.seq,
        createdAt: event.at,
        updatedSeq: event.seq,
        updatedAt: event.at,
      }
      state.cards[card.id] = card
      state.keys[key] = card.id
    }

    if (source) {
      if (isStaleSource({
        card,
        source,
      })) {
        return false
      }

      card.sourceRefs = [
        ...card.sourceRefs.filter(r => !sameSource({
          a: r,
          b: source,
        })),
        source,
      ]
    }

    const {
      parentId,
      activity,
      settings,
      folder,
      autoTitle,
      project,
      ...rest
    } = fields
    Object.assign(
      card,
      rest,
    )

    if (project === null) {
      delete card.project
    } else if (project !== undefined) {
      card.project = project
    }

    if (settings === null) {
      delete card.settings
    } else if (settings !== undefined) {
      card.settings = settings
    }

    if (rest.title === null) {
      delete card.titleSet
      card.title = card.autoTitle?.text ?? key
    } else if (rest.title !== undefined) {
      card.titleSet = true
    }

    if (autoTitle) {
      offerTitle({
        card,
        next: autoTitle,
      })
    }

    if (folder === null) {
      delete card.folder
    } else if (folder !== undefined) {
      card.folder = folder
    }

    if (activity === null) {
      delete card.activity
    } else if (activity !== undefined) {
      card.activity = activity
    }

    if (activity === 'ended') {
      card.stoppedAt ??= event.at
    } else if (typeof activity === 'string' && (source?.adapter === 'hooks' || source?.adapter === 'pnyx' || !card.sessionActivity)) {
      delete card.stoppedAt
    }

    // A hosted agent's activity comes from the host as its session's own.
    if ((source?.adapter === 'hooks' || source?.adapter === 'pnyx') && typeof activity === 'string') {
      if (activity !== 'working') {
        if (card.sessionActivity === 'working') {
          card.turnEndedSeq = event.seq
        }

        delete card.workingSince
      } else if (card.sessionActivity !== 'working' || !card.workingSince) {
        card.workingSince = event.at
      }

      card.sessionActivity = activity
    }

    if (parentId === null) {
      delete card.parentId
    } else if (parentId !== undefined && !wouldCycle({
      cards: state.cards,
      cardId: card.id,
      parentId,
    })) {
      card.parentId = parentId
    }
  } else {
    if (!card) {
      return false
    }

    if (event.type === 'card.moved') {
      if (event.data.after) {
        card.column = event.data.after
      }

      if (event.data.rank !== undefined) {
        card.rank = event.data.rank
      }
    } else if (event.type === 'card.linked') {
      const {
        url,
        after,
      } = event.data
      const current = card.links.find(l => l.url === url)

      if (after && !event.undoes && isStaleLink({
        current,
        next: after,
      })) {
        return false
      }

      const others = card.links.filter(l => l.url !== url)
      card.links = after
        ? (current ? card.links.map(l => (l.url === url ? after : l)) : [
          ...others,
          after,
        ])
        : others
    } else if (event.type === 'card.replied') {
      const answers = event.data.answers
      const previous = card.replies?.find(r => r.id === event.data.reply)
      const taskMessage = event.data.taskMessage || previous?.route
      const resumes = event.data.resumes ?? previous?.resumes
      const reply = {
        id: event.data.reply,
        state: event.data.state,
        ...(resumes !== undefined ? { resumes } : {}),
        ...(taskMessage ? { route: event.data.route } : {}),
        ...(taskMessage && event.data.detail ? { detail: event.data.detail } : {}),
      }
      const kept = answers ? {
        ...reply,
        answers,
      } : reply
      const replies = card.replies ?? []
      card.replies = replies.some(r => r.id === reply.id)
        ? replies.map(r => (r.id === reply.id ? kept : r))
        : [
          ...replies,
          kept,
        ]

      // A task shows its session's requests, which hooks read back from the
      // session's own card, so the answer is marked on all of them.
      if (answers && event.data.state === 'delivered') {
        if (card.asks) {
          card.asks = card.asks.map(a => (a.id === answers ? {
            ...a,
            answered: reply.id,
            answeredAt: event.at,
            fromMessage: event.data.decision?.fromMessage,
          } : a))
        }

        const id = cardSessionId({ card })
        const session = id ? state.sessions?.[id] : undefined
        const origin = session && state.cards[session.originCardId]
        const task = session?.taskId ? state.cards[session.taskId] : undefined

        for (const holder of new Set([
          card,
          session,
          origin,
          task,
        ])) {
          if (holder) {
            holder.attention = holder.attention
              .map(a => (requestId({ request: a }) === answers ? {
                ...a,
                answered: reply.id,
              } : a))
          }
        }
      }
    } else if (event.type === 'card.noted') {
      const {
        kind,
        source,
        at,
        text,
      } = event.data
      card.notes = [
        ...(card.notes ?? []),
        {
          id: event.id,
          kind,
          source,
          ...(at ? { at } : {}),
        },
      ]

      if (kind === 'context' && text.startsWith(SESSION_TITLE)) {
        offerTitle({
          card,
          next: {
            from: 'session',
            text: text.slice(SESSION_TITLE.length),
          },
        })
      }
    } else if (event.type === 'card.outcome') {
      if (event.data.after) {
        card.outcome = event.data.after

        if (event.data.after.state === 'ended') {
          card.stoppedAt ??= event.at
        }
      } else {
        delete card.outcome
      }

      const before = event.data.before, after = event.data.after
      const changed = before?.state !== after?.state || before?.note !== after?.note
        || before?.closed !== after?.closed || before?.source !== after?.source
      const manual = !after?.source && before?.source !== 'firstmate'
        && !(!after && before?.source === 'hooks')

      const undone = event.undoes ? card.statusLog?.findIndex(d => d.id === event.undoes) ?? -1 : -1

      if (undone >= 0) {
        if (card.status?.id === event.undoes) {
          const previous = card.statusLog![undone - 1]

          if (previous) {
            card.status = previous
          } else {
            delete card.status
          }
        }
      } else if (card.tracking && changed && manual) {
        const declaration = {
          id: event.id,
          at: event.at,
          actor: event.actor,
          state: !event.data.after ? 'paused' as const
            : event.data.after.state === 'failed' && !event.data.after.closed
              ? 'blocked' as const : 'done' as const,
          note: event.data.after?.note ?? 'Task outcome updated',
        }
        card.status = declaration
        card.statusLog = [
          ...(card.statusLog ?? []),
          declaration,
        ]
      }
    }
  }

  if (event.undoes) {
    state.undone[event.undoes] = event.id
  }

  observeSession({
    state,
    card,
    event,
  })
  const task = card.agent && state.sessions?.[sessionId({ agent: card.agent })]?.taskId
  refreshTasks({
    state,
    ids: [
      card.id,
      task,
    ],
  })

  card.revision += 1

  if (event.type === 'card.noted') {
    return true
  }

  card.updatedSeq = event.seq
  card.updatedAt = event.at

  return true
}

export function replay({
  state,
  events,
}: {
  state: HydraState
  events: Iterable<HydraEvent>
}): HydraState {
  const next = structuredClone(state)

  for (const event of events) {
    if (apply({
      state: next,
      event,
    })) {
      refreshDone({
        state: next,
        at: event.at,
      })
    }
  }

  return next
}

export function reduce({
  state,
  event,
}: {
  state: HydraState
  event: HydraEvent
}): HydraState {
  return replay({
    state,
    events: [event],
  })
}
