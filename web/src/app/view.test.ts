import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { HydraState } from '#app/model.ts'
import { pageTitle } from './view.ts'

test(
  'the Settings page is named in the title, which still counts the cards that need the owner',
  () => {
    const cards = {
      a: {
        id: 'a',
        title: 'Quasar export',
        column: 'needs_you',
      },
    } as unknown as HydraState['cards']
    assert.equal(
      pageTitle({
        page: 'settings',
        cards,
        selected: 'a',
      }),
      '(1) Settings · Pnyx',
    )
    assert.equal(
      pageTitle({
        cards,
        selected: 'a',
      }),
      '(1) Quasar export · Pnyx',
    )
  },
)
