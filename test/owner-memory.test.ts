import assert from 'node:assert/strict'
import { appendFileSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { commands } from '../src/cli/commands.ts'
import { workerCommands } from '../src/cli/workers.ts'
import { hydraEvent } from '../src/core/hydra.ts'
import { withWriter } from '../src/app/writer.ts'
import { loadHydra } from '../src/app/store.ts'
import { hydraDir } from '../src/app/home-migration.ts'
import { readEvents } from '../src/app/event-log.ts'
import { mergeLines, ownerMemory } from '../src/store/owner-memory.ts'

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
function oldMemory({
  hydraId,
  key,
  text,
}: {
  hydraId: string
  key: string
  text: string
}) {
  withWriter({
    hydraId,
    create: true,
    fn: ({ writer }) => {
      const d = hydraEvent({
        state: writer.state,
        meta: {
          at: '2026-10-01T00:00:00Z',
          actor: 'hydra',
        },
        cardId: '$board',
        change: {
          type: 'hydra.memory',
          data: {
            key,
            before: writer.state.hydraMemory?.[key]?.text ?? null,
            after: text,
          },
        },
      })

      if ('event' in d) {
        writer.append({ event: d.event })
      }
    },
  })
}

const digest = ({ hydraId }: { hydraId: string }) => workerCommands.hydra([
  'digest',
  '--hydra',
  hydraId,
]) as unknown as string

test(
  'merging preferences keeps every line once',
  () => {
    assert.equal(
      mergeLines({
        texts: [
          'Short PRs.\n\nAsk before deploys.',
          'short  PRs.\nAnswer in English.  ',
          '',
        ],
      }),
      'Short PRs.\nAsk before deploys.\nAnswer in English.',
    )
  },
)

test(
  'the first run moves each Hydra’s preferences and learnings into owner memory and forgets them there',
  async () => {
    const dir = home()

    oldMemory({
      hydraId: 'alpha',
      key: 'preferences',
      text: 'Short PRs.\nAsk before deploys.',
    })
    oldMemory({
      hydraId: 'alpha',
      key: 'learnings',
      text: 'CI takes ten minutes.',
    })
    oldMemory({
      hydraId: 'beta',
      key: 'preferences',
      text: 'Ask before deploys.\nAnswer in English.',
    })
    oldMemory({
      hydraId: 'gamma',
      key: 'check-cursor',
      text: '12',
    })
    const untouched = readEvents({ hydraId: 'gamma' }).length

    assert.match(
      digest({ hydraId: 'gamma' }),
      /Owner preferences \(owner memory key preferences\):\nShort PRs\.\nAsk before deploys\.\nAnswer in English\.\n/,
    )
    assert.ok(existsSync(join(
      dir,
      'owner',
      'migrated',
    )))

    for (const hydraId of [
      'alpha',
      'beta',
    ]) {
      assert.ok(readEvents({ hydraId }).some(e => e.type === 'hydra.memory' && e.actor === 'pnyx'
        && e.data.key === 'preferences' && e.data.after === null && e.data.before !== null))
    }

    assert.deepEqual(
      Object.keys(loadHydra({ hydraId: 'alpha' }).state.hydraMemory ?? {}),
      [],
    )
    assert.equal(
      ownerMemory().learnings?.text,
      'CI takes ten minutes.',
    )
    assert.equal(
      readEvents({ hydraId: 'gamma' }).length,
      untouched,
    )

    const log = readFileSync(
      join(
        dir,
        'owner',
        'memory.jsonl',
      ),
      'utf8',
    ).trim()
      .split('\n')
      .map(line => JSON.parse(line) as {
        reason: string
        after: string
      })
    assert.deepEqual(
      log.map(entry => entry.reason),
      [
        'Moved preferences from Hydra alpha',
        'Moved learnings from Hydra alpha',
        'Moved preferences from Hydra beta',
      ],
    )

    // A later run finds the marker and leaves owner memory alone.
    oldMemory({
      hydraId: 'beta',
      key: 'preferences',
      text: 'Written by an older server.',
    })
    assert.doesNotMatch(
      ownerMemory().preferences?.text ?? '',
      /older server/,
    )
  },
)

test(
  'a run cut short repeats without duplicating moved lines',
  () => {
    const dir = home()

    oldMemory({
      hydraId: 'alpha',
      key: 'preferences',
      text: 'Short PRs.',
    })
    ownerMemory()
    rmSync(join(
      dir,
      'owner',
      'migrated',
    ))
    oldMemory({
      hydraId: 'beta',
      key: 'preferences',
      text: 'Short PRs.\nAnswer in English.',
    })
    assert.equal(
      ownerMemory().preferences?.text,
      'Short PRs.\nAnswer in English.',
    )
  },
)

test(
  'a Hydra that cannot be moved keeps its preferences, leaves no marker and moves on the next read',
  () => {
    const dir = home()
    const lock = () => join(
      hydraDir({ hydraId: 'beta' }),
      'writer.lock',
    )

    oldMemory({
      hydraId: 'alpha',
      key: 'preferences',
      text: 'Short PRs.',
    })
    oldMemory({
      hydraId: 'beta',
      key: 'preferences',
      text: 'Short PRs.\nAnswer in English.',
    })
    // A live writer holds beta's lock for the whole first read.
    writeFileSync(
      lock(),
      String(process.pid),
    )
    assert.equal(
      ownerMemory().preferences?.text,
      'Short PRs.',
    )
    assert.equal(
      loadHydra({ hydraId: 'beta' }).state.hydraMemory?.preferences?.text,
      'Short PRs.\nAnswer in English.',
    )
    assert.ok(!existsSync(join(
      dir,
      'owner',
      'migrated',
    )))
    rmSync(lock())
    assert.equal(
      ownerMemory().preferences?.text,
      'Short PRs.\nAnswer in English.',
    )
    assert.equal(
      loadHydra({ hydraId: 'beta' }).state.hydraMemory?.preferences,
      undefined,
    )
    assert.ok(existsSync(join(
      dir,
      'owner',
      'migrated',
    )))
  },
)

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
