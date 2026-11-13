import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { readTranscript } from './transcript-read.ts'

test(
  'an admitted transcript boundary excludes later records without changing normal tail reads',
  t => {
    const folder = mkdtempSync(join(
      tmpdir(),
      'pnyx-transcript-boundary-',
    ))
    t.after(() => rmSync(
      folder,
      {
        recursive: true,
        force: true,
      },
    ))
    const path = join(
      folder,
      'native.jsonl',
    )
    const prefix = '{"type":"user","message":{"content":"Admitted input"}}\n'
    const through = Buffer.byteLength(prefix)
    writeFileSync(
      path,
      `${prefix}{"type":"user","message":{"content":"Later input"}}\n`,
    )
    const cursor = {
      source: path,
      identity: '',
      pos: 0,
    }
    const bounded = readTranscript({
      cursor,
      through,
    })
    assert.deepEqual(
      bounded?.lines,
      [
        {
          pos: 0,
          record: {
            type: 'user',
            message: { content: 'Admitted input' },
          },
        },
      ],
    )
    assert.equal(
      bounded?.end,
      through,
    )
    assert.equal(
      readTranscript({ cursor })?.lines.length,
      2,
    )
    assert.equal(
      readTranscript({
        cursor,
        through: through + 1,
      })?.end,
      through,
    )
  },
)
