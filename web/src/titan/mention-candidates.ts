import { reference, taskMention } from '#titan/mentions.ts'
import { filterRows, prepareRow, type PreparedRow, type RowMatch } from '#titan/suggestion-matches.ts'
import { TITAN_CARD } from '#titan/identity.ts'
import { liveTask } from '#tasks/select.ts'
import type { Card } from '#tasks/model.ts'
import type { TitanProject } from '#projects/model.ts'
import type { ProjectGroup } from '#projects/groups.ts'
import { isPendingImage, type PlacedChip } from './draft.ts'
import type { MentionItem } from './mention-picker.tsx'
import { columnLook } from '#web-tasks/view.ts'
import { projectTitle } from '#web-projects/view.ts'
import { taskStateIcon, type TaskReferenceData } from '#web-tasks/task-reference.tsx'

type MentionRow = PreparedRow<MentionItem>

// A task looks like its card reference: card, then state, in its column's color.
export function taskLook({ reference }: { reference?: TaskReferenceData }) {
  return {
    icons: [
      'task-card',
      taskStateIcon({ kind: reference?.kind }),
    ],
    tone: `column-${reference?.column ?? 'custom'}`,
  }
}

// A card keeps its row while neither the card nor its look changed, so a push that changes one card prepares one row.
const taskRows = new WeakMap<Card, {
  look: string
  row: MentionRow
}>()

function taskRow({
  card,
  reference: known,
}: {
  card: Card
  reference?: TaskReferenceData
}): MentionRow {
  const look = taskLook({ reference: known })
  const lookKey = JSON.stringify(look)
  const cached = taskRows.get(card)

  if (cached?.look === lookKey) {
    return cached.row
  }

  const prompt = card.initialPrompt ?? card.brief ?? ''
  const row = prepareRow<MentionItem>({
    key: `task:${card.id}`,
    item: {
      key: `task:${card.id}`,
      kind: 'task',
      title: card.title,
      detail: card.project ? projectTitle({ project: card.project }) : 'No project',
      excerpt: prompt || 'No initial prompt',
      ...look,
      insert: taskMention({
        id: card.id,
        title: card.title,
      }),
    },
    title: card.title,
    fallback: prompt,
  })
  taskRows.set(
    card,
    {
      look: lookKey,
      row,
    },
  )

  return row
}

export const projectRows = ({ projects }: { projects: TitanProject[] }): MentionRow[] => projects
  .filter(project => !project.detached)
  .map(project => prepareRow<MentionItem>({
    key: `project:${project.path}`,
    item: {
      key: `project:${project.path}`,
      kind: 'project',
      title: project.name,
      detail: 'Project',
      icons: ['project'],
      insert: reference({
        kind: 'project',
        value: project.path,
        label: project.name,
      }),
      path: project.path,
    },
    title: project.name,
    fallback: project.path,
  }))

const columnRow = ({ column }: { column: ProjectGroup }) => prepareRow<MentionItem>({
  key: `column:${column.id}`,
  item: {
    key: `column:${column.id}`,
    kind: 'column',
    title: column.title,
    detail: 'Column',
    icons: [columnLook().icon],
    tone: columnLook().tone,
    insert: reference({
      kind: 'column',
      value: column.id,
      label: column.title,
    }),
  },
  title: column.title,
})

export const columnRows = ({ columns }: { columns: ProjectGroup[] }): MentionRow[] => columns
  .map(column => columnRow({ column }))

export const taskRowsOf = ({
  cards,
  references,
}: {
  cards: Card[]
  references: Record<string, TaskReferenceData>
}): MentionRow[] => cards
  .filter(card => card.id !== TITAN_CARD && liveTask({ card }))
  .map(card => taskRow({
    card,
    reference: references[card.id],
  }))

export const titanRows = ({ titans }: {
  titans: {
    id: string
    name: string
    icon: string
  }[]
}): MentionRow[] => titans.map(titan => prepareRow<MentionItem>({
  key: `titan:${titan.id}`,
  item: {
    key: `titan:${titan.id}`,
    kind: 'titan',
    title: titan.name,
    detail: 'Titan',
    icons: [titan.icon],
    insert: reference({
      kind: 'titan',
      value: titan.id,
      label: titan.name,
    }),
  },
  title: titan.name,
}))

export const attachmentRows = ({ chips }: { chips: PlacedChip[] }): MentionRow[] => chips
  .filter(chip => chip.attached && !isPendingImage({ path: chip.value }))
  .map(chip => prepareRow<MentionItem>({
    key: `${chip.kind}:${chip.value}`,
    item: {
      key: `${chip.kind}:${chip.value}`,
      kind: chip.kind,
      title: chip.name,
      detail: chip.kind === 'image' ? 'Attached image' : 'Attached file',
      icons: [chip.kind],
      insert: reference({
        kind: chip.kind,
        value: chip.value,
        label: chip.name,
      }),
    },
    title: chip.name,
  }))

const folderRow = ({ item }: { item: MentionItem }) => prepareRow<MentionItem>({
  key: item.key,
  item,
  title: item.title,
  fallback: item.path,
})

export const folderRows = ({ folders }: { folders: MentionItem[] }): MentionRow[] => folders
  .map(item => folderRow({ item }))

export function mentionMatches({
  query,
  rows,
  folders,
  filterFolders,
  typedFolder,
}: {
  query: string
  rows: MentionRow[]
  folders: MentionRow[]
  // A typed path or clone URL lists only what the server found for it, so its folders are not filtered again.
  filterFolders: boolean
  typedFolder?: MentionItem
}): RowMatch<MentionItem>[] {
  // Folders follow the ranked matches.
  const listed = [
    ...filterRows({
      rows,
      query,
    }),
    ...filterRows({
      rows: folders,
      query: filterFolders ? query : '',
    }),
  ]

  if (!typedFolder) {
    return listed
  }

  // A typed path that names a folder leads, so Enter adds the folder typed rather than a project under it.
  return [
    {
      row: prepareRow<MentionItem>({
        key: typedFolder.key,
        item: typedFolder,
        title: typedFolder.title,
      }),
      ranges: [],
      context: false,
    },
    ...listed.filter(match => match.row.item.insert !== typedFolder.insert),
  ]
}
