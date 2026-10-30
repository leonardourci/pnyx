import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
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
          type: 'structured',
          value: id,
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
        'structured',
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
    const saved = readFileSync(
      join(
        directory,
        'outbox.jsonl',
      ),
      'utf8',
    )
    const replayed = recovered.pending()
    await recovered.acknowledge({
      through: recovered.pending().at(-1)!.seq,
      delivered: new Set(recovered.pending().map(fact => fact.seq)),
    })
    assert.deepEqual(
      recovered.pending(),
      [],
    )
    assert.equal(
      readFileSync(
        join(
          directory,
          'outbox.jsonl',
        ),
        'utf8',
      ),
      saved,
    )
    assert.deepEqual(
      output({
        directory,
        session,
      }).pending(),
      replayed,
    )
  },
)

test(
  'view events preserve sequence across the durable outcome barrier',
  async t => {
    const directory = mkdtempSync('/tmp/pnyx-output-order-')
    t.after(() => rmSync(
      directory,
      {
        recursive: true,
        force: true,
      },
    ))
    const stream = output({
      directory,
      session: {
        ref: {
          id: 'session',
          epoch: 'epoch',
        },
        provider: 'codex',
        phase: 'live',
        controllerRevision: 1,
      },
    })
    const received: number[] = []
    stream.subscribe({
      listener: ({ frame }) => {
        received.push(frame.seq)
      },
    })
    stream.publish({
      event: {
        type: 'structured',
        value: 'completed first turn',
      },
    })
    stream.publish({ event: 'working' })
    await stream.flush()
    assert.deepEqual(
      received,
      [
        1,
        2,
      ],
    )
    assert.equal(
      stream.baseline({}).activity,
      'working',
    )
  },
)

test(
  'descriptor saves record live-owner time without advancing a recovered owner cutoff',
  t => {
    const directory = mkdtempSync('/tmp/pnyx-output-alive-')
    t.after(() => rmSync(
      directory,
      {
        recursive: true,
        force: true,
      },
    ))
    t.mock.timers.enable({
      apis: ['Date'],
      now: Date.parse('2026-01-01T00:00:01Z'),
    })
    const session: Summary = {
      ref: {
        id: 'session',
        epoch: 'epoch',
      },
      provider: 'codex',
      phase: 'opening',
      controllerRevision: 0,
    }
    const stream = output({
      directory,
      session,
    })
    const saved = () => JSON.parse(readFileSync(
      join(
        directory,
        'session.json',
      ),
      'utf8',
    ))
    assert.equal(
      saved().lastAliveAt,
      Date.parse('2026-01-01T00:00:01Z'),
    )
    t.mock.timers.tick(2000)
    session.phase = 'live'
    stream.save()
    assert.equal(
      saved().lastAliveAt,
      Date.parse('2026-01-01T00:00:03Z'),
    )
    t.mock.timers.tick(3000)
    session.phase = 'recovery_required'
    stream.save()
    assert.equal(
      saved().lastAliveAt,
      Date.parse('2026-01-01T00:00:03Z'),
    )
    session.phase = 'closed'
    stream.save()
    assert.equal(
      saved().lastAliveAt,
      Date.parse('2026-01-01T00:00:03Z'),
    )
  },
)
