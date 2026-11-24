import { TitanError } from '#store/errors.ts'
import { readInput } from '#app/request-context.ts'
import { createHash, randomUUID } from 'node:crypto'
import { guard, parse, meta, required, COMMON, type Output } from '#app/cli-support.ts'
import { loadTitan, requireTitan } from '#app/store.ts'
import { withWriter } from '#app/writer.ts'
import { base } from '#app/command-meta.ts'
import { transactionReceipt } from '#app/transactions.ts'
import { parseDocument, ApplyError } from './schema.ts'
import { parseApplyJson } from './json.ts'
import { compactReceipt } from './receipt.ts'
import { planDocument } from './plan.ts'

function canonicalDocument({ value }: { value: unknown }): unknown {
  if (Array.isArray(value)) {
    return value.map(entry => canonicalDocument({ value: entry }))
  }

  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value).sort((
      [left],
      [right],
    ) => left.localeCompare(right))
      .filter(([
        , entry,
      ]) => entry !== undefined)
      .map(([
        key,
        entry,
      ]) => [
        key,
        canonicalDocument({ value: entry }),
      ]))
  }

  return value
}

export const apply = guard({
  handler: async ({ args }): Promise<Output> => {
    const {
      values,
      hydraId,
    } = parse({
      args,
      options: {
        ...COMMON,
        file: { type: 'string' },
        check: { type: 'boolean' },
        full: { type: 'boolean' },
        'event-id': { type: 'string' },
      },
      positionals: 0,
    })

    if (values.full && !values.check) {
      throw new TitanError({
        message: '--full requires --check',
        code: 'VALIDATION_ERROR',
        help: ['Use --check --full for complete before/after records without writing'],
      })
    }

    const file = required({
      value: values.file as string | undefined,
      what: '--file <path|->',
    })
    let input: unknown

    try {
      const contents = readInput({ file: file })
      input = parseApplyJson({ contents })
    } catch (error) {
      if (error instanceof ApplyError) {
        throw error
      }

      throw new ApplyError({
        errors: [
          {
            operation: null,
            path: '/file',
            code: 'VALIDATION_ERROR',
            reason: error instanceof Error ? error.message : String(error),
          },
        ],
      })
    }

    const document = parseDocument({ value: input })
    const m = meta({ values })
    const id = m.id ?? `apply-${randomUUID()}`
    const digest = createHash('sha256').update(JSON.stringify(canonicalDocument({
      value: {
        document,
        actor: m.actor,
      },
    })))
      .digest('hex')
    requireTitan({ hydraId })

    if (values.check) {
      const duplicate = transactionReceipt({
        hydraId,
        id,
        digest,
      })

      if (duplicate) {
        if (values.full) {
          throw new TitanError({
            message: 'This apply already has a recorded receipt; full preview requires a fresh event id',
            code: 'VALIDATION_ERROR',
            help: ['Run task history <task> --full for original event data, or omit --event-id to preview current state'],
          })
        }

        return {
          ...compactReceipt({ output: duplicate }),
          applied: false,
          check: true,
        }
      }

      const loaded = loadTitan({
        hydraId,
        migrate: false,
      })
      const planned = planDocument({
        document,
        ...loaded,
        full: Boolean(values.full),
        hydraId,
        meta: m,
        id,
      })

      return {
        ...planned.receipt,
        check: true,
      }
    }

    const output = await withWriter({
      hydraId,
      transaction: {
        id,
        digest,
      },
      migrate: false,
      fn: ({ writer }) => {
        const checked = planDocument({
          document,
          state: writer.state,
          dir: writer.dir,
          hydraId,
          meta: m,
          id,
        })

        for (const event of checked.events) {
          writer.append({
            event,
            effects: false,
          })
        }

        writer.append({
          event: {
            ...base({
              state: writer.state,
              meta: {
                ...m,
                id,
              },
              cardId: '$board',
            }),
            type: 'apply.recorded',
            data: { digest },
          },
          effects: false,
        })

        return {
          ...checked.receipt,
          applied: true,
          operations: checked.receipt.operations.map(operation => ({
            ...operation,
            state: operation.state === 'planned' ? 'applied' : operation.state,
          })),
        }
      },
    })

    return compactReceipt({ output })
  },
})
