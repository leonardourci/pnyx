import { mentionQuery,reference } from '#hydra/mentions.ts'
import { skillReference } from '#hydra/transcripts-skill-reference.ts'
import type { HydraColumn } from '#tasks/columns-model.ts'
import { ImageViewer } from './attached-image.tsx'
import { embedImages,imagesHtml } from './clipboard.ts'
import { copyDraft,draftView,editDraft,isPendingImage,placeBlock,removeChip,replaceDisplay,shownDraft,snapSelection,type PlacedChip } from './draft.ts'
import { pastedImages } from './image-upload.ts'
import { MentionPicker,type MentionItem } from './mention-picker.tsx'
import { completePath } from './path-completion.ts'
import { GOALS,mentionText,projectRequestActions,REQUEST_HEAD,requestPaths } from './project-request.ts'
import { slashState,type SlashState } from './view.ts'
import { useKeyAction } from '#web-preferences/keyboard-registry.tsx'
import { useFolders } from '#web-projects/folders.ts'
import { useAutoHeight } from './auto-height.ts'
import { Textarea } from '#web-shared/ui/controls.tsx'
import { Label } from '#web-shared/ui/label.tsx'
import { SuggestionPicker } from '#web-shared/ui/suggestion-picker.tsx'
import { taskStateIcon } from '#web-tasks/task-reference.tsx'
import { columnLook } from '#web-tasks/view.ts'
import { useEffect,useLayoutEffect,useImperativeHandle,useRef,useState,type KeyboardEvent,type Ref } from 'react'
import { select,selectionEnds } from './composer-caret.ts'
import { useComposerSources } from './composer-sources.tsx'
import { useComposerUploads } from './composer-uploads.ts'
import { DraftMirror,writeDraftMirror } from './draft-mirror.tsx'
import { mentionCandidates } from './mention-candidates.ts'
import { folderSuggestions } from './mention-folders.ts'
import { useSlashMenu } from './slash-menu.ts'
import { slashIcons } from './skill-icons.ts'

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

// An owner-typed field with the Hydra composer's chips, mentions, skills and images.
export function ComposerField({
  value,
  change,
  label,
  id,
  placeholder,
  className = '',
  standalone = true,
  keyScope,
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
  // A field on its own is a compact box; the Hydra composer draws its own box, menu and controls around it.
  standalone?: boolean
  keyScope?: string
  // Runs after the pickers had their turn with the key.
  onKeyDown?({ event }: { event: KeyboardEvent<HTMLTextAreaElement> }): void
  onBlur?(): void
  // The Hydra composer's own: /add-project writes an Add project request into the draft.
  projectRequests?: boolean
  // An Add project request to write into the draft; projectRequested clears it once written.
  projectRequest?: boolean
  projectRequested?(): void
  ref?: Ref<ComposerFieldHandle>
}) {
  const {
    cards,
    projects,
    columns,
    taskReferences,
    openTask,
    catalog,
    catalogOpen: onCatalogOpen,
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
  // Programmatic chip writes restore the selection after their mirror mounts.
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

  const matches = mentionCandidates({
    query,
    view,
    projects,
    columns,
    cards,
    taskLook,
    folderItems,
    typedFolder,
  })
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
      ) => {
        const after = next.chips[index]

        return !after || chip.kind !== after.kind || chip.value !== after.value
          || chip.label !== after.label || chip.name !== after.name
          || chip.attached !== after.attached
      })
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

      fit()
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

  const fit = useAutoHeight({
    input,
    mirror,
    display,
    afterFit: ({ element }) => {
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
  })

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
    view,
    draft,
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

  const {
    suggestions,
    catalogOpen,
    choose,
  } = useSlashMenu({
    catalog,
    prefix,
    onCatalogOpen,
    input,
    display,
    view,
    draft,
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

  useKeyAction({
    id: 'cancel',
    handler: ({ context: { target } }) => {
      if (!input.current?.contains(target) || prefix === null && mention === null) {
        return false
      }

      closePickers()

      return true
    },
  })

  return (
    <div
      className={`composer-field${standalone ? ' composer-compact' : ''} ${className}`}
      // Inside the chat's caret host the field edits only its own text.
      contentEditable={false}
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
            id={`goals-${fieldKey}`}
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
            id={suggestionList}
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
          data-key-scope={keyScope}
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
            const listing = mention && folderPath && fromTop ? folders?.listing : undefined
            const completed = listing && completePath({
              typed: folderPath,
              listing,
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
            removeCard={({ index }) => removeCard({ chip: view.chips[index]! })}
            openChip={({ index }) => openChip({ chip: view.chips[index]! })}
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
