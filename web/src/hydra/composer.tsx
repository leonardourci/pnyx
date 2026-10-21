import type { Card } from '../../../src/core/model.ts'
import { matchingTasks, mentionQuery, taskMention, taskMentions } from '../../../src/mentions/mentions.ts'
import { MentionPicker } from './mention-picker.tsx'
import { commandBytes, MAX_MESSAGE_BYTES } from '../../../src/server/protocol.ts'
import { HYDRA_CARD } from '../../../src/core/hydra.ts'
import { readAttempt, saveAttempt } from './outbox.ts'
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import type { ThreadPage } from '../../../src/thread/read.ts'
import type { Catalog } from '../../../src/thread/catalog.ts'
import { VIEW_SIZE_LIMITS } from '../../../src/core/view.ts'
import { Button, Input, Textarea } from '../components/ui/controls.tsx'
import { Icon } from '../components/ui/icon.tsx'
import { Popover } from '../components/ui/popover.tsx'
import { Resize } from '../components/ui/resize.tsx'
import { slashMatches, slashPrefix } from './view.ts'
import { commentReply, sendableComment, type ChatComment } from './chat.ts'
import type { Command } from './connection.ts'
import { useKeyAction, useKeyboard } from '../keyboard/registry.tsx'
import { placeMessageCaret, conversationMessages, enterNote, latestAgentMessage } from './caret.ts'
import { imagePaths } from '../../../src/attachments/images.ts'
import { pastedImages, uploadImages } from './image-upload.ts'
import { CommentsDialog, CommentsPill } from './comments-dialog.tsx'
import { AttachedImage } from '../components/ui/attached-image.tsx'

const DRAFT_MIN = 36, DRAFT_MAX = 128, COMPOSER_CONTROLS = 44
const COMPOSER_MIN = VIEW_SIZE_LIMITS.composerHeight.min

