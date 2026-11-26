import { reference, taskMention } from '#titan/mentions.ts'
import { filterRows, prepareRow, type PreparedRow, type RowMatch } from '#titan/suggestion-matches.ts'
import { TITAN_CARD } from '#titan/identity.ts'
import { liveTask } from '#tasks/select.ts'
import type { Card } from '#tasks/model.ts'
import type { TitanProject } from '#projects/model.ts'
import type { ProjectGroup } from '#projects/groups.ts'
import type { ProjectFiles } from '#projects/file-index.ts'
import type { FolderEntry } from '#projects/folders.ts'
import { isPendingImage, type PlacedChip } from './draft.ts'
import type { OtherTitan } from './composer-sources.tsx'
import type { MentionItem } from './mention-picker.tsx'
import { columnLook } from '#web-tasks/view.ts'
import { projectTitle } from '#web-projects/view.ts'
import { taskStateIcon, type TaskReferenceData } from '#web-tasks/task-reference.tsx'

type MentionRow = PreparedRow<MentionItem>

export function taskLook({ reference }: { reference?: TaskReferenceData }) {
  return {
    icons: [
      'task-card',
      taskStateIcon({ kind: reference?.kind }),
    ],
    tone: `column-${reference?.column ?? 'custom'}`,
  }
}

const preparedTaskRows = new WeakMap<Card, {
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
  const prepared = preparedTaskRows.get(card)

  if (prepared?.look === lookKey) {
    return prepared.row
  }

  const prompt = card.initialPrompt ?? card.brief ?? ''
  const row = prepareRow<MentionItem>({
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
    fallback: prompt,
  })
  preparedTaskRows.set(
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
    fallback: project.path,
  }))

export const columnRows = ({ columns }: { columns: ProjectGroup[] }): MentionRow[] => columns
  .map(column => prepareRow<MentionItem>({
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
  }))

export const taskRows = ({
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

export const titanRows = ({ titans }: { titans: OtherTitan[] }): MentionRow[] => titans
  .map(titan => prepareRow<MentionItem>({
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
  }))

export const fileItem = ({
  name,
  path,
}: FolderEntry): MentionItem => ({
  key: `file:${path}`,
  kind: 'file',
  title: name,
  detail: path,
  icons: ['file'],
  group: 'Files',
  insert: reference({
    kind: 'file',
    value: path,
    label: name,
  }),
})

const fileRow = ({
  project,
  file,
}: {
  project: ProjectFiles
  file: string
}) => prepareRow<MentionItem>({
  item: {
    ...fileItem({
      name: file.slice(file.lastIndexOf('/') + 1),
      path: `${project.path}/${file}`,
    }),
    detail: projectTitle({ project: project.path }),
    excerpt: file,
  },
  fallback: file,
})

export const fileRows = ({ projects }: { projects: ProjectFiles[] }): MentionRow[] => projects
  .flatMap(project => project.files.map(file => fileRow({
    project,
    file,
  })))

export const attachmentRows = ({ chips }: { chips: PlacedChip[] }): MentionRow[] => chips
  .filter(chip => chip.attached && !isPendingImage({ path: chip.value }))
  .map(chip => prepareRow<MentionItem>({
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
  }))

export const folderRows = ({ folders }: { folders: MentionItem[] }): MentionRow[] => folders
  .map(item => prepareRow({
    item,
    fallback: item.path,
  }))

export function mentionMatches({
  query,
  rows,
  files,
  folders,
  filterFolders,
  typedFolder,
}: {
  query: string
  rows: MentionRow[]
  files: MentionRow[]
  folders: MentionRow[]
  filterFolders: boolean
  typedFolder?: MentionItem
}): RowMatch<MentionItem>[] {
  const listed = [
    ...filterRows({
      rows,
      query,
    }),
    ...filterRows({
      rows: folders,
      query: filterFolders ? query : '',
    }),
    ...filterRows({
      rows: files,
      query,
    }),
  ]

  if (!typedFolder) {
    return listed
  }

  // A typed path that names a folder leads, so Enter adds the folder typed rather than a project under it.
  return [
    ...filterRows({
      rows: [prepareRow({ item: typedFolder })],
      query: '',
    }),
    ...listed.filter(match => match.row.item.insert !== typedFolder.insert),
  ]
}
