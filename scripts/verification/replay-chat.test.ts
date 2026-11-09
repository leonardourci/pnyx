import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { replayChat } from './replay-chat.ts'

test(
  'replay rejects a current native path without an admitted cursor before reading it',
  t => {
    const archive = mkdtempSync(join(
      tmpdir(),
      'pnyx-replay-admission-',
    ))
    t.after(() => rmSync(
      archive,
      {
        recursive: true,
        force: true,
      },
    ))
    const hydra = join(
      archive,
      'hydras',
      'fixture',
    )
    mkdirSync(
      hydra,
      { recursive: true },
    )
    writeFileSync(
      join(
        hydra,
        'events.jsonl',
      ),
      '',
    )
    writeFileSync(
      join(
        hydra,
        'harvest.json',
      ),
      '{}',
    )
    writeFileSync(
      join(
        hydra,
        'snapshot.json',
      ),
      JSON.stringify({
        offset: 0,
        state: {
          seq: 0,
          cards: {
            $hydra: {
              agent: {
                transcriptPath: join(
                  archive,
                  'unadmitted.jsonl',
                ),
              },
            },
          },
        },
      }),
    )
    assert.throws(
      () => replayChat({
        archive,
        roots: [archive],
      }),
      /no admitted archived cursor/,
    )
  },
)
