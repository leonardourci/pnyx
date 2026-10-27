import assert from 'node:assert/strict'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { commands } from '../src/cli/commands.ts'
import { decidePush } from '../src/core/decide.ts'
import { LABEL_COLORS } from '../src/core/model.ts'
import { hydraDir, loadHydra, readEvents, withWriter } from '../src/store/hydra-store.ts'

process.env.PNYX_SEMANTIC = 'off'

function fixture() {
  const home = realpathSync(mkdtempSync(join(
    tmpdir(),
    'pnyx-labels-',
  )))
  process.env.PNYX_HOME = home
  const state = () => loadHydra({ hydraId: 'default' }).state
  const push = ({
    key,
    input,
  }: {
    key: string
    input: unknown
  }) => withWriter({
    hydraId: 'default',
    fn: ({ writer }) => {
      const result = decidePush({
        state: writer.state,
        key,
        input,
        meta: {
          actor: 'test',
          at: '2026-10-15T10:00:00Z',
        },
      })

      if ('event' in result) {
        writer.append({ event: result.event })
      }
    },
  })

  return {
    home,
    state,
    push,
  }
}

test(
  'project and tag colors are saved once, reused across tasks and survive movement and replay',
  () => {
    const {
      home,
      state,
      push,
    } = fixture()

    try {
      push({
        key: 'first',
        input: {
          title: 'First task',
          project: 'payments',
          tags: ['urgent'],
        },
      })
      const colors = state().labelColors
      assert.deepEqual(
        colors?.map(entry => entry.label),
        [
          'payments',
          'urgent',
        ],
      )
      assert.ok(colors?.every(entry => LABEL_COLORS.includes(entry.color)))
      push({
        key: 'second',
        input: {
          project: 'payments',
          tags: ['urgent'],
        },
      })
      commands.move([
        'first',
        'done',
      ])
      push({
        key: 'first',
        input: {
          project: null,
          tags: [],
        },
      })
      push({
        key: 'first',
        input: {
          project: 'payments',
          tags: ['urgent'],
        },
      })
      assert.deepEqual(
        state().labelColors,
        colors,
      )
      const events = readEvents({ hydraId: 'default' })
      assert.equal(
        events.filter(event => event.labelColors?.length).length,
        1,
      )
      assert.deepEqual(
        events[0]?.labelColors,
        colors,
      )
      rmSync(join(
        hydraDir({ hydraId: 'default' }),
        'snapshot.json',
      ))
      assert.deepEqual(
        state().labelColors,
        colors,
      )
    } finally {
      rmSync(
        home,
        {
          recursive: true,
          force: true,
        },
      )
    }
  },
)
