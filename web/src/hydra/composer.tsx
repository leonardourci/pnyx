import type { HydraProject } from '../../../src/projects/model.ts'
import type { HydraColumn } from '../../../src/tasks/columns-model.ts'
import type { Card, SavedLabelColor } from '../../../src/core/model.ts'
import { matchingTasks, mentionQuery, reference, taskMention } from '../../../src/mentions/mentions.ts'
import { MentionPicker, type MentionItem } from './mention-picker.tsx'
import { commandBytes, MAX_MESSAGE_BYTES } from '../../../src/app/server-protocol.ts'
import { readAttempt, saveAttempt } from './outbox.ts'
import { revealComment } from './comment-reveal.ts'
import { Fragment, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import type { ThreadPage } from '../../../src/thread/read.ts'
import { readSkillReference, skillReference } from '../../../src/thread/skill-reference.ts'
import { UPGRADE_SUGGESTION } from '../../../src/upgrade/model.ts'
import { SkillBadge } from '../components/ui/skill-badge.tsx'
import { Label } from '../shared/ui/label.tsx'
import { SuggestionPicker } from '../shared/ui/suggestion-picker.tsx'
import type { Catalog } from '../../../src/thread/catalog.ts'
import { ReferenceBadge } from '../components/ui/reference-badge.tsx'
import { Button, Input, Textarea } from '../shared/ui/controls.tsx'
import { Icon } from '../shared/ui/icon.tsx'
import { taskStateIcon, type TaskReferenceData } from '../components/ui/task-reference.tsx'
import { Popover } from '../shared/ui/popover.tsx'
import { ImageThumb, ImageViewer } from '../components/ui/attached-image.tsx'
import { AttachmentCard } from '../components/ui/attachment-card.tsx'
import { projectTitle } from '../projects/view.ts'
import { columnLook, slashMatches, slashPrefix } from './view.ts'
import { clock, commentReply, sendableComment, type ChatComment } from './chat.ts'
import type { Command } from '../app/connection.ts'
import { useKeyAction, useKeyboard } from '../preferences/keyboard-registry.tsx'
import { placeMessageCaret, conversationMessages, latestAgentMessage } from './caret.ts'
import { pastedImages, uploadImages } from './image-upload.ts'
import { CommentsDialog, CommentsPill } from './comments-dialog.tsx'
import { fileBlock } from '../../../src/attachments/files.ts'
import { cardChip, CHIP_SPACE, draftView, editDraft, placeBlock, placeImages, removeChip, replaceDisplay, snapCaret, type PlacedChip } from './draft.ts'

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
  catalog,
  onCatalogOpen,
  labelColors,
  notify,
  settings,
  meter,
  stop,
  compacting = false,
  serverComments = true,
  focusAbove,
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
  serverComments?: boolean
  stop?(): Promise<void>
  focusAbove?(): boolean
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
    setPrefix(slashPrefix({
      text: shown.display,
      cursor,
    }))
    const found = mentionQuery({
      text: shown.display,
      cursor,
    })
    const insideChip = found && shown.chips.some(chip =>
      chip.from <= found.start && found.start < chip.to)
    setMention(insideChip ? null : found)
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

  const hydraId = document.querySelector<HTMLMetaElement>('meta[name=pnyx-hydra]')?.content
  const attempt = useRef(readAttempt({
    key: card,
    hydraId,
  }))
  const commentKey = `pnyx-comments:${card}:${thread?.session ?? ''}`
  const [
    taught,
    setTaught,
  ] = useState(false)
  useEffect(
    () => {
      if (serverComments) {
        return
      }

      try {
        setTaught(localStorage.getItem(commentKey) === 'sent')
      } catch {
        setTaught(false)
      }
    },
    [
      commentKey,
      serverComments,
    ],
  )
  const outgoing = commentReply({
    draft,
    comments,
    firstComment: !serverComments && !taught,
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
  const { label } = useKeyboard()
  const catalogOpen = prefix !== null
  useEffect(
    () => onCatalogOpen({ open: catalogOpen }),
    [
      catalogOpen,
      onCatalogOpen,
    ],
  )
  const suggestions = (catalog?.suggestions ?? []).filter(s => slashMatches({
    command: s.command,
    prefix: prefix ?? '',
  }))

  const choose = ({ command }: { command: string }) => {
    const unavailable = catalog?.suggestions.some(item =>
      skillReference({ item }) === command && item.unavailable)

    if (unavailable) {
      return
    }

    const cursor = input.current?.selectionStart ?? display.length
    const query = slashPrefix({
      text: display,
      cursor,
    })

    if (query === null || query !== prefix) {
      setPrefix(null)

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
        if (!serverComments && (commented || taken?.comments.length)) {
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
            <SuggestionPicker
              id={`suggestions-${card}`}
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
                icons: item.source === UPGRADE_SUGGESTION.source ? ['upgrade'] : undefined,

              }))}
              choose={({ item }) => choose({ command: skillReference({ item }) })}
              loading={!catalog}
              empty={catalog?.unavailable ?? 'No matching skill or command.'}
              footer={catalog?.note ? <p>{catalog.note}</p> : undefined}

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
                    choose({ command: skillReference({ item: suggestions[index] }) })
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
                    firstComment: !serverComments && !taught,
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
