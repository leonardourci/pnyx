import { existsSync, lstatSync, mkdirSync, readdirSync, rmdirSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, expect, test } from 'vitest'
import { startPnyx, type Pnyx } from './setup/pnyx.ts'
import { git } from './setup/upgrade.ts'

let pnyx: Pnyx
beforeAll(async () => {
  pnyx = await startPnyx()
})

test(
  'copy allocation refuses a linked pool and skips a dangling slot inside a real pool',
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

    mkdirSync(pool)
    const slot = join(
      pool,
      'copy-root-project-1',
    )
    symlinkSync(
      join(
        outside,
        'missing',
      ),
      slot,
      'dir',
    )
    const started = await hydra.owner({
      args: [
        'task',
        'start',
        'linked-copy',
      ],
    })
    expect(started.agent.folder).toBe(join(
      pool,
      'copy-root-project-2',
    ))
    expect(lstatSync(slot).isSymbolicLink()).toBe(true)
  },
)
