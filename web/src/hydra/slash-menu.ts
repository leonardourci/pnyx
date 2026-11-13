import { ADD_PROJECT_COMMAND } from '#hydra/built-in-skills.ts'
import { matchingSuggestions } from '#hydra/suggestion-matches.ts'
import type { Catalog,Suggestion } from '#hydra/transcripts-catalog.ts'
import { skillReference } from '#hydra/transcripts-skill-reference.ts'
import { useEffect,type Dispatch,type RefObject,type SetStateAction } from 'react'
import { draftView,replaceDisplay } from './draft.ts'
import { slashPrefix } from './view.ts'

export function useSlashMenu({
  catalog,
  prefix,
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
  prefix: string | null
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
  const suggestions = matchingSuggestions({
    items: catalog?.suggestions ?? [],
    query: prefix ?? '',
    name: ({ item }) => item.command,
  })

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
    suggestions,
    catalogOpen,
    choose,
  }
}
