import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { HydraSummary } from '#app/server-hydras.ts'
import { placements } from './hydra-order.ts'

const hydra = ({
  id,
  order,
}: {
  id: string
  order: number
}): HydraSummary => ({
  id,
  name: id,
  order,
  hydra: 'Hydra',
  projects: [],
})

test(
  'a move between spaced neighbors writes only the moved Hydra, at the midpoint',
  () => {
    assert.deepEqual(
      placements({
        hydras: [
          hydra({
            id: 'a',
            order: 1000,
          }),
          hydra({
            id: 'b',
            order: 2000,
          }),
          hydra({
            id: 'c',
            order: 3000,
          }),
        ],
        id: 'c',
        index: 1,
      }),
      [
        {
          id: 'c',
          position: 1500,
        },
      ],
    )
  },
)

test(
  'a move between neighbors with equal keys renumbers the list in its new order',
  () => {
    assert.deepEqual(
      placements({
        hydras: [
          hydra({
            id: 'a',
            order: 1,
          }),
          hydra({
            id: 'b',
            order: 1,
          }),
          hydra({
            id: 'c',
            order: 2,
          }),
        ],
        id: 'c',
        index: 1,
      }),
      [
        {
          id: 'c',
          position: 1001,
        },
        {
          id: 'b',
          position: 2001,
        },
      ],
    )
  },
)
