import type { ViewPreferences } from '#preferences/model.ts'
import type { Settings } from '#settings/model.ts'
import { DEFAULT_COLUMN_WIDTH } from '#preferences/view.ts'
import { DEFAULT_KEYBOARD } from '#preferences/keyboard.ts'
import { DEFAULT_SETTINGS } from '#settings/settings.ts'

const initialOf = ({ id }: { id: string }) => DEFAULT_SETTINGS[id as keyof typeof DEFAULT_SETTINGS]

const differs = ({
  value,
  initial,
}: {
  value: unknown
  initial: unknown
}) => JSON.stringify(value) !== JSON.stringify(initial)

const HYDRA_KEYS = [
  'doneAfterHours',
  'reviewMinutes',
  'helper',
] as const

// Column widths count once any column differs, since the map also names columns the default does not.
export function changedIds({
  view,
  settings,
}: {
  view: ViewPreferences
  settings: Settings
}): Set<string> {
  const ids = new Set(Object.keys(DEFAULT_SETTINGS).filter(key => key !== 'defaultColumnWidths'
    && key in view && differs({
    value: view[key as keyof ViewPreferences],
    initial: initialOf({ id: key }),
  })))

  for (const key of HYDRA_KEYS) {
    if (differs({
      value: settings[key],
      initial: DEFAULT_SETTINGS[key],
    })) {
      ids.add(key)
    }
  }

  if (Object.values(view.defaultColumnWidths).some(width => width !== DEFAULT_COLUMN_WIDTH)) {
    ids.add('defaultColumnWidths')
  }

  return ids
}

// Shared settings merge maps, so a reset clears every binding and every width the default does not name.
export function resetPatch({
  id,
  view,
}: {
  id: string
  view: ViewPreferences
}): Record<string, unknown> {
  if (id === 'keyboard') {
    return {
      keyboard: {
        characterShortcuts: DEFAULT_KEYBOARD.characterShortcuts,
        bindings: null,
      },
    }
  }

  if (id === 'defaultColumnWidths') {
    return {
      defaultColumnWidths: Object.fromEntries(Object.keys(view.defaultColumnWidths).map(column => [
        column,
        column in DEFAULT_SETTINGS.defaultColumnWidths ? DEFAULT_COLUMN_WIDTH : null,
      ])),
    }
  }

  return { [id]: initialOf({ id }) }
}
