import type { HydraEvent, HydraState } from '#app/model.ts'
import { observeSession, sessionId } from '#workers/session-attachments.ts'
import { applyReplyReceipt } from '#workers/reduce.ts'
import { refreshTasks } from './columns.ts'
import { SESSION_TITLE } from './model.ts'
import { newCardColumn, isStaleSource, sameSource, offerTitle, wouldCycle } from './events.ts'
import { isStaleLink } from '#tasks/delivery/events.ts'

export function applyCardEvent({
  state,
  event,
}: {
  state: HydraState
  event: HydraEvent
}): boolean {
  let card = state.cards[event.cardId]

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
        card.turnStartedAt = event.at
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

    if (event.type === 'card.observed') {
      const { source } = event.data

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
    } else if (event.type === 'card.moved') {
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
      applyReplyReceipt({
        state,
        card,
        event,
      })
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

      // A note a moved card already holds, under the id its old Hydra gave it, is not listed twice.
      if (card.notes?.some(note => note.id === event.id)) {
        return false
      }

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
