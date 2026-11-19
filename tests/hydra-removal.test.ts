import { spawn } from 'node:child_process'
import { trackChildren } from '#workers/children.ts'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, expect, test } from 'vitest'
import { rows, startPnyx, until, type Hydra, type Pnyx } from './setup/pnyx.ts'
import { legacyDuplicate } from './setup/legacy.ts'
import { git } from './setup/upgrade.ts'

let pnyx: Pnyx
beforeAll(async () => {
  pnyx = await startPnyx()
  const last = await pnyx.hydra({ id: 'default' })
  const refusal = await last.ownerRefused({
    args: [
      'hydra',
      'remove',
      last.id,
    ],
  })
  expect(refusal.code).toBe('CONFLICT')
  expect(refusal.error).toContain('last Hydra')
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

test(
  'removal requires owner confirmation, discards unlanded copies, detaches only its projects and keeps history searchable after restart',
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
    const session = await caller.chat({ text: 'remove the other Hydra' })
    const proposal = await caller.as({ session }).run({
      args: [
        'hydra',
        'remove',
        target.id,
      ],
    })
    expect(proposal.confirmation).toBe('needed')
    expect(proposal.action).toContain('Tasks: 1')
    expect(proposal.action).toContain(copy)
    expect(proposal.action).toContain('https://github.com/o/shop/pull/999')
    expect(existsSync(copy)).toBe(true)
    expect((await caller.as({ session }).refused({
      args: [
        'approval',
        'confirm',
        proposal.token,
        '--confirm',
        proposal.token,
      ],
    })).code).toBe('OWNER_ONLY')
    await caller.owner({
      args: [
        'approval',
        'confirm',
        proposal.token,
        '--confirm',
        proposal.token,
      ],
    })
    expect(existsSync(copy)).toBe(false)
    expect(worker.closed).toBe(true)
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
    })).toHaveLength(1)
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
        '--title',
        'resurrection',
      ],
    })).code).toBe('NOT_FOUND')
  },
)

test(
  'removal refuses the caller and Firstmate, and Settings uses the same confirmation',
  async () => {
    const caller = await pnyx.hydra()
    expect((await caller.ownerRefused({
      args: [
        'hydra',
        'remove',
        caller.id,
      ],
    })).code).toBe('CONFLICT')
    const firstmate = await pnyx.hydra()
    await firstmate.owner({
      args: [
        'hydra',
        'set',
        '--firstmate',
        firstmate.folder({ name: 'home' }),
      ],
    })
    expect((await caller.ownerRefused({
      args: [
        'hydra',
        'remove',
        firstmate.id,
      ],
    })).code).toBe('CONFLICT')
    const target = await pnyx.hydra()
    const page = await caller.page()
    const proposal = await page.send({
      name: 'hydra',
      args: [
        'remove',
        target.id,
      ],
    })

    if (proposal.type !== 'receipt' || typeof proposal.token !== 'string') {
      throw new Error('Expected a command receipt')
    }

    expect(proposal.confirmation).toBe('needed')
    await target.owner({
      args: [
        'task',
        'create',
        '--title',
        'Created after the preview',
      ],
    })
    const stale = await caller.ownerRefused({
      args: [
        'approval',
        'confirm',
        proposal.token,
        '--confirm',
        proposal.token,
      ],
    })
    expect(stale.code).toBe('CONFLICT')
    expect(stale.error).toContain('target changed')
    await caller.owner({
      args: [
        'approval',
        'dismiss',
        proposal.token,
      ],
    })
    page.close()
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
      ].map(child => {
        if (child.exitCode !== null || child.signalCode !== null) {
          return Promise.resolve()
        }

        return new Promise<void>(resolve => {
          child.once(
            'exit',
            () => resolve(),
          )
          child.kill('SIGKILL')
        })
      }))
    })
    children.spawned({ child: worker })
    children.associate({
      pid: worker.pid!,
      task: 'worker',
    })
    children.spawned({ child: helper })
    await children.stopAll()
    await until({
      what: 'worker and helper tools to exit',
      check: () => worker.exitCode !== null || worker.signalCode !== null,
    })
    await until({
      what: 'unassigned helper tools to exit',
      check: () => helper.exitCode !== null || helper.signalCode !== null,
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
    git({
      cwd: folder,
      args: [
        'worktree',
        'lock',
        locked,
      ],
    })
    const proposed = await caller.owner({
      args: [
        'hydra',
        'remove',
        target.id,
      ],
    })
    const failed = await caller.ownerRefused({
      args: [
        'approval',
        'confirm',
        proposed.token,
        '--confirm',
        proposed.token,
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
        '--title',
        'Competing write',
      ],
    })).code).toBe('CONFLICT')
    await pnyx.restart()
    expect(existsSync(first)).toBe(false)
    expect((await caller.owner({
      args: [
        'hydra',
        'show',
      ],
    })).hydra.id).toBe(caller.id)
    git({
      cwd: folder,
      args: [
        'worktree',
        'unlock',
        locked,
      ],
    })
    await pnyx.restart()
    expect(existsSync(locked)).toBe(false)
    expect((await caller.owner({
      args: [
        'hydra',
        'list',
      ],
    })).hydras.some((hydra: { id: string }) => hydra.id === target.id)).toBe(false)
  },
)
