import { syncBuiltinESMExports } from 'node:module'
import { execFileSync } from 'node:child_process'
import filesystem, { appendFileSync, existsSync, readFileSync, rmSync, renameSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, expect, onTestFinished, test } from 'vitest'
import { readEvents } from '#app/event-log.ts'
import { loadTitan } from '#app/store.ts'
import { nativeHome } from '#app/native-home.ts'
import { readNativeTitan } from '#app/native-read.ts'
import { nativeReferences } from '#app/native-state.ts'
import { NativePositions } from '#app/native-positions.ts'
import { withWriter } from '#app/writer.ts'
import { applyDecision } from '#app/decision.ts'
import { operationEvent } from '#titan/operations.ts'
import { base } from '#app/command-meta.ts'
import { askHost, infoPath } from '#app/server-state.ts'
import { COPY_LEASE_PREFIX, dropCopyLeases, taskLease, taskLeasePresent } from '#routine-helper/leases.ts'
import { appendRecords } from './setup/transcripts.ts'
import type { ThreadPage } from '#titan/transcripts-read.ts'
import { othrys as runOthrys, parsed, startOthrys, until, type Othrys } from './setup/othrys.ts'

let othrys: Othrys

beforeAll(async () => {
  othrys = await startOthrys()
})

test.each([
  { phase: 'interrupted' },
  { phase: 'finished' },
] as const)(
  'receiptless compaction and $phase child inscribe keep their file-only cutoff and recovery bounds',
  async ({ phase }) => {
    const titan = await othrys.titan()
    const boundary = readEvents({ titanId: titan.id }).at(-1)!.id
    await withWriter({
      titanId: titan.id,
      fn: ({ writer }) => {
        const through = writer.state.eventIds[boundary]!
        applyDecision({
          writer,
          decision: operationEvent({
            state: writer.state,
            meta: {
              actor: 'othrys',
              at: new Date().toISOString(),
            },
            operation: {
              id: 'cutoff-compaction',
              kind: 'compaction',
              state: 'started',
              through,
              after: through,
            },
          }),
        })
        writer.append({
          event: {
            ...base({
              state: writer.state,
              cardId: '$all',
              meta: {
                id: 'after-cutoff-message',
                actor: 'cli',
                at: new Date().toISOString(),
              },
            }),
            type: 'titan.message',
            data: {
              action: 'send',
              text: 'Owner message after the saved cutoff',
              titan: 'titan',
            },
          },
        })
        applyDecision({
          writer,
          decision: operationEvent({
            state: writer.state,
            meta: {
              actor: 'othrys',
              at: new Date().toISOString(),
            },
            operation: {
              id: 'cutoff-inscribe',
              kind: 'inscribe',
              state: 'started',
              through,
              historySince: 'origin',
              parent: 'cutoff-compaction',
              blocking: false,
            },
          }),
        })
      },
    })
    const saved = readNativeTitan({ titanId: titan.id }).state
    const through = saved.eventIds[boundary]
    expect(saved.titanOperation).toMatchObject({
      id: 'cutoff-compaction',
      kind: 'compaction',
      seq: through,
    })
    expect(saved.historyMilestones).toContainEqual(expect.objectContaining({
      id: 'cutoff-compaction',
      state: 'started',
      through,
      after: through,
    }))
    expect(saved.historyMilestones).toContainEqual(expect.objectContaining({
      id: 'cutoff-inscribe',
      state: 'started',
      through,
      parent: 'cutoff-compaction',
      blocking: false,
      historySince: 'origin',
    }))
    expect(saved.eventIds['after-cutoff-message']).toBeGreaterThan(through!)

    if (phase === 'finished') {
      await withWriter({
        titanId: titan.id,
        fn: ({ writer }) => applyDecision({
          writer,
          decision: operationEvent({
            state: writer.state,
            meta: {
              actor: 'othrys',
              at: new Date().toISOString(),
            },
            operation: {
              id: 'cutoff-inscribe',
              kind: 'inscribe',
              state: 'finished',
            },
          }),
        }),
      })
    }

    await othrys.restart()
    const recovered = readNativeTitan({ titanId: titan.id }).state
    const restoredThrough = recovered.eventIds[boundary]
    expect(recovered.titanOperation).toBeUndefined()
    expect(readEvents({
      titanId: titan.id,
      types: ['titan.operation'],
    })).toContainEqual(expect.objectContaining({
      data: expect.objectContaining({
        id: 'cutoff-compaction',
        state: 'started',
        after: restoredThrough,
      }),
    }))

    for (const id of [
      'cutoff-compaction',
      'cutoff-inscribe',
    ]) {
      expect(recovered.historyMilestones).toContainEqual(expect.objectContaining({
        id,
        state: id === 'cutoff-inscribe' && phase === 'finished' ? 'finished' : 'failed',
        through: restoredThrough,
      }))
    }

    const child = recovered.historyMilestones?.find(item => item.id === 'cutoff-inscribe')
    expect(child).toMatchObject({
      parent: 'cutoff-compaction',
      blocking: false,
    })
  },
)

