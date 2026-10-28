import { isDeepStrictEqual } from 'node:util'
import type { HydraEvent, HydraState, Decision } from './model.ts'
import { HydraError } from '../store/errors.ts'
import { type Card, type PushFields } from '../core/model.ts'
import { removedColumnPlacements, checkColumn } from '../tasks/columns-decisions.ts'
import { pushedValue, checkRevision, findCard, decideSession } from '../core/decide.ts'
import { rankOf, findSession } from '../core/tasks.ts'
import { base, type Meta } from './command-meta.ts'
import { notUndoable } from './command-validation.ts'
import { hydraConfig, hydraEvent } from '../core/hydra.ts'
import { viewFor, patchView, DEFAULT_VIEW } from '../preferences/view.ts'
import { decided } from './decision.ts'

function currentValue({
  card,
  target,
}: {
  card: Card
  target: Exclude<HydraEvent, { type: 'board.view' }>
}): unknown {
  if (target.type === 'card.pushed') {
    return Object.fromEntries(
      Object.keys(target.data.before ?? {}).map(field => [
        field,
        pushedValue({
          card,
          field,
        }),
      ]),
    )
  }

  if (target.type === 'card.moved') {
    return {
      column: card.column,
      rank: rankOf({ card }),
    }
  }

  if (target.type === 'card.linked') {
    return card.links.find(l => l.url === target.data.url) ?? null
  }

  return card.outcome ?? null
}

function afterValue({ target }: { target: HydraEvent }): unknown {
  if (target.type === 'card.replied' || target.type === 'card.noted') {
    return null
  }

  if (target.type === 'card.moved') {
    return {
      column: target.data.after,
      rank: target.data.rank,
    }
  }

  if (target.type !== 'card.pushed' && 'after' in target.data) {
    return target.data.after
  }

  if (target.type !== 'card.pushed') {
    return null
  }

  const after = target.data as unknown as Record<string, unknown>

  return Object.fromEntries(
    Object.keys(target.data.before ?? {}).map(field => [
      field,
      after[field] ?? null,
    ]),
  )
}

