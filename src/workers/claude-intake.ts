import { closeSync, openSync, readSync, statSync } from 'node:fs'
import { log } from '#app/diagnostics.ts'

export interface Intake {
  uuid: string
  at: string
  // Folded into a running turn rather than opening one.
  folded: boolean
}

function fileSize({ path }: { path: string }) {
  try {
    return statSync(path).size
  } catch (error) {
    // Claude Code creates the transcript with its first line.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return 0
    }

    throw error
  }
}

// The intake only times a receipt and the SDK still confirms the message, so a transcript Pnyx cannot read is logged,
// never thrown into the agent's turn.
const unreadable = ({ error }: { error: unknown }) => log({
  level: 'warn',
  operation: 'claude.intake',
  error,
})

function readFrom({
  path,
  start,
  end,
}: {
  path: string
  start: number
  end: number
}) {
  const buffer = Buffer.alloc(end - start)
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

function intakeOf({
  line,
  pending,
}: {
  line: string
  pending: Set<string>
}): Intake | undefined {
  if (![...pending].some(uuid => line.includes(uuid))) {
    return undefined
  }

  let record: Record<string, unknown>

  try {
    record = JSON.parse(line) as Record<string, unknown>
  } catch {
    // A complete line that is not JSON is not an intake; an unfinished one waits in partial.
    return undefined
  }

  if (typeof record.timestamp !== 'string') {
    return undefined
  }

  const command = record.commandUuid
  const absorbed = record.type === 'queue-operation' && record.operation === 'remove'
    && record.reason === 'absorbed_mid_turn'

  if (absorbed && typeof command === 'string' && pending.has(command)) {
    return {
      uuid: command,
      at: record.timestamp,
      folded: true,
    }
  }

  const uuid = record.uuid

  if (record.type === 'user' && typeof uuid === 'string' && pending.has(uuid)) {
    return {
      uuid,
      at: record.timestamp,
      folded: false,
    }
  }

  return undefined
}

// When Claude Code took each message, by its own transcript: the user line of a message that opens a turn, or the queue removal of one folded into a running turn (its queued_command attachment's time is when it was queued). Reads only what Claude Code appended since the message was handed over.
export function watchIntake({ path }: { path: string }) {
  const pending = new Set<string>()
  let offset: number | undefined
  let partial = ''

  const read = (): Intake[] => {
    if (!pending.size || offset === undefined) {
      return []
    }

    const end = fileSize({ path })

    if (end <= offset) {
      return []
    }

    const lines = (partial + readFrom({
      path,
      start: offset,
      end,
    })).split('\n')
    offset = end
    partial = lines.pop() ?? ''
    const found = lines.flatMap(line => {
      const intake = intakeOf({
        line,
        pending,
      })

      return intake ? [intake] : []
    })

    for (const intake of found) {
      pending.delete(intake.uuid)
    }

    return found
  }

  return {
    expect: ({ uuid }: { uuid: string }) => {
      // Nothing earlier can be its intake, so the scan starts where the transcript ends now.
      if (!pending.size) {
        partial = ''

        try {
          offset = fileSize({ path })
        } catch (error) {
          offset = undefined
          unreadable({ error })
        }
      }

      pending.add(uuid)
    },
    taken: (): Intake[] => {
      try {
        return read()
      } catch (error) {
        // These messages are confirmed by the SDK alone, so a failing transcript is not read again on every frame.
        pending.clear()
        unreadable({ error })

        return []
      }
    },
  }
}
