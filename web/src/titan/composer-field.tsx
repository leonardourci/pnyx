import { CHIP_CHARACTER,mentionQuery,reference } from '#titan/mentions.ts'
import { skillReference } from '#titan/transcripts-skill-reference.ts'
import { ImageViewer } from './attached-image.tsx'
import { embedImages,imagesHtml } from './clipboard.ts'
import { copyDraft,draftView,isPendingImage,placeBlock,removeChip,replaceDisplay,shownDraft,type PlacedChip } from './draft.ts'
import { pastedImages } from './image-upload.ts'
import { MentionPicker,type MentionItem } from './mention-picker.tsx'
import { completePath,splitPath,typedListing } from './path-completion.ts'
import { GOALS,mentionText,projectRequestActions,REQUEST_HEAD,requestPaths } from './project-request.ts'
import { slashState,type SlashState } from './view.ts'
import { useFolders } from '#web-projects/folders.ts'
import type { FolderListing } from '#projects/folders.ts'
import { SuggestionPicker } from '#web-shared/ui/suggestion-picker.tsx'
import { useStableActions } from '#web-shared/stable.ts'
import { columnLook } from '#web-tasks/view.ts'
import { filterRows,prepareRow } from '#titan/suggestion-matches.ts'
import { useDeferredValue,useEffect,useLayoutEffect,useImperativeHandle,useMemo,useRef,useState,type KeyboardEvent,type Ref } from 'react'
import { createPortal } from 'react-dom'
import { ComposerChip } from './composer-chip.tsx'
import { paintField,readField,restoreSelection,select,selectionEnds,selectionRange } from './composer-editable.ts'
import { emptyHistory,record,step,type Snapshot } from './composer-history.ts'
import { useComposerSources } from './composer-sources.tsx'
import { useComposerUploads } from './composer-uploads.ts'
import { attachmentRows,folderRows,mentionMatches,taskLook } from './mention-candidates.ts'
import { CLONE_URL,folderSuggestions } from './mention-folders.ts'
import { useSlashMenu } from './slash-menu.tsx'

const SCRIPT_EDIT = 'script'

const GOAL_ROWS = filterRows({
  rows: GOALS.map(text => prepareRow({
    item: {
      key: text,
      title: text,
      detail: '',
      group: 'What you want done (optional)',
    },
  })),
  query: '',
})

export interface ComposerFieldHandle {
  input: HTMLDivElement | null
  read(): string
  write({
    text,
    caret,
  }: {
    text: string
    caret: number
  }): void
  attach({ files }: { files: File[] }): void
  insertBlock({ block }: { block: string }): string
  mention(): void
  closePickers(): void
}

const sameChip = ({
  before,
  after,
}: {
  before: PlacedChip
  after?: PlacedChip
}) => !!after && before.kind === after.kind && before.value === after.value
  && before.name === after.name
  && before.attached === after.attached

function chipHosts({
  view,
  text,
  hostsByKey,
}: {
  view: ReturnType<typeof draftView>
  text: string
  hostsByKey: Map<string, HTMLElement>
}) {
  const occurrences = new Map<string, number>()

  return view.chips.map(chip => {
    const identity = JSON.stringify([
      chip.kind,
      chip.attached,
      chip.value,
    ])
    const occurrence = occurrences.get(identity) ?? 0
    occurrences.set(
      identity,
      occurrence + 1,
    )
    const key = JSON.stringify([
      identity,
      occurrence,
    ])
    let host = hostsByKey.get(key)

    if (!host) {
      host = document.createElement('span')
      host.contentEditable = 'false'
      hostsByKey.set(
        key,
        host,
      )
    }

    host.dataset.source = text.slice(
      chip.start,
      chip.end,
    )

    return {
      chip,
      key,
      host,
    }
  })
}

