import { HYDRA_CARD } from '#hydra/identity.ts'
import { sendableComment, type ChatComment } from './chat.ts'

type CommentStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem' | 'key' | 'length'>

export function commentPrefix({
  key,
  card,
}: {
  key: string
  card: string
}) {
  return `${key}:${encodeURIComponent(card)}:`
}

function commentValue({ value }: { value: unknown }): ChatComment | undefined {
  if (!value || typeof value !== 'object') {
    return
  }

  const comment = value as ChatComment
  const indices = [
    comment.block,
    comment.offset,
    comment.start,
    comment.end?.position,
    comment.end?.offset,
  ]
  const strings = [
    comment.reference,
    comment.paragraph,
    comment.at,
  ]

  const validIdentity = typeof comment.id === 'string' && !!comment.id && typeof comment.messageId === 'string'
    && typeof comment.text === 'string' && typeof comment.quote === 'string'
  const validIndices = Number.isSafeInteger(comment.block) && Number.isSafeInteger(comment.offset)
    && indices.every(index => index === undefined || (Number.isSafeInteger(index) && index >= 0))
  const validStrings = strings.every(text => text === undefined || typeof text === 'string')
  const validEnd = comment.end === undefined || (!!comment.end && typeof comment.end === 'object'
    && Number.isSafeInteger(comment.end.position) && Number.isSafeInteger(comment.end.offset))
  const validImages = comment.images === undefined
    || (Array.isArray(comment.images) && comment.images.every(path => typeof path === 'string'))
  const valid = validIdentity && validIndices && validStrings && validEnd && validImages

  if (!valid || !sendableComment({ comment })) {
    return
  }

  return comment
}

// A failed migration leaves the old list available and in memory until a later save or load succeeds.
function migrateComments({
  storage,
  key,
}: {
  storage: CommentStorage
  key: string
}): ChatComment[] | undefined {
  const raw = storage.getItem(key)

  if (raw === null) {
    return
  }

  let value: unknown

  try {
    value = JSON.parse(raw)
  } catch {
    // Unreadable JSON leaves value undefined, so it is removed below like a list that holds no cards.
  }

  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    // Nothing can be recovered from it, and leaving it would parse it again on every save.
    storage.removeItem(key)

    return
  }

  const cards = value as Record<string, unknown>

  const entries = Object.entries(cards).flatMap(([
    card,
    list,
  ]) => Array.isArray(list)
    ? list.flatMap(item => {
      const comment = commentValue({ value: item })

      return comment ? [
        {
          card,
          comment,
        },
      ] : []
    }) : [])

  try {
    for (const {
      card,
      comment,
    } of entries) {
      const prefix = commentPrefix({
        key,
        card,
      })
      const record = `${prefix}${encodeURIComponent(comment.id)}`

      if (!readCommentRecord({
        storage,
        key: record,
        prefix,
      })?.comment) {
        storage.setItem(
          record,
          JSON.stringify(comment),
        )
      }
    }

    storage.removeItem(key)
  } catch {
    return entries.filter(entry => entry.card === HYDRA_CARD).map(entry => entry.comment)
  }
}

export function readCommentRecord({
  storage,
  key,
  prefix,
}: {
  storage: CommentStorage
  key: string
  prefix: string
}): {
  id: string
  comment: ChatComment | null
} | undefined {
  if (!key.startsWith(prefix)) {
    return
  }

  try {
    const id = decodeURIComponent(key.slice(prefix.length))
    const raw = storage.getItem(key)

    if (raw === null) {
      return {
        id,
        comment: null,
      }
    }

    const comment = commentValue({ value: JSON.parse(raw) })

    if (comment?.id === id) {
      return {
        id,
        comment,
      }
    }
  } catch { /* A malformed record cannot replace the mounted comment. */ }
}

export function loadCommentRecords({
  storage,
  key,
}: {
  storage: CommentStorage
  key: string
}) {
  const fallback = migrateComments({
    storage,
    key,
  }) ?? []
  const comments = new Map(fallback.map(comment => [
    comment.id,
    comment,
  ]))
  const prefix = commentPrefix({
    key,
    card: HYDRA_CARD,
  })
  const keys = Array.from(
    { length: storage.length },
    (
      _,
      index,
    ) => storage.key(index),
  )

  for (const key of keys) {
    if (key === null) {
      continue
    }

    const record = readCommentRecord({
      storage,
      key,
      prefix,
    })

    if (record?.comment) {
      comments.set(
        record.id,
        record.comment,
      )
    } else if (record) {
      comments.delete(record.id)
    }
  }

  return [...comments.values()]
}

export function commentChanges({
  comments,
  previous,
}: {
  comments: ChatComment[]
  previous: ChatComment[]
}) {
  return {
    changed: comments.filter(comment => JSON.stringify(comment)
      !== JSON.stringify(previous.find(saved => saved.id === comment.id))),
    removed: previous.filter(saved => !comments.some(comment => comment.id === saved.id)),
  }
}

export function saveCommentRecords({
  storage,
  key,
  comments,
  previous,
}: {
  storage: CommentStorage
  key: string
  comments: ChatComment[]
  previous: ChatComment[]
}) {
  const {
    changed,
    removed,
  } = commentChanges({
    comments: comments.filter(comment => sendableComment({ comment })),
    previous,
  })

  if (!changed.length && !removed.length) {
    return previous
  }

  if (migrateComments({
    storage,
    key,
  }) !== undefined) {
    return previous
  }

  const saved = new Map(previous.map(comment => [
    comment.id,
    comment,
  ]))
  const prefix = commentPrefix({
    key,
    card: HYDRA_CARD,
  })

  for (const comment of changed) {
    try {
      storage.setItem(
        `${prefix}${encodeURIComponent(comment.id)}`,
        JSON.stringify(comment),
      )
      saved.set(
        comment.id,
        comment,
      )
    } catch { /* Only this record remains dirty when its write fails. */ }
  }

  for (const comment of removed) {
    try {
      storage.removeItem(`${prefix}${encodeURIComponent(comment.id)}`)
      saved.delete(comment.id)
    } catch { /* A blocked deletion remains dirty. */ }
  }

  return [...saved.values()]
}
