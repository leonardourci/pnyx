import assert from 'node:assert/strict'
import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { commands } from '#app/cli.ts'
import { readEvents } from '#app/event-log.ts'
import { loadHydra } from '#app/store.ts'
import { withWriter } from '#app/writer.ts'
import { taskMention } from '#hydra/mentions.ts'
import { copyTagged } from './tagged-updates.ts'

test(
  'two Hydra turns that finish in the same millisecond both copy their tagged reply',
  () => {
    process.env.PNYX_HOME = realpathSync(mkdtempSync(join(
      tmpdir(),
      'pnyx-tagged-updates-',
    )))
    commands.hydra([
      'create',
      'default',
    ])
    commands.task([
      'create',
      '--key',
      'quick',
      '--title',
      'Task quick',
    ])
    const state = () => loadHydra({ hydraId: 'default' }).state
    const task = state().keys.quick!
    const reply = `${taskMention({
      id: task,
      title: 'Task quick',
    })} Noted.`
    const at = '2026-10-29T00:19:02.599Z'

    const finishTurn = () => withWriter({
      hydraId: 'default',
      fn: ({ writer }) => copyTagged({
        writer,
        texts: [reply],
        asks: [],
        at,
      }),
    })
    finishTurn()
    finishTurn()

    assert.deepEqual(
      readEvents({ hydraId: 'default' }).flatMap(event =>
        event.type === 'card.noted' && event.cardId === task && event.data.source === 'hydra' ? [event.data.text] : []),
      [
        'Noted.',
        'Noted.',
      ],
    )
  },
)
