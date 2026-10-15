// Per-install search settings in $PNYX_HOME/settings.json. They describe this
// machine (which models it holds and runs), not a Hydra, so they live outside
// every Hydra's log.
import { readFileSync, renameSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { HydraError } from '../core/model.ts'
import { pnyxHome } from '../store/hydra-store.ts'
import { EMBEDDER_IDS, type EmbedderId } from './models.ts'

export type Auto<T> = T | 'auto'

export interface OracleSettings {
  semantic: boolean
  rerank: Auto<boolean>
  model: Auto<EmbedderId>
}

export const DEFAULTS: OracleSettings = { semantic: true, rerank: 'auto', model: 'auto' }

// Tests run the worker on hash vectors and never need a model file.
export const stubbed = () => process.env.PNYX_SEMANTIC_STUB === '1'

const settingsPath = () => join(pnyxHome(), 'settings.json')

const onOffAuto = ({ value }: { value: unknown }): Auto<boolean> | undefined =>
  value === 'on' ? true : value === 'off' ? false : value === 'auto' ? 'auto' : undefined

// PNYX_SEMANTIC=off turns semantic search off for a process and its children,
// whatever the file says: a CI machine, a script, the test suite. Writes keep the file's own value.
export function readSettings({ applyEnv = true }: { applyEnv?: boolean } = {}): OracleSettings {
  let raw: Record<string, unknown> = {}

  try {
    raw = JSON.parse(readFileSync(settingsPath(), 'utf8')) as Record<string, unknown>
  } catch {
    // Missing or unreadable: the defaults.
  }

  const model = raw['search.model']

  return {
    semantic: !(applyEnv && process.env.PNYX_SEMANTIC === 'off') && raw['search.semantic'] !== 'off',
    rerank: onOffAuto({ value: raw['search.rerank'] }) ?? DEFAULTS.rerank,
    model: EMBEDDER_IDS.includes(model as EmbedderId) ? (model as EmbedderId) : DEFAULTS.model,
  }
}

export const SETTING_KEYS = ['oracle.semantic', 'oracle.rerank', 'oracle.model'] as const
export type SettingKey = (typeof SETTING_KEYS)[number]

const word = ({ value }: { value: Auto<boolean> }) => (value === 'auto' ? 'auto' : value ? 'on' : 'off')

export function settingEntries({ settings }: {
  settings: OracleSettings
}): Record<SettingKey, string> {
  return { 'oracle.semantic': settings.semantic ? 'on' : 'off', 'oracle.rerank': word({ value: settings.rerank }), 'oracle.model': settings.model }
}

export function writeSetting({ key, value }: { key: string; value: string }): OracleSettings {
  const next = readSettings({ applyEnv: false })

  if (key === 'oracle.semantic') {
    if (value !== 'on' && value !== 'off') {
      throw new HydraError({ message: 'oracle.semantic takes on or off', code: 'VALIDATION_ERROR' })
    }

    next.semantic = value === 'on'
  } else if (key === 'oracle.rerank') {
    const rerank = onOffAuto({ value })

    if (rerank === undefined) {
      throw new HydraError({ message: 'oracle.rerank takes auto, on or off', code: 'VALIDATION_ERROR' })
    }

    next.rerank = rerank
  } else if (key === 'oracle.model') {
    if (value !== 'auto' && !EMBEDDER_IDS.includes(value as EmbedderId)) {
      throw new HydraError({ message: `oracle.model takes auto, ${EMBEDDER_IDS.join(' or ')}`, code: 'VALIDATION_ERROR' })
    }

    next.model = value as Auto<EmbedderId>
  } else {
    throw new HydraError({ message: `unknown setting: ${key}`, code: 'VALIDATION_ERROR', help: [`Use one of ${SETTING_KEYS.join(', ')}`] })
  }

  saveSettings({ settings: next })

  return next
}

export function saveSettings({ settings }: { settings: OracleSettings }): void {
  mkdirSync(pnyxHome(), { recursive: true })
  const tmp = `${settingsPath()}.${process.pid}.tmp`
  const stored = Object.fromEntries(Object.entries(settingEntries({ settings })).map(([key, value]) => [key.replace(/^oracle\./, 'search.'), value]))
  writeFileSync(tmp, `${JSON.stringify(stored, null, 2)}\n`)
  renameSync(tmp, settingsPath())
}
