import { ComposerAction, ComposerBar, ComposerFrame } from './composer-ui.tsx'
import type { ChatDrafts } from './chat-drafts.ts'
import { commandBytes, MAX_MESSAGE_BYTES } from '#app/server-protocol.ts'
import { readAttempt, saveAttempt } from './outbox.ts'
import { revealComment } from './comment-reveal.ts'
import { chatAround } from './composer-shortcut.ts'
import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent, type ReactNode } from 'react'
import type { ThreadPage } from '#titan/transcripts-read.ts'
import { sendableRequest } from './project-request.ts'
import { Button, NativeInput } from '#web-shared/ui/controls.tsx'
import { ICON_SIZE, Icon } from '#web-shared/icons.tsx'
import { Popover } from '#web-shared/ui/popover.tsx'
import { IconButton } from '#web-shared/ui/icon-button.tsx'
import { ComposerField, type ComposerFieldHandle } from './composer-field.tsx'
import { commentReply, sendableComment, type ChatComment } from './chat.ts'
import type { Command } from '#web-app/connection.ts'
import { composing } from '#web-shared/ime.ts'
import { CommentsDialog, CommentsPill } from './comments-dialog.tsx'
import { fileBlock } from '#titan/attachments.ts'
import { draftView, hasPendingImage } from './draft.ts'
import { selectionRange } from './composer-editable.ts'
import { touchFirst } from '#web-shared/touch.ts'