export function Composer({
  card,
  cards,
  openTask,
  title,
  draft,
  setDraft,
  comments,
  setComments,
  thread,
  height,
  command,
  save,
  connected,
  notify,
  settings,
}: {
  card: string
  cards: Card[]
  openTask({ id }: { id: string }): void
  title: string
  draft: string
  setDraft({ text }: { text: string }): void
  comments: ChatComment[]
  setComments({ items }: { items: ChatComment[] }): void
  thread: ThreadPage | null
  height: number
  command: Command
  save({ patch }: { patch: unknown }): Promise<boolean>
  connected: boolean
  notify({ text }: { text: string }): void
  settings?: ReactNode
}) {
  const [
    preview,
    setPreview,
  ] = useState<number | null>(null)
  const [
    failure,
    setFailure,
  ] = useState('')
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
  const matches = matchingTasks({
    cards,
    query: mention?.query ?? '',
  })
  const mentions = taskMentions({ text: draft })
  const mentionList = `mentions-${card}`

  const trackMention = ({
    text,
    cursor,
  }: {
    text: string
    cursor: number
  }) => {
    setMention(mentionQuery({
      text,
      cursor,
    })); setMentionActive(0)
  }

  const chooseMention = ({ card }: { card: Card }) => {
    const element = input.current

    if (!mention || !element) {
      return
    }

    const reference = taskMention({
      id: card.id,
      title: card.title,
    }) + ' '
    const cursor = mention.start + reference.length
    const text = draft.slice(
      0,
      mention.start,
    ) + reference + draft.slice(element.selectionStart)
    setDraft({ text })
    setMention(null); element.focus()
    requestAnimationFrame(() => element.setSelectionRange(
      cursor,
      cursor,
    ))
  }

  const input = useRef<HTMLTextAreaElement>(null), form = useRef<HTMLFormElement>(null)
  const files = useRef<HTMLInputElement>(null)
  const [
    contentHeight,
    setContentHeight,
  ] = useState<number>(COMPOSER_MIN)
  const [
    limit,
    setLimit,
  ] = useState<number>(VIEW_SIZE_LIMITS.composerHeight.max)
  const savedSize = Math.min(
    limit,
    Math.max(
      height,
      contentHeight,
    ),
  )
  const size = Math.min(
    limit,
    Math.max(
      preview ?? savedSize,
      contentHeight,
    ),
  )
  useLayoutEffect(
    () => {
      const pane = form.current?.closest('.hydra-chat, .card') ?? form.current?.parentElement
      const element = input.current

      if (!pane || !element) {
        return
      }

      const measure = () => {
        setLimit(Math.min(
          VIEW_SIZE_LIMITS.composerHeight.max,
          Math.max(
            COMPOSER_MIN,
            Math.floor(pane.clientHeight * .35),
          ),
        ))
        element.style.height = `${DRAFT_MIN}px`
        const draftHeight = draft ? element.scrollHeight : DRAFT_MIN
        const controls = form.current?.querySelector<HTMLElement>('.composer-bar')
        const controlsHeight = Math.max(
          COMPOSER_CONTROLS,
          (controls?.offsetHeight ?? 0) + 12,
        )
        const context = form.current?.querySelector<HTMLElement>('.composer-comments')
        const error = form.current?.querySelector<HTMLElement>('.reply-failure')
        const references = form.current?.querySelector<HTMLElement>('.draft-mentions')
        const images = form.current?.querySelector<HTMLElement>('.draft-images')
        const contextHeight = context ? Math.min(
          64,
          context.scrollHeight,
        ) + 4 : 0
        const errorHeight = (error ? error.scrollHeight + 4 : 0)
        + (references ? references.offsetHeight + 4 : 0)
        + (images ? images.offsetHeight + 4 : 0)
        setContentHeight(
          Math.min(
            DRAFT_MAX,
            Math.max(
              DRAFT_MIN,
              draftHeight,
            ),
          )
        + controlsHeight + contextHeight + errorHeight,
        )
        element.style.height = ''
      }

      measure()
      const observer = new ResizeObserver(measure)
      observer.observe(pane)
      observer.observe(element)
      const controls = form.current?.querySelector<HTMLElement>('.composer-bar')

      if (controls) {
        observer.observe(controls)
      }

      return () => observer.disconnect()
    },
    [
      draft,
      comments,
      failure,
    ],
  )
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

  // The list closes onto the comment under its passage, ready to edit.
  const showComment = ({ id }: { id: string }) => {
    setListing(null)
    requestAnimationFrame(() => {
      const host = form.current && conversationMessages({ from: form.current })
      const note = host?.querySelector<HTMLTextAreaElement>(`[data-comment-id="${id}"] textarea`)

      if (note) {
        note.scrollIntoView({ block: 'center' })
        enterNote({
          note,
          direction: 'backward',
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
    const cursor = input.current?.selectionStart ?? draft.length; setDraft({ text: command + ' ' + draft.slice(cursor) }); setPrefix(null); setActive(-1); input.current?.focus(); requestAnimationFrame(() => input.current?.setSelectionRange(
      command.length + 1,
      command.length + 1,
    ))
  }

  // Each image becomes its own paragraph in the draft.
  const attach = async ({ files }: { files: File[] }) => {
    const {
      lines,
      failures,
    } = await uploadImages({ files })

    if (failures.length) {
      notify({ text: failures.join(' ') })
    }

    if (lines.length) {
      const text = current.current.draft, cursor = input.current?.selectionEnd ?? text.length
      const before = text.slice(
          0,
          cursor,
        ).trimEnd(), added = lines.join('\n\n')
      const caret = (before ? before.length + 2 : 0) + added.length + 2
      setDraft({
        text: [
          before,
          added,
          text.slice(cursor).trimStart(),
        ].filter(Boolean).join('\n\n') + (text.slice(cursor).trim() ? '' : '\n\n'),
      })
      input.current?.focus()
      requestAnimationFrame(() => input.current?.setSelectionRange(
        caret,
        caret,
      ))
    }
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
    setFailure(''); setSending(true)

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
      const why = receipt?.detail ? ` (${receipt.detail})` : ''

      if (receipt?.state !== 'delivered' && receipt?.state !== 'queued') {
        setFailure(receipt?.state === 'delivery_unknown' ? 'Send could not be confirmed. Check the conversation before retrying.' : `Could not send${why}. Draft kept.`)
      }

      if (receipt?.state === 'delivered' || receipt?.state === 'queued') {
        notify({ text: receipt.state === 'queued' ? 'Message queued for Hydra.' : 'Reply delivered to the route. This does not confirm it was handled.' })
      }

      if ((receipt?.state === 'delivered' || receipt?.state === 'queued')) {
        if (commented) {
          setTaught(true)

          try {
            localStorage.setItem(
              commentKey,
              'sent',
            )
          } catch { /* Storage can be disabled. */ }
        }

        // Keep anything typed or commented while the reply was in flight.
        if (text === outgoing && current.current.draft === draft) {
          setDraft({ text: '' }); setMention(null)
        }

        if (text === outgoing) {
          const key = ({ comment }: { comment: ChatComment }) => JSON.stringify([
            comment.id,
            comment.text,
            comment.images,
          ])
          const sent = new Set(comments.map(comment => key({ comment })))
          const kept = current.current.comments.filter(comment => !sent.has(key({ comment })))
          setComments({ items: kept })
        }

        attempt.current = null
      }
    } catch (e) {
      setFailure((e as Error).message)
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
    <form
      ref={form}
      aria-busy={sending}
      className="composer"
      style={{ height: size }}
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
      <Resize
        label="Resize composer"
        axis="y"
        reverse
        value={savedSize}
        min={VIEW_SIZE_LIMITS.composerHeight.min}
        max={Math.min(
          limit,
          VIEW_SIZE_LIMITS.composerHeight.max,
        )}
        onPreview={({ value }) => setPreview(value)}
        onCommit={({ value: n }) => save({
          patch: card === HYDRA_CARD ? { composerHeight: n } : { taskComposerHeight: n },
        })}
      />
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
      {mentions.length > 0 && (
        <div className="draft-mentions" aria-label="Referenced tasks">
          {mentions.map((
            mention,
            index,
          ) => <Button key={index} className="task-mention" onClick={() => openTask({ id: mention.id })}>@{mention.title}</Button>)}
        </div>
      )}
      {imagePaths({ text: draft }).length > 0 && (
        <div className="draft-images" aria-label="Attached images">
          {imagePaths({ text: draft }).map(path => <AttachedImage key={path} path={path} />)}
        </div>
      )}
      <div className="composer-input">
        {mention && (
          <MentionPicker
            anchor={input}
            id={mentionList}
            matches={matches}
            active={Math.min(
              mentionActive,
              matches.length - 1,
            )}
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
          data-key-scope="composer"
          id={`reply-${card}`}
          value={draft}
          placeholder={title === 'Hydra' ? 'Message Hydra…' : 'Reply, or / for commands…'}
          aria-label={`Reply to ${title}`}
          aria-controls={mention ? mentionList : catalogOpen ? `suggestions-${card}` : undefined}
          aria-activedescendant={mention && matches.length ? `${mentionList}-${Math.min(
            mentionActive,
            matches.length - 1,
          )}` : active >= 0 && suggestions[active] ? `suggestion-${card}-${active}` : undefined}
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
            setDraft({ text: e.target.value })
            setPrefix(slashPrefix({
              text: e.target.value,
              cursor: e.target.selectionStart,
            }))
            setActive(-1)
            trackMention({
              text: e.target.value,
              cursor: e.target.selectionStart,
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
              'Escape',
            ].includes(e.key) && !e.metaKey && !e.ctrlKey && !e.altKey) {
              e.preventDefault(); e.stopPropagation()

              if (e.key === 'Escape') {
                setMention(null)
              } else if (e.key === 'Enter') {
                const selected = matches[Math.min(
                  mentionActive,
                  matches.length - 1,
                )]

                if (selected) {
                  chooseMention({ card: selected.card })
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
                    text: input.current.value,
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
                    const boundary = cursor > 0 && !/\s/.test(draft[cursor - 1]!) ? ' ' : ''
                    const text = draft.slice(
                      0,
                      cursor,
                    ) + boundary + '@' + draft.slice(element.selectionEnd)
                    const start = cursor + boundary.length
                    setDraft({ text }); setMention({
                      start,
                      query: '',
                    }); setMentionActive(0); setPrefix(null)
                    requestAnimationFrame(() => element.setSelectionRange(
                      start + 1,
                      start + 1,
                    ))
                  }
                }}
              >Mention a task
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

                  return `File: ${file.name}\n\n${text}`
                }))
                const next = [
                  current.current.draft,
                  ...contents,
                ].filter(Boolean).join('\n\n')
                const text = commentReply({
                  draft: next,
                  comments: current.current.comments,
                  firstComment: !taught,
                })
                const id = crypto.randomUUID()
                const name = card === HYDRA_CARD ? 'hydra' : 'reply'
                const args = card === HYDRA_CARD
                  ? [
                    'send',
                    `--text=${text}`,
                    '--event-id',
                    id,
                  ] : [
                    card,
                    text,
                    id,
                  ]

                if (commandBytes({
                  name,
                  args,
                }) > MAX_MESSAGE_BYTES) {
                  throw new Error('Files and draft exceed the 64 KiB message limit. Draft kept.')
                }

                setDraft({ text: next })
                input.current?.focus()
              } catch (error) {
                notify({ text: error instanceof Error ? error.message : 'Could not read the selected files.' })
              }
            })()
          }}
        />
        {settings}
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
      {failure && <p className="reply-failure" role="status">{failure}</p>}
    </form>
  )
}
