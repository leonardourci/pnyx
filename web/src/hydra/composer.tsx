import { matchingSuggestions, suggestionMatch } from '#hydra/suggestion-matches.ts'
import type { HydraProject } from '#projects/model.ts'
import type { HydraColumn } from '#tasks/columns-model.ts'
import type { Card, SavedLabelColor } from '#tasks/model.ts'
import { matchingTasks, mentionQuery, reference, taskMention } from '#hydra/mentions.ts'
import { MentionPicker, type MentionItem } from './mention-picker.tsx'
import { commandBytes, MAX_MESSAGE_BYTES } from '#app/server-protocol.ts'
import { readAttempt, saveAttempt } from './outbox.ts'
import { revealComment } from './comment-reveal.ts'
import { Fragment, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { flushSync } from 'react-dom'
import type { ThreadPage } from '#hydra/transcripts-read.ts'
import { readSkillReference, skillReference } from '#hydra/transcripts-skill-reference.ts'
import { isUpgradeSuggestion } from '#upgrade/model.ts'
import { ADD_PROJECT_COMMAND } from '#hydra/built-in-skills.ts'
import { useFolders } from '#web-projects/add-project.tsx'
import { completePath } from './path-completion.ts'
import { COMPOSER_ICON } from './hydra-agent.tsx'
import { GOALS, mentionText, REQUEST_HEAD, requestPaths, sendableRequest, withProjectRequest } from './project-request.ts'
import { SkillBadge } from './skill-badge.tsx'
import { Label } from '#web-shared/ui/label.tsx'
import { SuggestionPicker } from '#web-shared/ui/suggestion-picker.tsx'
import type { Catalog, Suggestion } from '#hydra/transcripts-catalog.ts'
import type { FolderListing } from '#projects/folders.ts'
import { ReferenceBadge } from './reference-badge.tsx'
import { Button, Input, Textarea } from '#web-shared/ui/controls.tsx'
import { Icon } from '#web-shared/ui/icon.tsx'
import { taskStateIcon, type TaskReferenceData } from '#web-tasks/task-reference.tsx'
import { Popover } from '#web-shared/ui/popover.tsx'
import { ImageThumb, ImageViewer } from './attached-image.tsx'
import { AttachmentCard } from './attachment-card.tsx'
import { projectTitle } from '#web-projects/view.ts'
import { columnLook } from '#web-tasks/view.ts'
import { slashPrefix } from './view.ts'
import { clock, commentReply, sendableComment, type ChatComment } from './chat.ts'
import type { Command } from '#web-app/connection.ts'
import { useKeyAction, useKeyboard } from '#web-preferences/keyboard-registry.tsx'
import { placeMessageCaret, conversationMessages, latestAgentMessage } from './caret.ts'
import { checkImages, pastedImages, uploadImage } from './image-upload.ts'
import { embedImages, imagesHtml } from './clipboard.ts'
import { CommentsDialog, CommentsPill } from './comments-dialog.tsx'
import { fileBlock } from '#hydra/attachments.ts'
import { imageLine } from '#hydra/images.ts'
import { cardChip, CHIP_SPACE, draftView, editDraft, copyDraft, hasPendingImage, isPendingImage, shownDraft, pendingImage, placeBlock, placeImages, removeChip, replaceDisplay, settleImage, snapSelection, withoutPendingImages, type PlacedChip } from './draft.ts'

// A selection's fixed end and the end that moves, whichever way it was made.
const selectionEnds = ({ field }: { field: HTMLTextAreaElement }) => field.selectionDirection === 'backward'
  ? {
    anchor: field.selectionEnd,
    focus: field.selectionStart,
  }
  : {
    anchor: field.selectionStart,
    focus: field.selectionEnd,
  }

const select = ({
  field,
  anchor,
  focus,
}: {
  field: HTMLTextAreaElement
  anchor: number
  focus: number
}) => field.setSelectionRange(
  Math.min(
    anchor,
    focus,
  ),
  Math.max(
    anchor,
    focus,
  ),
  focus < anchor ? 'backward' : 'forward',
)

// Icons beside the text of the composer's menu items.
const MENU_ICON = 16

const CLONE_URL = /^(?:https?:\/\/|git@)\S+$/

// What the @ picker offers beyond this Hydra's own projects.
function folderSuggestions({
  query,
  typed,
  attached,
  otherProjects,
  listing,
  typedPath,
}: {
  query: string
  typed: string
  attached: HydraProject[]
  otherProjects: {
    name: string
    path: string
    hydra: string
  }[]
  listing?: FolderListing
  typedPath: boolean
}): MentionItem[] {
  if (CLONE_URL.test(typed)) {
    const repository = typed.replace(
      /\.git$/,
      '',
    ).split(/[/:]/)
      .pop() || typed

    return [
      {
        key: `clone:${typed}`,
        kind: 'project',
        title: `Clone ${repository}`,
        detail: typed,
        icons: ['clone'],
        group: 'Folders',
        insert: typed,
        path: typed,
      },
    ]
  }

  const candidates = otherProjects.map(project => ({
    ...project,
    detail: `In ${project.hydra}`,
  }))
  const folders: FolderListing['recent'] = []

  if (listing) {
    folders.push(...listing.recent)
  }

  if (listing && typedPath) {
    folders.push(...listing.folders)
  }

  for (const folder of folders) {
    candidates.push({
      ...folder,
      hydra: '',
      detail: folder.path,
    })
  }

  const skip = new Set(attached.filter(project => !project.detached).map(project => project.path))
  const items: MentionItem[] = []

  for (const folder of candidates) {
    const matching = typedPath || !query || `${folder.name} ${folder.path}`.toLocaleLowerCase().includes(query)

    if (matching && !skip.has(folder.path)) {
      skip.add(folder.path)
      items.push({
        key: `folder:${folder.path}`,
        kind: 'project',
        title: folder.name,
        detail: folder.detail,
        group: 'Folders',
        insert: reference({
          kind: 'project',
          value: folder.path,
          label: folder.name,
        }),
        path: folder.path,
      })
    }
  }

  return items
}

// Display text from `from` to `to`, with the request paths in it marked.
function markedPaths({
  display,
  from,
  to,
  paths,
}: {
  display: string
  from: number
  to: number
  paths: {
    from: number
    to: number
  }[]
}): ReactNode[] {
  const parts: ReactNode[] = []
  let at = from

  for (const path of paths.filter(path => path.to > from && path.from < to)) {
    const start = Math.max(
      path.from,
      at,
    )
    const end = Math.min(
      path.to,
      to,
    )
    parts.push(
      display.slice(
        at,
        start,
      ),
      <span key={start} className="draft-path">{display.slice(
        start,
        end,
      )}
      </span>,
    )
    at = end
  }

  parts.push(display.slice(
    at,
    to,
  ))

  return parts
}

function slashIcons({ item }: { item: Suggestion }): string[] | undefined {
  if (isUpgradeSuggestion({ item })) {
    return ['upgrade']
  }

  return item.command === ADD_PROJECT_COMMAND ? ['attach'] : undefined
}

function UploadBar({ fraction }: { fraction: number }) {
  return (
    <span className="upload-bar">
      <span className="upload-bar-done" style={{ width: `${fraction * 100}%` }} />
    </span>
  )
}

function DraftCard({
  chip,
  progress = 0,
  open,
  remove,
}: {
  chip: PlacedChip
  progress?: number
  open(): void
  remove(): void
}) {
  const image = chip.kind === 'image'
  const loading = image && isPendingImage({ path: chip.value })
  const stored = image && !loading
  const slot = stored ? <ImageThumb path={chip.value} /> : <Icon name={image ? 'image' : 'file'} size={13} />
  const label = loading ? <>{chip.name}<UploadBar fraction={progress} /></> : chip.name

  return (
    <span className="draft-chip draft-card" data-kind={chip.kind} data-loading={loading || undefined}>
      {chip.label}
      <AttachmentCard
        keepsInputFocus
        slot={slot}
        label={label}
        title={stored ? 'Show image' : chip.name}
        tone={chip.attached ? undefined : 'reference'}
        open={stored ? open : undefined}
        remove={remove}
        removeLabel={`Remove ${chip.name}`}
      />
    </span>
  )
}

export function Composer({
  card,
  cards,
  projects,
  columns,
  taskReferences,
  openTask,
  title,
  draft,
  setDraft,
  comments,
  setComments,
  thread,
  command,
  catalog,
  onCatalogOpen,
  labelColors,
  notify,
  settings,
  meter,
  stop,
  compacting = false,
  focusAbove,
  projectRequest = false,
  projectRequested,
  otherProjects = [],
}: {
  card: string
  cards: Card[]
  projects: HydraProject[]
  columns: HydraColumn[]
  taskReferences: Record<string, TaskReferenceData>
  openTask({ id }: { id: string }): void
  title: string
  draft: string
  setDraft({ text }: { text: string }): void
  comments: ChatComment[]
  setComments({ items }: { items: ChatComment[] }): void
  thread: ThreadPage | null
  command: Command
  catalog: Catalog | null
  onCatalogOpen({ open }: { open: boolean }): void
  labelColors?: SavedLabelColor[]
  notify({ text }: { text: string }): void
  settings?: ReactNode
  meter?: ReactNode
  // Shown while Hydra runs a turn: it stops that turn, never the workers.
  compacting?: boolean
  stop?(): Promise<void>
  focusAbove?(): boolean
  // An Add project request to write into the draft; projectRequested clears it once written.
  projectRequest?: boolean
  projectRequested?(): void
  // Projects of the owner's other Hydras, offered under Folders in the @ picker.
  otherProjects?: {
    name: string
    path: string
    hydra: string
  }[]
}) {
  const [
    failure,
    setFailure,
  ] = useState<{
    at: string
    text: string
  } | null>(null)
  const [
    sending,
    setSending,
  ] = useState(false)
  const [
    checking,
    setChecking,
  ] = useState(false)
  const [
    prefix,
    setPrefix,
  ] = useState<string | null>(null)
  const [
    active,
    setActive,
  ] = useState(0)
  const [
    mention,
    setMention,
  ] = useState<ReturnType<typeof mentionQuery>>(null)
  const [
    mentionActive,
    setMentionActive,
  ] = useState(0)
  // The goal blank of an Add project request is selected: -1 has no suggestion chosen yet.
  const [
    goal,
    setGoal,
  ] = useState<number | null>(null)
  const [
    viewing,
    setViewing,
  ] = useState<PlacedChip | null>(null)
  // How far each image still uploading has got, by its placeholder's path.
  const [
    uploads,
    setUploads,
  ] = useState<Record<string, number>>({})
  const view = draftView({ text: draft })
  const display = view.display
  const paths = requestPaths({ display })
  const mirrored = view.chips.length > 0 || paths.length > 0
  const mentionList = `mentions-${card}`
  const input = useRef<HTMLTextAreaElement>(null), form = useRef<HTMLFormElement>(null)
  const mirror = useRef<HTMLDivElement>(null), files = useRef<HTMLInputElement>(null)
  // Where the selection goes once React has written the new display text.
  const caretNext = useRef<{
    anchor: number
    focus: number
  } | null>(null), caretLast = useRef(0)
  // The draft before each cut, keyed by what it showed, so an Undo that brings that text back restores its chips.
  const beforeCuts = useRef(new Map<string, string>())

  const query = mention?.query ?? ''
  const typed = query.trim()
  const folderPath = /^[~/]/.test(typed) ? typed : ''
  const folders = useFolders({
    path: folderPath,
    repository: '',
    connected: mention !== null,
  })
  const folderItems = folderSuggestions({
    query: typed.toLocaleLowerCase(),
    typed,
    attached: projects,
    otherProjects,
    listing: folders?.listing,
    typedPath: !!folderPath,
  })
  const selectedFolder = folderPath ? folders?.listing?.selected : undefined
  const typedFolder: MentionItem | undefined = selectedFolder && {
    key: `folder:${selectedFolder.path}`,
    kind: 'project',
    title: selectedFolder.name,
    detail: selectedFolder.path,
    insert: reference({
      kind: 'project',
      value: selectedFolder.path,
      label: selectedFolder.name,
    }),
    path: selectedFolder.path,
  }

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
      query: mention?.query ?? '',
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
  const picked = Math.min(
    mentionActive,
    matches.length - 1,
  )

  // A chip's own @ never starts a new mention.
  const trackMention = ({
    text,
    cursor,
  }: {
    text: string
    cursor: number
  }) => {
    const shown = draftView({ text })
    setPrefix(slashPrefix({
      text: shown.display,
      cursor,
      chips: shown.chips,
    }))
    const found = mentionQuery({
      text: shown.display,
      cursor,
    })
    const typed = mention && `@${mention.query}`
    const leftFolder = !found && typedFolder && typed
      && shown.display.slice(
        mention.start,
        mention.start + typed.length,
      ) === typed

    // Moving the caret off a typed path that names a folder adds that folder as a badge.
    if (leftFolder) {
      const edit = replaceDisplay({
        text,
        from: mention.start,
        to: mention.start + typed.length,
        insert: mentionText({
          item: typedFolder,
          before: shown.display.slice(
            0,
            mention.start,
          ),
        }),
      })
      const grown = draftView({ text: edit.text }).display.length - shown.display.length
      write({
        text: edit.text,
        caret: cursor > mention.start ? cursor + grown : cursor,
      })
      setMention(null)

      return
    }

    const insideChip = found && shown.chips.some(chip =>
      chip.from <= found.start && found.start < chip.to)
    setMention(insideChip ? null : found)
    setMentionActive(0)
  }

  const write = ({
    text,
    caret,
    anchor = caret,
  }: {
    text: string
    caret: number
    anchor?: number
  }) => {
    caretNext.current = {
      anchor,
      focus: caret,
    }
    setDraft({ text })
    // An insert finishing before the next render, like a second chosen file, builds on this text.
    current.current.draft = text
  }

  const fittedHeight = useRef<string | undefined>(undefined)

  // Holding the box height while measuring stops the browser from scrolling a pinned chat up.
  const fit = ({ element }: { element: HTMLTextAreaElement }) => {
    if (fittedHeight.current !== undefined && element.style.height !== fittedHeight.current) {
      return
    }

    const box = element.parentElement

    if (box) {
      box.style.minHeight = `${box.offsetHeight}px`
    }

    element.style.height = '0'
    element.style.height = `${element.scrollHeight}px`
    fittedHeight.current = element.style.height
    box?.style.removeProperty('min-height')
  }

  useLayoutEffect(
    () => {
      const element = input.current

      if (!element) {
        return
      }

      fit({ element })

      if (caretNext.current !== null) {
        select({
          field: element,
          ...caretNext.current,
        })
        caretLast.current = caretNext.current.focus
        caretNext.current = null
      }

      if (mirror.current) {
        mirror.current.scrollTop = element.scrollTop
      }
    },
    [display],
  )

  // A wider or narrower panel re-wraps the draft; only a width change refits, so the refit's own height change does not loop.
  useEffect(
    () => {
      const element = input.current

      if (!element) {
        return
      }

      let width = element.clientWidth
      const observer = new ResizeObserver(() => {
        if (element.clientWidth !== width) {
          width = element.clientWidth
          fit({ element })

          if (mirror.current) {
            mirror.current.scrollTop = element.scrollTop
          }
        }
      })
      observer.observe(element)

      return () => observer.disconnect()
    },
    [],
  )

  const chooseMention = ({ item }: { item: MentionItem }) => {
    const element = input.current

    if (!mention || !element) {
      return
    }

    const written = mentionText({
      item,
      before: display.slice(
        0,
        mention.start,
      ),
    })
    const edit = replaceDisplay({
      text: draft,
      from: mention.start,
      to: element.selectionStart,
      // A chip is followed by a space; a plain path already has the request's own.
      insert: written === item.insert ? `${written} ` : written,
    })
    const goalSlot = display.slice(
      0,
      mention.start,
    ).endsWith(REQUEST_HEAD) && draftView({ text: edit.text }).chips.find(chip => chip.kind === 'slot' && chip.from >= edit.caret)

    if (goalSlot) {
      write({
        text: edit.text,
        anchor: goalSlot.from,
        caret: goalSlot.to,
      })
      setGoal(-1)
    } else {
      write(edit)
    }

    setMention(null); element.focus()
  }

  const requestProject = ({ text }: { text: string }) => {
    const edit = withProjectRequest({ text })
    write(edit)
    input.current?.focus()
    trackMention({
      text: edit.text,
      cursor: edit.caret,
    })
  }

  const fillGoal = ({ text }: { text: string }) => {
    const slot = view.chips.find(chip => chip.kind === 'slot')

    if (slot) {
      write(replaceDisplay({
        text: draft,
        from: slot.from,
        to: slot.to,
        insert: text,
      }))
    }

    setGoal(null); input.current?.focus()
  }

  useEffect(
    () => {
      if (!projectRequest) {
        return
      }

      projectRequested?.()
      requestProject({ text: current.current.draft })
    },
    // Only a new request writes; the helpers read the latest draft.
    [projectRequest],
  )

  // A task looks like its card reference (card, then state, in its column's color); a column shows its icon.
  function taskLook({ id }: { id: string }) {
    const known = taskReferences[id]

    return {
      icons: [
        'task-card',
        taskStateIcon({ kind: known?.kind }),
      ],
      tone: `column-${known?.column ?? 'custom'}`,
    }
  }

  const chipLook = ({ chip }: { chip: PlacedChip }) => {
    if (chip.kind === 'task') {
      return taskLook({ id: chip.value })
    }

    const look = columnLook({
      column: columns.find(column => column.id === chip.value) ?? { id: chip.value as HydraColumn['id'] },
    })

    return {
      icons: [look.icon],
      tone: look.tone,
    }
  }

  // Chips let the pointer through to the textarea so a drag can start on one; a click on one still opens it.
  const chipAt = ({
    x,
    y,
  }: {
    x: number
    y: number
  }) => {
    const token = [...mirror.current?.querySelectorAll<HTMLElement>('.draft-token') ?? []]
      .find(element => [...element.querySelector('.draft-chip')?.getClientRects() ?? []]
        .some(rect => x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom))

    return token ? view.chips.find(chip => chip.from === Number(token.dataset.from)) : undefined
  }

  const openChip = ({ chip }: { chip: PlacedChip }) => {
    if (chip.kind === 'task') {
      openTask({ id: chip.value })
    } else if (chip.kind === 'image' && !isPendingImage({ path: chip.value })) {
      setViewing(chip)
    } else if (chip.kind === 'slot') {
      write({
        text: draft,
        anchor: chip.from,
        caret: chip.to,
      })
      setGoal(-1); input.current?.focus()
    } else if (chip.kind === 'project') {
      const edit = replaceDisplay({
        text: draft,
        from: chip.from,
        to: chip.to,
        insert: '@',
      })
      write(edit)
      input.current?.focus()
      trackMention({
        text: edit.text,
        cursor: edit.caret,
      })
    }
  }

  const hydraId = document.querySelector<HTMLMetaElement>('meta[name=pnyx-hydra]')?.content
  const attempt = useRef(readAttempt({
    key: card,
    hydraId,
  }))
  const outgoing = commentReply({
    draft,
    comments,
  })
  const sendable = comments.filter(comment => sendableComment({ comment }))
  const imagesLoading = hasPendingImage({ text: outgoing })
  const commented = sendable.length
  const [
    listing,
    setListing,
  ] = useState<string[] | null>(null)

  const showComment = ({ id }: { id: string }) => {
    setListing(null)
    requestAnimationFrame(() => {
      const host = form.current && conversationMessages({ from: form.current })
      const comment = comments.find(item => item.id === id)

      if (host && comment) {
        revealComment({
          host,
          comment,
        })
      }
    })
  }

  const current = useRef({
    draft,
    comments,
  })
  current.current = {
    draft,
    comments,
  }
  const { label } = useKeyboard()
  const catalogOpen = prefix !== null
  useEffect(
    () => onCatalogOpen({ open: catalogOpen }),
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

    const cursor = input.current?.selectionStart ?? display.length
    const query = slashPrefix({
      text: display,
      cursor,
      chips: view.chips,
    })

    if (query === null || query !== prefix) {
      setPrefix(null)

      return
    }

    if (item?.kind === 'command' && item.command === ADD_PROJECT_COMMAND) {
      setPrefix(null); setActive(0)
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
    setPrefix(null); setActive(0); input.current?.focus()
  }

  const insertBlock = ({ block }: { block: string }) => {
    const edit = placeBlock({
      text: current.current.draft,
      caret: input.current?.selectionEnd,
      block,
    })
    write(edit)
    input.current?.focus()

    return edit.text
  }

  // A placeholder lives only while this composer's upload runs, so a restored one goes and leaving stops them.
  const uploading = useRef(new AbortController())
  useEffect(
    () => {
      const controller = new AbortController()
      uploading.current = controller
      const restored = current.current.draft

      if (hasPendingImage({ text: restored })) {
        setDraft({ text: withoutPendingImages({ text: restored }) })
      }

      return () => controller.abort()
    },
    [],
  )

  const settle = ({
    path,
    line,
  }: {
    path: string
    line?: string
  }) => {
    if (uploading.current.signal.aborted) {
      return
    }

    const ends = input.current ? selectionEnds({ field: input.current }) : {
      anchor: caretLast.current,
      focus: caretLast.current,
    }
    const settled = settleImage({
      text: current.current.draft,
      ...ends,
      path,
      line,
    })

    // Written before the next keystroke or upload reads the draft and caret.
    if (settled) {
      flushSync(() => write({
        text: settled.text,
        caret: settled.focus,
        anchor: settled.anchor,
      }))
    }
  }

  const upload = async ({
    file,
    path,
  }: {
    file: File
    path: string
  }) => {
    const { signal } = uploading.current
    const track = ({ fraction }: { fraction: number }) => setUploads(progress => ({
      ...progress,
      [path]: fraction,
    }))

    track({ fraction: 0 })

    try {
      settle({
        path,
        line: await uploadImage({
          file,
          progress: track,
          signal,
        }),
      })
    } catch (error) {
      if (signal.aborted) {
        return
      }

      settle({ path })
      notify({ text: error instanceof Error ? error.message : 'Could not add the image.' })
    } finally {
      setUploads(progress => Object.fromEntries(Object.entries(progress)
        .filter(([key]) => key !== path)))
    }
  }

  // Each image takes its place at the caret at once, so typing goes on while it uploads.
  const attach = ({ files }: { files: File[] }) => {
    const {
      images,
      failures,
    } = checkImages({ files })

    if (failures.length) {
      notify({ text: failures.join(' ') })
    }

    if (!images.length) {
      return
    }

    const placed = images.map(file => ({
      file,
      path: pendingImage({ id: crypto.randomUUID() }),
    }))
    write(placeImages({
      text: current.current.draft,
      caret: input.current?.selectionEnd,
      lines: placed.map(({ path }) => imageLine({ path })),
    }))
    input.current?.focus()

    // Each upload settles its own placeholder and reports its own failure.
    for (const image of placed) {
      void upload(image)
    }
  }

  // A selection with chips carries their Markdown as plain text, so a paste rebuilds them; one without goes as it shows.
  const carryChips = ({
    field,
    data,
  }: {
    field: HTMLTextAreaElement
    data: DataTransfer
  }) => {
    const source = copyDraft({
      text: draft,
      from: field.selectionStart,
      to: field.selectionEnd,
    })

    if (source === undefined) {
      return false
    }

    data.setData(
      'text/plain',
      source,
    )

    const embedded = embedImages()
    const marked = shownDraft({
      text: source,
      image: embedded.image,
    })

    if (embedded.images.length) {
      data.setData(
        'text/html',
        imagesHtml({
          text: marked,
          images: embedded.images,
        }),
      )
    }

    return true
  }

  const removeCard = ({ chip }: { chip: PlacedChip }) => {
    write(removeChip({
      text: draft,
      chip,
    }))
    input.current?.focus()
  }

  const send = async ({ restore = false }: { restore?: boolean } = {}) => {
    const request = sendableRequest({
      text: restore && attempt.current ? attempt.current.text : outgoing,
    })
    const text = request.text

    if (sending || !text.trim()) {
      return
    }

    if (request.unpicked) {
      notify({ text: 'Pick a project or folder to add first.' })
      input.current?.focus()

      return
    }

    if (hasPendingImage({ text })) {
      notify({ text: 'Images are still loading. Send once they are in.' })

      return
    }

    if (attempt.current?.text !== text) {
      attempt.current = {
        text,
        id: crypto.randomUUID(),
        pending: true,
      }
    }

    attempt.current.pending = true
    saveAttempt({
      key: card,
      hydraId,
      attempt: attempt.current,
    })
    const taken = restore ? null : {
      draft,
      comments: sendable,
    }
    setFailure(null); setSending(true); setChecking(false)

    if (taken) {
      write({
        text: '',
        caret: 0,
      })
      setComments({ items: comments.filter(comment => !sendableComment({ comment })) })
      setMention(null); setPrefix(null); setActive(0)
    }

    let problem: string | null = null

    try {
      const r = await command({
        name: 'reply',
        args: [
          card,
          text,
          attempt.current.id,
        ],
        onChecking: () => setChecking(true),
      }); const receipt = r.reply as {
        state: string
        detail?: string
      } | undefined

      if (receipt?.state === 'delivered' || receipt?.state === 'queued') {
        attempt.current = null
      } else {
        problem = receipt?.state === 'delivery_unknown'
          ? 'Pnyx could not confirm it was delivered; check the conversation before sending again.'
          : receipt?.detail ?? 'It could not be delivered.'
      }
    } catch (e) {
      problem = (e as Error).message
    } finally {
      if (attempt.current) {
        attempt.current.pending = false
      }

      saveAttempt({
        key: card,
        hydraId,
        attempt: attempt.current,
      })
      setSending(false)
      setChecking(false)
    }

    if (problem) {
      setFailure({
        at: new Date().toISOString(),
        text: problem,
      })
      const later = current.current
      const back = taken?.draft ?? (later.draft.trim() ? '' : text)
      const restored = [
        back,
        later.draft,
      ].filter(part => part.trim()).join('\n\n')
      write({
        text: restored,
        caret: draftView({ text: restored }).display.length,
      })

      if (taken?.comments.length) {
        setComments({
          items: [
            ...taken.comments,
            ...later.comments.filter(comment =>
              !taken.comments.some(sent => sent.id === comment.id)),
          ],
        })
      }
    }
  }

  useEffect(
    () => {
      if (attempt.current?.pending) {
        void send({ restore: true })
      }
    },
    [],
  )

  useKeyAction({
    id: 'send',
    handler: ({
      context: {
        scope,
        target,
      },
    }) => {
      if (scope !== 'composer' || !input.current?.form?.contains(target)) {
        return false
      }

      void send()

      return true
    },
  })
  useKeyAction({
    id: 'cancel',
    handler: ({
      context: {
        scope,
        target,
      },
    }) => {
      if (scope !== 'composer' || !input.current?.form?.contains(target) || prefix === null && mention === null) {
        return false
      }

      setPrefix(null); setActive(0); setMention(null)

      return true
    },
  })

  return (
    <>
      {checking && <p className="save-checking muted small" role="status">Checking whether your message was saved. Retrying automatically.</p>}
      {failure && (
        <div className="send-error" role="alert">
          <Icon name="error" size={16} />
          <p>
            <strong>Not sent at {clock({ at: failure.at })}.</strong>
            {' '}Your message is back below. {failure.text.replace(
              /\s*Draft kept\.$/,
              '',
            )}
          </p>
          <Button className="icon-button" aria-label="Dismiss" onClick={() => setFailure(null)}>
            <Icon name="close" size={14} />
          </Button>
        </div>
      )}
      <form
        ref={form}
        aria-busy={sending}
        className="composer"
        onSubmit={e => {
          e.preventDefault(); void send()
        }}
        onDragOver={event => {
          if (event.dataTransfer.types.includes('Files')) {
            event.preventDefault()
          }
        }}
        onDrop={event => {
          if (event.dataTransfer.files.length) {
            event.preventDefault(); attach({ files: [...event.dataTransfer.files] })
          }
        }}
      >
        {commented > 0 && (
          <CommentsPill
            count={commented}
            open={() => setListing(sendable.map(c => c.id))}
            remove={() => setComments({ items: [] })}
          />
        )}
        {listing && (
          <CommentsDialog
            comments={comments}
            shown={listing}
            setComments={setComments}
            show={showComment}
            close={() => setListing(null)}
          />
        )}
        <div className="composer-input" data-chips={mirrored || undefined}>
          {mention && (
            <MentionPicker
              anchor={input}
              id={mentionList}
              query={query}
              matches={matches}
              active={picked}
              choose={chooseMention}
            />
          )}
          {goal !== null && !mention && (
            <SuggestionPicker
              id={`goals-${card}`}
              anchor={input}
              label="What you want done (optional)"
              active={goal}
              matches={GOALS.map(text => ({
                key: text,
                title: text,
                detail: '',
                group: 'What you want done (optional)',
              }))}
              choose={({ item }) => fillGoal({ text: item.title })}
            />
          )}
          {prefix !== null && (
            <SuggestionPicker
              id={`suggestions-${card}`}
              query={prefix}
              anchor={input}
              label="Skills and commands"
              className="slash-menu"
              active={Math.min(
                active,
                suggestions.length - 1,
              )}
              matches={suggestions.map(item => ({
                ...item,
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

              }))}
              choose={({ item }) => choose({
                command: skillReference({ item }),
                item,
              })}
              loading={!catalog}
              empty={catalog?.unavailable ?? 'No matching skill or command.'}
              footer={(
                <>
                  {catalog?.unavailable && catalog.suggestions.length > 0 && <p role="status">{catalog.unavailable}</p>}
                  {catalog?.note && <p>{catalog.note}</p>}
                </>
              )}

            />
          )}
          <Textarea
            ref={input}
            rows={1}
            data-key-scope="composer"
            id={`reply-${card}`}
            value={display}
            placeholder={title === 'Hydra' ? 'Message Hydra…' : 'Reply, or / for commands…'}
            aria-label={`Reply to ${title}`}
            aria-controls={mention ? mentionList : catalogOpen ? `suggestions-${card}` : undefined}
            aria-activedescendant={mention && matches.length ? `${mentionList}-${picked}`
              : active >= 0 && suggestions[active] ? `suggestions-${card}-${Math.min(
                active,
                suggestions.length - 1,
              )}` : undefined}
            onScroll={event => {
              if (mirror.current) {
                mirror.current.scrollTop = event.currentTarget.scrollTop
              }
            }}
            onSelect={event => {
              const element = event.currentTarget
              const {
                anchor,
                focus,
              } = selectionEnds({ field: element })
              const snapped = snapSelection({
                view,
                anchor,
                focus,
                previous: caretLast.current,
              })

              if (snapped.anchor !== anchor || snapped.focus !== focus) {
                select({
                  field: element,
                  ...snapped,
                })
              }

              caretLast.current = snapped.focus
            }}
            onClick={event => {
              const element = event.currentTarget
              const clicked = element.selectionStart === element.selectionEnd ? chipAt({
                x: event.clientX,
                y: event.clientY,
              }) : undefined

              if (clicked) {
                openChip({ chip: clicked })
              }

              trackMention({
                text: draft,
                cursor: element.selectionStart,
              })
            }}
            onBlur={() => setMention(null)}
            onCopy={event => {
              if (carryChips({
                field: event.currentTarget,
                data: event.clipboardData,
              })) {
                event.preventDefault()
              }
            }}
            onCut={event => {
              if (carryChips({
                field: event.currentTarget,
                data: event.clipboardData,
              })) {
                event.preventDefault()
                beforeCuts.current.set(
                  display,
                  draft,
                )

                // Only the browser's own edit lands on Undo; inside a script's execCommand it can't run, so write directly.
                if (!document.execCommand('delete')) {
                  write(replaceDisplay({
                    text: draft,
                    from: event.currentTarget.selectionStart,
                    to: event.currentTarget.selectionEnd,
                    insert: '',
                  }))
                }
              }
            }}
            // A dragged chip carries its Markdown too, so it lands as a chip, not its label.
            onDragStart={event => carryChips({
              field: event.currentTarget,
              data: event.dataTransfer,
            })}
            onPaste={event => {
              const files = pastedImages({ clipboardData: event.clipboardData })

              if (files.length) {
                event.preventDefault(); attach({ files })
              }
            }}
            onChange={e => {
              const undoneCut = e.nativeEvent instanceof InputEvent && e.nativeEvent.inputType === 'historyUndo'
                ? beforeCuts.current.get(e.target.value) : undefined
              const edit = undoneCut === undefined ? editDraft({
                text: draft,
                next: e.target.value,
                caret: e.target.selectionStart,
              }) : {
                text: undoneCut,
                caret: e.target.selectionEnd,
                anchor: e.target.selectionStart,
              }

              write(edit)
              setGoal(null)
              setActive(0)
              trackMention({
                text: edit.text,
                cursor: edit.caret,
              })
            }}
            onKeyDown={e => {
              if (e.nativeEvent.isComposing || e.key === 'Process') {
                return
              }

              if (goal !== null && !e.metaKey && !e.ctrlKey && !e.altKey) {
                const chosen = goal >= 0 ? GOALS[goal] : undefined

                if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                  e.preventDefault()
                  setGoal(Math.max(
                    -1,
                    Math.min(
                      GOALS.length - 1,
                      goal + (e.key === 'ArrowDown' ? 1 : -1),
                    ),
                  ))

                  return
                }

                if ((e.key === 'Tab' && !e.shiftKey) || (e.key === 'Enter' && chosen)) {
                  e.preventDefault()
                  fillGoal({ text: chosen ?? GOALS[0] })

                  return
                }

                if (e.key === 'Escape') {
                  e.preventDefault(); setGoal(null)

                  return
                }
              }

              // A typed path completes like a shell: Tab extends it as text, and Tab on a complete path adds it.
              // An item the owner moved to with the arrows is picked as usual.
              const fromTop = picked <= 0
              const listing = mention && folderPath && fromTop ? folders?.listing : undefined
              const completed = listing && completePath({
                typed: folderPath,
                listing,
              })

              if (e.key === 'Tab' && mention && (completed || (typedFolder && fromTop))
                && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
                e.preventDefault()
                e.stopPropagation()

                if (typedFolder) {
                  chooseMention({ item: typedFolder })
                } else if (completed) {
                  const edit = replaceDisplay({
                    text: draft,
                    from: mention.start + 1,
                    to: e.currentTarget.selectionStart,
                    insert: completed,
                  })
                  write(edit)
                  trackMention({
                    text: edit.text,
                    cursor: edit.caret,
                  })
                }

                return
              }

              const pickerCount = mention ? matches.length : suggestions.length

              const dismissEmptyPicker = pickerCount === 0
                && (e.key === 'Tab' || mention !== null || catalog !== null)

              if ((mention || catalogOpen) && dismissEmptyPicker
                && (e.key === 'Enter' || e.key === 'Tab') && !e.metaKey && !e.ctrlKey && !e.altKey) {
                setMention(null)
                setPrefix(null)

                return
              }

              if ((mention || catalogOpen) && [
                'ArrowDown',
                'ArrowUp',
                'Enter',
                'Tab',
                'Escape',
              ].includes(e.key)
                && !e.metaKey && !e.ctrlKey && !e.altKey && !(e.key === 'Tab' && e.shiftKey)) {
                e.preventDefault()
                e.stopPropagation()
                const count = mention ? matches.length : suggestions.length
                const index = mention ? picked : Math.min(
                  active,
                  count - 1,
                )

                if (e.key === 'Escape') {
                  setMention(null)
                  setPrefix(null)
                } else if (e.key === 'Enter' || e.key === 'Tab') {
                  if (mention && matches[index]) {
                    chooseMention({ item: matches[index] })
                  } else if (!mention && suggestions[index]) {
                    choose({
                      command: skillReference({ item: suggestions[index] }),
                      item: suggestions[index],
                    })
                  }
                } else {
                  const next = Math.max(
                    0,
                    Math.min(
                      count - 1,
                      index + (e.key === 'ArrowDown' ? 1 : -1),
                    ),
                  )

                  if (mention) {
                    setMentionActive(next)
                  } else {
                    setActive(next)
                  }
                }

                return
              }

              if ([
                'ArrowLeft',
                'ArrowRight',
                'Home',
                'End',
              ].includes(e.key)) {
                requestAnimationFrame(() => {
                  if (input.current) {
                    trackMention({
                      text: current.current.draft,
                      cursor: input.current.selectionStart,
                    })
                  }
                })
              }

              if (e.key === 'Tab') {
                setMention(null)
                setPrefix(null); setActive(0)
              }

              if (e.key === 'ArrowUp' && !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey
                && prefix === null && mention === null && e.currentTarget.selectionEnd === 0
                && focusAbove?.()) {
                e.preventDefault(); e.stopPropagation()

                return
              }

              const host = conversationMessages({ from: e.currentTarget })

              if (e.key === 'ArrowUp' && !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey && prefix === null && mention === null &&
                e.currentTarget.selectionEnd === 0 && host && placeMessageCaret({
                host,
                target: latestAgentMessage({ host }),
                edge: 'end',
              })) {
                e.preventDefault()
              }
            }}
          />
          {mirrored && (
            <div className="draft-mirror" ref={mirror} aria-hidden="true">
              {view.chips.map((
                chip,
                index,
              ) => {
                const look = chip.kind === 'task' || chip.kind === 'column' ? chipLook({ chip }) : undefined
                const title = chip.kind === 'project' ? chip.value : chip.kind === 'task' ? 'Open task' : undefined
                const before = markedPaths({
                  display,
                  from: view.chips[index - 1]?.to ?? 0,
                  to: chip.from,
                  paths,
                })

                const skill = chip.kind === 'skill' ? readSkillReference({
                  value: chip.value,
                }) : undefined

                let token: ReactNode

                if (skill) {
                  token = (
                    <SkillBadge
                      skill={skill}
                      colors={labelColors}
                      remove={() => removeCard({ chip })}
                    />
                  )
                } else if (cardChip({ chip })) {
                  token = (
                    <DraftCard
                      chip={chip}
                      progress={uploads[chip.value]}
                      open={() => openChip({ chip })}
                      remove={() => removeCard({ chip })}
                    />
                  )
                } else {
                  token = (
                    <ReferenceBadge
                      icons={look?.icons ?? []}
                      className={look?.tone ?? ''}
                      data-kind={chip.kind}
                      title={title}
                      onClick={() => openChip({ chip })}
                    >
                      {look ? chip.name : chip.label}
                    </ReferenceBadge>
                  )
                }

                return (
                  <Fragment key={chip.start}>
                    {before}
                    <span className="draft-token" data-from={chip.from} data-to={chip.to}>
                      {CHIP_SPACE}{token}{CHIP_SPACE}
                    </span>
                  </Fragment>
                )
              })}
              {markedPaths({
                display,
                from: view.chips.at(-1)?.to ?? 0,
                to: display.length,
                paths,
              })}
              {/* A trailing newline still gets a line box, as it does in the textarea. */}
              {'\u200B'}
            </div>
          )}
        </div>
        <div className="composer-bar">
          <Popover label="Add to message" className="composer-add" trigger={<Icon name="attach" size={COMPOSER_ICON} />}>
            {({ close }) => (
              <>
                <Button
                  onClick={() => {
                    close(); files.current?.click()
                  }}
                >
                  <Icon name="paperclip" size={MENU_ICON} />Insert files or images
                </Button>
                <Button
                  onClick={() => {
                    close()
                    const element = input.current

                    if (element) {
                      element.focus()

                      const cursor = element.selectionStart
                      const boundary = cursor > 0 && !/\s/.test(display[cursor - 1]!) ? ' ' : ''
                      const edit = replaceDisplay({
                        text: draft,
                        from: cursor,
                        to: element.selectionEnd,
                        insert: `${boundary}@`,
                      })
                      write(edit)
                      setMention({
                        start: edit.caret - 1,
                        query: '',
                      }); setMentionActive(0); setPrefix(null)
                    }
                  }}
                >
                  <Icon name="mention" size={MENU_ICON} />Mention
                </Button>
              </>
            )}
          </Popover>
          <Input
            ref={files}
            type="file"
            multiple
            hidden
            aria-label="Insert files or images"
            onChange={event => {
              const chosen = [...(event.target.files ?? [])]
              const images = chosen.filter(file => file.type.startsWith('image/'))
              const selected = chosen.filter(file => !images.includes(file))
              event.target.value = ''

              if (images.length) {
                attach({ files: images })
              }

              if (!selected.length) {
                return
              }

              void (async () => {
                try {
                  const contents = await Promise.all(selected.map(async file => {
                    if (file.size > MAX_MESSAGE_BYTES) {
                      throw new Error(`${file.name} exceeds the 64 KiB message limit.`)
                    }

                    const bytes = await file.arrayBuffer()
                    const text = new TextDecoder(
                      'utf-8',
                      { fatal: true },
                    ).decode(bytes)

                    if (text.includes('\0')) {
                      throw new Error(`${file.name} is not a UTF-8 text file.`)
                    }

                    return fileBlock({
                      name: file.name,
                      text,
                    })
                  }))
                  const before = current.current.draft
                  const next = insertBlock({ block: contents.join('\n\n') })
                  const text = commentReply({
                    draft: next,
                    comments: current.current.comments,
                  })
                  const id = crypto.randomUUID()
                  const name = 'hydra'
                  const args = [
                    'send',
                    `--text=${text}`,
                    '--event-id',
                    id,
                  ]

                  if (commandBytes({
                    name,
                    args,
                  }) > MAX_MESSAGE_BYTES) {
                    write({
                      text: before,
                      caret: draftView({ text: before }).display.length,
                    })
                    throw new Error('Files and draft exceed the 64 KiB message limit. Draft kept.')
                  }
                } catch (error) {
                  notify({ text: error instanceof Error ? error.message : 'Could not read the selected files.' })
                }
              })()
            }}
          />
          {settings}
          {meter}
          {stop && (
            <Button
              className="composer-stop"
              aria-label={compacting ? 'Cancel compaction' : 'Stop Hydra'}
              title={compacting ? 'Cancel compaction' : 'Stop Hydra’s turn; workers keep going'}
              onClick={() => void stop()}
            >
              <Icon name="stop" size={12} />
            </Button>
          )}
          <Button
            type="submit"
            variant="primary"
            className="composer-send"
            aria-label="Send reply"
            title={sending ? 'Sending…' : `Send · ${label({ id: 'send' })}${thread?.route ? ` · through ${thread.via ?? 'the recorded route'}` : ''}`}
            disabled={sending || !outgoing.trim() || imagesLoading}
          >
            <Icon name="send" size={COMPOSER_ICON} />
          </Button>
        </div>
      </form>
      {viewing && (
        <ImageViewer
          path={viewing.value}
          label={viewing.name}
          close={() => setViewing(null)}
        />
      )}
    </>
  )
}
