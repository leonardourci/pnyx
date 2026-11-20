import { hydraDir } from '#app/home-migration.ts'
import { once } from 'node:events'
import { hydraRemoval, infoPath, processStart } from '#app/server-state.ts'
import { spawn } from 'node:child_process'
import { stopOldHost, trackChildren } from '#workers/children.ts'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pnyxHome } from '#store/storage.ts'
import { beforeAll, expect, test } from 'vitest'
import { rows, startPnyx, until, type Hydra, type Pnyx } from './setup/pnyx.ts'
import { legacyDuplicate } from './setup/legacy.ts'
import { git } from './setup/upgrade.ts'

let pnyx: Pnyx
beforeAll(async () => {
  pnyx = await startPnyx()
})

function projectFolder({
  hydra,
  name,
}: {
  hydra: Hydra
  name: string
}) {
  const folder = hydra.folder({ name })
  git({
    cwd: folder,
    args: [
      'init',
      '-b',
      'main',
    ],
  })
  writeFileSync(
    join(
      folder,
      'source.txt',
    ),
    'base',
  )
  git({
    cwd: folder,
    args: [
      'add',
      '.',
    ],
  })
  git({
    cwd: folder,
    args: [
      'commit',
      '-m',
      'base',
    ],
  })

  return folder
}

function landWork({
  copy,
  project,
}: {
  copy: string
  project: string
}) {
  git({
    cwd: copy,
    args: [
      'add',
      '--all',
      '--force',
      '.',
    ],
  })
  const changed = git({
    cwd: copy,
    args: [
      'status',
      '--porcelain',
    ],
  })

  if (changed.trim()) {
    git({
      cwd: copy,
      args: [
        'commit',
        '-m',
        'Land fixture work',
      ],
    })
  }

  const head = git({
    cwd: copy,
    args: [
      'rev-parse',
      'HEAD',
    ],
  }).trim()
  git({
    cwd: project,
    args: [
      'merge',
      '--no-edit',
      head,
    ],
  })
}

