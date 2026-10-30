import type { EventBase } from '#store/events.ts'
import type { Column } from '#tasks/columns-model.ts'

export interface ViewPreferences {
  focusMode: boolean
  lastMessageOnCards: boolean
  defaultHydraWidth: number
  defaultColumnWidth: number
  defaultColumnWidths: Record<string, number>
  theme: 'light' | 'dark' | 'system'
  keyboard: import('./keyboard.ts').KeyboardPreferences
  fontSize: number
  chatFontSize: number
  codeFontSize: number
  panelPlacement: 'right' | 'inline'
  panelWidth: number
  hydraWidth: number
  cardHeight: number
  cardColors: boolean
  toolDetails: boolean
  thinkingDetails: boolean
  columnWidths: Record<string, number>
  cardHeights: Record<string, number>
  closedCardHeights: Record<string, number>
  cardTraceOverrides: Record<string, {
    tools?: boolean
    thinking?: boolean
  }>
  customColumns: {
    id: `custom:${string}`
    title: string
  }[]
}

export type ViewEvent = EventBase & {
  type: 'board.view'
  // placements: cards a deleted custom column moved to the fallback column, applied atomically.
  data: {
    before: ViewPreferences
    after: ViewPreferences
    placements?: {
      cardId: string
      before: Column | null
      after: Column | null
      revision: number
    }[]
  }
}
