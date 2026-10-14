// Per-install search settings in $PNYX_HOME/settings.json. They describe this
// machine (which models it holds and runs), not a board, so they live outside
// every board's log.
import { readFileSync, renameSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { BoardError } from '../core/model.ts'
import { pnyxHome } from '../store/board-store.ts'
import { EMBEDDERS, EMBEDDER_IDS, RERANKER, isInstalled, type EmbedderId } from './models.ts'

export interface SearchSettings {
  // Off until `pnyx-axi search setup --semantic`; when off, search is lexical only.
  semantic: boolean
  rerank: boolean
  model: EmbedderId
}

export const DEFAULTS: SearchSettings = { semantic: false, rerank: false, model: 'granite-311m' }

// Tests run the worker on hash vectors and never need a model file.
export const stubbed = () => process.env.PNYX_SEMANTIC_STUB === '1'

const settingsPath = () => join(pnyxHome(), 'settings.json')

export function readSettings(): SearchSettings {
  let raw: Record<string, unknown> = {}

  try {
    raw = JSON.parse(readFileSync(settingsPath(), 'utf8')) as Record<string, unknown>
  } catch {
    // Missing or unreadable: the defaults.
  }

  const model = raw['search.model']

  return {
    semantic: raw['search.semantic'] === 'on',
    rerank: raw['search.rerank'] === 'on',
    model: EMBEDDER_IDS.includes(model as EmbedderId) ? (model as EmbedderId) : DEFAULTS.model,
  }
}

export const SETTING_KEYS = ['search.semantic', 'search.rerank', 'search.model'] as const
export type SettingKey = (typeof SETTING_KEYS)[number]

export function settingEntries(s: SearchSettings): Record<SettingKey, string> {
  return { 'search.semantic': s.semantic ? 'on' : 'off', 'search.rerank': s.rerank ? 'on' : 'off', 'search.model': s.model }
}

const SETUP = 'Run `pnyx-axi search setup --semantic` to download the models'

// Validates and saves one setting. Turning on what needs a model file that is not
// installed is refused, so an on setting always has its model.
export function writeSetting(key: string, value: string): SearchSettings {
  const next = readSettings()

  const onOff = () => {
    if (value !== 'on' && value !== 'off') {
      throw new BoardError(`${key} takes on or off`, 'VALIDATION_ERROR')
    }

    return value === 'on'
  }

  if (key === 'search.semantic') {
    next.semantic = onOff()
  } else if (key === 'search.rerank') {
    next.rerank = onOff()
  } else if (key === 'search.model') {
    if (!EMBEDDER_IDS.includes(value as EmbedderId)) {
      throw new BoardError(`search.model takes ${EMBEDDER_IDS.join(' or ')}`, 'VALIDATION_ERROR')
    }

    next.model = value as EmbedderId
  } else {
    throw new BoardError(`unknown setting: ${key}`, 'VALIDATION_ERROR', [`Use one of ${SETTING_KEYS.join(', ')}`])
  }

  if (!stubbed()) {
    if (next.semantic && !isInstalled(EMBEDDERS[next.model])) {
      throw new BoardError(`${next.model} is not downloaded`, 'VALIDATION_ERROR', [`${SETUP}, or add --model ${next.model}`])
    }

    if (next.rerank && !isInstalled(RERANKER)) {
      throw new BoardError('the reranker is not downloaded', 'VALIDATION_ERROR', [`${SETUP} --rerank`])
    }
  }

  saveSettings(next)

  return next
}

export function saveSettings(s: SearchSettings): void {
  mkdirSync(pnyxHome(), { recursive: true })
  const tmp = `${settingsPath()}.${process.pid}.tmp`
  writeFileSync(tmp, `${JSON.stringify(settingEntries(s), null, 2)}\n`)
  renameSync(tmp, settingsPath())
}
