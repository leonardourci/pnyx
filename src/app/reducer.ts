import { ownerActor } from './actors.ts'
import type { HydraState, HydraEvent } from './model.ts'
import { refreshTasks } from '../tasks/columns.ts'
import { roleColumn, ROLE_STATUS } from '../tasks/column-rules.ts'
import { HYDRA_CARD, hydraConfig } from '../core/hydra.ts'
import { EVENT_VERSION } from '../store/events.ts'
import { SESSION_TITLE } from '../tasks/model.ts'
import { applyLabelColors } from '../tasks/labels.ts'
import { applyCompaction } from '../workers/compaction/state.ts'
import { applyUpgrade } from '../upgrade/state.ts'
import { applyExternalSource } from '../task-sources/state.ts'
import { applySteering } from '../workers/steering.ts'
import { applyDependencies } from '../tasks/dependencies.ts'
import { applyQueue } from '../workers/queue.ts'
import { applyReminder } from '../tasks/reminders.ts'
import { applyPermission } from '../workers/permission-rules.ts'
import { applyAsk } from '../tasks/questions.ts'
import { applyHelper } from '../helper/state.ts'
import { applyAttachment, cardSessionId, observeSession, sessionId } from '../workers/session-attachments.ts'
import { newCardColumn, isStaleSource, sameSource, offerTitle, wouldCycle } from '../tasks/events.ts'
import { isStaleLink } from '../tasks/delivery/events.ts'
import { requestId } from '../workers/answers.ts'
import { refreshDone } from '../tasks/retention-rules.ts'

