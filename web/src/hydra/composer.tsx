import type { ChatDrafts } from './chat-drafts.ts'
import { commandBytes, MAX_MESSAGE_BYTES } from '#app/server-protocol.ts'
import { readAttempt, saveAttempt } from './outbox.ts'
import { revealComment } from './comment-reveal.ts'
import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent, type ReactNode } from 'react'
import type { ThreadPage } from '#hydra/transcripts-read.ts'
import { COMPOSER_ICON } from '#web-workers/agent-pickers.tsx'
import { sendableRequest } from './project-request.ts'
import { Button, Input } from '#web-shared/ui/controls.tsx'
import { Icon } from '#web-shared/ui/icon.tsx'
import { Popover } from '#web-shared/ui/popover.tsx'
import { ComposerField, type ComposerFieldHandle } from './composer-field.tsx'
import { commentReply, sendableComment, type ChatComment } from './chat.ts'
import type { Command } from '#web-app/connection.ts'
import { useKeyAction, useKeyboard } from '#web-preferences/keyboard-registry.tsx'
import { placeMessageCaret, conversationMessages, latestAgentMessage } from './caret.ts'
import { CommentsDialog, CommentsPill } from './comments-dialog.tsx'
import { fileBlock } from '#hydra/attachments.ts'
import { draftView, hasPendingImage } from './draft.ts'

// Icons beside the text of the composer's menu items.
const MENU_ICON = 16

export function Composer({
  hydraId,
  card,
  title,
  drafts,
  thread,
  loadComment,
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
  hydraId: string
  card: string
  title: string
  drafts: ChatDrafts
  thread: ThreadPage | null
  loadComment({ comment }: { comment: ChatComment }): Promise<void>
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
  const {
    setDraft,
    setComments,
  } = drafts
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
  }

  useEffect(
    () => drafts.subscribe(() => {
      const text = drafts.read().text
      const editor = field.current

      if (editor && editor.read() !== text) {
        editor.write({
          text,
          caret: draftView({ text }).display.length,
        })
      }
    }),
    [drafts],
  )

  const cacheIdentity = document.querySelector<HTMLMetaElement>('meta[name=pnyx-hydra]')?.content
  const attempt = useRef(readAttempt({
    key: card,
    hydraId: cacheIdentity,
  }))
  const commented = useSyncExternalStore(
    drafts.subscribe,
    () => drafts.read().comments.filter(comment => sendableComment({ comment })).length,
  )
  const disabled = useSyncExternalStore(
    drafts.subscribe,
    () => {
      const {
        text: draft,
        comments,
      } = drafts.read()
      const outgoing = commentReply({
        draft,
        comments,
        hydraId,
        card,
      })

      return !outgoing.trim() || hasPendingImage({ text: outgoing })
    },
  )
  const [
    listing,
    setListing,
  ] = useState<string[] | null>(null)

  const closeListing = useCallback(
    () => setListing(null),
    [],
  )
  const showComment = useCallback(
    async ({ id }: { id: string }) => {
      setListing(null)
      const comment = drafts.read().comments.find(item => item.id === id)

      if (!comment) {
        return
      }

      try {
        await loadComment({ comment })
        requestAnimationFrame(() => {
          const host = form.current && conversationMessages({ from: form.current })

          if (host && !revealComment({
            host,
            comment,
          })) {
            notify({ text: 'This comment’s message is unavailable' })
          }
        })
      } catch (error) {
        notify({ text: (error as Error).message })
      }
    },
    [
      drafts,
      loadComment,
      notify,
    ],
  )

  const { label } = useKeyboard()
  const insertBlock = ({ block }: { block: string }) => field.current!.insertBlock({ block })

  const send = async ({ restore = false }: { restore?: boolean } = {}) => {
    const {
      text: draft,
      comments,
    } = drafts.read()
    const sendable = comments.filter(comment => sendableComment({ comment }))
    const outgoing = commentReply({
      draft,
      comments,
      hydraId,
      card,
    })
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
      hydraId: cacheIdentity,
      attempt: attempt.current,
    })
    const taken = restore ? null : {
      draft,
      comments: sendable,
    }
    setSending(true); setChecking(false)

    if (taken) {
      write({
        text: '',
        caret: 0,
      })
      setComments({ items: comments.filter(comment => !sendableComment({ comment })) })
      field.current?.closePickers()
    }

    try {
      await command({
        name: 'reply',
        args: [
          card,
          text,
          attempt.current.id,
        ],
        onChecking: () => setChecking(true),
      })
    } catch {
      // The chat keeps a message that was not sent, marked with a retry; the error is shown there.
    } finally {
      attempt.current = null
      saveAttempt({
        key: card,
        hydraId: cacheIdentity,
        attempt: null,
      })
      setSending(false)
      setChecking(false)
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
            open={() => setListing(drafts.read().comments
              .filter(comment => sendableComment({ comment })).map(c => c.id))}
            remove={() => setComments({ items: [] })}
          />
        )}
        {listing && (
          <CommentsDialog
            drafts={drafts}
            shown={listing}
            setComments={setComments}
            show={showComment}
            close={closeListing}
          />
        )}
        <ComposerField
          ref={field}
          standalone={false}
          id={`reply-${card}`}
          keyScope="composer"
          value={drafts.read().text}
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
                  const before = drafts.read().text
                  const next = insertBlock({ block: contents.join('\n\n') })
                  const text = commentReply({
                    draft: next,
                    comments: drafts.read().comments,
                    hydraId,
                    card,
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
            disabled={sending || disabled}
          >
            <Icon name="send" size={COMPOSER_ICON} />
          </Button>
        </div>
      </form>
    </>
  )
}
