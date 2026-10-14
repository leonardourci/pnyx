// Per-install search settings in $PNYX_HOME/settings.json. They describe this
// machine (which models it holds and runs), not a board, so they live outside
// every board's log.
import { readFileSync, renameSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { BoardError } from '../core/model.ts'
import { pnyxHome } from '../store/board-store.ts'
import { EMBEDDER_IDS, type EmbedderId } from './models.ts'

// auto: decided by the machine. With a GPU backend the 311m embedder and the
// reranker; on CPU only the 97m embedder without it.
export type Auto<T> = T | 'auto'

export interface SearchSettings {
  // On by default; off makes search full-text only.
  semantic: boolean
  rerank: Auto<boolean>
  model: Auto<EmbedderId>
}

export const DEFAULTS: SearchSettings = { semantic: true, rerank: 'auto', model: 'auto' }

// Tests run the worker on hash vectors and never need a model file.
export const stubbed = () => process.env.PNYX_SEMANTIC_STUB === '1'

const settingsPath = () => join(pnyxHome(), 'settings.json')

const onOffAuto = ({ value }: { value: unknown }): Auto<boolean> | undefined =>
  value === 'on' ? true : value === 'off' ? false : value === 'auto' ? 'auto' : undefined

// PNYX_SEMANTIC=off turns semantic search off for a process and its children,
// whatever the file says: a CI machine, a script, the test suite. Writes keep the file's own value.
export function readSettings({ applyEnv = true }: { applyEnv?: boolean } = {}): SearchSettings {
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

export const SETTING_KEYS = ['search.semantic', 'search.rerank', 'search.model'] as const
export type SettingKey = (typeof SETTING_KEYS)[number]

const word = ({ value }: { value: Auto<boolean> }) => (value === 'auto' ? 'auto' : value ? 'on' : 'off')

export function settingEntries({ settings }: {
  settings: SearchSettings
}): Record<SettingKey, string> {
  return { 'search.semantic': settings.semantic ? 'on' : 'off', 'search.rerank': word({ value: settings.rerank }), 'search.model': settings.model }
}

// Validates and saves one setting.
export function writeSetting({ key, value }: { key: string; value: string }): SearchSettings {
  const next = readSettings({ applyEnv: false })

  if (key === 'search.semantic') {
    if (value !== 'on' && value !== 'off') {
      throw new BoardError({ message: 'search.semantic takes on or off', code: 'VALIDATION_ERROR' })
    }

    next.semantic = value === 'on'
  } else if (key === 'search.rerank') {
    const rerank = onOffAuto({ value })

    if (rerank === undefined) {
      throw new BoardError({ message: 'search.rerank takes auto, on or off', code: 'VALIDATION_ERROR' })
    }

    next.rerank = rerank
  } else if (key === 'search.model') {
    if (value !== 'auto' && !EMBEDDER_IDS.includes(value as EmbedderId)) {
      throw new BoardError({ message: `search.model takes auto, ${EMBEDDER_IDS.join(' or ')}`, code: 'VALIDATION_ERROR' })
    }

    next.model = value as Auto<EmbedderId>
  } else {
    throw new BoardError({ message: `unknown setting: ${key}`, code: 'VALIDATION_ERROR', help: [`Use one of ${SETTING_KEYS.join(', ')}`] })
  }

  saveSettings({ settings: next })

  return next
}

export function saveSettings({ settings }: { settings: SearchSettings }): void {
  mkdirSync(pnyxHome(), { recursive: true })
  const tmp = `${settingsPath()}.${process.pid}.tmp`
  writeFileSync(tmp, `${JSON.stringify(settingEntries({ settings }), null, 2)}\n`)
  renameSync(tmp, settingsPath())
}
