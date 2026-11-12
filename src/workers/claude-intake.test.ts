import assert from 'node:assert/strict'
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { closeLogs, logsDir, openLogs } from '#app/diagnostics.ts'
import { watchIntake } from './claude-intake.ts'

const OPENS = '11111111-1111-4111-8111-111111111111'
const FOLDED = '22222222-2222-4222-8222-222222222222'
const CANCELLED = '33333333-3333-4333-8333-333333333333'
const lines = readFileSync(
  join(
    import.meta.dirname,
    'fixtures/claude-intake.jsonl',
  ),
  'utf8',
).trim()
  .split('\n')
// Lines in the order Claude Code writes them, each starting with what identifies it.
const line = ({ starts }: { starts: string }) => lines.find(item => item.startsWith(starts))!

test(
  'Claude Code takes an opening message at its user line and a mid-turn one when it folds it in, not when it queued it',
  t => {
    const folder = mkdtempSync(join(
      tmpdir(),
      'claude-intake-',
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
      'session.jsonl',
    )
    writeFileSync(
      path,
      `${line({ starts: '{"type":"queue-operation","operation":"dequeue"' })}\n`,
    )
    const intake = watchIntake({ path })
    intake.expect({ uuid: OPENS })
    intake.expect({ uuid: FOLDED })
    intake.expect({ uuid: CANCELLED })
    const user = line({ starts: '{"parentUuid":null' })
    // Half a line is read again once Claude Code finishes writing it.
    appendFileSync(
      path,
      user.slice(
        0,
        40,
      ),
    )
    assert.deepEqual(
      intake.taken(),
      [],
    )
    appendFileSync(
      path,
      `${user.slice(40)}\n`,
    )
    assert.deepEqual(
      intake.taken(),
      [
        {
          uuid: OPENS,
          at: '2026-11-11T15:54:58.074Z',
          folded: false,
        },
      ],
    )
    // Queued at 15:54:58, folded in at 15:55:11; a removal for another reason is not an intake.
    appendFileSync(
      path,
      `${lines.slice(2).join('\n')}\n`,
    )
    assert.deepEqual(
      intake.taken(),
      [
        {
          uuid: FOLDED,
          at: '2026-11-11T15:55:11.710Z',
          folded: true,
        },
      ],
    )
  },
)

test(
  'a transcript Claude Code has not created yet gives no intake until it appears',
  t => {
    const folder = mkdtempSync(join(
      tmpdir(),
      'claude-intake-',
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
      'session.jsonl',
    )
    const intake = watchIntake({ path })
    intake.expect({ uuid: OPENS })
    assert.deepEqual(
      intake.taken(),
      [],
    )
    writeFileSync(
      path,
      `${line({ starts: '{"parentUuid":null' })}\n`,
    )
    assert.deepEqual(
      intake.taken().map(found => found.uuid),
      [OPENS],
    )
  },
)

test(
  'a transcript Pnyx cannot read is logged and gives no intake, never failing the agent’s turn',
  t => {
    openLogs()
    const folder = mkdtempSync(join(
      tmpdir(),
      'claude-intake-',
    ))
    t.after(() => {
      closeLogs()
      chmodSync(
        folder,
        0o700,
      )
      rmSync(
        folder,
        {
          recursive: true,
          force: true,
        },
      )
    })
    const path = join(
      folder,
      'session.jsonl',
    )
    writeFileSync(
      path,
      '',
    )
    const replaced = watchIntake({ path })
    replaced.expect({ uuid: OPENS })
    // Replaced between the size check and the read, so the read fails.
    rmSync(path)
    mkdirSync(path)
    assert.deepEqual(
      replaced.taken(),
      [],
    )
    // A folder Pnyx may not search is not a transcript that has yet to appear.
    chmodSync(
      folder,
      0o000,
    )
    const hidden = watchIntake({
      path: join(
        folder,
        'other.jsonl',
      ),
    })
    hidden.expect({ uuid: OPENS })
    assert.deepEqual(
      hidden.taken(),
      [],
    )
    closeLogs()
    const warned = readdirSync(logsDir()).flatMap(name => readFileSync(
      join(
        logsDir(),
        name,
      ),
      'utf8',
    ).split('\n'))
      .filter(Boolean)
      .map(text => JSON.parse(text) as Record<string, unknown>)
      .filter(line => line.operation === 'claude.intake')
    assert.deepEqual(
      warned.map(line => line.level),
      [
        'warn',
        'warn',
      ],
    )
  },
)
