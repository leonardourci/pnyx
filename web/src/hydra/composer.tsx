import { commandBytes, MAX_MESSAGE_BYTES } from '#app/server-protocol.ts'
import { readAttempt, saveAttempt } from './outbox.ts'
import { revealComment } from './comment-reveal.ts'
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import type { ThreadPage } from '#hydra/transcripts-read.ts'
import { COMPOSER_ICON } from './hydra-agent.tsx'
import { sendableRequest } from './project-request.ts'
import { Button, Input } from '#web-shared/ui/controls.tsx'
import { Icon } from '#web-shared/ui/icon.tsx'
import { Popover } from '#web-shared/ui/popover.tsx'
import { ComposerField, type ComposerFieldHandle } from '#web-shared/ui/composer-field.tsx'
import { clock, commentReply, sendableComment, type ChatComment } from './chat.ts'
import type { Command } from '#web-app/connection.ts'
import { useKeyAction, useKeyboard } from '#web-preferences/keyboard-registry.tsx'
import { placeMessageCaret, conversationMessages, latestAgentMessage } from './caret.ts'
import { CommentsDialog, CommentsPill } from './comments-dialog.tsx'
import { fileBlock } from '#hydra/attachments.ts'
import { draftView, hasPendingImage } from './draft.ts'

// Icons beside the text of the composer's menu items.
const MENU_ICON = 16

export function Composer({
  card,
  title,
  draft,
  setDraft,
  comments,
  setComments,
  thread,
  command,
  notify,
  settings,
  meter,
  stop,
  compacting = false,
  focusAbove,
  projectRequest = false,
  projectRequested,
}: {
  card: string
  title: string
  draft: string
  setDraft({ text }: { text: string }): void
  comments: ChatComment[]
  setComments({ items }: { items: ChatComment[] }): void
  thread: ThreadPage | null
  command: Command
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
  const field = useRef<ComposerFieldHandle>(null)
  const form = useRef<HTMLFormElement>(null), files = useRef<HTMLInputElement>(null)

  const write = ({
    text,
    caret,
  }: {
    text: string
    caret: number
  }) => {
    // The field is mounted for the composer's whole life, so every write goes through it.
    field.current!.write({
      text,
      caret,
    })

    current.current.draft = text
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
  const insertBlock = ({ block }: { block: string }) => field.current!.insertBlock({ block })

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
      field.current?.input?.focus()

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
      field.current?.closePickers()
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
      if (scope !== 'composer' || !form.current?.contains(target)) {
        return false
      }

      void send()

      return true
    },
  })

  // Up from the start of the draft leaves for what sits above the composer: an open question, then the last reply.
  const leaveUp = ({ event: e }: { event: KeyboardEvent<HTMLTextAreaElement> }) => {
    const plainUp = e.key === 'ArrowUp' && !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey
      && e.currentTarget.selectionEnd === 0

    if (!plainUp) {
      return
    }

    if (focusAbove?.()) {
      e.preventDefault(); e.stopPropagation()

      return
    }

    const host = conversationMessages({ from: e.currentTarget })

    if (host && placeMessageCaret({
      host,
      target: latestAgentMessage({ host }),
      edge: 'end',
    })) {
      e.preventDefault()
    }
  }

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
            event.preventDefault(); field.current?.attach({ files: [...event.dataTransfer.files] })
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
        <ComposerField
          ref={field}
          standalone={false}
          id={`reply-${card}`}
          keyScope="composer"
          value={draft}
          change={setDraft}
          label={`Reply to ${title}`}
          placeholder={title === 'Hydra' ? 'Message Hydra…' : 'Reply, or / for commands…'}
          onKeyDown={leaveUp}
          projectRequests
          projectRequest={projectRequest}
          projectRequested={projectRequested}
        />
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
                    close(); field.current?.mention()
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
                field.current?.attach({ files: images })
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
    </>
  )
}
