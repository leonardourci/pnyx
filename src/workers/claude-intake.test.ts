import assert from 'node:assert/strict'
import { join } from 'node:path'
import { test } from 'node:test'
import { claudeIntake } from './claude-intake.ts'

const path = join(
  import.meta.dirname,
  'fixtures/claude-intake.jsonl',
)

test(
  'a message that opens a turn is taken at its user line',
  () => {
    assert.equal(
      claudeIntake({
        path,
        uuid: '11111111-1111-4111-8111-111111111111',
      }),
      '2026-11-11T15:54:58.074Z',
    )
  },
)

test(
  'a message that joins a running turn is taken when Claude Code folds it in, not when it was queued',
  () => {
    assert.equal(
      claudeIntake({
        path,
        uuid: '22222222-2222-4222-8222-222222222222',
      }),
      '2026-11-11T15:55:11.710Z',
    )
  },
)

test(
  'an unknown message or a missing transcript has no intake time',
  () => {
    assert.equal(
      claudeIntake({
        path,
        uuid: '33333333-3333-4333-8333-333333333333',
      }),
      undefined,
    )
    assert.equal(
      claudeIntake({
        path: join(
          import.meta.dirname,
          'fixtures/missing.jsonl',
        ),
        uuid: '11111111-1111-4111-8111-111111111111',
      }),
      undefined,
    )
  },
)
