import type { Settings } from '#settings/model.ts'
import type { ViewPreferences } from '#preferences/model.ts'
import { DEFAULT_SETTINGS } from '#settings/settings.ts'

const initialOf = ({ id }: { id: string }) => DEFAULT_SETTINGS[id as keyof typeof DEFAULT_SETTINGS]

const differs = ({
  value,
  initial,
}: {
  value: unknown
  initial: unknown
}) => JSON.stringify(value) !== JSON.stringify(initial)

// Settings that are not view preferences, each compared with its default.
const NON_VIEW_KEYS = [
  'doneAfterHours',
  'reviewMinutes',
  'helper',
  'logs',
  'logDays',
  'logMaxMB',
] as const

export function changedIds({
  view,
  settings,
}: {
  view: ViewPreferences
  settings: Settings
}): Set<string> {
  const ids = new Set(Object.keys(DEFAULT_SETTINGS).filter(key => key in view && differs({
    value: view[key as keyof ViewPreferences],
    initial: initialOf({ id: key }),
  })))

  for (const key of NON_VIEW_KEYS) {
    if (differs({
      value: settings[key],
      initial: DEFAULT_SETTINGS[key],
    })) {
      ids.add(key)
    }
  }

  return ids
}

export function resetPatch({
  id,
}: {
  id: string
  view: ViewPreferences
  settings?: Settings
}): Record<string, unknown> {
  return { [id]: initialOf({ id }) }
}