// An owner-typed field with the Titan composer's chips, mentions, skills and images.
export function ComposerField({
  value,
  change,
  label,
  id,
  placeholder,
  className = '',
  standalone = true,
  limitHeight = false,
  onKeyDown,
  onBlur,
  projectRequests = false,
  projectRequest = false,
  projectRequested,
  ref,
}: {
  value: string
  change({ text }: { text: string }): void
  label: string
  id?: string
  placeholder?: string
  className?: string
  // A field on its own is a compact box; the Titan composer draws its own box, menu and controls around it.
  standalone?: boolean
  limitHeight?: boolean
  // Runs after the pickers had their turn with the key.
  onKeyDown?({ event }: { event: KeyboardEvent<HTMLDivElement> }): void
  onBlur?(): void
  // The Titan composer's own: /add-project writes an Add project request into the draft.
  projectRequests?: boolean
  // An Add project request to write into the draft; projectRequested clears it once written.
  projectRequest?: boolean
  projectRequested?(): void
  ref?: Ref<ComposerFieldHandle>
}) {
  const {
    projects,
    mentionRows,
    fileRows,
    slashRows,
    taskReferences,
    openTask,
    catalog,
    catalogOpen: onCatalogOpen,
    mentionOpen,
    labelColors,
    notify,
    otherProjects,
  } = useComposerSources()
  const [
    slash,
    setSlash,
  ] = useState<SlashState>({
    prefix: null,
    dismissed: null,
  })
  const prefix = slash.prefix
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
  const current = useRef(value)
  const [
    , redraw,
  ] = useState(0)
  let draft = current.current
  let view = draftView({ text: draft })
  let display = view.display
  let paths = requestPaths({ display })
  const [fieldKey] = useState(() => id ?? crypto.randomUUID())
  const mentionList = `mentions-${fieldKey}`
  const suggestionList = `suggestions-${fieldKey}`
  const input = useRef<HTMLDivElement>(null)
  const hostsByKey = useRef(new Map<string, HTMLElement>())
  let hosts = chipHosts({
    view,
    text: draft,
    hostsByKey: hostsByKey.current,
  })
  const pendingSelection = useRef<{
    anchor: number
    focus: number
  } | null>(null)
  const history = useRef(emptyHistory())
  const browserEdit = useRef<{
    kind: string
    before: Snapshot
  } | null>(null)
  const composingText = useRef(false)
  const focusingByPointer = useRef(false)
  // An upload settles after later renders, so it writes through the newest change, never a stale one.
  const latestChange = useRef(change)
  latestChange.current = change

  const query = mention?.query ?? ''
  const typed = query.trim()
  const folderPath = /^[~/]/.test(typed) ? typed : ''
  const typedPath = !!folderPath
  const mentioning = mention !== null
  const {
    directory,
    name: typedName,
  } = splitPath({ path: folderPath })
  const folders = useFolders({
    path: directory,
    repository: '',
    connected: mentioning,
    files: typedPath,
  })
  const listingWhileNextLoads = useRef<{
    listing?: FolderListing
    name: string
  }>({ name: '' })

  if (folders) {
    listingWhileNextLoads.current = {
      listing: folders.listing,
      name: typedName,
    }
  }

  const {
    listing: shownListing,
    name: shownName,
  } = listingWhileNextLoads.current
  const listingOfTypedFolder = folders?.listing
  const pathListing = useMemo(
    () => shownListing && typedPath ? typedListing({
      listing: shownListing,
      name: shownName,
    }) : shownListing,
    [
      shownListing,
      typedPath,
      shownName,
    ],
  )
  const cloneUrl = CLONE_URL.test(typed) ? typed : ''
  const folderList = useMemo(
    () => folderRows({
      folders: folderSuggestions({
        typed: cloneUrl,
        attached: projects,
        otherProjects,
        listing: pathListing,
        typedPath,
      }),
    }),
    [
      cloneUrl,
      projects,
      otherProjects,
      pathListing,
      typedPath,
    ],
  )
  const selectedFolder = typedPath && listingOfTypedFolder ? pathListing?.selected : undefined
  const typedFolder = useMemo(
    (): MentionItem | undefined => selectedFolder && {
      key: `folder:${selectedFolder.path}`,
      kind: 'project',
      title: selectedFolder.name,
      detail: selectedFolder.path,
      icons: ['project'],
      insert: reference({
        kind: 'project',
        value: selectedFolder.path,
        label: selectedFolder.name,
      }),
      path: selectedFolder.path,
    },
    [selectedFolder],
  )

  const chipsKey = JSON.stringify(view.chips.map(chip => [
    chip.kind,
    chip.value,
    chip.name,
    chip.attached,
  ]))
  const attached = useMemo(
    () => attachmentRows({ chips: view.chips }),
    [chipsKey],
  )
  const rows = useMemo(
    () => [
      ...attached,
      ...mentionRows,
    ],
    [
      attached,
      mentionRows,
    ],
  )
  const shownQuery = useDeferredValue(query)
  const searchesByName = !typedPath && !cloneUrl
  const matched = useMemo(
    () => mentionMatches({
      query: shownQuery,
      rows,
      files: searchesByName ? fileRows : [],
      folders: folderList,
      filterFolders: searchesByName,
      typedFolder,
    }),
    [
      shownQuery,
      rows,
      searchesByName,
      fileRows,
      folderList,
      typedFolder,
    ],
  )
  const matches = mention ? matched : []
  useEffect(
    () => {
      if (!mentioning) {
        return
      }

      mentionOpen({ open: true })

      return () => mentionOpen({ open: false })
    },
    [
      mentioning,
      mentionOpen,
    ],
  )
  const picked = Math.min(
    mentionActive,
    matches.length - 1,
  )

  const dismissSlash = () => {
    const cursor = input.current ? selectionEnds({ field: input.current }).focus : display.length
    const dismissed = prefix === null ? slash.dismissed : cursor - prefix.length
    setSlash({
      prefix: null,
      dismissed,
    })
  }

  const trackMention = ({
    text,
    cursor,
  }: {
    text: string
    cursor: number
  }) => {
    const shown = draftView({ text })
    const nextSlash = slashState({
      text: shown.display,
      cursor,
      dismissed: slash.dismissed,
    })

    if (nextSlash.prefix !== slash.prefix || nextSlash.dismissed !== slash.dismissed) {
      setSlash(nextSlash)
    }

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

    if (found?.start !== mention?.start || found?.query !== mention?.query) {
      setMention(found)
    }

    if (mentionActive !== 0) {
      setMentionActive(0)
    }
  }

  const snapshotNow = (): Snapshot => {
    const field = input.current
    const ends = field ? selectionEnds({ field }) : {
      anchor: 0,
      focus: 0,
    }

    return {
      text: current.current,
      ...ends,
    }
  }

  const writeWithoutUndoStep = ({
    text,
    caret,
    anchor = caret,
  }: {
    text: string
    caret: number
    anchor?: number
  }) => {
    const next = draftView({ text })
    const chipsChanged = view.chips.length !== next.chips.length
      || view.chips.some((
        chip,
        index,
      ) => !sameChip({
        before: chip,
        after: next.chips[index],
      }))
    current.current = text
    draft = text
    view = next
    display = next.display
    paths = requestPaths({ display })
    hosts = chipHosts({
      view,
      text,
      hostsByKey: hostsByKey.current,
    })
    pendingSelection.current = {
      anchor,
      focus: caret,
    }

    if (chipsChanged) {
      redraw(version => version + 1)
    } else {
      paint()
      syncCaret()
    }

    latestChange.current({ text })
  }

  const recordStep = ({
    text,
    kind,
    before,
  }: {
    text: string
    kind: string
    before: Snapshot
  }) => {
    if (text === current.current) {
      return
    }

    record({
      history: history.current,
      before,
      kind,
      at: Date.now(),
    })
  }

  const write = ({
    text,
    caret,
    anchor,
  }: {
    text: string
    caret: number
    anchor?: number
  }) => {
    recordStep({
      text,
      kind: SCRIPT_EDIT,
      before: snapshotNow(),
    })
    writeWithoutUndoStep({
      text,
      caret,
      anchor,
    })
  }

  useLayoutEffect(
    () => {
      if (value !== current.current) {
        write({
          text: value,
          caret: Math.min(
            input.current ? selectionEnds({ field: input.current }).focus : 0,
            draftView({ text: value }).display.length,
          ),
        })
      }
    },
    [value],
  )

  const paint = () => {
    const keys = new Set(hosts.map(({ key }) => key))

    for (const key of hostsByKey.current.keys()) {
      if (!keys.has(key)) {
        hostsByKey.current.delete(key)
      }
    }

    if (input.current && !composingText.current) {
      paintField({
        field: input.current,
        display,
        chips: hosts,
        paths,
      })
    }
  }

  const syncCaret = () => {
    if (input.current && pendingSelection.current !== null && !composingText.current) {
      select({
        field: input.current,
        ...pendingSelection.current,
      })
      pendingSelection.current = null
    }
  }

  useLayoutEffect(() => {
    paint()
    syncCaret()
  })

  useEffect(
    () => {
      const rememberSelection = () => {
        if (input.current?.contains(getSelection()?.anchorNode ?? null)) {
          selectionEnds({ field: input.current })
        }
      }

      document.addEventListener(
        'selectionchange',
        rememberSelection,
      )

      return () => document.removeEventListener(
        'selectionchange',
        rememberSelection,
      )
    },
    [],
  )

  const updatePickers = ({
    text,
    cursor,
  }: {
    text: string
    cursor: number
  }) => {
    if (goal !== null) {
      setGoal(null)
    }

    if (active !== 0) {
      setActive(0)
    }

    trackMention({
      text,
      cursor,
    })
  }

  const readInput = () => {
    const element = input.current

    if (!element) {
      return
    }

    const edit = readField({ field: element })
    const announced = browserEdit.current
    browserEdit.current = null
    recordStep({
      text: edit.text,
      kind: announced?.kind ?? SCRIPT_EDIT,
      before: announced?.before ?? snapshotNow(),
    })
    writeWithoutUndoStep({
      text: edit.text,
      caret: edit.focus,
      anchor: edit.anchor,
    })
    updatePickers({
      text: edit.text,
      cursor: edit.focus,
    })
  }

  const deleteChipBeside = ({ forward }: { forward: boolean }) => {
    const element = input.current

    if (!element) {
      return false
    }

    const {
      start,
      end,
    } = selectionRange({ field: element })

    if (start !== end) {
      return false
    }

    const text = current.current
    const at = forward ? start : start - 1
    const chip = draftView({ text }).chips.find(placed => placed.from === at)

    if (!chip) {
      return false
    }

    write(removeChip({
      text,
      chip,
    }))

    return true
  }

  const stepHistory = ({ back }: { back: boolean }) => {
    const target = step({
      history: history.current,
      present: snapshotNow(),
      back,
    })

    if (!target) {
      return
    }

    writeWithoutUndoStep({
      text: target.text,
      caret: target.focus,
      anchor: target.anchor,
    })
    updatePickers({
      text: target.text,
      cursor: target.focus,
    })
  }

  const editActions = useStableActions({
    actions: {
      deleteChipBeside,
      stepHistory,
    },
  })
  useEffect(
    () => {
      const field = input.current

      if (!field) {
        return
      }

      const beforeInput = (event: InputEvent) => {
        const forward = event.inputType === 'deleteContentForward'
        const deletes = forward || event.inputType === 'deleteContentBackward'

        if (deletes && editActions.deleteChipBeside({ forward })) {
          event.preventDefault()

          return
        }

        if (event.inputType === 'historyUndo' || event.inputType === 'historyRedo') {
          event.preventDefault()
          editActions.stepHistory({ back: event.inputType === 'historyUndo' })

          return
        }

        browserEdit.current = {
          kind: event.inputType,
          before: snapshotNow(),
        }
      }

      field.addEventListener(
        'beforeinput',
        beforeInput,
      )

      return () => field.removeEventListener(
        'beforeinput',
        beforeInput,
      )
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
      to: selectionEnds({ field: element }).focus,
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

  const {
    requestProject,
    fillGoal,
  } = projectRequestActions({
    input,
    read: () => current.current,
    write,
    trackMention,
    setGoal,
  })

  useEffect(
    () => {
      if (!projectRequest) {
        return
      }

      projectRequested?.()
      requestProject({ text: current.current })
    },
    // Only a new request writes; the helpers read the latest draft.
    [projectRequest],
  )

  const chipLook = ({ chip }: { chip: PlacedChip }) => {
    if (chip.kind === 'task') {
      return taskLook({ reference: taskReferences[chip.value] })
    }

    if (chip.kind !== 'column') {
      return undefined
    }

    const look = columnLook()

    return {
      icons: [look.icon],
      tone: look.tone,
    }
  }

  const currentChip = ({ key }: { key: string }) => hosts.find(placed => placed.key === key)?.chip

  const openChip = ({ key }: { key: string }) => {
    const chip = currentChip({ key })

    if (!chip) {
      return
    }

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

  const shownPrefix = useDeferredValue(prefix ?? '')
  const {
    matches: suggestions,
    catalogOpen,
    choose,
  } = useSlashMenu({
    catalog,
    rows: slashRows,
    prefix,
    shownPrefix,
    onCatalogOpen,
    input,
    read: () => current.current,
    projectRequests,
    dismissSlash,
    setActive,
    requestProject,
    write,
  })

  const insertBlock = ({ block }: { block: string }) => {
    const edit = placeBlock({
      text: current.current,
      caret: input.current ? selectionRange({ field: input.current }).end : undefined,
      block,
    })
    write(edit)
    input.current?.focus()

    return edit.text
  }

  const {
    attach,
    settleAfterComposition,
  } = useComposerUploads({
    current,
    input,
    composingText,
    latestChange,
    history,
    snapshotNow,
    write,
    writeWithoutUndoStep,
    notify,
    setUploads,
  })

  // A selection with chips carries their Markdown as plain text, so a paste rebuilds them; one without goes as it shows.
  const carryChips = ({
    field,
    data,
  }: {
    field: HTMLDivElement
    data: DataTransfer
  }) => {
    const {
      start,
      end,
    } = selectionRange({ field })
    const source = copyDraft({
      text: draft,
      from: start,
      to: end,
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

  const removeCard = ({ key }: { key: string }) => {
    const chip = currentChip({ key })

    if (!chip) {
      return
    }

    write(removeChip({
      text: draft,
      chip,
    }))
    input.current?.focus()
  }

  const closePickers = () => {
    setMention(null); dismissSlash(); setActive(0)
  }

  const startMention = () => {
    const element = input.current

    if (!element) {
      return
    }

    element.focus()
    const {
      start: cursor,
      end,
    } = selectionRange({ field: element })
    const previous = display.charAt(cursor - 1)
    const separated = previous === '' || /\s/.test(previous) || previous === CHIP_CHARACTER
    const boundary = separated ? '' : ' '
    const edit = replaceDisplay({
      text: draft,
      from: cursor,
      to: end,
      insert: `${boundary}@`,
    })
    write(edit)
    setMention({
      start: edit.caret - 1,
      query: '',
    }); setMentionActive(0); dismissSlash()
  }

  useImperativeHandle(
    ref,
    () => ({
      get input() {
        return input.current
      },
      read: () => current.current,
      write,
      attach,
      insertBlock,
      mention: startMention,
      closePickers,
    }),
  )

  return (
    <div
      className={`composer-field group/composer-field [&.comment-note]:flex-1 ${standalone ? 'composer-compact relative min-w-0 rounded-md border border-control bg-surface focus-within:border-gold-line' : 'contents'} ${className}`}
      data-standalone={standalone}
      // Focus moving to the field's own chips stays inside it; only leaving the whole field counts as a blur.
      onBlur={event => {
        if (!event.currentTarget.contains(event.relatedTarget)) {
          onBlur?.()
        }
      }}
      onDragOver={event => {
        if (event.dataTransfer.types.includes('Files')) {
          event.preventDefault()
        }
      }}
      onDrop={event => {
        // A drop on the image viewer, portaled from this field, is not a drop on the field.
        if (event.dataTransfer.files.length && event.currentTarget.contains(event.target as Node)) {
          event.preventDefault(); event.stopPropagation()
          attach({ files: [...event.dataTransfer.files] })
        }
      }}
    >
      <div className="composer-input group/composer-input relative flex min-h-(--spacing-composer-line) flex-[0_1_auto] flex-col overflow-hidden group-data-[standalone=true]/composer-field:min-h-0">
        {mention && (
          <MentionPicker
            anchor={input}
            id={mentionList}
            matches={matches}
            active={picked}
            choose={chooseMention}
          />
        )}
        {goal !== null && !mention && (
          <SuggestionPicker
            id={`goals-${fieldKey}`}
            anchor={input}
            label="What you want done (optional)"
            active={goal}
            matches={GOAL_ROWS}
            choose={({ item }) => fillGoal({ text: item.title })}
          />
        )}
        {prefix !== null && (
          <SuggestionPicker
            id={suggestionList}
            anchor={input}
            label="Skills and commands"
            className="slash-menu"
            active={Math.min(
              active,
              suggestions.length - 1,
            )}
            matches={suggestions}
            choose={({ item }) => choose({
              command: skillReference({ item: item.suggestion }),
              item: item.suggestion,
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
        <div
          className="composer-text relative min-h-12 w-full cursor-text group-[.comment-note]/composer-field:select-text bg-transparent outline-none data-[limit-height=true]:max-h-[min(50vh,var(--spacing-composer-max))] data-[limit-height=true]:overflow-y-auto"
          data-limit-height={limitHeight || undefined}
          ref={input}
          id={id}
          contentEditable="plaintext-only"
          role="textbox"
          aria-multiline="true"
          data-placeholder={placeholder}
          aria-placeholder={placeholder}
          aria-label={label}
          aria-controls={mention ? mentionList : catalogOpen ? suggestionList : undefined}
          aria-activedescendant={mention && matches.length ? `${mentionList}-${picked}`
            : active >= 0 && suggestions[active] ? `${suggestionList}-${Math.min(
              active,
              suggestions.length - 1,
            )}` : undefined}
          onPointerDown={event => {
            focusingByPointer.current = document.activeElement !== event.currentTarget
          }}
          onFocus={event => {
            if (!focusingByPointer.current) {
              restoreSelection({ field: event.currentTarget })
            }

            focusingByPointer.current = false
          }}
          onClick={event => trackMention({
            text: draft,
            cursor: selectionEnds({ field: event.currentTarget }).focus,
          })}
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
              const {
                start,
                end,
              } = selectionRange({ field: event.currentTarget })
              const edit = replaceDisplay({
                text: draft,
                from: start,
                to: end,
                insert: '',
              })
              write(edit)
              updatePickers({
                text: edit.text,
                cursor: edit.caret,
              })
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
          onCompositionStart={event => {
            composingText.current = true
            event.currentTarget.removeAttribute('data-empty')
          }}
          onCompositionEnd={() => {
            composingText.current = false
            readInput()
            settleAfterComposition()
          }}
          onInput={readInput}
          onKeyDown={e => {
            if (e.nativeEvent.isComposing || e.key === 'Process') {
              return
            }

            const key = e.key.toLowerCase()
            const commandZ = (e.metaKey || e.ctrlKey) && !e.altKey && key === 'z'
            const controlY = e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && key === 'y'
            const undo = commandZ && !e.shiftKey
            const redo = (commandZ && e.shiftKey) || controlY

            if (undo || redo) {
              e.preventDefault()
              stepHistory({ back: undo })

              return
            }

            if (e.key === 'Escape' && (prefix !== null || mention !== null)) {
              e.preventDefault()
              e.stopPropagation()
              closePickers()

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
            // Tab with nothing to complete leaves the path as typed; an item moved to with the arrows is picked as usual.
            const fromTop = picked <= 0
            const contents = mention && folderPath && fromTop ? listingOfTypedFolder : undefined
            const completed = contents && completePath({
              typed: folderPath,
              contents,
            })

            if (e.key === 'Tab' && mention && folderPath && fromTop
            && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
              e.preventDefault()
              e.stopPropagation()

              if (typedFolder) {
                chooseMention({ item: typedFolder })
              } else if (completed) {
                const edit = replaceDisplay({
                  text: draft,
                  from: mention.start + 1,
                  to: selectionEnds({ field: e.currentTarget }).focus,
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
              dismissSlash()
              onKeyDown?.({ event: e })

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
                dismissSlash()
              } else if (e.key === 'Enter' || e.key === 'Tab') {
                const mentioned = mention ? matches[index]?.row.item : undefined
                const suggestion = mention ? undefined : suggestions[index]?.row.item.suggestion

                if (mentioned) {
                  chooseMention({ item: mentioned })
                } else if (suggestion) {
                  choose({
                    command: skillReference({ item: suggestion }),
                    item: suggestion,
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
                    text: current.current,
                    cursor: selectionEnds({ field: input.current }).focus,
                  })
                }
              })
            }

            if (e.key === 'Tab') {
              setMention(null)
              dismissSlash(); setActive(0)
            }

            onKeyDown?.({ event: e })
          }}
        />
        {hosts.map(({
          chip,
          key,
          host,
        }) => createPortal(
          <ComposerChip
            chip={chip}
            progress={uploads[chip.value]}
            labelColors={labelColors}
            look={chipLook({ chip })}
            open={() => openChip({ key })}
            remove={() => removeCard({ key })}
          />,
          host,
          key,
        ))}
      </div>
      {viewing && (
        <ImageViewer
          path={viewing.value}
          label={viewing.name}
          close={() => setViewing(null)}
        />
      )}
    </div>
  )
}