test(
  'dispatch reads leave mirrors untouched and daemon startup repairs them from the journal',
  () => {
    const home = join(
      process.env.TMPDIR!,
      'dispatch-mirror-read',
    )
    const script = [
      "import assert from 'node:assert/strict'",
      "import {readFileSync, writeFileSync} from 'node:fs'",
      "import {join} from 'node:path'",
      "import {commitChange, savedDocument} from '#workers/dispatch-config.ts'",
      "import {startServer} from '#app/server-daemon.ts'",
      'const home = process.env.OTHRYS_HOME',
      'const document = {rules: {}, default: [], workers: {}, projects: {}, accounts: {}}',
      "commitChange({entry: {v: 1, id: 'dispatch-before-start', at: new Date().toISOString(), actor: 'web', document}})",
      "const mirror = join(home, 'config', 'titan-dispatch.json')",
      "writeFileSync(mirror, 'stale mirror bytes')",
      'assert.deepEqual(savedDocument(), document)',
      "assert.equal(readFileSync(mirror, 'utf8'), 'stale mirror bytes')",
      "const server = await startServer({port: 0, upgradeRoot: join(home, 'no-upgrade')})",
      "assert.deepEqual(JSON.parse(readFileSync(mirror, 'utf8')).default, [])",
      'await server.close()',
    ].join('\n')
    execFileSync(
      process.execPath,
      [
        '--conditions=source',
        '--input-type=module',
        '-e',
        script,
      ],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          OTHRYS_HOME: home,
        },
        timeout: 30_000,
      },
    )
  },
)

test(
  'batch previews refuse an event id already accepted by an individual command',
  async () => {
    const titan = await othrys.titan()
    const id = 'individual-command-id'
    await titan.owner({
      args: [
        'task',
        'create',
        '--no-start',
        '--title',
        'Original task',
        '--event-id',
        id,
      ],
    })
    const input = JSON.stringify({
      version: 1,
      changes: [
        {
          op: 'task.create',
          title: 'Conflicting batch',
          noStart: true,
        },
      ],
    })

    for (const preview of [
      true,
      false,
    ]) {
      expect((await titan.ownerRefused({
        args: [
          'apply',
          '--file',
          '-',
          '--event-id',
          id,
          ...(preview ? ['--check'] : []),
        ],
        input,
      })).code).toBe('IDEMPOTENCY_CONFLICT')
    }
  },
)

test(
  'task leases use one identity through a symlinked home',
  async () => {
    const titan = await othrys.titan()
    const created = await titan.owner({
      args: [
        'task',
        'create',
        '--no-start',
        '--title',
        'Leased task',
      ],
    })
    const original = process.env.OTHRYS_HOME!
    const alias = join(
      process.env.TMPDIR!,
      `lease-alias-${titan.id}`,
    )
    symlinkSync(
      original,
      alias,
    )
    let release: (() => void) | undefined

    try {
      process.env.OTHRYS_HOME = alias
      release = taskLease({
        titanId: titan.id,
        task: created.card.id,
        actor: `${COPY_LEASE_PREFIX}test`,
      })
      process.env.OTHRYS_HOME = original
      expect(taskLeasePresent({
        titanId: titan.id,
        task: created.card.id,
      })).toBe(true)
      dropCopyLeases({ titanId: titan.id })
      process.env.OTHRYS_HOME = alias
      expect(taskLeasePresent({
        titanId: titan.id,
        task: created.card.id,
      })).toBe(false)
    } finally {
      process.env.OTHRYS_HOME = original
      release?.()
      rmSync(alias)
    }
  },
)

test(
  'a permission answered while its request commits reaches the registered waiter',
  async () => {
    const titan = await othrys.titan()
    const { worker } = await titan.startTask({ key: 'answer-during-write' })
    const task = await titan.task({ key: 'answer-during-write' })
    const path = join(
      process.env.OTHRYS_HOME!,
      'titans',
      titan.id,
      'tasks',
      task.id,
      'task.log',
    )
    const inode = statSync(path).ino
    const sync = filesystem.fdatasyncSync
    const controller = new AbortController()
    const command = 'echo answer-before-publication'
    let answering: Promise<Record<string, unknown>> | undefined

    // eslint-disable-next-line othrys/object-params -- Node owns the sync signature.
    filesystem.fdatasyncSync = fd => {
      sync(fd)

      if (answering || filesystem.fstatSync(fd).ino !== inode) {
        return
      }

      const facts = readFileSync(
        path,
        'utf8',
      ).trim()
        .split('\n')
        .map(line => JSON.parse(line))
      const request = facts.find(fact => fact.event?.type === 'task.permission' && fact.event.data.input?.command === command)
        ?.event.data

      if (request) {
        answering = askHost({
          titanId: titan.id,
          body: {
            action: 'permission',
            task: task.id,
            request: request.id,
            choice: 'deny',
            actor: 'web',
            reason: 'Declined during commit',
          },
        })
        void answering.catch(() => {})
      }
    }

    syncBuiltinESMExports()
    onTestFinished(() => {
      filesystem.fdatasyncSync = sync
      syncBuiltinESMExports()
      controller.abort()
    })
    const decision = worker.useTool!({
      tool: 'Bash',
      input: { command },
      signal: controller.signal,
    })
    await until({
      what: 'the answer to enter during the request sync',
      check: () => answering !== undefined,
    })
    expect(await answering).toMatchObject({ status: 'deny' })
    expect(await decision).toMatchObject({
      behavior: 'deny',
      message: 'Declined during commit',
    })
  },
)