test(
  'removal protects unlanded copies then runs directly, detaches its projects and keeps history searchable after restart',
  async () => {
    const caller = await pnyx.hydra()
    const target = await pnyx.hydra({
      id: 'default',
      create: false,
    })
    const folder = projectFolder({
      hydra: target,
      name: 'shared',
    })

    await target.owner({
      args: [
        'project',
        'add',
        folder,
        '--landing',
        'branch',
      ],
    })
    const shared = await legacyDuplicate({
      pnyx,
      id: 'legacy-reader',
      projects: [
        {
          path: folder,
          landing: 'branch',
        },
      ],
    })

    await target.owner({
      args: [
        'task',
        'create',
        '--no-start',
        '--key',
        'lost',
        '--title',
        'Unlanded narwhal',
        '--project',
        folder,
      ],
    })
    const started = await target.owner({
      args: [
        'task',
        'start',
        'lost',
      ],
    })
    const copy = started.agent.folder as string
    const worker = await target.agent({ cwd: copy })
    writeFileSync(
      join(
        copy,
        'unlanded.txt',
      ),
      'discard this',
    )
    await target.owner({
      args: [
        'link',
        'lost',
        '--url',
        'https://github.com/o/shop/pull/999',
        '--state',
        'open',
      ],
    })
    await target.owner({
      args: [
        'task',
        'create',
        '--no-start',
        '--key',
        'moved',
        '--title',
        'Moved',
        '--project',
        folder,
      ],
    })
    const movedCopy = (await target.owner({
      args: [
        'task',
        'start',
        'moved',
      ],
    })).agent.folder as string
    await target.owner({
      args: [
        'task',
        'stop',
        'moved',
      ],
    })
    await target.owner({
      args: [
        'task',
        'move',
        'moved',
        '--to-hydra',
        shared.id,
      ],
    })
    writeFileSync(
      join(
        movedCopy,
        'moved.txt',
      ),
      'surviving work',
    )
    await target.owner({
      args: [
        'task',
        'create',
        '--no-start',
        '--key',
        'pooled',
        '--title',
        'Pooled',
        '--project',
        folder,
      ],
    })
    const pooled = (await target.owner({
      args: [
        'task',
        'start',
        'pooled',
      ],
    })).agent.folder as string
    await target.owner({
      args: [
        'task',
        'copy',
        'pooled',
        'remove',
        '--safe',
      ],
    })
    expect((await target.owner({
      args: [
        'task',
        'copy',
        'pooled',
      ],
    })).copy.state).toBe('removed')
    expect(existsSync(pooled)).toBe(true)
    await shared.owner({
      args: [
        'task',
        'create',
        '--no-start',
        '--key',
        'neighbor',
        '--title',
        'Neighbor',
        '--project',
        folder,
      ],
    })
    const neighbor = (await shared.owner({
      args: [
        'task',
        'start',
        'neighbor',
      ],
    })).agent.folder as string

    writeFileSync(
      join(
        neighbor,
        'neighbor.txt',
      ),
      'keep this work',
    )

    writeFileSync(
      join(
        pooled,
        'dirty-pool.txt',
      ),
      'unrecorded work',
    )
    const unrelatedFile = join(
      pooled,
      '..',
      'outside-checkouts.txt',
    )
    writeFileSync(
      unrelatedFile,
      'keep this file',
    )

    const session = await caller.chat({ text: 'remove the other Hydra' })
    const unsafe = await caller.as({ session }).refused({
      args: [
        'hydra',
        'remove',
        target.id,
      ],
    })
    expect(unsafe.code).toBe('CONFLICT')
    expect(unsafe.error).toContain('unlanded')
    expect((await caller.ownerRefused({
      args: [
        'hydra',
        'remove',
        target.id,
      ],
    })).code).toBe('CONFLICT')
    expect(existsSync(copy)).toBe(true)
    landWork({
      copy,
      project: folder,
    })
    landWork({
      copy: pooled,
      project: folder,
    })
    await caller.owner({
      args: [
        'hydra',
        'remove',
        target.id,
      ],
    })
    expect(existsSync(copy)).toBe(false)
    expect(existsSync(pooled)).toBe(false)
    expect(existsSync(neighbor)).toBe(true)
    expect(readFileSync(
      unrelatedFile,
      'utf8',
    )).toBe('keep this file')
    expect(readFileSync(
      join(
        movedCopy,
        'moved.txt',
      ),
      'utf8',
    )).toBe('surviving work')
    expect(readFileSync(
      join(
        neighbor,
        'neighbor.txt',
      ),
      'utf8',
    )).toBe('keep this work')
    expect(readFileSync(
      join(
        folder,
        'source.txt',
      ),
      'utf8',
    )).toBe('base')
    expect(existsSync(folder)).toBe(true)
    const worktrees = git({
      cwd: folder,
      args: [
        'worktree',
        'list',
        '--porcelain',
      ],
    })
    expect(worktrees).not.toContain(pooled)
    expect(worktrees).toContain(neighbor)
    expect(worktrees).toContain(movedCopy)
    expect(worker.closed).toBe(true)
    const advertised = JSON.parse(readFileSync(
      infoPath(),
      'utf8',
    )).url
    expect(new URL(advertised).pathname).toBe('/')
    const response = await fetch(advertised)
    expect(response.status).toBe(200)
    expect(new URL(response.url).pathname).not.toBe(`/hydra/${target.id}/`)

    expect((await caller.owner({
      args: [
        'hydra',
        'list',
      ],
    })).hydras.some((hydra: { id: string }) => hydra.id === target.id)).toBe(false)
    expect((await shared.owner({
      args: [
        'project',
        'show',
        folder,
      ],
    })).project).toBeDefined()
    expect(rows({
      text: 'select data from events where hydra_id = $1 and type = \'task.created\'',
      values: [target.id],
    })).toHaveLength(3)
    expect(rows<{ config: { removed: boolean } }>({
      text: 'select config from hydras where id = $1',
      values: [target.id],
    })[0]?.config.removed).toBe(true)
    await pnyx.restart()
    expect((await caller.owner({
      args: [
        'hydra',
        'list',
      ],
    })).hydras.some((hydra: { id: string }) => hydra.id === target.id)).toBe(false)
    expect((await target.owner({
      args: [
        'oracle',
        'narwhal',
      ],
    })).results.length).toBeGreaterThan(0)
    expect((await target.ownerRefused({
      args: [
        'task',
        'create',
        '--no-start',
        '--title',
        'resurrection',
      ],
    })).code).toBe('NOT_FOUND')
  },
)

