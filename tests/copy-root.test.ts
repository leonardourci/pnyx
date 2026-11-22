import { existsSync, lstatSync, mkdirSync, readdirSync, renameSync, rmdirSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { beforeAll, expect, test } from 'vitest'
import { startPnyx, type Pnyx } from './setup/pnyx.ts'
import { git } from './setup/upgrade.ts'

let pnyx: Pnyx
beforeAll(async () => {
  pnyx = await startPnyx()
})

test(
  'copy allocation refuses linked roots and leaves linked slots untouched',
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
    git({
      cwd: project,
      args: [
        'worktree',
        'add',
        '-b',
        'outside-preserve',
        outside,
      ],
    })
    const linked = join(
      pool,
      'copy-root-project-1',
    )
    const dangling = join(
      pool,
      'copy-root-project-2',
    )
    symlinkSync(
      outside,
      linked,
      'dir',
    )
    symlinkSync(
      join(
        outside,
        'missing',
      ),
      dangling,
      'dir',
    )
    const started = await hydra.owner({
      args: [
        'task',
        'start',
        'linked-copy',
      ],
    })
    expect(dirname(started.agent.folder)).toBe(pool)
    expect(lstatSync(started.agent.folder).isDirectory()).toBe(true)
    expect(git({
      cwd: outside,
      args: [
        'branch',
        '--show-current',
      ],
    })).toBe('outside-preserve')
    expect(lstatSync(linked).isSymbolicLink()).toBe(true)
    expect(lstatSync(dangling).isSymbolicLink()).toBe(true)

    for (const action of [
      'stop',
      'detach',
    ]) {
      await hydra.owner({
        args: [
          'task',
          action,
          'linked-copy',
        ],
      })
    }

    const parkedPool = `${pool}-parked`
    renameSync(
      pool,
      parkedPool,
    )

    try {
      symlinkSync(
        parkedPool,
        pool,
        'dir',
      )
      expect(await hydra.ownerRefused({
        args: [
          'task',
          'start',
          'linked-copy',
        ],
      })).toMatchObject({
        code: 'CONFLICT',
        error: expect.stringContaining('Copies folder is a symbolic link'),
      })
    } finally {
      if (existsSync(pool)) {
        unlinkSync(pool)
      }

      renameSync(
        parkedPool,
        pool,
      )
    }
  },
)