test(
  'a corrupt optional Titan does not prevent healthy Titans from starting',
  async () => {
    const healthy = await othrys.titan()
    const broken = await othrys.titan()
    const path = join(
      process.env.OTHRYS_HOME!,
      'titans',
      broken.id,
      'titan.log',
    )
    const contents = readFileSync(
      path,
      'utf8',
    )

    try {
      await othrys.restart({
        whileStopped: () => writeFileSync(
          path,
          `invalid frame\n${contents}`,
        ),
      })
      const created = await healthy.owner({
        args: [
          'task',
          'create',
          '--no-start',
          '--title',
          'Healthy after corruption',
        ],
      })
      expect((await healthy.task({ key: created.card.id })).title).toBe('Healthy after corruption')
      const { url } = JSON.parse(readFileSync(
        infoPath(),
        'utf8',
      ))
      const response = await fetch(new URL(
        '/health',
        url,
      ))
      expect(await response.json()).toMatchObject({
        skipped: { [broken.id]: expect.any(String) },
      })
      const discoveredId = `${broken.id}-healthy`
      await healthy.owner({
        args: [
          'titan',
          'create',
          discoveredId,
          '--helper',
          'off',
        ],
      })
      await until({
        what: 'a new healthy Titan to mount after the corrupt Titan in discovery',
        check: () => othrys.home().scopes[discoveredId]?.queue,
      })
    } finally {
      await othrys.restart({
        whileStopped: () => writeFileSync(
          path,
          contents,
        ),
      })
    }
  },
)

test(
  'a failed optional mount releases its home before the next restart',
  async () => {
    const titan = await othrys.titan()
    const spool = join(
      process.env.OTHRYS_HOME!,
      'titans',
      titan.id,
      'spool',
    )

    try {
      await othrys.restart({
        whileStopped: () => {
          rmSync(
            spool,
            {
              recursive: true,
              force: true,
            },
          )
          writeFileSync(
            spool,
            'not a spool directory',
          )
        },
      })
      const failedMountEpoch = othrys.cursor().epoch
      await othrys.restart({ whileStopped: () => rmSync(spool) })
      expect(othrys.cursor().epoch).not.toBe(failedMountEpoch)
      const created = await titan.owner({
        args: [
          'task',
          'create',
          '--no-start',
          '--title',
          'Recovered mount',
        ],
      })
      expect((await titan.task({ key: created.card.id })).title).toBe('Recovered mount')
    } finally {
      if (existsSync(spool) && statSync(spool).isFile()) {
        rmSync(spool)
        await othrys.restart()
      }
    }
  },
)

test(
  'a home initialization failure releases the daemon claim for a corrected start',
  () => {
    const home = join(
      process.env.TMPDIR!,
      'initialization-retry',
    )
    const script = [
      "import assert from 'node:assert/strict'",
      "import {mkdirSync, writeFileSync, rmSync} from 'node:fs'",
      "import {join} from 'node:path'",
      "import {startServer} from '#app/server-daemon.ts'",
      'const home = process.env.OTHRYS_HOME',
      'mkdirSync(home, {recursive: true})',
      "const titans = join(home, 'titans')",
      "writeFileSync(titans, 'not a Titan directory')",
      "await assert.rejects(startServer({port: 0, upgradeRoot: join(home, 'no-upgrade')}))",
      'rmSync(titans)',
      "const server = await startServer({port: 0, upgradeRoot: join(home, 'no-upgrade')})",
      'await server.close()',
      "console.log('corrected start succeeded')",
    ].join('\n')
    expect(execFileSync(
      process.execPath,
      [
        '--conditions=source',
        '--input-type=module',
        '-e',
        script,
      ],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          OTHRYS_HOME: home,
        },
        timeout: 30_000,
      },
    ).trim()).toBe('corrected start succeeded')
  },
)

