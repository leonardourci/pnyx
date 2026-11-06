import { imageLine } from '#hydra/images.ts'
import { isEditing } from '#web-preferences/keyboard-registry.tsx'
import {
  useEffect,
  useRef,
  type ClipboardEvent as PasteEvent,
} from 'react'
import { flushSync } from 'react-dom'
import {
  enterNote,
} from './caret.ts'
import { commentUpdates,sendableComment,type ChatComment } from './chat.ts'
import { pendingImage,settleImage } from './draft.ts'
import { checkImages,pastedImages,uploadImage } from './image-upload.ts'
import {
  blockPassage,
  samePassage,selectedPassage,
  type CommentPassage,
} from './message-selection.ts'

import type { RefObject } from 'react'

export function useCommentDrafts({
  root,
  comments,
  setComments,
  notify,
  clearSelection,
  blocks,
}: {
  root: RefObject<HTMLDivElement | null>
  comments: ChatComment[]
  setComments({ items }: { items: ChatComment[] }): void
  notify({ text }: { text: string }): void
  clearSelection(): void
  blocks(): HTMLElement[]
}) {
  // Writes between renders build on each other, as do uploads that finish after them.
  const latest = useRef(comments)
  latest.current = comments

  const update = ({ items }: { items: ChatComment[] }) => {
    latest.current = items; setComments({ items })
  }

  const updates = commentUpdates({
    read: () => latest.current,
    write: update,
  })
  const remove = updates.remove

  // An image still uploading holds its placeholder in the note, which keeps the note alive.
  const release = ({ id }: { id: string }) => {
    const comment = latest.current.find(c => c.id === id)

    if (comment && !sendableComment({ comment })) {
      remove({ id })
    }
  }

  // Rendered at once, so keys or a composition begun over the selection land in the note.
  const addComment = ({
    quote,
    text = '',
  }: {
    quote: CommentPassage
    text?: string
  }) => {
    const same = latest.current.find(c => samePassage({
      before: c,
      after: quote,
    }))
    const gap = same && text && /\S$/.test(same.text) ? ' ' : ''
    const comment = same ? {
      ...same,
      text: same.text + gap + text,
    } : {
      ...quote,
      id: crypto.randomUUID(),
      text,
    }
    flushSync(() => {
      update({
        items: same ? latest.current.map(c => c.id === same.id ? comment : c) : [
          ...latest.current,
          comment,
        ],
      }); clearSelection()
    })
    window.getSelection()?.removeAllRanges()
    const note = root.current?.querySelector<HTMLTextAreaElement>(
      `[data-comment-id="${comment.id}"] textarea`,
    )

    if (note) {
      enterNote({
        note,
        direction: 'backward',
      })
    }

    return comment.id
  }

  // An image pasted over a passage goes at the end of its comment's text as a placeholder at once, so Send
  // waits for its upload; the upload then puts the image in its place, or takes the placeholder out.
  const attach = ({
    id,
    files,
  }: {
    id: string
    files: File[]
  }) => {
    const {
      images,
      failures,
    } = checkImages({ files })

    if (failures.length) {
      notify({ text: failures.join(' ') })
    }

    const placed = images.map(file => ({
      file,
      path: pendingImage({ id: crypto.randomUUID() }),
    }))

    if (!placed.length) {
      return
    }

    updates.edit({
      id,
      update: ({ text }) => [
        text.trimEnd(),
        ...placed.map(({ path }) => imageLine({ path })),
      ].filter(Boolean).join(' '),
    })

    for (const {
      file,
      path,
    } of placed) {
      void uploadImage({ file }).catch((error: Error) => {
        notify({ text: error.message })
      })
        .then(line => {
          updates.edit({
            id,
            update: ({ text }) => settleImage({
              text,
              anchor: 0,
              focus: 0,
              path,
              line: line ?? undefined,
            })?.text ?? text,
          })

          if (!document.activeElement?.closest(`[data-comment-id="${id}"]`)) {
            release({ id })
          }
        })
    }
  }

  // The caret host is contenteditable for navigation, so native paste must be intercepted.
  const paste = ({ event }: { event: PasteEvent<HTMLDivElement> }) => {
    if (event.target instanceof Element && (
      isEditing({ target: event.target }) || event.target.closest('.comment-card')
    )) {
      return
    }

    event.preventDefault()
    const passage = selectedPassage({ messages: root.current })
    const text = event.clipboardData.getData('text/plain').replace(
      /\r\n/g,
      '\n',
    )
    const files = pastedImages({ clipboardData: event.clipboardData })

    if (!passage || !text && !files.length) {
      return
    }

    const id = addComment({
      quote: passage,
      text,
    })

    if (files.length) {
      void attach({
        id,
        files,
      })
    }
  }

  // A streamed reply settles into the transcript under a new id; its comments follow the passage there.
  useEffect(() => {
    const rendered = blocks(), present = new Set(rendered.map(b => b.dataset.messageId))
    let moved = false
    const items = comments.map(comment => {
      const settled = !comment.messageId.startsWith('live:') || present.has(comment.messageId)
      const block = settled ? undefined : rendered
        .filter(b => Number(b.dataset.blockOffset) === comment.offset
          && !!comment.paragraph && !!b.dataset.quote?.startsWith(comment.paragraph))
        .at(-1)

      if (!block) {
        return comment
      }

      moved = true

      return {
        ...comment,
        ...blockPassage({ block }),
        quote: comment.quote,
        start: comment.start,
      }
    })

    if (moved) {
      setComments({ items })
    }
  })

  return {
    addComment,
    attach,
    paste,
    remove,
    release,
    update,
    latest,
  }
}