test(
  'removal runs for the caller and page without confirmation',
  async () => {
    const caller = await pnyx.hydra()
    const target = await pnyx.hydra()
    const page = await caller.page()
    const result = await page.send({
      name: 'hydra',
      args: [
        'remove',
        target.id,
      ],
    })
    expect(result).toMatchObject({
      type: 'receipt',
      removed: target.id,
    })
    expect(result).not.toHaveProperty('confirmation')
    page.close()
    const own = await caller.owner({
      args: [
        'hydra',
        'remove',
        caller.id,
      ],
    })
    expect(own.removed).toBe(caller.id)
    expect(own.notices).toBeDefined()
  },
)

test(
  'permanent child cleanup stops worker processes and tools with no task assignment',
  async ({ onTestFinished }) => {
    const hydra = await pnyx.hydra()
    const children = trackChildren({ hydraId: hydra.id })
    const worker = spawn(
      process.execPath,
      [
        '-e',
        'setInterval(() => {}, 1000)',
      ],
      {
        detached: true,
        stdio: 'ignore',
      },
    )
    const helper = spawn(
      process.execPath,
      [
        '-e',
        'setInterval(() => {}, 1000)',
      ],
      {
        detached: true,
        stdio: 'ignore',
      },
    )
    onTestFinished(async () => {
      await Promise.all([
        worker,
        helper,
      ].map(async child => {
        if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) {
          return
        }

        child.kill('SIGKILL')
        await until({
          what: 'the test child to exit',
          check: () => child.exitCode !== null || child.signalCode !== null,
        })
      }))
    })
    children.spawned({ child: worker })
    children.associate({
      pid: worker.pid!,
      task: 'worker',
    })
    children.spawned({ child: helper })
    await trackChildren({ hydraId: hydra.id }).stopAll()
    await until({
      what: 'the task worker to exit',
      check: () => worker.exitCode !== null || worker.signalCode !== null,
    })
    await until({
      what: 'unassigned helper tools to exit',
      check: () => helper.exitCode !== null || helper.signalCode !== null,
    })
  },
)

test(
  'a legacy host recorded as a single process is stopped',
  async ({ onTestFinished }) => {
    const folder = join(
      pnyxHome(),
      'native',
    )
    const path = join(
      folder,
      'owner.json',
    )
    mkdirSync(
      folder,
      { recursive: true },
    )
    const child = spawn(
      process.execPath,
      [
        '-e',
        'setInterval(() => {}, 1000)',
      ],
      { stdio: 'ignore' },
    )
    onTestFinished(() => {
      child.kill('SIGKILL')
      rmSync(
        path,
        { force: true },
      )
    })
    const pid = child.pid

    if (pid === undefined) {
      throw new Error('The legacy host did not start')
    }

    const start = processStart({
      pid,
      localTime: true,
    })
    expect(start).not.toBeNull()
    writeFileSync(
      path,
      JSON.stringify({
        pid,
        start,
      }),
    )
    await stopOldHost()
    await until({
      what: 'the legacy host to exit',
      check: () => child.exitCode !== null || child.signalCode !== null,
    })
  },
)

