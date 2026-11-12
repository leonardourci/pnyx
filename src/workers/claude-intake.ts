import { closeSync, openSync, readSync, statSync } from 'node:fs'

// The confirming reply frame comes right after the intake, so the intake line sits near the end of the transcript.
const TAIL_BYTES = 256 * 1024

function transcriptTail({ path }: { path: string }) {
  const size = statSync(path).size
  const start = Math.max(
    0,
    size - TAIL_BYTES,
  )
  const buffer = Buffer.alloc(size - start)
  const file = openSync(
    path,
    'r',
  )

  try {
    readSync(
      file,
      buffer,
      0,
      buffer.length,
      start,
    )
  } finally {
    closeSync(file)
  }

  return buffer.toString('utf8')
}

// When Claude Code took a message, by its own transcript: the user line of a message that opens a turn, or the
// queue removal of one folded into a running turn. The queued_command attachment's own time is when it was queued.
export function claudeIntake({
  path,
  uuid,
}: {
  path: string
  uuid: string
}): string | undefined {
  let text: string

  try {
    text = transcriptTail({ path })
  } catch {
    // No transcript yet: the receipt keeps the time Pnyx heard of it.
    return undefined
  }

  for (const line of text.split('\n').toReversed()) {
    if (!line.includes(uuid)) {
      continue
    }

    let record: Record<string, unknown>

    try {
      record = JSON.parse(line) as Record<string, unknown>
    } catch {
      // The tail can start mid-line.
      continue
    }

    const folded = record.type === 'queue-operation' && record.operation === 'remove'
      && record.reason === 'absorbed_mid_turn' && record.commandUuid === uuid
    const opened = record.type === 'user' && record.uuid === uuid

    if ((folded || opened) && typeof record.timestamp === 'string') {
      return record.timestamp
    }
  }

  return undefined
}
