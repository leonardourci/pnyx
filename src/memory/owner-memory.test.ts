import assert from 'node:assert/strict'
import { appendFileSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { commands } from '#app/cli.ts'
import { ownerMemory } from './owner-memory.ts'

const scratch = mkdtempSync(join(
  tmpdir(),
  'pnyx-test-',
))
after(() => rmSync(
  scratch,
  {
    recursive: true,
    force: true,
  },
))

function home() {
  const dir = realpathSync(mkdtempSync(join(
    scratch,
    'pnyx-owner-',
  )))
  process.env.PNYX_HOME = dir

  return dir
}

// Writes Hydra memory the way the release before owner memory did, which no longer accepts preferences.

test(
  'a save from an older revision or onto an unreadable log is refused',
  async () => {
    const dir = home()

    const save = ({
      text,
      revision,
    }: {
      text: string
      revision: string
    }) => commands.owner([
      'memory',
      'set',
      '--key',
      'preferences',
      '--text',
      text,
      '--if-revision',
      revision,
    ])

    assert.match(
      JSON.stringify(await commands.owner(['memory'])),
      /"revision":0/,
    )
    await save({
      text: 'Short PRs.',
      revision: '0',
    })
    assert.throws(
      () => save({
        text: 'Long PRs.',
        revision: '0',
      }),
      /revision is 1/,
    )
    appendFileSync(
      join(
        dir,
        'owner',
        'memory.jsonl',
      ),
      '{"torn',
    )
    assert.throws(
      () => save({
        text: 'Long PRs.',
        revision: '1',
      }),
      /unreadable line/,
    )
    assert.equal(
      ownerMemory().preferences?.text,
      'Short PRs.',
    )
  },
)

test(
  'owner worker notes need a reason, stay within their budget and are saved as owner memory',
  async () => {
    home()

    const save = ({ flags }: { flags: string[] }) => commands.owner([
      'worker-notes',
      'set',
      ...flags,
    ])

    await assert.rejects(
      async () => save({
        flags: [
          '--text',
          'Write commits in English.',
        ],
      }),
      { code: 'VALIDATION_ERROR' },
    )
    await assert.rejects(
      async () => save({
        flags: [
          '--text',
          'x'.repeat(1501),
          '--reason',
          'too long',
        ],
      }),
      { code: 'MEMORY_FULL' },
    )
    await assert.rejects(
      async () => commands.owner([
        'worker-notes',
        'save',
        '--reason',
        'not a worker-notes action',
      ]),
      { code: 'VALIDATION_ERROR' },
    )
    assert.equal(
      ownerMemory().workers,
      undefined,
    )

    await save({
      flags: [
        '--text',
        'Write commits in English.',
        '--reason',
        'workers kept asking',
      ],
    })
    assert.equal(
      ownerMemory().workers?.text,
      'Write commits in English.',
    )

    await commands.owner([
      'worker-notes',
      'forget',
      '--reason',
      'no longer needed',
    ])
    assert.equal(
      ownerMemory().workers,
      undefined,
    )
  },
)
