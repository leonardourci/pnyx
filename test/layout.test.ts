import assert from 'node:assert/strict'
import { test } from 'node:test'
import { emptyHydra } from '../src/core/reducer.ts'
import { DEFAULT_VIEW, patchView, traces, viewFor } from '../src/core/view.ts'
import type { ViewPreferences } from '../src/core/model.ts'

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
