import type { Card, HydraColumn, HydraProject } from '../../../src/core/model.ts'
import { matchingTasks, mentionQuery, reference, taskMention } from '../../../src/mentions/mentions.ts'
import { MentionPicker, type MentionItem } from './mention-picker.tsx'
import { commandBytes, MAX_MESSAGE_BYTES } from '../../../src/server/protocol.ts'
import { readAttempt, saveAttempt } from './outbox.ts'
import { revealComment } from './comment-reveal.ts'
import { Fragment, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import type { ThreadPage } from '../../../src/thread/read.ts'
import type { Catalog } from '../../../src/thread/catalog.ts'
import { Button, Input, Textarea } from '../components/ui/controls.tsx'
import { Icon } from '../components/ui/icon.tsx'
import { taskStateIcon, type TaskReferenceData } from '../components/ui/task-reference.tsx'
import { Popover } from '../components/ui/popover.tsx'
import { ImageThumb, ImageViewer } from '../components/ui/attached-image.tsx'
import { AttachmentCard } from '../components/ui/attachment-card.tsx'
import { columnLook, projectTitle, slashMatches, slashPrefix } from './view.ts'
import { clock, commentReply, sendableComment, type ChatComment } from './chat.ts'
import type { Command } from './connection.ts'
import { useKeyAction, useKeyboard } from '../keyboard/registry.tsx'
import { placeMessageCaret, conversationMessages, latestAgentMessage } from './caret.ts'
import { pastedImages, uploadImages } from './image-upload.ts'
import { CommentsDialog, CommentsPill } from './comments-dialog.tsx'
import { fileBlock } from '../../../src/attachments/files.ts'
import { cardChip, draftView, editDraft, placeBlock, placeImages, removeChip, replaceDisplay, snapCaret, type PlacedChip } from './draft.ts'

function DraftCard({
  chip,
  open,
  remove,
}: {
  chip: PlacedChip
  open(): void
  remove(): void
}) {
  const image = chip.kind === 'image'

  return (
    <span className="draft-chip draft-card" data-kind={chip.kind}>
      {chip.label}
      <AttachmentCard
        keepsInputFocus
        slot={image ? <ImageThumb path={chip.value} /> : <Icon name="file" size={13} />}
        label={chip.name}
        title={image ? 'Show image' : chip.name}
        tone={chip.attached ? undefined : 'reference'}
        open={image ? open : undefined}
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
  connected,
  notify,
  settings,
  meter,
  stop,
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
  connected: boolean
  notify({ text }: { text: string }): void
  settings?: ReactNode
  meter?: ReactNode
  // Shown while Hydra runs a turn: it stops that turn, never the workers.
  stop?(): Promise<void>
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
    prefix,
    setPrefix,
  ] = useState<string | null>(null)
  const [
    active,
    setActive,
  ] = useState(-1)
  const [
    mention,
    setMention,
  ] = useState<ReturnType<typeof mentionQuery>>(null)
  const [
    mentionActive,
    setMentionActive,
  ] = useState(0)
  const [
    viewing,
    setViewing,
  ] = useState<PlacedChip | null>(null)
  const view = draftView({ text: draft })
  const display = view.display
  const mentionList = `mentions-${card}`
  const input = useRef<HTMLTextAreaElement>(null), form = useRef<HTMLFormElement>(null)
  const mirror = useRef<HTMLDivElement>(null), files = useRef<HTMLInputElement>(null)
  // Where the caret goes once React has written the new display text.
  const caretNext = useRef<number | null>(null), caretLast = useRef(0)

  const query = (mention?.query ?? '').trim().toLocaleLowerCase()
  const matches: MentionItem[] = [
    ...view.chips.filter(chip => chip.attached
      && chip.name.toLocaleLowerCase().includes(query)).map(chip => ({
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
    ...projects.filter(project => !project.detached
      && `${project.name} ${project.path}`.toLocaleLowerCase().includes(query)).map(project => ({
      key: `project:${project.path}`,
      kind: 'project' as const,
      title: project.name,
      detail: 'Project',
      insert: reference({
        kind: 'project',
        value: project.path,
        label: project.name,
      }),
    })),
    ...columns.filter(column => column.title.toLocaleLowerCase().includes(query)).map(column => ({
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
    }) => ({
      key: `task:${card.id}`,
      kind: 'task' as const,
      title: card.title,
      detail: card.project ? projectTitle({ project: card.project }) : 'No project',
      excerpt,
      ...taskLook({ id: card.id }),
      insert: taskMention({
        id: card.id,
        title: card.title,
      }),
    })),
  ]
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
    const found = mentionQuery({
      text: shown.display,
      cursor,
    })
    setMention(found && !shown.chips.some(chip => chip.from === found.start) ? found : null)
    setMentionActive(0)
  }

  const write = ({
    text,
    caret,
  }: {
    text: string
    caret: number
  }) => {
    caretNext.current = caret; setDraft({ text })
  }

  // Holding the box height while measuring stops the browser from scrolling a pinned chat up.
  const fit = ({ element }: { element: HTMLTextAreaElement }) => {
    const box = element.parentElement

    if (box) {
      box.style.minHeight = `${box.offsetHeight}px`
    }

    element.style.height = '0'
    element.style.height = `${element.scrollHeight}px`
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
        element.setSelectionRange(
          caretNext.current,
          caretNext.current,
        )
        caretLast.current = caretNext.current
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

    write(replaceDisplay({
      text: draft,
      from: mention.start,
      to: element.selectionStart,
      insert: `${item.insert} `,
    }))
    setMention(null); element.focus()
  }

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

  const openChip = ({ chip }: { chip: PlacedChip }) => {
    if (chip.kind === 'task') {
      openTask({ id: chip.value })
    } else if (chip.kind === 'image') {
      setViewing(chip)
    }
  }

  const hydraId = useRef(document.querySelector<HTMLMetaElement>('meta[name=pnyx-hydra]')?.content).current
  const attempt = useRef(readAttempt({
    key: card,
    hydraId,
  }))
  // Comments travel with the draft as one reply, and stay until it is delivered.
  const commentKey = `pnyx-comments:${card}:${thread?.session ?? ''}`
  const [
    taught,
    setTaught,
  ] = useState(() => {
    try {
      return localStorage.getItem(commentKey) === 'sent'
    } catch {
      return false
    }
  })
  useEffect(
    () => {
      try {
        setTaught(localStorage.getItem(commentKey) === 'sent')
      } catch {
        setTaught(false)
      }
    },
    [commentKey],
  )
  const outgoing = commentReply({
    draft,
    comments,
    firstComment: !taught,
  })
  const sendable = comments.filter(comment => sendableComment({ comment }))
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
  const { label } = useKeyboard(), [
    catalog,
    setCatalog,
  ] = useState<Catalog | null>(null)
  const suggestions = (catalog?.suggestions ?? []).filter(s => slashMatches({
    command: s.command,
    prefix: prefix ?? '',
  }))
  const catalogOpen = prefix !== null
  useEffect(
    () => {
      if (!catalogOpen || !connected) {
        return
      }

      let cancelled = false; setCatalog(null)
      const timer = setTimeout(
        () => {
          void command({
            name: 'catalog',
            args: [card],
          }).then(r => {
            if (!cancelled) {
              setCatalog(r.catalog as Catalog)
            }
          })
            .catch(() => {
              if (!cancelled) {
                setCatalog({
                  suggestions: [],
                  unavailable: 'Catalog unavailable. Your command stays literal.',
                })
              }
            })
        },
        120,
      )

      return () => {
        cancelled = true; clearTimeout(timer)
      }
    },
    [
      card,
      catalogOpen,
      command,
      connected,
    ],
  )
  useEffect(
    () => {
      document.getElementById(`suggestion-${card}-${active}`)?.scrollIntoView({ block: 'nearest' })
    },
    [
      card,
      active,
    ],
  )

  const choose = ({ command }: { command: string }) => {
    const cursor = input.current?.selectionStart ?? display.length
    write(replaceDisplay({
      text: draft,
      from: 0,
      to: cursor,
      insert: `${command} `,
    }))
    setPrefix(null); setActive(-1); input.current?.focus()
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

  const attach = async ({ files }: { files: File[] }) => {
    const {
      lines,
      failures,
    } = await uploadImages({ files })

    if (failures.length) {
      notify({ text: failures.join(' ') })
    }

    if (lines.length) {
      write(placeImages({
        text: current.current.draft,
        caret: input.current?.selectionEnd,
        lines,
      }))
      input.current?.focus()
    }
  }

  const removeCard = ({ chip }: { chip: PlacedChip }) => {
    write(removeChip({
      text: draft,
      chip,
    }))
    input.current?.focus()
  }

  const send = async ({ restore = false }: { restore?: boolean } = {}) => {
    const text = restore && attempt.current ? attempt.current.text : outgoing

    if (sending || !text.trim()) {
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
    setFailure(null); setSending(true)

    if (taken) {
      write({
        text: '',
        caret: 0,
      })
      setComments({ items: comments.filter(comment => !sendableComment({ comment })) })
      setMention(null); setPrefix(null); setActive(-1)
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
      }); const receipt = r.reply as {
        state: string
        detail?: string
      } | undefined

      if (receipt?.state === 'delivered' || receipt?.state === 'queued') {
        if (commented || taken?.comments.length) {
          setTaught(true)

          try {
            localStorage.setItem(
              commentKey,
              'sent',
            )
          } catch { /* Storage can be disabled. */ }
        }

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

      setPrefix(null); setActive(-1); setMention(null)

      return true
    },
  })

  return (
    <>
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
            event.preventDefault(); void attach({ files: [...event.dataTransfer.files] })
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
        <div className="composer-input" data-chips={view.chips.length > 0 || undefined}>
          {mention && (
            <MentionPicker
              anchor={input}
              id={mentionList}
              matches={matches}
              active={picked}
              choose={chooseMention}
            />
          )}
          {prefix !== null && (
            <div className="slash-menu">
              <span className="eyebrow">Session commands</span>
              <div id={`suggestions-${card}`} role="listbox" aria-label="Session commands">
                {suggestions.map((
                  s,
                  n,
                ) => (
                  <Button
                    role="option"
                    aria-selected={n === active}
                    id={`suggestion-${card}-${n}`}
                    key={s.command}
                    className={n === active ? 'active' : ''}
                    onMouseDown={e => e.preventDefault()}
                    onClick={() => choose({ command: s.command })}
                  >
                    <strong>{s.command}</strong>
                    <span>
                      {s.description}
                      <small>{s.source}</small>
                    </span>
                  </Button>
                ))}
              </div>
              {!suggestions.length && <p role="status">{!catalog ? 'Loading local commands…' : catalog.unavailable ?? 'No matching local command.'}</p>}
              {catalog?.note && <p>{catalog.note}</p>}
            </div>
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
              : active >= 0 && suggestions[active] ? `suggestion-${card}-${active}` : undefined}
            onScroll={event => {
              if (mirror.current) {
                mirror.current.scrollTop = event.currentTarget.scrollTop
              }
            }}
            onSelect={event => {
              const element = event.currentTarget
              const {
                selectionStart: start,
                selectionEnd: end,
              } = element

              if (start === end) {
                const snapped = snapCaret({
                  view,
                  offset: start,
                  backward: start < caretLast.current,
                })

                if (snapped !== start) {
                  element.setSelectionRange(
                    snapped,
                    snapped,
                  )
                }

                caretLast.current = snapped
              }
            }}
            onClick={event => {
              trackMention({
                text: draft,
                cursor: event.currentTarget.selectionStart,
              })
            }}
            onBlur={() => setMention(null)}
            onPaste={event => {
              const files = pastedImages({ clipboardData: event.clipboardData })

              if (files.length) {
                event.preventDefault(); void attach({ files })
              }
            }}
            onChange={e => {
              const edit = editDraft({
                text: draft,
                next: e.target.value,
                caret: e.target.selectionStart,
              })
              write(edit)
              const shown = draftView({ text: edit.text }).display
              setPrefix(slashPrefix({
                text: shown,
                cursor: edit.caret,
              }))
              setActive(-1)
              trackMention({
                text: edit.text,
                cursor: edit.caret,
              })
            }}
            onKeyDown={e => {
              if (e.nativeEvent.isComposing || e.key === 'Process') {
                return
              }

              if (mention && [
                'ArrowDown',
                'ArrowUp',
                'Enter',
                'Tab',
                'Escape',
              ].includes(e.key) && !e.metaKey && !e.ctrlKey && !e.altKey && !(e.key === 'Tab' && e.shiftKey)) {
                e.preventDefault(); e.stopPropagation()

                if (e.key === 'Escape') {
                  setMention(null)
                } else if (e.key === 'Enter' || e.key === 'Tab') {
                  const selected = matches[picked]

                  if (selected) {
                    chooseMention({ item: selected })
                  } else {
                    setMention(null)
                  }
                } else {
                  setMentionActive(index => Math.max(
                    0,
                    Math.min(
                      matches.length - 1,
                      index + (e.key === 'ArrowDown' ? 1 : -1),
                    ),
                  ))
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
                setPrefix(null); setActive(-1)
              }

              if (prefix !== null && suggestions.length && [
                'ArrowDown',
                'ArrowUp',
              ].includes(e.key)) {
                e.preventDefault(); setActive(n => Math.max(
                  0,
                  Math.min(
                    suggestions.length - 1,
                    n + (e.key === 'ArrowDown' ? 1 : -1),
                  ),
                ))

                return
              }

              if (prefix !== null && active >= 0 && e.key === 'Enter' && !e.metaKey && !e.ctrlKey) {
                e.preventDefault(); choose({ command: suggestions[active].command })

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
          {view.chips.length > 0 && (
            <div className="draft-mirror" ref={mirror} aria-hidden="true">
              {view.chips.map((
                chip,
                index,
              ) => {
                const look = chip.kind === 'task' || chip.kind === 'column' ? chipLook({ chip }) : undefined
                const title = chip.kind === 'project' ? chip.value : chip.kind === 'task' ? 'Open task' : undefined
                const before = display.slice(
                  view.chips[index - 1]?.to ?? 0,
                  chip.from,
                )

                return cardChip({ chip }) ? (
                  <Fragment key={chip.start}>
                    {before}
                    <DraftCard
                      chip={chip}
                      open={() => openChip({ chip })}
                      remove={() => removeCard({ chip })}
                    />
                  </Fragment>
                ) : (
                  <Fragment key={chip.start}>
                    {before}
                    <span
                      className={`draft-chip ${chip.attached ? 'attached' : 'reference'} ${look?.tone ?? ''}`}
                      data-kind={chip.kind}
                      title={title}
                      onMouseDown={event => event.preventDefault()}
                      onClick={() => openChip({ chip })}
                    >
                      {look ? (
                        <>
                          {look.icons.map(icon => <span key={icon} className="chip-icon"><Icon name={icon} size={14} /></span>)}
                          {chip.name}
                        </>
                      ) : chip.label}
                    </span>
                  </Fragment>
                )
              })}
              {display.slice(view.chips.at(-1)!.to)}
              {/* A trailing newline still gets a line box, as it does in the textarea. */}
              {'\u200B'}
            </div>
          )}
        </div>
        <div className="composer-bar">
          <Popover label="Add to message" className="composer-add" trigger={<Icon name="plus" size={16} />}>
            {({ close }) => (
              <>
                <Button
                  onClick={() => {
                    close(); files.current?.click()
                  }}
                >Insert files or images
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
                >Mention
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
                void attach({ files: images })
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
                    firstComment: !taught,
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
              aria-label="Stop Hydra"
              title="Stop Hydra’s turn; workers keep going"
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
            disabled={sending || !outgoing.trim()}
          >
            <Icon name="send" size={14} />
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
