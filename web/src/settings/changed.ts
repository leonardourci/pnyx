import type { Settings } from '#settings/model.ts'
import type { ViewPreferences } from '#preferences/model.ts'
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

// Column widths count once any column differs, since the map also names columns the default does not.
export function changedIds({
  view,
  settings,
}: {
  view: ViewPreferences
  settings?: Settings
}): Set<string> {
  const ids = new Set(Object.keys(DEFAULT_SETTINGS).filter(key => ![
    'defaultColumnWidths',
    'defaultColumnWidth',
  ].includes(key)
    && key in view && differs({
    value: view[key as keyof ViewPreferences],
    initial: initialOf({ id: key }),
  })))

  const widths = settings?.defaultColumnWidths ?? view.defaultColumnWidths
  const columnsChanged = view.defaultColumnWidth !== DEFAULT_COLUMN_WIDTH
    || Object.values(widths).some(width => width !== DEFAULT_COLUMN_WIDTH)

  if (columnsChanged) {
    ids.add('defaultColumnWidths')
  }

  return ids
}

// Shared settings merge maps, so a reset clears every binding and every width the default does not name.
export function resetPatch({
  id,
  view,
  settings,
}: {
  id: string
  view: ViewPreferences
  settings?: Settings
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
    const widths = settings?.defaultColumnWidths ?? view.defaultColumnWidths

    return {
      defaultColumnWidth: DEFAULT_COLUMN_WIDTH,
      defaultColumnWidths: Object.fromEntries(Object.keys(widths).map(column => [
        column,
        null,
      ])),
    }
  }

  return { [id]: initialOf({ id }) }
}
