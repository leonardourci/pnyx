import { AxiError } from 'axi-sdk-js'
import { guard, parse, WRITE, required, meta, commit } from '#app/cli-support.ts'
import { loadHydra } from '#app/store.ts'
import { viewFor, DEFAULT_VIEW, DEFAULT_WIDTHS, resetLayoutWidths } from './view.ts'
import { decideView } from './decisions.ts'
import { HydraError } from '#store/errors.ts'

export const view = guard({
  handler: ({ args }) => {
    const [
      sub,
      ...rest
    ] = args
    const {
      values,
      hydraId,
    } = parse({
      args: rest,
      options: {
        ...WRITE,
        json: { type: 'string' },
      },
      positionals: 0,
    })

    if (sub === 'show') {
      const { state } = loadHydra({ hydraId })

      return {
        view: viewFor({ state }),
        revision: state.viewRevision ?? 0,
      }
    }

    if (sub === 'schema') {
      return {
        defaults: DEFAULT_VIEW,
        help: ['view set --json <patch> --if-revision <revision>'],
      }
    }

    if (sub !== 'set') {
      throw new AxiError(
        'use view show, schema or set',
        'VALIDATION_ERROR',
      )
    }

    let patch: unknown

    try {
      patch = JSON.parse(required({
        value: values.json as string,
        what: '--json',
      }))
    } catch {
      throw new AxiError(
        '--json must contain a preference object',
        'VALIDATION_ERROR',
      )
    }

    const m = meta({ values })

    return commit({
      hydraId,
      meta: m,
      intent: {
        type: 'board.view',
        card: '$board',
      },
      decide: ({ state: s }) => decideView({
        state: s,
        patch,
        meta: m,
      }),
    })
  },
})

export const layout = guard({
  handler: ({ args }) => {
    const {
      values,
      positionals,
      hydraId,
    } = parse({
      args,
      options: WRITE,
      positionals: 1,
    })

    if (positionals[0] === 'show') {
      const view = viewFor({ state: loadHydra({ hydraId }).state })

      return {
        widths: {
          hydra: view.hydraWidth,
          columns: view.columnWidths,
        },
        defaults: {
          column: DEFAULT_WIDTHS.column,
          hydra: view.defaultHydraWidth,
          columns: view.defaultColumnWidths,
        },
      }
    }

    if (positionals[0] !== 'reset') {
      throw new HydraError({
        message: 'use layout show or reset',
        code: 'VALIDATION_ERROR',
      })
    }

    const m = meta({ values })

    return commit({
      hydraId,
      meta: m,
      intent: {
        type: 'board.view',
        card: '$board',
      },
      decide: ({ state }) => decideView({
        state,
        patch: resetLayoutWidths({ view: viewFor({ state }) }),
        meta: m,
      }),
    })
  },
})
