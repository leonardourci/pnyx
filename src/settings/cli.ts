import { AxiError } from 'axi-sdk-js'
import { guard, meta, parse, required, WRITE } from '#app/cli-support.ts'
import { readSettings, saveSettings, settingsReceipt } from './store.ts'
import { DEFAULT_SETTINGS } from './settings.ts'
import { HELPER_MODELS, type Settings } from './model.ts'
import type { AgentConfig } from '#workers/model.ts'
import { knownHarness } from '#workers/providers.ts'
import { hydraConfig } from '#hydra/config.ts'
import { loadHydra } from '#app/store.ts'
import { HydraError } from '#store/errors.ts'

const USE = 'use settings show, schema or set'

export const settings = guard({
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
          'defaultColumnWidth is the fallback for every existing and future column; defaultColumnWidths holds per-column overrides',
          'Every key applies to every Hydra; a patch names only what changes',
          'doneAfterHours takes off or hours (0 hides right away); reviewMinutes 0 turns reviews off; helper takes auto, off or { harness, account?, model, effort?, fast? }',
          'oracleRememberFilters takes true or false; hydraOrder takes the whole list of Hydra ids, each once',
          'logs takes off (warnings and errors only), on or detailed; logDays keeps 1 or more days of logs; logMaxMB caps their total size',
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

    return settingsReceipt({
      saved: saveSettings({
        hydraId,
        patch,
        meta: meta({ values }),
      }),
    })
  },
})

const HELPER_FLAGS = [
  'helper',
  'helper-model',
  'helper-account',
  'helper-effort',
  'helper-fast',
]

// The hydra set flags that write shared settings; any other flag changes this Hydra, so the Hydra event is committed too.
export const SETTING_FLAGS = [
  'done-after-hours',
  'review-minutes',
  ...HELPER_FLAGS,
]

export function sharedSettingFlags({
  values,
  hydraId,
}: {
  values: Record<string, string | boolean | undefined>
  hydraId: string
}): Partial<Settings> | undefined {
  const patch: Partial<Settings> = {}
  const done = values['done-after-hours']

  if (done !== undefined) {
    const raw = String(done).trim()
    patch.doneAfterHours = raw === 'off' ? 'off' : Number(raw || Number.NaN)
  }

  if (values['review-minutes'] !== undefined) {
    const raw = String(values['review-minutes']).trim()

    if (!raw) {
      throw new HydraError({
        message: '--review-minutes takes a number of minutes (0 turns reviews off)',
        code: 'VALIDATION_ERROR',
      })
    }

    patch.reviewMinutes = Number(raw)
  }

  if (HELPER_FLAGS.some(flag => values[flag] !== undefined)) {
    const current = readSettings().settings.helper
    const agent = typeof current === 'object' ? current : undefined
    const harness = values.helper ?? agent?.harness ?? hydraConfig({ state: loadHydra({ hydraId }).state }).hydra.agent?.harness ?? 'claude'
    const helperHarness = knownHarness({ name: harness })

    if (harness === 'off' || harness === 'auto') {
      patch.helper = harness
    } else if (helperHarness) {
      const previous = agent?.harness === helperHarness ? agent : undefined
      const effort = values['helper-effort'] ?? previous?.effort
      const helper: AgentConfig = {
        harness: helperHarness,
        model: String(values['helper-model'] ?? previous?.model ?? HELPER_MODELS[helperHarness]),
      }

      const account = values['helper-account'] ?? previous?.account

      if (account) {
        helper.account = String(account)
      }

      if (effort !== undefined) {
        helper.effort = String(effort)
      }

      const fast = values['helper-fast']

      if (fast !== undefined && fast !== 'on' && fast !== 'off') {
        throw new HydraError({
          message: '--helper-fast takes on or off',
          code: 'VALIDATION_ERROR',
        })
      }

      const fastOn = fast === undefined ? previous?.fast : fast === 'on'

      if (fastOn) {
        helper.fast = true
      }

      patch.helper = helper
    } else {
      throw new HydraError({
        message: '--helper takes auto, off, claude or codex',
        code: 'VALIDATION_ERROR',
      })
    }
  }

  return Object.keys(patch).length ? patch : undefined
}
