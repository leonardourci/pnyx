import assert from 'node:assert/strict'
import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { commands } from './cli.ts'
import { listHydras } from './server-hydras.ts'

const listed = () => listHydras().map(hydra => hydra.id)

const move = ({
  id,
  position,
}: {
  id: string
  position: string
}) => commands.hydra([
  'set',
  '--hydra',
  id,
  '--position',
  position,
])

test(
  'Hydras list in creation order, and --position moves one',
  () => {
    process.env.PNYX_HOME = realpathSync(mkdtempSync(join(
      tmpdir(),
      'pnyx-hydra-order-',
    )))

    for (const id of [
      'zeta',
      'alpha',
      'mu',
    ]) {
      commands.hydra([
        'create',
        id,
      ])
      // Creation times are in ms; keep them distinct.
      Atomics.wait(
        new Int32Array(new SharedArrayBuffer(4)),
        0,
        0,
        5,
      )
    }

    assert.deepEqual(
      listed(),
      [
        'zeta',
        'alpha',
        'mu',
      ],
    )

    const [
      zeta,
      alpha,
    ] = listHydras()
    move({
      id: 'mu',
      position: String((zeta!.order + alpha!.order) / 2),
    })
    assert.deepEqual(
      listed(),
      [
        'zeta',
        'mu',
        'alpha',
      ],
    )

    move({
      id: 'alpha',
      position: '0',
    })
    assert.deepEqual(
      listed(),
      [
        'alpha',
        'zeta',
        'mu',
      ],
    )

    assert.throws(
      () => move({
        id: 'mu',
        position: 'first',
      }),
      /--position must be a number/,
    )
  },
)