test(
  'a partial removal fences writes and resumes after restart without recreating discarded copies',
  async () => {
    const caller = await pnyx.hydra()
    const target = await pnyx.hydra()
    const folder = projectFolder({
      hydra: target,
      name: 'recovery',
    })
    await target.owner({
      args: [
        'project',
        'add',
        folder,
        '--landing',
        'branch',
      ],
    })
    await target.owner({
      args: [
        'task',
        'create',
        '--no-start',
        '--key',
        'first',
        '--title',
        'First',
        '--project',
        folder,
      ],
    })
    const first = (await target.owner({
      args: [
        'task',
        'start',
        'first',
      ],
    })).agent.folder as string
    await target.owner({
      args: [
        'task',
        'create',
        '--no-start',
        '--key',
        'locked',
        '--title',
        'Locked',
        '--project',
        folder,
      ],
    })
    const locked = (await target.owner({
      args: [
        'task',
        'start',
        'locked',
      ],
    })).agent.folder as string
    await target.owner({
      args: [
        'task',
        'copy',
        'locked',
        'remove',
        '--safe',
      ],
    })
    expect(existsSync(locked)).toBe(true)
    git({
      cwd: folder,
      args: [
        'worktree',
        'lock',
        locked,
      ],
    })
    const failed = await caller.ownerRefused({
      args: [
        'hydra',
        'remove',
        target.id,
      ],
    })
    expect(failed.code).toBe('CONFLICT')
    expect(failed.error).toContain('git could not remove')
    expect(existsSync(first)).toBe(false)
    expect(existsSync(locked)).toBe(true)
    expect((await target.ownerRefused({
      args: [
        'task',
        'create',
        '--no-start',
        '--title',
        'Competing write',
      ],
    })).code).toBe('CONFLICT')
    await pnyx.restart()
    expect(existsSync(first)).toBe(false)
    expect(existsSync(locked)).toBe(true)
    expect((await target.ownerRefused({
      args: [
        'task',
        'create',
        '--no-start',
        '--title',
        'Competing write after restart',
      ],
    })).code).toBe('CONFLICT')
    expect((await caller.owner({
      args: [
        'hydra',
        'list',
      ],
    })).hydras).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: caller.id }),
      expect.objectContaining({ id: target.id }),
    ]))
    const legacy = await legacyDuplicate({
      pnyx,
      id: `recovery-${target.id}`,
      projects: [
        {
          path: folder,
          landing: 'branch',
        },
      ],
    })
    git({
      cwd: folder,
      args: [
        'worktree',
        'unlock',
        locked,
      ],
    })
    await pnyx.restart({
      whileStopped: () => {
        rows({
          text: 'delete from hydras where id = $1',
          values: [legacy.id],
        })
      },
    })
    expect(existsSync(locked)).toBe(false)
    expect(git({
      cwd: folder,
      args: [
        'worktree',
        'list',
        '--porcelain',
      ],
    })).not.toContain(locked)
    expect((await caller.owner({
      args: [
        'hydra',
        'list',
      ],
    })).hydras.some((hydra: { id: string }) => hydra.id === target.id)).toBe(false)
  },
)

test(
  'new ignored work written while stopping tools keeps the copy until a direct retry',
  async ({ onTestFinished }) => {
    const caller = await pnyx.hydra()
    const target = await pnyx.hydra()
    const folder = projectFolder({
      hydra: target,
      name: 'changed-work',
    })
    await target.owner({
      args: [
        'project',
        'add',
        folder,
        '--landing',
        'branch',
      ],
    })
    await target.owner({
      args: [
        'task',
        'create',
        '--no-start',
        '--key',
        'changed',
        '--title',
        'Changed',
        '--project',
        folder,
      ],
    })
    const copy = (await target.owner({
      args: [
        'task',
        'start',
        'changed',
      ],
    })).agent.folder as string
    writeFileSync(
      join(
        copy,
        '.gitignore',
      ),
      'new-work.txt\n',
    )
    landWork({
      copy,
      project: folder,
    })
    const workPath = join(
      copy,
      'new-work.txt',
    )
    const tool = spawn(
      process.execPath,
      [
        '-e',
        "process.once('SIGTERM', () => { require('node:fs').writeFileSync(process.argv[1], 'keep new work'); process.exit(0) }); process.send('ready'); setInterval(() => {}, 1000)",
        workPath,
      ],
      {
        detached: true,
        stdio: [
          'ignore',
          'ignore',
          'ignore',
          'ipc',
        ],
      },
    )
    onTestFinished(() => {
      tool.kill('SIGKILL')
    })
    await once(
      tool,
      'message',
    )
    trackChildren({ hydraId: target.id }).spawned({ child: tool })
    const refused = await caller.ownerRefused({
      args: [
        'hydra',
        'remove',
        target.id,
      ],
    })
    expect(refused.code).toBe('CONFLICT')
    expect(refused.error).toContain('Checkout work changed')
    expect(readFileSync(
      workPath,
      'utf8',
    )).toBe('keep new work')
    await target.owner({
      args: [
        'task',
        'create',
        '--no-start',
        '--title',
        'Created after removal refusal',
      ],
    })
    await pnyx.restart()
    expect(existsSync(copy)).toBe(true)
    landWork({
      copy,
      project: folder,
    })
    await caller.owner({
      args: [
        'hydra',
        'remove',
        target.id,
      ],
    })
    expect(existsSync(copy)).toBe(false)
  },
)

