import { AxiError } from 'axi-sdk-js'
import { guard, meta, parse, required, WRITE } from '#app/cli-support.ts'
import { readSettings, saveSettings } from './store.ts'
import { DEFAULT_SETTINGS } from './settings.ts'

const USE = 'use settings show, schema or set'

export const settings = guard({
  handler: ({ args }) => {
    const [
      sub,
      ...rest
    ] = args
    const { values } = parse({
      args: rest,
      options: {
        ...WRITE,
        json: { type: 'string' },
      },
      positionals: 0,
    })

    if (sub === 'show') {
      const read = readSettings()

      return {
        settings: read.settings,
        revision: read.revision,
        help: ['settings set --json <patch> --if-revision <revision>'],
      }
    }

    if (sub === 'schema') {
      return {
        defaults: DEFAULT_SETTINGS,
        help: [
          'Every key applies to every Hydra; a patch names only what changes',
          'doneAfterHours takes off or hours (0 hides right away); reviewMinutes 0 turns reviews off; helper takes auto, off or { harness, model, effort }',
        ],
      }
    }

    if (sub !== 'set') {
      throw new AxiError(
        USE,
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
        '--json must contain a settings object',
        'VALIDATION_ERROR',
      )
    }

    const saved = saveSettings({
      patch,
      meta: meta({ values }),
    })

    if (saved.skipped) {
      return {
        event: `none: ${saved.skipped}`,
        settings: saved.settings,
        revision: saved.revision,
      }
    }

    return {
      changed: saved.entry!.after,
      settings: saved.settings,
      revision: saved.revision,
    }
  },
})
