import { matchingTasks, reference, taskMention } from '#hydra/mentions.ts'
import { matchingSuggestions, suggestionMatch } from '#hydra/suggestion-matches.ts'
import { isPendingImage, type PlacedChip } from './draft.ts'
import type { ComposerSources } from './composer-sources.tsx'
import type { MentionItem } from './mention-picker.tsx'
import { columnLook } from '#web-tasks/view.ts'
import { projectTitle } from '#web-projects/view.ts'

export function mentionCandidates({
  query,
  view,
  projects,
  columns,
  cards,
  taskLook,
  folderItems,
  typedFolder,
}: {
  query: string
  view: { chips: PlacedChip[] }
  projects: ComposerSources['projects']
  columns: ComposerSources['columns']
  cards: ComposerSources['cards']
  taskLook({ id }: { id: string }): {
    icons: string[]
    tone: string
  }
  folderItems: MentionItem[]
  typedFolder?: MentionItem
}) {
  const candidates: (MentionItem & { search?: string })[] = [
    ...view.chips.filter(chip => {
      return chip.attached && !isPendingImage({ path: chip.value })
    }).map(chip => ({
      key: `${chip.kind}:${chip.value}`,
      kind: chip.kind,
      title: chip.name,
      detail: chip.kind === 'image' ? 'Attached image' : 'Attached file',
      insert: reference({
        kind: chip.kind,
        value: chip.value,
        label: chip.name,
      }),
    })),

    ...projects.filter(project => !project.detached).map(project => {
      const titleMatch = suggestionMatch({
        name: project.name,
        query,
      })

      return ({
        key: `project:${project.path}`,
        kind: 'project' as const,
        title: project.name,
        excerpt: titleMatch ? undefined : project.path,
        search: project.path,
        detail: 'Project',
        insert: reference({
          kind: 'project',
          value: project.path,
          label: project.name,
        }),
        path: project.path,
      })
    }),
    ...columns.map(column => ({
      key: `column:${column.id}`,
      kind: 'column' as const,
      title: column.title,
      detail: 'Column',
      icons: [columnLook({ column }).icon],
      tone: columnLook({ column }).tone,
      insert: reference({
        kind: 'column',
        value: column.id,
        label: column.title,
      }),
    })),
    ...matchingTasks({
      cards,
      query,
    }).map(({
      card,
      excerpt,
      excerptHighlights,
    }) => ({
      key: `task:${card.id}`,
      kind: 'task' as const,
      title: card.title,
      search: card.initialPrompt ?? card.brief ?? '',
      detail: card.project ? projectTitle({ project: card.project }) : 'No project',
      excerpt,
      excerptHighlights,
      ...taskLook({ id: card.id }),
      insert: taskMention({
        id: card.id,
        title: card.title,
      }),
    })),
  ]
  // Folders follow the ranked matches; they are already matched against what was typed.
  const listed: MentionItem[] = [
    ...matchingSuggestions({
      items: candidates,
      query,
      name: ({ item }) => item.title,
      fallback: ({ item }) => item.search ?? '',
    }),
    ...folderItems,
  ]
  // A typed path that names a folder leads, so Enter adds the folder typed rather than a project under it.
  const matches = typedFolder
    ? [
      typedFolder,
      ...listed.filter(item => item.insert !== typedFolder.insert),
    ]
    : listed

  return matches
}
