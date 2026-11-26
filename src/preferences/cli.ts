import { guard, parse, WRITE, required, meta, commit, integer, type Output } from '#app/cli-support.ts'
import { loadTitan } from '#app/store.ts'
import { titanIds } from '#app/home-migration.ts'
import { effectiveView, readSettings, saveSettings, settingsReceipt } from '#settings/store.ts'
import { isSharedViewKey } from '#settings/model.ts'
import { DEFAULT_VIEW, resetLayoutWidths, resizeViewPatch } from './view.ts'
import { decideView } from './decisions.ts'
import { TitanError } from '#store/errors.ts'

export const view = guard({
  handler: async ({ args }) => {
    const [
      sub,
      ...rest
    ] = args
    const {
      values,
      titanId,
    } = parse({
      args: rest,
      options: {
        ...WRITE,
        json: { type: 'string' },
      },
      positionals: 0,
    })

    if (sub === 'show') {
      const { state } = loadTitan({ titanId })

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
      throw new TitanError({
        message: 'use view show, schema or set',
        code: 'VALIDATION_ERROR',
      })
    }

    let patch: unknown

    try {
      patch = JSON.parse(required({
        value: values.json as string,
        what: '--json',
      }))
    } catch {
      throw new TitanError({
        message: '--json must contain a preference object',
        code: 'VALIDATION_ERROR',
      })
    }

    if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) {
      throw new TitanError({
        message: '--json must contain a preference object',
        code: 'VALIDATION_ERROR',
      })
    }

    const m = meta({ values })
    const entries = Object.entries(resizeViewPatch({
      patch: patch as Record<string, unknown>,
    }))
    const shared = Object.fromEntries(entries.filter(([key]) => isSharedViewKey({ key })))
    const own = Object.fromEntries(entries.filter(([key]) => !isSharedViewKey({ key })))
    const viewCommit = () => commit({
      titanId,
      meta: m,
      intent: {
        type: 'titan.view',
        card: '$all',
      },
      decide: ({ state: s }) => decideView({
        state: s,
        patch: own,
        meta: m,
      }),
    })

    if (!Object.keys(shared).length) {
      return await viewCommit()
    }

    let committed: Awaited<ReturnType<typeof viewCommit>> | undefined
    // --if-revision guards the Titan's own view; shared keys follow the settings store.
    const settings = settingsReceipt({
      saved: await saveSettings({
        titanId,
        patch: shared,
        meta: {
          ...m,
          ifRevision: undefined,
        },
        beforeSave: async () => {
          if (Object.keys(own).length) {
            committed = await viewCommit()
          }
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
  handler: async ({ args }) => {
    const {
      values,
      positionals,
      titanId,
    } = parse({
      args,
      options: {
        ...WRITE,
        all: { type: 'boolean' },
      },
      positionals: 1,
    })

    if (positionals[0] === 'show') {
      const view = effectiveView({ state: loadTitan({ titanId }).state })

      return {
        widths: {
          titan: view.titanWidth,
          projects: view.workspace.projectWidths,
        },
        defaults: {
          titan: view.defaultTitanWidth,
        },
      }
    }

    if (positionals[0] !== 'reset') {
      throw new TitanError({
        message: 'use layout show or reset',
        code: 'VALIDATION_ERROR',
      })
    }

    const m = meta({ values })
    const { settings } = readSettings()

    const reset = ({ id }: { id: string }) => commit({
      titanId: id,
      meta: m,
      intent: {
        type: 'titan.view',
        card: '$all',
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
      return await reset({ id: titanId })
    }

    if (m.ifRevision !== undefined) {
      throw new TitanError({
        message: '--if-revision names one Titan\'s view; drop it with --all',
        code: 'VALIDATION_ERROR',
      })
    }

    const titans: Output[] = []

    for (const id of titanIds()) {
      const receipt = await reset({ id })
      titans.push({
        titan: id,
        ...receipt,
      })
    }

    return { titans }
  },
})

export async function titanResize({
  values,
  titanId,
}: {
  values: Record<string, string | boolean | undefined>
  titanId: string
}): Promise<Output> {
  const width = integer({
    value: values.width,
    flag: '--width',
  })

  if (width === undefined) {
    throw new TitanError({
      message: 'pass --width <pixels>',
      code: 'VALIDATION_ERROR',
    })
  }

  const m = meta({ values })

  return await commit({
    titanId,
    meta: m,
    intent: {
      type: 'titan.view',
      card: '$all',
    },
    decide: ({ state }) => decideView({
      state,
      patch: { titanWidth: width },
      meta: m,
    }),
  })
}
