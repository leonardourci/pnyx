import assert from 'node:assert/strict'
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { commands } from '#app/cli.ts'
import { readEvents } from '#app/event-log.ts'
import { withWriter } from '#app/writer.ts'
import { HYDRA_CARD } from '#hydra/identity.ts'
import { decidePush } from '#tasks/push.ts'
import { decideSession } from '#workers/sessions.ts'
import { harvestTranscripts } from './harvest.ts'

test(
  'harvesting records a transcript\'s notes without copying its conversation into the log',
  async t => {
    const home = mkdtempSync(join(
      tmpdir(),
      'pnyx-harvest-',
    ))
    const previous = process.env.PNYX_HOME
    process.env.PNYX_HOME = home
    t.after(() => {
      if (previous === undefined) {
        delete process.env.PNYX_HOME
      } else {
        process.env.PNYX_HOME = previous
      }

      rmSync(
        home,
        {
          recursive: true,
          force: true,
        },
      )
    })
    await commands.hydra([
      'create',
      'fixture',
    ])
    const transcript = join(
      home,
      'session.jsonl',
    )
    cpSync(
      join(
        import.meta.dirname,
        '..',
        '..',
        'hydra',
        'fixtures',
        'transcripts',
        'claude-notes.jsonl',
      ),
      transcript,
    )
    const meta = {
      actor: 'web',
      at: '2026-10-11T09:00:00.000Z',
    }
    withWriter({
      hydraId: 'fixture',
      fn: ({ writer }) => {
        const pushed = decidePush({
          state: writer.state,
          key: HYDRA_CARD,
          input: {
            title: 'Hydra',
            agent: {
              host: 'pnyx',
              provider: 'claude-code',
              sessionId: 'fixture',
              transcriptPath: transcript,
            },
          },
          meta,
        })
        assert.ok('event' in pushed)
        writer.append({ event: pushed.event })
        const attached = decideSession({
          state: writer.state,
          ref: 'claude-code:fixture',
          task: null,
          meta,
        })
        assert.ok('event' in attached)
        writer.append({ event: attached.event })
      },
    })
    await commands.hydra([
      'set',
      '--session',
      'claude-code:fixture',
      '--hydra',
      'fixture',
    ])
    const harvest = () => withWriter({
      hydraId: 'fixture',
      fn: ({ writer }) => {
        return harvestTranscripts({
          writer,
          cardIds: [HYDRA_CARD],
          at: '2026-10-11T10:00:00.000Z',
        })
      },
    })
    assert.ok(harvest() > 0)
    const events = readEvents({ hydraId: 'fixture' })
    assert.ok(events.some(event => event.type === 'card.noted' && event.actor === 'harvest'))
    assert.ok(!events.some(event => event.type === 'chat.message'))
    assert.equal(
      harvest(),
      0,
    )
    assert.ok(!readFileSync(
      join(
        home,
        'hydras',
        'fixture',
        'harvest.json',
      ),
      'utf8',
    ).includes('conversation'))
  },
)