export function applyHydra({
  state,
  event,
}: {
  state: HydraState
  event: HydraEvent
}): boolean {
  if (event.type === 'hydra.dispatch-proposed') {
    state.dispatchProposals = [
      ...(state.dispatchProposals ?? []).filter(p => p.token !== event.data.token),
      structuredClone(event.data),
    ]

    return true
  }

  if (event.type === 'hydra.status') {
    state.hydraStatus = {
      ...structuredClone(event.data),
      seq: event.seq,
    }

    return true
  }

  if (event.type === 'hydra.dispatch-progress') {
    const proposal = state.dispatchProposals?.find(p => p.token === event.data.token)

    if (proposal) {
      proposal.status = event.data.status
      proposal.error = event.data.error
    }

    return true
  }

  if (event.type === 'hydra.dispatch-resolved') {
    state.dispatchProposals = (state.dispatchProposals ?? [])
      .filter(p => p.token !== event.data.token)

    return true
  }

  if (event.type === 'hydra.project') {
    state.projects = [
      ...(state.projects ?? []).filter(p => p.path !== event.data.after.path),
      structuredClone(event.data.after),
    ]
    state.projectsRevision = (state.projectsRevision ?? 0) + 1

    return true
  }

  if (event.type === 'task.project') {
    const card = state.cards[event.cardId]

    if (card) {
      if (event.data.after === null) {
        delete card.project
      } else {
        card.project = event.data.after
      }

      card.revision++
      card.updatedSeq = event.seq
      card.updatedAt = event.at
    }

    return true
  }

  if (event.type === 'hydra.memory') {
    state.hydraMemory ??= {}

    if (event.data.after === null) {
      delete state.hydraMemory[event.data.key]
    } else {
      state.hydraMemory[event.data.key] = {
        text: event.data.after,
        at: event.at,
      }
    }

    return true
  }

  if (event.type === 'task.held' || event.type === 'task.released') {
    const card = state.cards[event.cardId]

    if (card) {
      if (event.type === 'task.held') {
        card.hold = {
          id: event.id,
          at: event.at,
          actor: event.actor,
          reason: event.data.reason,
        }
      } else if (card.hold?.id === event.data.hold) {
        delete card.hold
      }

      card.revision++
      card.updatedSeq = event.seq
      card.updatedAt = event.at
    }

    return true
  }

  if (event.type === 'task.intent') {
    const card = state.cards[event.cardId]

    if (card) {
      card.ask = [
        ...(card.ask ?? []),
        structuredClone(event.data),
      ]
      card.revision++
      card.updatedSeq = event.seq
      card.updatedAt = event.at
    }

    return true
  }

  if (event.type === 'task.brief' || event.type === 'task.visibility' || event.type === 'task.retention') {
    const card = state.cards[event.cardId]

    if (card) {
      if (event.type === 'task.brief') {
        card.brief = event.data.after
      } else if (event.type === 'task.retention') {
        if (event.data.after === null) {
          delete card.doneAfterHours
        } else {
          card.doneAfterHours = event.data.after
        }

        delete card.keepDone
      } else {
        card.hidden = event.data.after

        if (event.data.automatic) {
          card.expired = true
        } else {
          delete card.expired

          if (!event.data.after && card.doneAt) {
            card.keepDone = true
          }
        }
      }

      card.revision++
      card.updatedSeq = event.seq
      card.updatedAt = event.at
    }

    return true
  }

  if (event.type === 'hydra.review') {
    const reminders = { ...state.hydraReview?.reminders }

    for (const key of event.data.reminders) {
      reminders[key] = event.at
    }

    state.hydraReview = {
      at: event.at,
      seq: event.seq,
      block: event.data.block,
      reminders,
    }

    return true
  }

  if (event.type === 'board.configured') {
    state.config = structuredClone(event.data)
    state.configured = true
    state.configRevision = (state.configRevision ?? 0) + 1
    state.cards[HYDRA_CARD] ??= {
      id: HYDRA_CARD,
      key: HYDRA_CARD,
      title: 'Hydra',
      workspace: 'unassigned',
      tags: [],
      attention: [],
      links: [],
      sourceRefs: [],
      hidden: true,
      column: 'parked',
      revision: 0,
      createdSeq: event.seq,
      updatedSeq: event.seq,
      updatedAt: event.at,
    }
    const hydra = state.cards[HYDRA_CARD]!
    hydra.title = event.data.hydra.name
    hydra.hidden = true
    state.keys[HYDRA_CARD] = HYDRA_CARD
    refreshTasks({ state })

    return true
  }

  // Kinds are Hydra settings; saving one does not choose the Hydra.
  if (event.type === 'board.agents') {
    state.config = structuredClone(hydraConfig({
      state,
      id: event.boardId,
    }))
    state.config.agents = structuredClone(event.data.agents)
    state.configRevision = (state.configRevision ?? 0) + 1

    return true
  }

  if (event.type === 'board.columns') {
    state.config = structuredClone(hydraConfig({
      state,
      id: event.boardId,
    }))
    state.config.columns = structuredClone(event.data.columns)
    state.configRevision = (state.configRevision ?? 0) + 1

    for (const card of Object.values(state.cards)) {
      const placement = event.data.placements?.[card.id]

      if (placement?.after) {
        card.column = placement.after
      }

      if (!event.data.columns.some(c => c.id === card.column)) {
        card.column = event.data.fallback ?? event.data.columns[0]!.id
      }

      if (placement) {
        card.revision++
        card.updatedSeq = event.seq
        card.updatedAt = event.at
      }
    }

    refreshTasks({ state })

    return true
  }

  if (event.type === 'task.created') {
    const {
      key,
      title,
      project,
      brief,
      parentId,
      column,
      folder,
      kind,
    } = event.data
    const columns = hydraConfig({ state }).columns
    let placement = column

    if (event.data.hold) {
      placement = roleColumn({
        columns,
        role: 'queued',
      })
    }

    const role = columns.find(c => c.id === placement)?.role
    const initial = role && ROLE_STATUS[role] && {
      id: event.id,
      at: event.at,
      actor: event.actor,
      state: ROLE_STATUS[role],
      note: '',
    }
    state.cards[event.cardId] = {
      id: event.cardId,
      key,
      title,
      ...(project ? { project } : {}),
      ...(brief !== undefined ? {
        brief,
        initialPrompt: brief,
      } : {}),
      ...(event.data.hold ? {
        hold: {
          id: event.id,
          at: event.at,
          actor: event.actor,
          reason: event.data.hold,
        },
      } : {}),
      ask: event.data.ask ? [structuredClone(event.data.ask)] : [],
      titleSet: true,
      workspace: 'unassigned',
      tags: [],
      attention: [],
      links: [],
      sourceRefs: [],
      sessionIds: [],
      tracking: 'declared',
      statusLog: initial ? [initial] : [],
      ...(initial ? { status: initial } : {}),
      ...(parentId ? { parentId } : {}),
      ...(folder ? { folder } : {}),
      column: placement ?? roleColumn({
        columns,
        role: 'queued',
      }) ?? 'parked',
      revision: 1,
      createdSeq: event.seq,
      updatedSeq: event.seq,
      updatedAt: event.at,
    }

    if (kind === 'investigation') {
      state.cards[event.cardId]!.kind = kind
    }

    state.keys[key] = event.cardId
    refreshTasks({
      state,
      ids: [event.cardId],
    })

    return true
  }

  if (event.type === 'task.kind' || event.type === 'task.report' || event.type === 'task.report-reviewed' || event.type === 'task.landing') {
    const card = state.cards[event.cardId]

    if (!card) {
      return true
    }

    if (event.type === 'task.kind') {
      card.kind = event.data.after
    }

    if (event.type === 'task.report') {
      card.report = {
        id: event.id,
        at: event.at,
        actor: event.actor,
        chars: event.data.text.length,
      }
    }

    if (event.type === 'task.report-reviewed' && card.report?.id === event.data.report) {
      card.report.review = {
        id: event.id,
        at: event.at,
        actor: event.actor,
        calls: structuredClone(event.data.calls),
      }
    }

    if (event.type === 'task.landing' && event.data.after) {
      card.landing = event.data.after
    }

    if (event.type === 'task.landing' && !event.data.after) {
      delete card.landing
    }

    card.revision++
    card.updatedSeq = event.seq
    card.updatedAt = event.at

    return true
  }

  if (event.type === 'task.declared' || event.type === 'task.mirrored') {
    const card = state.cards[event.cardId]

    if (card) {
      card.tracking = 'declared'

      if (event.type === 'task.declared') {
        const declaration = {
          ...event.data,
          id: event.id,
          at: event.at,
          actor: event.actor,
        }
        card.statusLog = [
          ...(card.statusLog ?? []),
          declaration,
        ]
        card.status = declaration
      } else {
        card.mirror = structuredClone(event.data)
      }

      card.revision++
      card.updatedSeq = event.seq
      card.updatedAt = event.at
      refreshTasks({
        state,
        ids: [card.id],
      })
    }

    return true
  }

  if (event.type === 'task.launched' || event.type === 'task.copy') {
    const card = state.cards[event.cardId]

    if (card) {
      if (event.type === 'task.copy') {
        card.copy = structuredClone(event.data.after)
      } else {
        card.launch = structuredClone(event.data)
        const session = card.sessionIds?.[0] && state.sessions?.[card.sessionIds[0]]

        if (session) {
          session.launch = structuredClone(event.data)
        }
      }

      card.revision++
      card.updatedAt = event.at
      card.updatedSeq = event.seq
    }

    return true
  }

  if (event.type === 'hydra.message') {
    const message = {
      ...event.data,
      id: event.id,
      at: event.at,
      actor: event.actor,
    }
    state.hydraMessages = [
      ...(state.hydraMessages ?? []),
      message,
    ]
    const card = event.data.task ? state.cards[event.data.task] : undefined

    if (card) {
      if (ownerActor({ actor: event.actor })) {
        card.ask = [
          ...(card.ask ?? []),
          {
            text: event.data.text,
            at: event.at,
            actor: event.actor,
            message: event.id,
          },
        ]
      }

      card.revision++
      card.updatedSeq = event.seq
      card.updatedAt = event.at
    }

    return true
  }

  return false
}

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

  if (applyCompaction({
    state,
    event,
  }) || applyUpgrade({
    state,
    event,
  }) || applyExternalSource({
    state,
    event,
  }) || applySteering({
    state,
    event,
  }) || applyDependencies({
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
    } else if (event.type === 'project.refreshed') {
      card.projectRefresh = {
        ...card.projectRefresh,
        [event.data.url]: { ...event.data },
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
