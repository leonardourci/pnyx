import type { RefObject } from 'react'
import { SuggestionPicker, type PickerItem } from '#web-shared/ui/suggestion-picker.tsx'
import type { ChipKind } from './draft.ts'

export interface MentionItem extends PickerItem {
  kind: ChipKind
  insert: string
  // The folder or clone URL a project item writes as plain text in an Add project request.
  path?: string
}

export function MentionPicker({
  id,
  matches,
  active,
  choose,
  anchor,
}: {
  id: string
  anchor: RefObject<HTMLTextAreaElement | null>
  matches: MentionItem[]
  active: number
  choose({ item }: { item: MentionItem }): void
}) {
  return (
    <SuggestionPicker
      id={id}
      matches={matches.map(item => ({
        ...item,
        icons: item.icons ?? [item.kind],
      }))}
      active={active}
      choose={choose}
      anchor={anchor}
      label="Mention"
    />
  )
}
