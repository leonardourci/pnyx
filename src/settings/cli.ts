import { HydraError } from '#store/errors.ts'
import { widensSpaceReaders } from '#memory/access-changes.ts'
import { memoryHydras, memoryPermission, memoryCaller, memoryAgent } from '#memory/spaces.ts'
import { patchSettings } from './settings.ts'
import { hydraActor } from '#app/request-context.ts'
import { canRead } from '#memory/space-policy.ts'
import { AxiError } from 'axi-sdk-js'
import { guard, meta, parse, required, WRITE } from '#app/cli-support.ts'
import { readSettings, saveSettings, settingsReceipt, shownSettings } from './store.ts'
import { DEFAULT_SETTINGS, MAX_LOG_DAYS, MAX_LOG_MB } from './settings.ts'
import { HELPER_MODELS, type Settings } from './model.ts'
import type { AgentConfig } from '#workers/model.ts'
import { knownHarness } from '#workers/providers.ts'
import { hydraConfig } from '#hydra/config.ts'
import { loadHydra } from '#app/store.ts'

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
        propose: { type: 'boolean' },
      },
      positionals: 0,
    })

    if (sub === 'show') {
      const read = readSettings()

      return {
        settings: visibleSettings({
          settings: shownSettings({ settings: read.settings }),
          hydraId,
        }),
        revision: read.revision,
        help: ['settings set --json <patch> --if-revision <revision>'],
      }
    }

    if (sub === 'schema') {
      return {
        defaults: visibleSettings({
          settings: DEFAULT_SETTINGS,
          hydraId,
        }),
        help: [
          'defaultColumnWidth is the fallback for every existing and future column; defaultColumnWidths holds per-column overrides',
          'Every key applies to every Hydra; a patch names only what changes',
          'memorySpaces patches named spaces (null removes, shared is reserved); readers are Hydra ids or *; projectSpaces patches project assignments (null restores shared); --propose saves a Confirm question',
          'doneAfterHours takes off or hours (0 hides right away); reviewMinutes 0 turns reviews off; helper takes auto, off or { harness, account?, model, effort?, fast? }',
          'oracleRememberFilters takes true or false; hydraOrder takes the whole list of Hydra ids, each once; hiddenHydras takes the Hydra ids hidden from the page list and switcher',
          `logs takes off (warnings and errors only), on or detailed; logDays keeps 1 to ${MAX_LOG_DAYS} days of logs; logMaxMB caps their total size at 1 to ${MAX_LOG_MB} MB`,
          'postgresUrl takes a postgres:// URL naming the database that holds Pnyx\'s data, or empty for this home\'s own database through PGHOST, PGPORT and PGUSER; a server restart applies a change, and its password prints as ***',
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

    const change = meta({ values })

    const read = readSettings()
    const after = patchSettings({
      current: read.settings,
      input: patch,
    })
    const proposalArgs = values['if-revision'] !== undefined ? args : [
      ...args,
      '--if-revision',
      String(read.revision),
    ]
    const memoryPatch = patch && typeof patch === 'object' && ('memorySpaces' in patch || 'projectSpaces' in patch)

    if (memoryPatch && typeof patch === 'object' && patch !== null
      && hydraActor({ actor: change.actor })) {
      const state = loadHydra({ hydraId }).state
      const spaces = read.settings.memorySpaces

      if ('projectSpaces' in patch) {
        throw new HydraError({
          message: 'Use project move to change the memory space of an attached project',
          code: 'VALIDATION_ERROR',
        })
      }

      if ('memorySpaces' in patch && patch.memorySpaces && typeof patch.memorySpaces === 'object') {
        for (const space of Object.keys(patch.memorySpaces)) {
          if (!values.propose && !canRead({
            hydraId,
            state,
            spaces,
            space,
          })) {
            throw new HydraError({
              message: 'Memory is unavailable',
              code: 'NOT_FOUND',
            })
          }
        }
      }
    }

    if (memoryPatch || values.propose) {
      const proposal = memoryPermission({
        hydraId,
        name: 'settings',
        args: proposalArgs,
        propose: Boolean(values.propose),
        actor: change.actor,
        widening: widensSpaceReaders({
          before: read.settings,
          after,
          hydras: memoryHydras(),
        }),
      })

      if (proposal) {
        return proposal
      }
    }

    const receipt = settingsReceipt({
      saved: saveSettings({
        hydraId,
        patch,
        meta: change,
      }),
    })

    if (memoryAgent()) {
      receipt.settings = visibleSettings({
        settings: shownSettings({ settings: readSettings().settings }),
        hydraId,
      })

      if (receipt.changed && typeof receipt.changed === 'object') {
        const changed = receipt.changed as Record<string, unknown>
        const visible = receipt.settings as Settings

        if ('memorySpaces' in changed) {
          changed.memorySpaces = visible.memorySpaces
        }

        if ('projectSpaces' in changed) {
          changed.projectSpaces = visible.projectSpaces
        }
      }
    }

    return receipt
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

function visibleSettings({
  settings,
  hydraId,
}: {
  settings: Settings
  hydraId: string
}): Settings {
  if (!memoryAgent()) {
    return settings
  }

  const state = loadHydra({ hydraId }).state
  const spaces = readSettings().settings.memorySpaces
  const readable = ({ space }: { space: string }) => memoryCaller({ hydraId }) && canRead({
    hydraId,
    state,
    spaces,
    space,
  })

  return {
    ...settings,
    memorySpaces: Object.fromEntries(Object.entries(settings.memorySpaces)
      .filter(([space]) => readable({ space }))),
    projectSpaces: {},
  }
}
