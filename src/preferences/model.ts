import type { EventBase } from '#store/events.ts'

export interface ViewPreferences {
  workspace: import('./workspace.ts').WorkspaceLayout
  focusMode: boolean
  lastMessageOnCards: boolean
  defaultTitanWidth: number
  theme: 'light' | 'dark' | 'system'
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
  cardHeights: Record<string, number>
  closedCardHeights: Record<string, number>
  cardTraceOverrides: Record<string, {
    tools?: boolean
    thinking?: boolean
  }>
}

export type ViewEvent = EventBase & {
  type: 'board.view'
  data: {
    before: ViewPreferences
    after: ViewPreferences
  }
}