export function Composer({
  titanId,
  storageIdentity,
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
  stopLabel = 'Stop Titan',
  stopTitle = 'Stop Titan’s turn; workers keep going',
  compacting = false,
  focusAbove,
  projectRequest = false,
  projectRequested,
  fieldLabel,
  placeholder,
  sendLabel = 'Send reply',
  unavailable = false,
  limitHeight = true,
}: {
  fieldLabel?: string
  placeholder?: string
  sendLabel?: string
  unavailable?: boolean
  limitHeight?: boolean
  titanId: string
  storageIdentity: string
  card: string
  title: string
  drafts: ChatDrafts
  thread: ThreadPage | null
  loadComment({ comment }: { comment: ChatComment }): Promise<void>
  command: Command
  notify({ text }: { text: string }): void
  settings?: ReactNode
  meter?: ReactNode
  // Shown while Titan runs a turn: it stops that turn, never the workers.
  compacting?: boolean
  stop?(): Promise<void>
  stopLabel?: string
  stopTitle?: string
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
  const [
    tall,
    setTall,
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

  const cacheIdentity = storageIdentity
  const attempt = useRef(readAttempt({
    key: card,
    titanId: cacheIdentity,
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
        titanId,
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
          const host = chatAround({ from: form.current })?.querySelector<HTMLElement>('.messages')

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
      titanId,
      card,
    })
    const request = sendableRequest({
      text: restore && attempt.current ? attempt.current.text : outgoing,
    })
    const text = request.text

    if (unavailable || sending || !text.trim()) {
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
      titanId: cacheIdentity,
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
      setTall(false)
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
        titanId: cacheIdentity,
        attempt: null,
      })
      setSending(false)
      setChecking(false)
    }
  }

  useEffect(
    () => {
      const saved = readAttempt({
        key: card,
        titanId: cacheIdentity,
      })

      if (attempt.current?.pending && saved?.pending && saved.id === attempt.current.id) {
        void send({ restore: true })
      }
    },
    [],
  )

  const draftKey = ({ event: e }: { event: KeyboardEvent<HTMLDivElement> }) => {
    if (composing({ event: e.nativeEvent })) {
      return
    }

    if (e.key === 'Enter' && !e.shiftKey && !e.altKey && !touchFirst()) {
      e.preventDefault()

      if (!e.repeat) {
        void send()
      }

      return
    }

    const plainUp = e.key === 'ArrowUp' && !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey
      && selectionRange({ field: e.currentTarget }).end === 0

    if (plainUp && focusAbove?.()) {
      e.preventDefault(); e.stopPropagation()
    }
  }

  const sendHint = touchFirst() ? 'Send' : 'Send · Enter'
  const tallLabel = tall ? 'Shrink the composer' : 'Expand the composer'

  return (
    <>
      {checking && <p className="save-checking muted small" role="status">Checking whether your message was saved. Retrying automatically.</p>}
      <ComposerFrame
        ref={form}
        className="max-phone:[&_.composer-text]:min-h-24 max-phone:[&_.composer-text]:pr-7 data-tall:max-h-none! data-tall:[&_.composer-text]:min-h-composer-tall data-tall:[&_.composer-text]:max-h-none!"
        data-limit-height={limitHeight || undefined}
        data-tall={tall || undefined}
        aria-busy={sending}
        // eslint-disable-next-line othrys/object-params -- React owns form event handlers.
        onSubmit={e => {
          e.preventDefault(); void send()
        }}
        // eslint-disable-next-line othrys/object-params -- React owns form event handlers.
        onDragOver={event => {
          if (event.dataTransfer.types.includes('Files')) {
            event.preventDefault()
          }
        }}
        // eslint-disable-next-line othrys/object-params -- React owns form event handlers.
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
            show={showComment}
            close={closeListing}
          />
        )}
        <IconButton
          className="composer-tall absolute top-1 right-1 z-1 hidden max-phone:inline-flex"
          label={tallLabel}
          aria-pressed={tall}
          icon={tall ? 'compact' : 'open'}
          size="compact"
          onClick={() => setTall(!tall)}
        />
        <ComposerField
          ref={field}
          standalone={false}
          limitHeight={limitHeight}
          id={`reply-${card}`}
          value={drafts.read().text}
          change={setDraft}
          label={fieldLabel ?? `Reply to ${title}`}
          placeholder={placeholder ?? (title === 'Titan' ? 'Message Titan…' : 'Reply, or / for commands…')}
          onKeyDown={draftKey}
          projectRequests
          projectRequest={projectRequest}
          projectRequested={projectRequested}
        />
        <ComposerBar>
          <Popover label="Add to message" className="composer-add [&>.button]:size-(--spacing-composer-control) [&>.button]:min-h-(--spacing-composer-control) [&>.button]:justify-center [&>.button]:p-0 [&>.popover-panel]:w-max! [&>.popover-panel]:p-1.25! [&>.popover-panel>.button]:flex [&>.popover-panel>.button]:w-full [&>.popover-panel>.button]:justify-start [&>.popover-panel>.button]:gap-2 [&>.popover-panel>.button]:whitespace-nowrap" trigger={<Icon name="paperclip" size={ICON_SIZE.toolbar} />}>
            {({ close }) => (
              <>
                <Button
                  onClick={() => {
                    close(); files.current?.click()
                  }}
                >
                  <Icon name="paperclip" size={ICON_SIZE.control} />Insert files or images
                </Button>
                <Button
                  onClick={() => {
                    close(); field.current?.mention()
                  }}
                >
                  <Icon name="mention" size={ICON_SIZE.control} />Mention
                </Button>
              </>
            )}
          </Popover>
          <NativeInput
            ref={files}
            type="file"
            multiple
            hidden
            aria-label="Insert files or images"
            onChange={({ target }) => {
              const chosen = [...(target.files ?? [])]
              const images = chosen.filter(file => file.type.startsWith('image/'))
              const selected = chosen.filter(file => !images.includes(file))
              target.value = ''

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
                    titanId,
                    card,
                  })
                  const id = crypto.randomUUID()
                  const name = 'reply'
                  const args = [
                    card,
                    text,
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
            <ComposerAction
              kind="stop"
              aria-label={compacting ? 'Cancel compaction' : stopLabel}
              title={compacting ? 'Cancel compaction' : stopTitle}
              onClick={() => void stop()}
            >
              <Icon name="stop" size={ICON_SIZE.badge} />
            </ComposerAction>
          )}
          <ComposerAction
            kind="send"
            type="submit"
            variant="primary"
            aria-label={sendLabel}
            title={sending ? 'Sending…' : `${sendHint}${thread?.route ? ` · through ${thread.via ?? 'the recorded route'}` : ''}`}
            disabled={unavailable || sending || disabled}
          >
            <Icon name="send" size={ICON_SIZE.toolbar} />
          </ComposerAction>
        </ComposerBar>
      </ComposerFrame>
    </>
  )
}
