import { hydraDir } from '#app/home-migration.ts'
import { once } from 'node:events'
import { hydraRemoval, infoPath, processStart } from '#app/server-state.ts'
import { withWriter } from '#app/writer.ts'
import { hydraEvent } from '#hydra/hydra.ts'
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
    await target.owner({
      args: [
        'task',
        'create',
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
    const proposal = await caller.as({ session }).run({
      args: [
        'hydra',
        'remove',
        target.id,
      ],
    })
    expect(proposal.confirmation).toBe('needed')
    expect(proposal.action).toContain('Tasks: 2')
    expect(proposal.action).toContain('Copies: 2.')
    expect(proposal.action).toContain(copy)
    expect(proposal.action).toContain(`${pooled} (unrecorded checkout; landing unknown)`)
    expect(proposal.action).toContain('https://github.com/o/shop/pull/999')
    const preview = await caller.owner({
      args: [
        'approval',
        'confirm',
        proposal.token,
      ],
    })
    expect(preview.preview).toMatchObject({
      name: 'hydra',
      args: [
        'remove',
        target.id,
      ],
    })
    expect(preview.preview).not.toHaveProperty('removalWork')
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
    expect(existsSync(locked)).toBe(true)
    expect((await target.ownerRefused({
      args: [
        'task',
        'create',
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
  'an ignored file written while stopping tools requires fresh approval and keeps the copy',
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
    const proposed = await caller.owner({
      args: [
        'hydra',
        'remove',
        target.id,
      ],
    })
    const refused = await caller.ownerRefused({
      args: [
        'approval',
        'confirm',
        proposed.token,
        '--confirm',
        proposed.token,
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
        '--title',
        'Created after removal refusal',
      ],
    })
    await pnyx.restart()
    expect(existsSync(copy)).toBe(true)
    const retry = await caller.owner({
      args: [
        'hydra',
        'remove',
        target.id,
      ],
    })
    expect(retry.confirmation).toBe('needed')
    await caller.owner({
      args: [
        'approval',
        'confirm',
        retry.token,
        '--confirm',
        retry.token,
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
  'an applying removal can only be dismissed after the interrupted approval is recovered',
  async () => {
    const caller = await pnyx.hydra()
    const target = await pnyx.hydra()
    const proposed = await caller.owner({
      args: [
        'hydra',
        'remove',
        target.id,
      ],
    })
    withWriter({
      hydraId: caller.id,
      fn: ({ writer }) => {
        const decision = hydraEvent({
          state: writer.state,
          meta: {
            actor: 'web',
            at: new Date().toISOString(),
          },
          cardId: '$hydra',
          change: {
            type: 'hydra.dispatch-progress',
            data: {
              token: proposed.token,
              status: 'applying',
            },
          },
        })

        if ('event' in decision) {
          writer.append({ event: decision.event })
        }
      },
    })
    const refusal = await caller.ownerRefused({
      args: [
        'approval',
        'dismiss',
        proposed.token,
      ],
    })
    expect(refusal.code).toBe('CONFLICT')
    expect(refusal.error).toContain('already applying')
    await pnyx.restart()
    const dismissed = await caller.owner({
      args: [
        'approval',
        'dismiss',
        proposed.token,
      ],
    })
    expect(dismissed.state).toBe('dismissed')
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
    const proposed = await caller.owner({
      args: [
        'hydra',
        'remove',
        target.id,
      ],
    })
    const refused = await caller.ownerRefused({
      args: [
        'approval',
        'confirm',
        proposed.token,
        '--confirm',
        proposed.token,
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
    const retry = await caller.owner({
      args: [
        'hydra',
        'remove',
        target.id,
      ],
    })
    await caller.owner({
      args: [
        'approval',
        'confirm',
        retry.token,
        '--confirm',
        retry.token,
      ],
    })
    expect(existsSync(copy)).toBe(false)
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true)
  },
)
