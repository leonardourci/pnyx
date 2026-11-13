import assert from 'node:assert/strict'
import { appendFileSync, closeSync, mkdtempSync, openSync, renameSync, rmSync, writeFileSync, writeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { sessionEntries } from './transcripts-read.ts'

const line = ({ text }: { text: string }) => `${JSON.stringify({
  type: 'assistant',
  timestamp: '2026-11-13T10:00:00.000Z',
  message: {
    content: text,
    stop_reason: 'end_turn',
  },
})}\n`

test(
  'a transcript read again parses only the lines appended since, and a replaced one is read whole',
  t => {
    const dir = mkdtempSync(join(
      tmpdir(),
      'pnyx-session-entries-',
    ))
    t.after(() => rmSync(
      dir,
      {
        recursive: true,
        force: true,
      },
    ))
    const path = join(
      dir,
      'session.jsonl',
    )
    const texts = () => sessionEntries({
      path,
      session: 'claude-code:fixture',
      boundaries: true,
    }).map(entry => entry.text)
    writeFileSync(
      path,
      line({ text: 'First reply' }),
    )
    assert.deepEqual(
      texts(),
      ['First reply'],
    )

    // Rewriting a line already read, in place, shows that it is not parsed again.
    const fd = openSync(
      path,
      'r+',
    )
    writeSync(
      fd,
      line({ text: 'Other reply' }),
      0,
    )
    closeSync(fd)
    appendFileSync(
      path,
      line({ text: 'Second reply' }),
    )
    assert.deepEqual(
      texts(),
      [
        'First reply',
        'Second reply',
      ],
    )

    const replacement = join(
      dir,
      'replacement.jsonl',
    )
    writeFileSync(
      replacement,
      line({ text: 'Replaced reply' }),
    )
    renameSync(
      replacement,
      path,
    )
    assert.deepEqual(
      texts(),
      ['Replaced reply'],
    )
  },
)