// Appends the reverse of `target`. Refuses when the field has changed since, so an
// undo never silently overwrites a later edit. Source observations, card creation
// and merges are facts, not edits, and cannot be undone. Only a source makes a push
// an observation: --actor is attribution, so a direct CLI or UI write stays undoable
// whether a person or an agent made it. A sent reply cannot be unsent, and a
// harvested note is a source observation.
export function decideUndo({
  state,
  target,
  meta,
}: {
  state: HydraState
  target: HydraEvent
  meta: Meta
}): Decision {
  if (target.type === 'board.columns') {
    if (target.actor === 'pnyx') {
      throw notUndoable({ message: 'the move onto the default columns cannot be undone' })
    }

    const unchanged = isDeepStrictEqual(
      hydraConfig({ state }).columns,
      target.data.columns,
    )

    if (!target.data.before || state.undone[target.id] || !unchanged) {
      throw new HydraError({
        message: 'columns changed since this event',
        code: 'CONFLICT',
      })
    }

    const pins = Object.entries(target.data.placements ?? {})
    const placements = Object.fromEntries(pins.map(([
      id,
      pin,
    ]) => {
      const card = state.cards[id]

      if (!card || card.column !== pin.after) {
        throw new HydraError({
          message: `task ${id} moved after the column edit`,
          code: 'CONFLICT',
        })
      }

      return [
        id,
        {
          before: pin.after,
          after: pin.before,
        },
      ]
    }))
    const decision = hydraEvent({
      state,
      meta,
      cardId: '$board',
      change: {
        type: 'board.columns',
        data: {
          columns: target.data.before,
          before: target.data.columns,
          placements,
        },
      },
    })

    return 'event' in decision ? {
      event: {
        ...decision.event,
        undoes: target.id,
      },
    } : decision
  }

  if ([
    'board.configured',
    'task.created',
    'task.held',
    'task.released',
    'task.intent',
    'task.declared',
    'task.kind',
    'task.report',
    'task.report-reviewed',
    'task.landing',
    'task.mirrored',
    'task.permission',
    'hydra.message',
    'hydra.status',
    'hydra.review',
    'chat.message',
    'board.agents',
  ].includes(target.type)) {
    throw notUndoable({ message: `${target.id} records durable work history; append a correction instead` })
  }

  if (target.type === 'task.session') {
    if (target.data.handoff) {
      throw notUndoable({ message: 'a queue handoff changed the branch and copy; it cannot be undone' })
    }

    const session = findSession({
      state,
      ref: target.data.session,
    })

    if (state.undone[target.id] || session.taskId !== target.data.after) {
      throw new HydraError({
        message: 'session attachment changed since this event',
        code: 'CONFLICT',
      })
    }

    checkRevision({
      card: findCard({
        state,
        ref: target.cardId,
      }),
      ifRevision: meta.ifRevision,
    })
    const decision = decideSession({
      state,
      ref: session.id,
      task: target.data.before,
      meta: {
        ...meta,
        ifRevision: undefined,
      },
    })

    return 'event' in decision ? {
      event: {
        ...decision.event,
        undoes: target.id,
      },
    } : decision
  }

  if (target.type === 'board.view') {
    if (
      state.undone[target.id]
      || !isDeepStrictEqual(
        viewFor({
          state,
        }),
        viewFor({
          state: {
            ...state,
            view: target.data.after,
          },
        }),
      )
    ) {
      throw new HydraError({
        message: 'preferences changed since this event',
        code: 'CONFLICT',
      })
    }

    if (meta.ifRevision !== undefined && meta.ifRevision !== (state.viewRevision ?? 0)) {
      throw new HydraError({
        message: 'view preferences changed',
        code: 'REVISION_CONFLICT',
      })
    }

    const after = patchView({
      state: {
        ...state,
        view: DEFAULT_VIEW,
      },
      input: target.data.before,
    })
    const placements = removedColumnPlacements({
      state,
      after,
    })

    // Undoing a column deletion puts its cards back, unless one was placed since.
    for (const p of target.data.placements ?? []) {
      const card = state.cards[p.cardId]

      if (!card || card.column !== p.after) {
        throw new HydraError({
          message: `card ${p.cardId} was moved since this event`,
          code: 'CONFLICT',
        })
      }

      if (placements.some(q => q.cardId === card.id)) {
        continue
      }

      placements.push({
        cardId: card.id,
        before: p.after,
        after: p.before,
        revision: card.revision,
      })
    }

    return {
      event: {
        ...base({
          state,
          meta,
          cardId: '$board',
        }),
        type: 'board.view',
        undoes: target.id,
        data: {
          before: viewFor({ state }),
          after,
          ...(placements.length ? { placements } : {}),
        },
      },
    }
  }

  if (target.type === 'card.replied') {
    throw notUndoable({ message: `${target.id} records a reply, which cannot be unsent` })
  }

  if (target.type === 'card.noted') {
    throw notUndoable({ message: `${target.id} records a note harvested from ${target.data.source} and cannot be undone` })
  }

  if (target.type === 'card.pushed' && target.data.source) {
    throw notUndoable({ message: `${target.id} records a source observation and cannot be undone` })
  }

  if (target.type === 'card.pushed' && !target.data.before) {
    throw notUndoable({ message: `${target.id} created card ${target.cardId} and cannot be undone` })
  }

  const after = target.type === 'card.outcome' && !target.undoes && target.data.after?.source
  const before = target.type === 'card.outcome' && target.data.before?.source
  const observedBy = after || (before && (before !== 'hooks' || target.actor.startsWith('hook:')) && before)

  if (observedBy) {
    throw notUndoable({ message: `${target.id} records an outcome observed by ${observedBy} and cannot be undone` })
  }

  if (target.type === 'card.linked' && target.data.after?.state === 'merged') {
    throw notUndoable({ message: `${target.id} records a merge, which cannot be undone` })
  }

  // Each undo can itself be undone, so follow the chain to the latest one.
  const chain: string[] = []

  for (let by = state.undone[target.id]; by; by = state.undone[by]) {
    chain.push(by)
  }

  const latest = chain.at(-1)

  if (latest) {
    const redone = chain.length % 2 === 0
    throw new HydraError({
      message: `${target.id} was already ${redone ? 'redone' : 'undone'} by ${latest}`,
      code: 'CONFLICT',
      help: [`Run \`pnyx-axi undo ${latest}\` to ${redone ? 'undo it again' : 'redo it'}`],
    })
  }

  const card = findCard({
    state,
    ref: target.cardId,
  })
  checkRevision({
    card,
    ifRevision: meta.ifRevision,
  })

  if (!isDeepStrictEqual(
    currentValue({
      card,
      target,
    }),
    afterValue({ target }),
  )) {
    throw new HydraError({
      message: `${target.id} no longer matches card ${card.id}: it changed since`,
      code: 'CONFLICT',
      help: [`Run \`pnyx-axi history --card ${card.id}\` to see the later change`],
    })
  }

  const head = {
    ...base({
      state,
      meta,
      cardId: card.id,
    }),
    undoes: target.id,
  }

  if (target.type === 'card.pushed') {
    const before = target.data.before!
    const data = {
      key: card.key,
      ...before,
      before: afterValue({ target }) as PushFields,
    }

    return decided({
      state,
      meta,
      event: {
        ...head,
        type: 'card.pushed',
        data,
      },
    })
  }

  if (target.type === 'card.moved') {
    checkColumn({
      state,
      column: target.data.before,
    })

    const {
      before,
      after,
      rank,
      beforeRank,
    } = target.data

    return decided({
      state,
      meta,
      event: {
        ...head,
        type: 'card.moved',
        data: {
          before: after,
          after: before,
          rank: beforeRank,
          beforeRank: rank,
        },
      },
    })
  }

  if (target.type === 'card.linked') {
    const data = {
      url: target.data.url,
      before: target.data.after,
      after: target.data.before,
    }

    return decided({
      state,
      meta,
      event: {
        ...head,
        type: 'card.linked',
        data,
      },
    })
  }

  if (target.type !== 'card.outcome') {
    throw notUndoable({ message: `${target.id} cannot be undone` })
  }

  return decided({
    state,
    meta,
    event: {
      ...head,
      type: 'card.outcome',
      data: {
        before: target.data.after,
        after: target.data.before,
        card: {
          title: card.title,
          workspace: card.workspace,
          tags: card.tags,
          links: card.links,
        },
      },
    },
  })
}
