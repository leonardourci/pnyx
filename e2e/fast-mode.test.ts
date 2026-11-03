import assert from 'node:assert/strict'
import { test } from 'node:test'
import { openPage, until } from '#test-harness/harness.ts'
import { pnyx } from '#test-harness/pnyx.ts'

test(
  'Fast in Hydra’s composer reaches the workers it starts whose model has Fast, and no others',
  async () => {
    const s = await pnyx.scenario()
    const page = await openPage({
      port: pnyx.port(),
      hydraId: s.hydraId,
    })

    try {
      await page.command({
        name: 'hydra-agent',
        args: [
          JSON.stringify({
            harness: 'claude',
            model: 'opus',
            fast: true,
          }),
        ],
      })
    } finally {
      page.close()
    }

    const start = async ({
      key,
      model,
    }: {
      key: string
      model: string
    }) => {
      const folder = s.folder({ name: key })
      await s.owner({
        args: [
          'rule',
          'set',
          key,
          '--when',
          `Work on ${key}`,
          '--harness',
          'claude',
          '--model',
          model,
        ],
      })
      await s.owner({
        args: [
          'task',
          'create',
          '--key',
          key,
          '--title',
          key,
          '--folder',
          folder,
        ],
      })
      await s.owner({
        args: [
          'task',
          'start',
          key,
          '--rule',
          key,
          '--reason',
          'Check Fast',
        ],
      })
      const worker = await s.agent({ cwd: folder })
      await until({
        what: `the ${key} worker to finish`,
        check: () => s.task({ key }).sessionActivity === 'finished',
      })

      return worker
    }

    assert.equal(
      (await start({
        key: 'quick',
        model: 'opus',
      })).fast,
      true,
    )
    // Sonnet has no Fast tier, so the worker starts without it.
    assert.equal(
      (await start({
        key: 'plain',
        model: 'sonnet',
      })).fast,
      undefined,
    )
  },
)

test(
  'Fast in Hydra’s composer reaches a candidate saved with Fast off, while task start --fast off keeps that start off Fast',
  async () => {
    const s = await pnyx.scenario()
    const page = await openPage({
      port: pnyx.port(),
      hydraId: s.hydraId,
    })

    try {
      await page.command({
        name: 'hydra-agent',
        args: [
          JSON.stringify({
            harness: 'claude',
            model: 'opus',
            fast: true,
          }),
        ],
      })
    } finally {
      page.close()
    }

    await s.owner({
      args: [
        'rule',
        'set',
        'saved-slow',
        '--when',
        'Work without Fast',
        '--harness',
        'claude',
        '--model',
        'opus',
        '--fast',
        'off',
      ],
    })

    const start = async ({
      key,
      flags,
    }: {
      key: string
      flags: string[]
    }) => {
      const folder = s.folder({ name: key })
      await s.owner({
        args: [
          'task',
          'create',
          '--key',
          key,
          '--title',
          key,
          '--folder',
          folder,
        ],
      })
      await s.owner({
        args: [
          'task',
          'start',
          key,
          '--rule',
          'saved-slow',
          ...flags,
          '--reason',
          'Check Fast',
        ],
      })
      const worker = await s.agent({ cwd: folder })
      await until({
        what: `the ${key} worker to finish`,
        check: () => s.task({ key }).sessionActivity === 'finished',
      })

      return worker
    }

    assert.equal(
      (await start({
        key: 'saved-off',
        flags: [],
      })).fast,
      true,
    )
    assert.equal(
      (await start({
        key: 'started-off',
        flags: [
          '--fast',
          'off',
        ],
      })).fast,
      false,
    )
  },
)