test(
  'Titan memory can replace and forget a key named constructor across restarts',
  async () => {
    const titan = await othrys.titan()

    for (const text of [
      'First memory',
      'Replacement memory',
    ]) {
      await titan.owner({
        args: [
          'titan',
          'memory',
          'set',
          '--key',
          'constructor',
          '--text',
          text,
        ],
      })
      await othrys.restart()
      expect((await titan.owner({
        args: [
          'titan',
          'memory',
          'list',
        ],
      })).memory).toEqual([
        expect.objectContaining({
          key: 'constructor',
          text,
        }),
      ])
    }

    await titan.owner({
      args: [
        'titan',
        'memory',
        'forget',
        '--key',
        'constructor',
      ],
    })
    await othrys.restart()
    expect((await titan.owner({
      args: [
        'titan',
        'memory',
        'list',
      ],
    })).memory).toBe('none: no Titan memory yet')
  },
)

test(
  'a caught reducer failure leaves its event id available for a corrected append',
  async () => {
    const titan = await othrys.titan()
    const failure = new Error('Injected reducer failure')
    const id = 'corrected-after-reducer-failure'
    await withWriter({
      titanId: titan.id,
      fn: ({ writer }) => {
        const append = ({
          key,
          text,
        }: {
          key: string
          text: string
        }) => writer.append({
          event: {
            ...base({
              state: writer.state,
              meta: {
                at: new Date().toISOString(),
                actor: 'web',
                id: key,
              },
              cardId: '$all',
            }),
            type: 'titan.memory',
            data: {
              key,
              before: null,
              after: text,
            },
          },
        })
        append({
          key: 'accepted-before-failure',
          text: 'First accepted change',
        })
        expect(() => writer.append({
          event: {
            ...base({
              state: writer.state,
              meta: {
                at: new Date().toISOString(),
                actor: 'web',
                id,
              },
              cardId: '$all',
            }),
            type: 'titan.memory',
            data: {
              key: id,
              before: null,
              get after(): string {
                throw failure
              },
            },
          },
        })).toThrow(failure)
        append({
          key: id,
          text: 'Corrected accepted change',
        })
      },
    })
    await othrys.restart()
    expect((await titan.owner({
      args: [
        'titan',
        'memory',
        'list',
      ],
    })).memory).toEqual(expect.arrayContaining([
      expect.objectContaining({
        key: 'accepted-before-failure',
        text: 'First accepted change',
      }),
      expect.objectContaining({
        key: id,
        text: 'Corrected accepted change',
      }),
    ]))
    expect(readEvents({ titanId: titan.id }).filter(event => event.id === id)).toHaveLength(1)
  },
)

test(
  'offline configuration reads retain the canonical sequence and accepted event ids',
  async () => {
    const titan = await othrys.titan()
    await titan.owner({
      args: [
        'titan',
        'set',
        '--name',
        'Offline configuration',
      ],
    })
    let ids: string[] = []
    let offline: ReturnType<typeof readNativeTitan>['state'] | undefined
    await othrys.restart({
      whileStopped: () => {
        const entries = readFileSync(
          join(
            process.env.OTHRYS_HOME!,
            'titans',
            titan.id,
            'titan.log',
          ),
          'utf8',
        )
          .trim()
          .split('\n')
          .map(line => JSON.parse(line) as { id: string })
        ids = entries.map(entry => entry.id)
        offline = readNativeTitan({ titanId: titan.id }).state
      },
    })
    expect(offline?.seq).toBe(ids.length)
    expect(Object.keys(offline!.eventIds).sort()).toEqual(ids.sort())
    expect(Object.values(offline!.eventIds).sort((
      a,
      b,
    ) => a - b)).toEqual(ids.map((
      _,
      index,
    ) => index + 1))
  },
)

test.each([
  { eventId: 'native-create-once' },
  { eventId: '__proto__' },
])(
  'an acknowledged task decision survives restart with receipt $eventId',
  async ({ eventId }) => {
    const titan = await othrys.titan()
    const args = [
      'task',
      'create',
      '--no-start',
      '--key',
      'saved',
      '--title',
      'Saved locally',
      '--brief',
      'Keep this intent',
      '--event-id',
      eventId,
    ]
    const created = await titan.owner({ args })
    const task = created.card.id as string
    const folder = join(
      process.env.OTHRYS_HOME!,
      'titans',
      titan.id,
      'tasks',
      task,
    )
    const log = readFileSync(
      join(
        folder,
        'task.log',
      ),
      'utf8',
    )
    expect(JSON.parse(log.split('\n')[0]!)).toMatchObject({
      n: 1,
      t: 'created',
      id: eventId,
    })
    expect(readFileSync(
      join(
        folder,
        'brief.md',
      ),
      'utf8',
    )).toBe('Keep this intent')
    const history = readEvents({
      titanId: titan.id,
      cardId: task,
    }).map(event => event.id)
    await othrys.restart()
    expect((await titan.task({ key: 'saved' })).title).toBe('Saved locally')
    expect((await titan.owner({ args })).card.id).toBe(task)
    expect(readEvents({
      titanId: titan.id,
      cardId: task,
    }).map(event => event.id)).toEqual(history)
    expect(readFileSync(
      join(
        folder,
        'task.log',
      ),
      'utf8',
    )).toBe(log)
    expect(existsSync(join(
      process.env.OTHRYS_HOME!,
      'titans',
      titan.id,
      'snapshot.json',
    ))).toBe(true)
    expect(loadTitan({ titanId: titan.id }).state.cards[task]?.brief).toBe('Keep this intent')
  },
)

