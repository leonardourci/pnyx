import { AxiError } from 'axi-sdk-js'
import { guard, parse, WRITE, required, meta, commit } from '#app/cli-support.ts'
import { loadHydra } from '#app/store.ts'
import { hydraIds } from '#app/home-migration.ts'
import { checkSettings, effectiveView, readSettings, saveSettings, settingsReceipt } from '#settings/store.ts'
import { isSharedViewKey } from '#settings/model.ts'
import { DEFAULT_VIEW, DEFAULT_WIDTHS, resetLayoutWidths } from './view.ts'
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
        view: effectiveView({ state }),
        revision: state.viewRevision ?? 0,
        settingsRevision: readSettings().revision,
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

    if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) {
      throw new AxiError(
        '--json must contain a preference object',
        'VALIDATION_ERROR',
      )
    }

    const m = meta({ values })
    const entries = Object.entries(patch)
    const shared = Object.fromEntries(entries.filter(([key]) => isSharedViewKey({ key })))
    const board = Object.fromEntries(entries.filter(([key]) => !isSharedViewKey({ key })))
    const viewCommit = () => commit({
      hydraId,
      meta: m,
      intent: {
        type: 'board.view',
        card: '$board',
      },
      decide: ({ state: s }) => decideView({
        state: s,
        patch: board,
        meta: m,
      }),
    })

    if (!Object.keys(shared).length) {
      return viewCommit()
    }

    checkSettings({ patch: shared })
    const committed = Object.keys(board).length ? viewCommit() : undefined
    // --if-revision guards the board's own view; shared keys follow the settings store.
    const settings = settingsReceipt({
      saved: saveSettings({
        patch: shared,
        meta: {
          ...m,
          ifRevision: undefined,
        },
      }),
    })

    if (!committed) {
      return settings
    }

    return {
      ...committed,
      settings,
    }
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
      options: {
        ...WRITE,
        all: { type: 'boolean' },
      },
      positionals: 1,
    })

    if (positionals[0] === 'show') {
      const view = effectiveView({ state: loadHydra({ hydraId }).state })

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
    const { settings } = readSettings()

    const reset = ({ id }: { id: string }) => commit({
      hydraId: id,
      meta: m,
      intent: {
        type: 'board.view',
        card: '$board',
      },
      decide: ({ state }) => decideView({
        state,
        patch: resetLayoutWidths({
          view: effectiveView({
            state,
            settings,
          }),
        }),
        meta: m,
      }),
    })

    if (!values.all) {
      return reset({ id: hydraId })
    }

    if (m.ifRevision !== undefined) {
      throw new HydraError({
        message: '--if-revision names one Hydra\'s view; drop it with --all',
        code: 'VALIDATION_ERROR',
      })
    }

    // One event id per Hydra keeps a retried --all from resetting twice.
    return {
      hydras: hydraIds().map(id => ({
        hydra: id,
        ...reset({ id }),
      })),
    }
  },
})
