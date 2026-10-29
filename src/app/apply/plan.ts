import { createHash } from 'node:crypto'
import type { HydraEvent, HydraState } from '#app/model.ts'
import type { Meta } from '#app/command-meta.ts'
import type { Output } from '#app/cli-support.ts'
import { eventWriter } from '#app/writer.ts'
import { HydraError } from '#store/errors.ts'
import { findCard, checkRevision } from '#tasks/push-rules.ts'
import { planTaskChange } from '#tasks/plans.ts'
import { planDeliveryChange } from '#tasks/delivery/plans.ts'
import { refuseEarlyDone } from '#tasks/delivery/done.ts'
import { ApplyError, type ApplyDocument, type ApplyIssue, type Operation } from './schema.ts'

interface ApplyReceipt extends Output {
  operations: Output[]
}

const OPERATION_FIELDS: Record<Operation['op'], string> = {
  'task.create': 'op',
  'task.brief': 'brief',
  'task.intent': 'text',
  'task.depend': 'on',
  'task.undepend': 'on',
  'task.status': 'status',
  'task.hold': 'reason',
  'task.release': 'message',
  link: 'url',
  outcome: 'state',
}

export function planDocument({
  document,
  state,
  dir,
  hydraId,
  meta,
  id,
}: {
  document: ApplyDocument
  state: HydraState
  dir: string
  hydraId: string
  meta: Meta
  id: string
}): {
  events: HydraEvent[]
  receipt: ApplyReceipt
} {
  const errors: ApplyIssue[] = []
  const events: HydraEvent[] = []
  const aliases: Record<string, string> = Object.create(null)
  const operations: Output[] = []
  let current = state
  const base: Record<string, number> = {}

  for (const [
    ref,
    revision,
  ] of Object.entries(document.expected?.tasks ?? {})) {
    try {
      const card = findCard({
        state,
        ref,
      })
      checkRevision({
        card,
        ifRevision: revision,
      })
      base[card.id] = card.revision
    } catch (error) {
      if (!(error instanceof HydraError)) {
        throw error
      }

      errors.push({
        operation: null,
        path: `/expected/tasks/${ref}`,
        code: error.code,
        reason: error.message,
      })
    }
  }

  document.changes.forEach((
    source,
    index,
  ) => {
    const operation = structuredClone(source)
    let field = 'op'
    const prepared: HydraEvent[] = []
    const writer = eventWriter({
      state: current,
      dir,
      hydraId,
      transaction: id,
      onAppend: ({ event }) => prepared.push(event),
    })

    const resolve = ({
      reference,
      path,
    }: {
      reference: string
      path: string
    }): string => {
      field = path
      let ref = reference

      if (reference.startsWith('$')) {
        const alias = aliases[reference.slice(1)]

        if (!alias) {
          throw new HydraError({
            message: `unknown or not-yet-created alias ${reference}`,
            code: 'NOT_FOUND',
          })
        }

        ref = alias
      }

      const card = findCard({
        state: current,
        ref,
      })

      if (state.cards[card.id]) {
        base[card.id] = state.cards[card.id]!.revision
      }

      return card.id
    }

    try {
      if (operation.op === 'task.create') {
        field = 'as'

        if (operation.as && (!/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(operation.as)
          || Object.hasOwn(
            aliases,
            operation.as,
          ))) {
          throw new HydraError({
            message: 'alias must be unique and match [a-zA-Z][a-zA-Z0-9_-]*',
            code: 'VALIDATION_ERROR',
          })
        }

        if (operation.parent) {
          operation.parent = resolve({
            reference: operation.parent,
            path: 'parent',
          })
        }
      } else {
        operation.task = resolve({
          reference: operation.task,
          path: 'task',
        })
      }

      if (operation.op === 'task.depend' || operation.op === 'task.undepend') {
        operation.on = operation.on.map((
          reference,
          item,
        ) => resolve({
          reference,
          path: `on/${item}`,
        }))
      }

      const operationMeta: Meta = {
        ...meta,
        id: `${id}:op:${index}`,
        reason: operation.reason,
      }
      field = 'op'

      const cardId = `task-${createHash('sha256').update(`${hydraId}:${id}:${index}`)
        .digest('hex')
        .slice(
          0,
          32,
        )}`
      const decision = operation.op === 'link' || operation.op === 'outcome'
        ? planDeliveryChange({
          state: current,
          operation,
          meta: operationMeta,
        })
        : planTaskChange({
          state: current,
          operation,
          meta: operationMeta,
          hydraId,
          cardId,
        })

      if ('event' in decision) {
        writer.append({ event: decision.event })
      }

      if (operation.op === 'task.create' && operation.as && 'event' in decision) {
        aliases[operation.as] = decision.event.cardId
      }

      current = writer.state
      events.push(...prepared)
      const result: Output = {
        operation: index,
        op: operation.op,
        state: 'unchanged',
      }

      if ('event' in decision) {
        result.task = decision.event.cardId
        result.event = decision.event.id
        result.state = 'planned'
      } else {
        result.state = decision.skipped
      }

      operations.push(result)
    } catch (error) {
      if (!(error instanceof HydraError)) {
        throw error
      }

      if (field === 'op') {
        field = error.field ?? OPERATION_FIELDS[operation.op]
      }

      errors.push({
        operation: index,
        path: `/changes/${index}/${field}`,
        code: error.code,
        reason: error.message,
      })
    }
  })

  document.changes.forEach((
    operation,
    index,
  ) => {
    if (operation.op !== 'task.status' || operation.status !== 'done') {
      return
    }

    try {
      const ref = operation.task.startsWith('$') ? aliases[operation.task.slice(1)] : operation.task

      if (ref) {
        refuseEarlyDone({
          state: current,
          card: findCard({
            state: current,
            ref,
          }),
          hydraId,
        })
      }
    } catch (error) {
      if (!(error instanceof HydraError)) {
        throw error
      }

      if (!errors.some(issue => issue.operation === index)) {
        errors.push({
          operation: index,
          path: `/changes/${index}/status`,
          code: error.code,
          reason: error.message,
        })
      }
    }
  })

  if (errors.length) {
    throw new ApplyError({ errors })
  }

  const targets = [...new Set(events.map(event => event.cardId))].filter(id => current.cards[id])
  const diff = targets.map(task => ({
    task,
    before: state.cards[task] ?? null,
    after: current.cards[task],
  }))
  const revisions = Object.fromEntries(targets.map(task => [
    task,
    current.cards[task]!.revision,
  ]))

  return {
    events,
    receipt: {
      applied: false,
      id,
      aliases,
      base,
      revisions,
      operations,
      diff,
    },
  }
}