test(
  'moving a task renames its folder while its captured report path keeps the same file',
  async () => {
    const source = await othrys.titan()
    const destination = await othrys.titan()
    const created = await source.owner({
      args: [
        'task',
        'create',
        '--no-start',
        '--key',
        'moving',
        '--title',
        'Keep the folder',
      ],
    })
    const task = created.card.id as string
    const sourceFolder = join(
      process.env.OTHRYS_HOME!,
      'titans',
      source.id,
      'tasks',
      task,
    )
    const before = statSync(sourceFolder)
    const card = loadTitan({ titanId: source.id }).state.cards[task]!
    const report = join(
      card.workerLogDir!,
      'worker.log',
    )
    const reportBefore = statSync(report)
    await source.owner({
      args: [
        'task',
        'move',
        task,
        '--to-titan',
        destination.id,
      ],
    })
    const destinationFolder = join(
      process.env.OTHRYS_HOME!,
      'titans',
      destination.id,
      'tasks',
      task,
    )
    expect(existsSync(sourceFolder)).toBe(false)
    expect(statSync(destinationFolder).ino).toBe(before.ino)
    expect(statSync(join(
      destinationFolder,
      'worker.log',
    )).ino).toBe(reportBefore.ino)
    expect(statSync(report).ino).toBe(reportBefore.ino)
    await othrys.restart()
    expect((await destination.task({ key: task })).title).toBe('Keep the folder')
    expect(readEvents({
      titanId: destination.id,
      cardId: task,
    }).some(event => event.type === 'task.created')).toBe(true)
  },
)

test(
  'a later owner message adds only its own words and both messages recover after restart',
  async () => {
    const titan = await othrys.titan()
    await titan.chat({ text: 'FIRST-NATIVE-WORDS-TO-KEEP' })
    const path = join(
      process.env.OTHRYS_HOME!,
      'titans',
      titan.id,
      'titan.log',
    )
    const prefix = readFileSync(
      path,
      'utf8',
    )
    await titan.chat({ text: 'SECOND-NATIVE-WORDS-TO-KEEP' })
    const suffix = readFileSync(
      path,
      'utf8',
    ).slice(prefix.length)
    expect(suffix).toContain('SECOND-NATIVE-WORDS-TO-KEEP')
    expect(suffix).not.toContain('FIRST-NATIVE-WORDS-TO-KEEP')
    await othrys.restart()
    const saved = (await titan.owner({
      args: [
        'titan',
        'messages',
      ],
    })).messages as { text: string }[]
    expect(saved.map(message => message.text)).toEqual(expect.arrayContaining([
      'FIRST-NATIVE-WORDS-TO-KEEP',
      'SECOND-NATIVE-WORDS-TO-KEEP',
    ]))
  },
)

test(
  'a corrupt task remains visible while another task can still save and recover',
  async () => {
    const titan = await othrys.titan()
    const bad = await titan.owner({
      args: [
        'task',
        'create',
        '--no-start',
        '--key',
        'bad',
        '--title',
        'Original bad task',
      ],
    })
    await titan.owner({
      args: [
        'task',
        'create',
        '--no-start',
        '--key',
        'healthy',
        '--title',
        'Healthy task',
      ],
    })
    await titan.owner({
      args: [
        'task',
        'rename',
        'bad',
        '--title',
        'Earlier saved title',
      ],
    })
    await titan.owner({
      args: [
        'task',
        'rename',
        'bad',
        '--title',
        'Last saved title',
      ],
    })
    await othrys.restart({
      whileStopped: () => {
        const folder = join(
          process.env.OTHRYS_HOME!,
          'titans',
          titan.id,
        )
        rmSync(
          join(
            folder,
            'snapshot.json',
          ),
          { force: true },
        )
        const path = join(
          folder,
          'tasks',
          bad.card.id as string,
          'task.log',
        )
        const lines = readFileSync(
          path,
          'utf8',
        ).split('\n')
        lines[1] = 'invalid middle JSON'
        writeFileSync(
          path,
          lines.join('\n'),
        )
      },
    })
    const unreadable = await titan.task({ key: bad.card.id as string })
    expect(unreadable.title).toContain('Unreadable task')
    expect((await titan.ownerRefused({
      args: [
        'task',
        'rename',
        bad.card.id as string,
        '--title',
        'Refused',
      ],
    })).code).toBe('LOG_CORRUPT')
    await titan.owner({
      args: [
        'task',
        'rename',
        'healthy',
        '--title',
        'Still saved locally',
      ],
    })
    await othrys.restart()
    expect((await titan.task({ key: 'healthy' })).title).toBe('Still saved locally')
  },
)

