import { readFileSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { AxiError, exitCodeForError } from 'axi-sdk-js'
import { guard, parse, meta, required, COMMON, type Output } from '#app/cli-support.ts'
import { loadHydra, requireHydra } from '#app/store.ts'
import { withWriter } from '#app/writer.ts'
import { base } from '#app/command-meta.ts'
import { transactionReceipt } from '#app/transactions.ts'
import { parseDocument, ApplyError } from './schema.ts'
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
  handler: ({ args }): Output => {
    const {
      values,
      hydraId,
    } = parse({
      args,
      options: {
        ...COMMON,
        file: { type: 'string' },
        check: { type: 'boolean' },
        'event-id': { type: 'string' },
      },
      positionals: 0,
    })
    const file = required({
      value: values.file as string | undefined,
      what: '--file <path|->',
    })
    let input: unknown

    try {
      const contents = readFileSync(
        file === '-' ? 0 : file,
        'utf8',
      )
      input = JSON.parse(contents)
    } catch (error) {
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
    requireHydra({
      hydraId,
      migrate: false,
    })
    const duplicate = transactionReceipt({
      hydraId,
      id,
      digest,
      migrate: false,
    })

    if (duplicate) {
      if (values.check) {
        return {
          ...duplicate,
          applied: false,
          check: true,
        }
      }

      const loaded = loadHydra({
        hydraId,
        migrate: false,
      })
      const planned = planDocument({
        document,
        ...loaded,
        hydraId,
        meta: m,
        id,
      })

      return {
        ...planned.receipt,
        check: true,
      }
    }

    return withWriter({
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
  },
})

// The SDK's error formatter has no extension fields; apply adds its validation table here.
// eslint-disable-next-line pnyx/object-params -- The AXI SDK owns the error formatter signature.
export function formatApplyError(error: unknown): {
  output: string
  exitCode: number
} {
  if (error instanceof ApplyError) {
    const rows = error.errors.map(issue => `  ${issue.operation === null ? 'null' : issue.operation},${JSON.stringify(issue.path)},${JSON.stringify(issue.code)},${JSON.stringify(issue.reason)}`)

    return {
      output: `error: ${JSON.stringify(error.message)}\ncode: ${error.code}\napplied: false\nerrors[${rows.length}]{operation,path,code,reason}:\n${rows.join('\n')}\n`,
      exitCode: 2,
    }
  }

  const message = error instanceof Error ? error.message : String(error)
  const code = error instanceof AxiError ? error.code : 'UNKNOWN'
  const suggestions = error instanceof AxiError ? error.suggestions : []
  const help = suggestions.length ? `help[${suggestions.length}]: ${suggestions.map(line => JSON.stringify(line)).join(',')}\n` : ''

  return {
    output: `error: ${JSON.stringify(message)}\ncode: ${code}\n${help}`,
    exitCode: exitCodeForError(error),
  }
}
