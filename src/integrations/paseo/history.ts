import { HydraError } from '../../core/model.ts'
import { THREAD_CURSOR, type ThreadPage } from '../../thread/read.ts'
import { withTaskReceipts } from '../../thread/task.ts'
import { PASEO_CURSOR, type PaseoConversation } from './thread.ts'

export const PASEO_HISTORY_CURSOR = /^q[A-Za-z0-9_-]{1,550}$/

interface Cursors { native: string | null; saved: string | null }

function cursors({ before }: { before?: string }): Cursors | undefined {
  if (before === undefined) {
    return undefined
  }

  try {
    if (!PASEO_HISTORY_CURSOR.test(before)) {
      throw new Error('shape')
    }

    const value: unknown = JSON.parse(Buffer.from(before.slice(1), 'base64url').toString())

    if (typeof value !== 'object' || value === null || !('native' in value) || !('saved' in value)) {
      throw new Error('fields')
    }

    const { native, saved } = value

    if ((native !== null && (typeof native !== 'string' || !PASEO_CURSOR.test(native)))
      || (saved !== null && (typeof saved !== 'string' || !THREAD_CURSOR.test(saved)))
      || (native === null && saved === null)) {
      throw new Error('sources')
    }

    return { native, saved }
  } catch {
    throw new HydraError({ message: 'invalid thread cursor', code: 'VALIDATION_ERROR' })
  }
}

export async function paseoHistory({ card, conversation, readSaved, before }: {
  card: string
  conversation: Pick<PaseoConversation, 'read'>
  readSaved({ before }: { before?: string }): ThreadPage
  before?: string
}): Promise<ThreadPage> {
  const cursor = cursors({ before })
  const saved = cursor?.saved === null ? undefined : readSaved({ before: cursor?.saved })
  let native: ThreadPage | undefined, unavailable: string | undefined

  if (cursor?.native !== null) {
    try {
      native = await conversation.read({ before: cursor?.native })
    } catch (error) {
      unavailable = `${error instanceof Error ? error.message : 'Paseo could not read this conversation'}; it shows again once Paseo answers.`
    }
  }

  const empty: ThreadPage = { ...(native ?? saved), card, entries: [], route: native?.route ?? saved?.route ?? false, watching: 'unknown', older: undefined, unavailable: undefined }
  const merged = withTaskReceipts({ native: native ?? empty, saved: saved ?? empty })
  const next = { native: native?.older ?? null, saved: saved?.older ?? null }

  return {
    ...merged,
    ...(unavailable ? { unavailable } : {}),
    older: next.native || next.saved ? `q${Buffer.from(JSON.stringify(next)).toString('base64url')}` : undefined,
  }
}