test(
  'a refused decision preserves live observations without writing them',
  async () => {
    const titan = await othrys.titan()
    await titan.owner({
      args: [
        'task',
        'create',
        '--no-start',
        '--key',
        'volatile',
        '--title',
        'Live facts',
      ],
    })
    await titan.owner({
      args: [
        'push',
        '--key',
        'volatile',
        '--file',
        '-',
      ],
      input: JSON.stringify({
        activity: 'working',
        attention: [
          {
            key: 'volatile',
            kind: 'permission',
            text: 'Still waiting',
            blocking: true,
          },
        ],
      }),
    })
    const task = async () => (await titan.owner({
      args: [
        'task',
        'show',
        'volatile',
        '--full',
      ],
    })).task
    expect((await task()).attention).toContainEqual(expect.objectContaining({ key: 'volatile' }))
    const folder = join(
      process.env.OTHRYS_HOME!,
      'titans',
      titan.id,
    )
    const paths = [
      join(
        folder,
        'titan.log',
      ),
      join(
        folder,
        'tasks',
        (await task()).id,
        'task.log',
      ),
    ]
    const before = paths.map(path => readFileSync(path))
    expect((await titan.ownerRefused({
      args: [
        'task',
        'rename',
        'volatile',
        '--title',
        'Refused',
        '--if-revision',
        '0',
      ],
    })).code).toBe('REVISION_CONFLICT')
    expect((await task()).attention).toContainEqual(expect.objectContaining({ key: 'volatile' }))
    expect(paths.map(path => readFileSync(path))).toEqual(before)
  },
)

test(
  'a permission cancelled during its write resolves after the committed view is published',
  async () => {
    const titan = await othrys.titan()
    const { worker } = await titan.startTask({ key: 'cancel-during-write' })
    const task = await titan.task({ key: 'cancel-during-write' })
    const taskLog = join(
      process.env.OTHRYS_HOME!,
      'titans',
      titan.id,
      'tasks',
      task.id,
      'task.log',
    )
    const inode = statSync(taskLog).ino
    const sync = filesystem.fdatasyncSync
    const controller = new AbortController()
    const command = 'echo cancelled-before-publication'
    const input = {
      command,
      native: 'literal-tool-input',
      seq: 42,
      cursorSeq: 7,
      nested: { native: 'literal-nested-input' },
    }
    let cancelledAtSync = false

    // eslint-disable-next-line othrys/object-params -- Node owns the sync signature.
    filesystem.fdatasyncSync = fd => {
      sync(fd)

      if (!cancelledAtSync && filesystem.fstatSync(fd).ino === inode && readFileSync(
        taskLog,
        'utf8',
      ).includes(command)) {
        cancelledAtSync = true
        controller.abort()
      }
    }

    syncBuiltinESMExports()
    onTestFinished(() => {
      filesystem.fdatasyncSync = sync
      syncBuiltinESMExports()
      controller.abort()
    })
    const decision = worker.useTool!({
      tool: 'Bash',
      input,
      signal: controller.signal,
    })
    expect(await decision).toMatchObject({ behavior: 'deny' })
    expect(cancelledAtSync).toBe(true)
    await until({
      what: 'the cancelled permission to expire after publication',
      check: async () => (await titan.owner({
        args: [
          'task',
          'show',
          task.id,
          '--full',
        ],
      })).task.permissions
        ?.some((request: {
          status: string
          input: { command?: string }
        }) => request.input.command === command && request.status === 'expired'),
    })
    await othrys.restart()
    const restored = (await titan.owner({
      args: [
        'task',
        'show',
        task.id,
        '--full',
      ],
    })).task
    expect(restored.permissions).toContainEqual(expect.objectContaining({
      input,
      status: 'expired',
    }))
  },
)

