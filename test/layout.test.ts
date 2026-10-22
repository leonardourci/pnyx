import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { commands } from '../src/cli/commands.ts'
import { emptyHydra, replay } from '../src/core/reducer.ts'
import { DEFAULT_VIEW, patchView, traces, viewFor } from '../src/core/view.ts'
import { loadHydra, readEvents } from '../src/store/hydra-store.ts'
import type { ViewPreferences } from '../src/core/model.ts'

test(
  'briefs, descriptions and layout settings survive event replay without moving the task',
  async () => {
    const home = mkdtempSync(join(
      tmpdir(),
      'pnyx-layout-',
    ))
    process.env.PNYX_HOME = home

    try {
      await commands.task([
        'create',
        '--key',
        'brief',
        '--title',
        'Read the design',
        '--column',
        'parked',
      ])
      await commands.task([
        'brief',
        'brief',
        '--brief',
        'Explain the design in plain English.',
      ])
      await commands.column([
        'describe',
        'parked',
        '--description',
        'Tasks held for a later day.',
      ])
      await commands.view([
        'set',
        '--json',
        JSON.stringify({
          hydraWidth: 420,
          lastMessageOnCards: true,
          focusMode: false,
        }),
      ])
      const { state } = loadHydra({ hydraId: 'default' })
      const events = readEvents({ hydraId: 'default' })
      assert.deepEqual(
        replay({
          state: emptyHydra(),
          events,
        }),
        state,
      )
      assert.equal(
        state.cards[state.keys.brief!]?.brief,
        'Explain the design in plain English.',
      )
      assert.equal(
        state.cards[state.keys.brief!]?.column,
        'parked',
      )
      assert.equal(
        state.config?.columns.find(c => c.id === 'parked')?.description,
        'Tasks held for a later day.',
      )
      assert.equal(
        viewFor({ state }).hydraWidth,
        420,
      )
      assert.equal(
        viewFor({ state }).lastMessageOnCards,
        true,
      )
      assert.deepEqual(
        [
          traces({
            view: viewFor({ state }),
            card: 'c1',
          }).tools,
          traces({
            view: viewFor({ state }),
            card: 'c1',
          }).thinking,
        ],
        [
          true,
          true,
        ],
      )
      const focused = patchView({
        state,
        input: {
          focusMode: true,
          toolDetails: true,
          thinkingDetails: true,
        },
      })
      assert.equal(
        traces({
          view: focused,
          card: 'c1',
        }).tools,
        false,
      )
      assert.equal(
        traces({
          view: focused,
          card: 'c1',
        }).thinking,
        false,
      )
      const legacy = viewFor({
        state: {
          ...state,
          view: undefined,
        },
      })
      assert.equal(
        legacy.lastMessageOnCards,
        DEFAULT_VIEW.lastMessageOnCards,
      )
      await commands.view([
        'set',
        '--json',
        JSON.stringify({
          defaultHydraWidth: 400,
          defaultColumnWidths: { needs_you: 310 },
        }),
      ])
      await commands.layout(['reset'])
      const reset = loadHydra({ hydraId: 'default' }).state
      assert.equal(
        reset.view?.hydraWidth,
        400,
      )
      assert.equal(
        reset.view?.columnWidths.needs_you,
        310,
      )
      assert.deepEqual(
        replay({
          state: emptyHydra(),
          events: readEvents({ hydraId: 'default' }),
        }),
        reset,
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
test(
  'focus mode hides traces for a fresh Hydra and a view saved without it, and an explicit opt-out stays',
  () => {
    const fresh = emptyHydra()

    const shown = ({ view }: { view: ViewPreferences }) => {
      const {
        focus,
        tools,
        thinking,
      } = traces({
        view: viewFor({
          state: {
            ...fresh,
            view,
          },
        }),
        card: 'c1',
      })

      return [
        focus,
        tools,
        thinking,
      ]
    }

    const missing: Partial<ViewPreferences> = structuredClone(DEFAULT_VIEW)
    delete missing.focusMode
    const optedOut = patchView({
      state: fresh,
      input: { focusMode: false },
    })

    assert.equal(
      traces({
        view: viewFor({ state: fresh }),
        card: 'c1',
      }).focus,
      true,
    )
    assert.deepEqual(
      shown({ view: missing as ViewPreferences }),
      [
        true,
        false,
        false,
      ],
    )
    assert.deepEqual(
      shown({ view: optedOut }),
      [
        false,
        true,
        true,
      ],
    )
    assert.equal(
      patchView({
        state: {
          ...fresh,
          view: optedOut,
        },
        input: { fontSize: 16 },
      }).focusMode,
      false,
    )
  },
)
