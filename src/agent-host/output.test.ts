import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { output } from './output.ts'
import type { Summary } from './protocol.ts'

test(
  'durable outbox preserves concurrent facts while an acknowledgement is being written',
  async t => {
    const directory = mkdtempSync('/tmp/pnyx-output-')
    t.after(() => rmSync(
      directory,
      {
        recursive: true,
        force: true,
      },
    ))
    const session: Summary = {
      ref: {
        id: 'session',
        epoch: 'original-epoch',
      },
      provider: 'codex',
      phase: 'live',
      controllerRevision: 1,
    }
    const stream = output({
      directory,
      session,
    })

    for (const id of [
      'first',
      'second',
      'third',
    ]) {
      stream.publish({
        event: {
          type: 'input',
          receipt: {
            inputId: id,
            phase: 'queued',
          },
        },
      })
    }

    await stream.flush()
    const original = stream.pending()
    const acknowledgement = stream.acknowledge({
      through: original[1]!.seq,
      delivered: new Set(original.map(fact => fact.seq)),
    })
    stream.publish({
      event: {
        type: 'turn-ended',
        outcome: {
          turn: 'original-turn',
          inputIds: [
            'first',
            'second',
          ],
          status: 'completed',
          at: '2026-10-29T12:00:00.000Z',
          assistant: [],
          result: 'durable result',
        },
      },
    })
    stream.publish({
      event: {
        type: 'ended',
        reason: 'closed',
      },
    })
    await Promise.all([
      acknowledgement,
      stream.flush(),
    ])
    const recovered = output({
      directory,
      session,
    })
    assert.deepEqual(
      recovered.pending().map(fact => fact.event.type),
      [
        'input',
        'turn-ended',
        'ended',
      ],
    )
    const completion = recovered.pending()[1]!
    assert.equal(
      completion.event.type,
      'turn-ended',
    )

    if (completion.event.type === 'turn-ended') {
      assert.equal(
        completion.event.outcome.at,
        '2026-10-29T12:00:00.000Z',
      )
      assert.equal(
        completion.event.outcome.result,
        'durable result',
      )
    }

    assert.deepEqual(
      completion.ref,
      session.ref,
    )
    assert.equal(
      statSync(join(
        directory,
        'outbox.jsonl',
      )).mode & 0o777,
      0o600,
    )
    await recovered.acknowledge({
      through: recovered.pending().at(-1)!.seq,
      delivered: new Set(recovered.pending().map(fact => fact.seq)),
    })
    assert.deepEqual(
      output({
        directory,
        session,
      }).pending(),
      [],
    )
  },
)