test(
  'a moved worker resumes once across different Titan histories and receives the next owner message',
  async () => {
    const source = await othrys.titan()
    const destination = await othrys.titan()

    for (let index = 0; index < 12; index++) {
      await destination.owner({
        args: [
          'task',
          'create',
          '--no-start',
          '--title',
          `Destination history ${index}`,
        ],
      })
    }

    othrys.claude.plan({
      titan: source.id,
      match: ({ text }) => text.includes('<othrys-worker'),
      reply: 'Moved work finished',
      partial: 'Moving work',
      hold: true,
    })
    const folder = source.folder({ name: 'moving-turn' })
    const created = await source.owner({
      args: [
        'task',
        'create',
        '--no-start',
        '--title',
        'Moving turn',
        '--key',
        'moving-turn',
        '--folder',
        folder,
      ],
    })
    const task = created.card.id as string
    await source.owner({
      args: [
        'task',
        'start',
        task,
      ],
    })
    const worker = await source.agent({ cwd: folder })
    await appendRecords({
      session: worker,
      records: [
        {
          type: 'assistant',
          content: 'Saved before moving',
        },
      ],
    })
    const sourcePage = await source.page()
    const beforeMove = await sourcePage.send({
      name: 'thread',
      args: [task],
    }) as unknown as { thread: ThreadPage }
    const saved = beforeMove.thread.entries.find(entry => entry.text === 'Saved before moving')!
    expect(saved).toBeDefined()
    sourcePage.close()
    await source.owner({
      args: [
        'task',
        'move',
        task,
        '--to-titan',
        destination.id,
      ],
    })
    const destinationPage = await destination.page()
    const afterMove = await destinationPage.send({
      name: 'thread',
      args: [task],
    }) as unknown as { thread: ThreadPage }
    expect(afterMove.thread.entries.find(entry => entry.id === saved.id)?.text).toBe('Saved before moving')
    destinationPage.close()
    await othrys.restart()
    const resumed = await until({
      what: 'the moved worker resumes its saved turn in the destination',
      check: () => othrys.claude.sessions.find(session =>
        session.cwd === folder && session.resumed),
    })
    expect(resumed.id).toBe(worker.id)
    const resumedSessions = othrys.claude.sessions.filter(session =>
      session.cwd === folder && session.resumed)
    expect(resumedSessions).toHaveLength(1)
    await destination.owner({
      args: [
        'reply',
        task,
        '--text',
        'Continue the moved work once',
      ],
    })
    await until({
      what: 'the destination message reaches the resumed worker',
      check: () => resumed.received.some(text => text.includes('Continue the moved work once')),
    })
    const delivered = resumed.received.filter(text => text.includes('Continue the moved work once'))
    expect(delivered).toHaveLength(1)
  },
)

test(
  'history reads only acknowledged bytes and leaves an unfinished native tail untouched',
  async () => {
    const titan = await othrys.titan()
    const created = await titan.owner({
      args: [
        'task',
        'create',
        '--no-start',
        '--title',
        'Read acknowledged history',
      ],
    })
    const task = created.card.id as string
    const fact = {
      t: 'brief',
      id: 'accepted-history',
      at: new Date().toISOString(),
      by: 'owner' as const,
      event: {
        titanId: titan.id,
        v: 1,
        actor: 'cli',
        cardId: task,
        type: 'task.brief',
        data: {
          before: '',
          after: 'Accepted history',
        },
      },
      change: [
        {
          path: [
            'card',
            'brief',
          ],
          value: 'Accepted history',
        },
      ],
    }
    await nativeHome().files.changeTask({
      titan: titan.id,
      task,
      decide: () => [fact],
    })
    const path = join(
      process.env.OTHRYS_HOME!,
      'titans',
      titan.id,
      'tasks',
      task,
      'task.log',
    )
    const accepted = readFileSync(
      path,
      'utf8',
    )
    const unacknowledged = {
      ...fact,
      n: accepted.trim().split('\n').length + 1,
      id: 'unacknowledged-history',
    }
    appendFileSync(
      path,
      JSON.stringify(unacknowledged)+'\n{"n":',
    )
    const untouched = readFileSync(
      path,
      'utf8',
    )
    onTestFinished(() => writeFileSync(
      path,
      accepted,
    ))
    const events = readEvents({
      titanId: titan.id,
      cardId: task,
    })
    expect(events).toContainEqual(expect.objectContaining({ id: 'accepted-history' }))
    expect(events).not.toContainEqual(expect.objectContaining({ id: 'unacknowledged-history' }))
    expect(readFileSync(
      path,
      'utf8',
    )).toBe(untouched)
  },
)

