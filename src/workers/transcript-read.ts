import { openSync, fstatSync, readSync, closeSync } from 'node:fs'

export interface TranscriptRead {
  identity: string
  // A replaced or truncated file restarts the cursor.
  reset: boolean
  lines: {
    pos: number
    record: unknown
  }[]
  end: number
}

// Complete JSONL lines after the cursor. A replaced file (another device and
// inode) or one shorter than the cursor is read again from the start. Null when
// the file is missing or unreadable, so the cursor waits for it.
// ponytail: reads the unread tail in one buffer; stream it if transcripts grow past memory.
export function readTranscript({
  cursor,
  through,
  maxBytes,
}: {
  cursor: {
    source: string
    identity: string
    pos: number
  }
  through?: number
  maxBytes?: number
}): TranscriptRead | null {
  let fd: number

  try {
    fd = openSync(
      cursor.source,
      'r',
    )
  } catch {
    return null
  }

  try {
    const stat = fstatSync(fd)
    const identity = `${stat.dev}:${stat.ino}`
    const reset = (cursor.identity !== '' && cursor.identity !== identity) || stat.size < cursor.pos
    const from = reset ? 0 : cursor.pos
    const admittedEnd = through ?? stat.size
    const available = Math.max(
      0,
      Math.min(
        stat.size,
        admittedEnd,
      ) - from,
    )
    let buf = Buffer.alloc(Math.min(
      available,
      maxBytes ?? available,
    ))
    readSync(
      fd,
      buf,
      0,
      buf.length,
      from,
    )

    // A batch can exceed its byte budget only to finish its first native record.
    while (!buf.includes(10) && buf.length < available) {
      buf = Buffer.alloc(Math.min(
        available,
        Math.max(
          1,
          buf.length * 2,
        ),
      ))
      readSync(
        fd,
        buf,
        0,
        buf.length,
        from,
      )
    }

    const complete = buf.lastIndexOf(10) + 1
    const lines: TranscriptRead['lines'] = []

    for (let start = 0; start < complete; ) {
      const end = buf.indexOf(
        10,
        start,
      )

      try {
        lines.push({
          pos: from + start,
          record: JSON.parse(buf.toString(
            'utf8',
            start,
            end,
          )),
        })
      } catch {
        // Partial or invalid records have no readable transcript content.
      }

      start = end + 1
    }

    return {
      identity,
      reset,
      lines,
      end: from + complete,
    }
  } finally {
    closeSync(fd)
  }
}
