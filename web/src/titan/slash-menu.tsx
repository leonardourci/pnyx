import { ADD_PROJECT_COMMAND } from '#titan/built-in-skills.ts'
import { filterRows,prepareRow,type PreparedRow } from '#titan/suggestion-matches.ts'
import type { Catalog,Suggestion } from '#titan/transcripts-catalog.ts'
import { skillReference } from '#titan/transcripts-skill-reference.ts'
import type { SavedLabelColor } from '#tasks/model.ts'
import { Label } from '#web-shared/ui/label.tsx'
import type { PickerItem } from '#web-shared/ui/suggestion-picker.tsx'
import { useEffect,useMemo,type Dispatch,type RefObject,type SetStateAction } from 'react'
import { draftView,replaceDisplay } from './draft.ts'
import { slashIcons } from './skill-icons.ts'
import { slashPrefix } from './view.ts'

export interface SlashItem extends PickerItem {
  suggestion: Suggestion
}

export const slashRows = ({
  catalog,
  labelColors,
}: {
  catalog: Catalog | null
  labelColors?: SavedLabelColor[]
}): PreparedRow<SlashItem>[] => (catalog?.suggestions ?? []).map(item => prepareRow<SlashItem>({
  item: {
    key: `${item.projectPath ?? item.source}:${item.file ?? item.command}`,
    title: `/${item.command.replace(
      /^[$/]/,
      '',
    )}`,
    detail: '',
    disabled: Boolean(item.unavailable),
    badge: item.project ? (
      <Label
        project
        label={item.projectPath ?? item.project}
        text={item.project}
        colors={labelColors}
      />
    ) : undefined,
    group: item.source,
    excerpt: item.description,
    icons: slashIcons({ item }),
    suggestion: item,
  },
}))

export function useSlashMenu({
  catalog,
  rows,
  prefix,
  shownPrefix,
  onCatalogOpen,
  input,
  read,
  projectRequests,
  dismissSlash,
  setActive,
  requestProject,
  write,
}: {
  catalog: Catalog | null
  rows: PreparedRow<SlashItem>[]
  prefix: string | null
  shownPrefix: string
  onCatalogOpen({ open }: { open: boolean }): void
  input: RefObject<HTMLTextAreaElement | null>
  read(): string
  projectRequests: boolean
  dismissSlash(): void
  setActive: Dispatch<SetStateAction<number>>
  requestProject({ text }: { text: string }): void
  write({
    text,
    caret,
  }: {
    text: string
    caret: number
  }): void
}) {
  const catalogOpen = prefix !== null
  useEffect(
    () => {
      if (!catalogOpen) {
        return
      }

      onCatalogOpen({ open: true })

      return () => onCatalogOpen({ open: false })
    },
    [
      catalogOpen,
      onCatalogOpen,
    ],
  )
  const matches = useMemo(
    () => filterRows({
      rows,
      query: shownPrefix,
    }),
    [
      rows,
      shownPrefix,
    ],
  )

  const choose = ({
    command,
    item,
  }: {
    command: string
    item?: Suggestion
  }) => {
    const unavailable = catalog?.suggestions.some(item =>
      skillReference({ item }) === command && item.unavailable)

    if (unavailable) {
      return
    }

    const draft = read()
    const view = draftView({ text: draft })
    const cursor = input.current?.selectionStart ?? view.display.length
    const query = slashPrefix({
      text: view.display,
      cursor,
      chips: view.chips,
    })

    if (query === null || query !== prefix) {
      dismissSlash()

      return
    }

    if (projectRequests && item?.kind === 'command' && item.command === ADD_PROJECT_COMMAND) {
      dismissSlash(); setActive(0)
      requestProject({
        text: replaceDisplay({
          text: draft,
          from: cursor - query.length,
          to: cursor,
          insert: '',
        }).text,
      })

      return
    }

    write(replaceDisplay({
      text: draft,
      from: cursor - query.length,
      to: cursor,
      insert: `${command} `,
    }))
    dismissSlash(); setActive(0); input.current?.focus()
  }

  return {
    matches,
    catalogOpen,
    choose,
  }
}
