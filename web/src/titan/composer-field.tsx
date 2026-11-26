import { mentionQuery,reference } from '#titan/mentions.ts'
import { skillReference } from '#titan/transcripts-skill-reference.ts'
import { ImageViewer } from './attached-image.tsx'
import { embedImages,imagesHtml } from './clipboard.ts'
import { copyDraft,draftView,editDraft,isPendingImage,placeBlock,removeChip,replaceDisplay,shownDraft,snapSelection,type PlacedChip } from './draft.ts'
import { pastedImages } from './image-upload.ts'
import { MentionPicker,type MentionItem } from './mention-picker.tsx'
import { completePath,splitPath,typedListing } from './path-completion.ts'
import { GOALS,mentionText,projectRequestActions,REQUEST_HEAD,requestPaths } from './project-request.ts'
import { slashState,type SlashState } from './view.ts'
import { useFolders } from '#web-projects/folders.ts'
import type { FolderListing } from '#projects/folders.ts'
import { Textarea } from '#web-shared/ui/controls.tsx'
import { SuggestionPicker } from '#web-shared/ui/suggestion-picker.tsx'
import { columnLook } from '#web-tasks/view.ts'
import { filterRows,prepareRow } from '#titan/suggestion-matches.ts'
import { useDeferredValue,useEffect,useLayoutEffect,useImperativeHandle,useMemo,useRef,useState,type KeyboardEvent,type Ref } from 'react'
import { select,selectionEnds } from './composer-caret.ts'
import { useComposerSources } from './composer-sources.tsx'
import { useComposerUploads } from './composer-uploads.ts'
import { DraftMirror,writeDraftMirror } from './draft-mirror.tsx'
import { attachmentRows,folderRows,mentionMatches,taskLook } from './mention-candidates.ts'
import { CLONE_URL,folderSuggestions } from './mention-folders.ts'
import { useSlashMenu } from './slash-menu.tsx'

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
  input: HTMLTextAreaElement | null
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
  && before.label === after.label && before.name === after.name
  && before.attached === after.attached

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
  onKeyDown?({ event }: { event: KeyboardEvent<HTMLTextAreaElement> }): void
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
  let mirrored = view.chips.length > 0 || paths.length > 0
  const [fieldKey] = useState(() => id ?? crypto.randomUUID())
  const mentionList = `mentions-${fieldKey}`
  const suggestionList = `suggestions-${fieldKey}`
  const input = useRef<HTMLTextAreaElement>(null)
  const mirror = useRef<HTMLDivElement>(null)
  // Where the selection goes after a write: at once for plain text, after the mirror renders when chips changed.
  const caretNext = useRef<{
    anchor: number
    focus: number
  } | null>(null), caretLast = useRef(0)
  // The draft before each cut, keyed by what it showed, so an Undo that brings that text back restores its chips.
  const beforeCuts = useRef(new Map<string, string>())
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
    const cursor = input.current?.selectionStart ?? display.length
    const dismissed = prefix === null ? slash.dismissed : cursor - prefix.length
    setSlash({
      prefix: null,
      dismissed,
    })
  }

  // A chip's own @ never starts a new mention.
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
      chips: shown.chips,
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

    const insideChip = found && shown.chips.some(chip =>
      chip.from <= found.start && found.start < chip.to)
    const nextMention = insideChip ? null : found

    if (nextMention?.start !== mention?.start || nextMention?.query !== mention?.query) {
      setMention(nextMention)
    }

    if (mentionActive !== 0) {
      setMentionActive(0)
    }
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
    const next = draftView({ text })
    const nextPaths = requestPaths({ display: next.display })
    const nextMirrored = next.chips.length > 0 || nextPaths.length > 0
    const decorationChanged = mirrored !== nextMirrored || view.chips.length !== next.chips.length
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
    paths = nextPaths
    mirrored = nextMirrored
    caretNext.current = {
      anchor,
      focus: caret,
    }
    const element = input.current

    if (element && element.value !== display) {
      element.value = display
    }

    if (decorationChanged) {
      redraw(version => version + 1)
    } else {
      if (mirror.current) {
        writeDraftMirror({
          element: mirror.current,
          view,
          paths,
        })
      }

      syncCaret()
    }

    latestChange.current({ text })
  }

  useLayoutEffect(
    () => {
      if (value !== current.current) {
        write({
          text: value,
          caret: Math.min(
            input.current?.selectionEnd ?? 0,
            draftView({ text: value }).display.length,
          ),
        })
      }
    },
    [value],
  )

  const syncCaret = () => {
    const element = input.current

    if (!element) {
      return
    }

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
  }

  useLayoutEffect(syncCaret)

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

  const chipLook =({ chip }: { chip: PlacedChip }) => {
    if (chip.kind === 'task') {
      return taskLook({ reference: taskReferences[chip.value] })
    }

    const look = columnLook()

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
      caret: input.current?.selectionEnd,
      block,
    })
    write(edit)
    input.current?.focus()

    return edit.text
  }

  const attach = useComposerUploads({
    current,
    input,
    caretLast,
    latestChange,
    write,
    notify,
    setUploads,
  })

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

  const closePickers = () => {
    setMention(null); dismissSlash(); setActive(0)
  }

  const startMention = () => {
    const element = input.current

    if (!element) {
      return
    }

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
      <div className="composer-input group/composer-input relative flex min-h-(--spacing-composer-line) flex-[0_1_auto] flex-col overflow-hidden group-data-[standalone=true]/composer-field:min-h-0" data-chips={mirrored || undefined}>
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
        <Textarea
          className="composer-text group-[.comment-note]/composer-field:select-text bg-transparent outline-none data-[limit-height=true]:max-h-[min(50vh,var(--spacing-composer-max))] data-[limit-height=true]:overflow-y-auto group-data-chips/composer-input:text-transparent group-data-chips/composer-input:caret-ink"
          data-limit-height={limitHeight || undefined}
          ref={input}
          id={id}
          defaultValue={display}
          placeholder={placeholder}
          aria-label={label}
          aria-controls={mention ? mentionList : catalogOpen ? suggestionList : undefined}
          aria-activedescendant={mention && matches.length ? `${mentionList}-${picked}`
            : active >= 0 && suggestions[active] ? `${suggestionList}-${Math.min(
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

            if (goal !== null) {
              setGoal(null)
            }

            if (active !== 0) {
              setActive(0)
            }

            trackMention({
              text: edit.text,
              cursor: edit.caret,
            })
          }}
          onKeyDown={e => {
            if (e.nativeEvent.isComposing || e.key === 'Process') {
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
                    cursor: input.current.selectionStart,
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
        {mirrored && (
          <DraftMirror
            view={view}
            paths={paths}
            uploads={uploads}
            labelColors={labelColors}
            removeCard={({ index }) => {
              const chip = view.chips[index]

              if (chip) {
                removeCard({ chip })
              }
            }}
            openChip={({ index }) => {
              const chip = view.chips[index]

              if (chip) {
                openChip({ chip })
              }
            }}
            chipLook={chipLook}
            mirror={mirror}
          />
        )}
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