test(
  "a local setup check leaves another daemon's unfinished logs and pending task move untouched",
  async () => {
    const source = await othrys.titan()
    const target = await othrys.titan()
    const created = await source.owner({
      args: [
        'task',
        'create',
        '--no-start',
        '--title',
        'Setup must only read',
      ],
    })
    const task = created.card.id as string
    const folder = join(
      process.env.OTHRYS_HOME!,
      'titans',
      source.id,
      'tasks',
      task,
    )
    const destination = join(
      process.env.OTHRYS_HOME!,
      'titans',
      target.id,
      'tasks',
      task,
    )
    const path = join(
      folder,
      'task.log',
    )
    const original = readFileSync(
      path,
      'utf8',
    )
    const move = {
      n: original.trim().split('\n').length + 1,
      at: new Date().toISOString(),
      by: 'owner',
      t: 'moved',
      id: 'pending-setup-move',
      from: source.id,
      to: target.id,
    }
    appendFileSync(
      path,
      JSON.stringify(move)+'\n{"n":',
    )
    const untouched = readFileSync(
      path,
      'utf8',
    )

    const restore = () => {
      if (existsSync(destination)) {
        renameSync(
          destination,
          folder,
        )
      }

      writeFileSync(
        path,
        original,
      )
    }

    onTestFinished(restore)
    await runOthrys({
      args: [
        'setup',
        'check',
        '--titan',
        source.id,
        '--json',
      ],
      env: process.env,
    })
    expect(existsSync(folder)).toBe(true)
    expect(existsSync(destination)).toBe(false)
    expect(readFileSync(
      path,
      'utf8',
    )).toBe(untouched)
    restore()
    const checked = await runOthrys({
      args: [
        'setup',
        'check',
        '--titan',
        source.id,
        '--json',
      ],
      env: process.env,
    })
    expect(parsed({ stdout: checked.stdout || checked.stderr }).titanId).toBe(source.id)
  },
)

test(
  'retained batch receipts stay with their Titan across restart and task moves, including no-ops',
  async () => {
    const source = await othrys.titan()
    const target = await othrys.titan()
    const document = {
      version: 1,
      changes: [
        {
          op: 'task.create',
          key: 'receipt-one',
          title: 'First receipt task',
          brief: 'Unchanged brief',
          noStart: true,
        },
        {
          op: 'task.create',
          key: 'receipt-two',
          title: 'Second receipt task',
          noStart: true,
        },
      ],
    }
    const args = [
      'apply',
      '--file',
      '-',
      '--event-id',
      'batch-receipt',
    ]
    const input = JSON.stringify(document)
    const first = await source.owner({
      args,
      input,
    })
    const second = await source.task({ key: 'receipt-two' })
    const noopArgs = [
      'apply',
      '--file',
      '-',
      '--event-id',
      'noop-receipt',
    ]
    const noopInput = JSON.stringify({
      version: 1,
      changes: [
        {
          op: 'task.brief',
          task: 'receipt-one',
          brief: 'Unchanged brief',
        },
      ],
    })
    const noop = await source.owner({
      args: noopArgs,
      input: noopInput,
    })
    const rootLog = join(
      process.env.OTHRYS_HOME!,
      'titans',
      source.id,
      'titan.log',
    )
    const before = readFileSync(
      rootLog,
      'utf8',
    )
    await othrys.restart()
    expect(await source.owner({
      args,
      input,
    })).toMatchObject({
      duplicate: true,
      operations: first.operations,
      aliases: first.aliases,
      revisions: first.revisions,
    })
    expect(await source.owner({
      args: noopArgs,
      input: noopInput,
    })).toMatchObject({
      duplicate: true,
      operations: noop.operations,
    })
    expect(readFileSync(
      rootLog,
      'utf8',
    )).toBe(before)
    await source.owner({
      args: [
        'task',
        'move',
        second.id,
        '--to-titan',
        target.id,
      ],
    })
    await othrys.restart()
    const movedLog = readFileSync(
      rootLog,
      'utf8',
    )
    expect(await source.owner({
      args,
      input,
    })).toMatchObject({
      duplicate: true,
      operations: first.operations,
    })
    expect(readFileSync(
      rootLog,
      'utf8',
    )).toBe(movedLog)
    expect((await source.ownerRefused({
      args,
      input: JSON.stringify({
        version: 1,
        changes: [
          {
            op: 'task.create',
            title: 'Different source intent',
            noStart: true,
          },
        ],
      }),
    })).code).toBe('IDEMPOTENCY_CONFLICT')
    expect(await target.owner({
      args,
      input: JSON.stringify({
        version: 1,
        changes: [
          {
            op: 'task.create',
            key: 'destination-receipt',
            title: 'Independent destination intent',
            noStart: true,
          },
        ],
      }),
    })).toMatchObject({ applied: true })
    expect((await target.task({ key: 'destination-receipt' })).title).toBe('Independent destination intent')
  },
)

test(
  'a saved sequence number names the newest id recorded at its position',
  () => {
    const ids = new NativePositions({
      entries: [
        [
          'first',
          1,
        ],
        [
          'second',
          2,
        ],
      ],
    })
    const saved = () => nativeReferences({
      kind: 'event',
      value: {
        seq: 2,
        createdSeq: 1,
      },
      ids,
    })

    expect(saved()).toEqual({
      seq: { native: 'second' },
      createdSeq: { native: 'first' },
    })

    ids.set(
      'first',
      2,
    )
    expect(saved()).toEqual({
      seq: { native: 'second' },
      createdSeq: 0,
    })

    ids.delete('second')
    expect(saved()).toEqual({
      seq: { native: 'first' },
      createdSeq: 0,
    })
  },
)
