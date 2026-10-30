import type { ViewPreferences } from '#preferences/model.ts'
import type { AgentConfig } from '#workers/model.ts'

// The view preferences every Hydra shares; the rest of a view (dragged widths, card heights, custom columns) stays with its board.
export const SHARED_VIEW_KEYS = [
  'theme',
  'fontSize',
  'chatFontSize',
  'codeFontSize',
  'focusMode',
  'lastMessageOnCards',
  'toolDetails',
  'thinkingDetails',
  'keyboard',
  'defaultHydraWidth',
  'defaultColumnWidth',
  'defaultColumnWidths',
] as const

export type SharedViewKey = (typeof SHARED_VIEW_KEYS)[number]

export const isSharedViewKey = ({ key }: { key: string }) =>
  SHARED_VIEW_KEYS.includes(key as SharedViewKey)

export type SharedView = Pick<ViewPreferences, SharedViewKey>

// off keeps Done cards on the board; a number of hours hides them after that long in Done, 0 right away.
export type DoneAfterHours = number | 'off'
// auto picks a lighter model on Hydra's harness; off sends every wake to Hydra.
export type HelperSetting = 'auto' | 'off' | AgentConfig

export interface Settings extends SharedView {
  doneAfterHours: DoneAfterHours
  reviewMinutes: number
  helper: HelperSetting
  // The Oracle opens with the filters it last had instead of only the current Hydra's.
  oracleRememberFilters: boolean
  // The Hydra list's order as Hydra ids; the Hydra list decides where ids it does not name go.
  hydraOrder: string[]
}

export const SETTING_KEYS = [
  ...SHARED_VIEW_KEYS,
  'doneAfterHours',
  'reviewMinutes',
  'helper',
  'oracleRememberFilters',
  'hydraOrder',
] as const

export type SettingKey = (typeof SETTING_KEYS)[number]

// One change to the shared settings; the log is only appended, so every old value stays.
export interface SettingsEntry {
  v: 1
  id: string
  at: string
  actor: string
  reason?: string
  before: Partial<Settings>
  after: Partial<Settings>
}