test(
  'command copies cannot contain another registered source project',
  async () => {
    const target = await pnyx.hydra()
    const folder = projectFolder({
      hydra: target,
      name: 'command-project',
    })
    const nested = projectFolder({
      hydra: target,
      name: 'copy-container/source',
    })
    const root = join(
      nested,
      '..',
    )
    await target.owner({
      args: [
        'project',
        'add',
        nested,
      ],
    })
    await target.owner({
      args: [
        'project',
        'add',
        folder,
      ],
    })
    await target.owner({
      args: [
        'project',
        'set',
        folder,
        '--copy',
        `printf '%s\n' '${root}'`,
      ],
    })
    await target.owner({
      args: [
        'task',
        'create',
        '--no-start',
        '--key',
        'unsafe',
        '--title',
        'Unsafe copy',
        '--project',
        folder,
      ],
    })
    const refusal = await target.ownerRefused({
      args: [
        'task',
        'start',
        'unsafe',
      ],
    })
    expect(refusal.code).toBe('CONFLICT')
    expect(refusal.error).toContain('contains a project')
    expect(readFileSync(
      join(
        nested,
        'source.txt',
      ),
      'utf8',
    )).toBe('base')
  },
)

test(
  'daemon shutdown joins a permanent close while its tools stop',
  async ({ onTestFinished }) => {
    const target = await pnyx.hydra()
    const child = spawn(
      process.execPath,
      [
        '-e',
        "process.on('SIGTERM', () => process.send('stopping')); process.send('ready'); setInterval(() => {}, 1000)",
      ],
      {
        detached: true,
        stdio: [
          'ignore',
          'ignore',
          'ignore',
          'ipc',
        ],
      },
    )
    onTestFinished(() => {
      child.kill('SIGKILL')
    })
    await once(
      child,
      'message',
    )
    trackChildren({ hydraId: target.id }).spawned({ child })
    const stopping = once(
      child,
      'message',
    )
    const permanent = hydraRemoval.close!({ hydraId: target.id })
    await stopping
    await pnyx.restart({
      whileStopped: () => {
        expect(child.exitCode !== null || child.signalCode !== null).toBe(true)
      },
    })
    await permanent
  },
)

test(
  'failed tool shutdown keeps copies and a retry stops persisted tools before deleting',
  async ({ onTestFinished }) => {
    const caller = await pnyx.hydra()
    const target = await pnyx.hydra()
    const folder = projectFolder({
      hydra: target,
      name: 'stop-retry',
    })
    await target.owner({
      args: [
        'project',
        'add',
        folder,
        '--landing',
        'branch',
      ],
    })
    await target.owner({
      args: [
        'task',
        'create',
        '--no-start',
        '--key',
        'retry',
        '--title',
        'Retry',
        '--project',
        folder,
      ],
    })
    const copy = (await target.owner({
      args: [
        'task',
        'start',
        'retry',
      ],
    })).agent.folder as string
    const child = spawn(
      process.execPath,
      [
        '-e',
        'setInterval(() => {}, 1000)',
      ],
      {
        detached: true,
        stdio: 'ignore',
      },
    )
    onTestFinished(() => {
      child.kill('SIGKILL')
    })
    trackChildren({ hydraId: target.id }).spawned({ child })
    const path = join(
      hydraDir({ hydraId: target.id }),
      'children.json',
    )
    const recorded = readFileSync(
      path,
      'utf8',
    )
    writeFileSync(
      path,
      JSON.stringify([{ pid: child.pid }]),
    )
    const refused = await caller.ownerRefused({
      args: [
        'hydra',
        'remove',
        target.id,
      ],
    })
    expect(refused.error).toContain('Cannot verify recorded processes')
    expect(existsSync(copy)).toBe(true)
    expect(child.exitCode).toBe(null)
    writeFileSync(
      path,
      recorded,
    )
    writeFileSync(
      join(
        copy,
        'work-after-failed-stop.txt',
      ),
      'included in the retry preview',
    )
    landWork({
      copy,
      project: folder,
    })
    await caller.owner({
      args: [
        'hydra',
        'remove',
        target.id,
      ],
    })
    expect(existsSync(copy)).toBe(false)
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true)
  },
)
