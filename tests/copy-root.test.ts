import { existsSync, readdirSync, rmdirSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, expect, test } from 'vitest'
import { startPnyx, type Pnyx } from './setup/pnyx.ts'
import { git } from './setup/upgrade.ts'

let pnyx: Pnyx
beforeAll(async () => {
  pnyx = await startPnyx()
})

test(
  'a shared copies symlink refuses worker allocation without changing its target',
  async () => {
    const hydra = await pnyx.hydra()
    const project = hydra.folder({ name: 'copy-root-project' })
    writeFileSync(
      join(
        project,
        'README.md',
      ),
      'source',
    )

    for (const args of [
      [
        'init',
        '-b',
        'main',
      ],
      [
        'add',
        '.',
      ],
      [
        'commit',
        '-m',
        'initial',
      ],
    ]) {
      git({
        cwd: project,
        args,
      })
    }

    await hydra.owner({
      args: [
        'project',
        'add',
        project,
      ],
    })
    await hydra.owner({
      args: [
        'task',
        'create',
        '--no-start',
        '--key',
        'linked-copy',
        '--title',
        'Linked copy',
        '--project',
        project,
      ],
    })
    const pool = join(
      process.env.PNYX_HOME!,
      'copies',
    )
    const outside = hydra.folder({ name: 'outside-pool' })

    if (existsSync(pool)) {
      rmdirSync(pool)
    }

    symlinkSync(
      outside,
      pool,
      'dir',
    )

    try {
      const refused = await hydra.ownerRefused({
        args: [
          'task',
          'start',
          'linked-copy',
        ],
      })
      expect(refused).toMatchObject({
        code: 'CONFLICT',
        error: expect.stringContaining('Copies folder is a symbolic link'),
      })
      expect(readdirSync(outside)).toEqual([])
    } finally {
      unlinkSync(pool)
    }
  },
)
