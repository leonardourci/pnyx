import { syncBuiltinESMExports } from 'node:module'
import filesystem, { appendFileSync, existsSync, readFileSync, rmSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, expect, onTestFinished, test } from 'vitest'
import { readEvents } from '#app/event-log.ts'
import { loadHydra } from '#app/store.ts'
import { nativeHome } from '#app/native-home.ts'
import { readNativeHydra } from '#app/native-read.ts'
import { withWriter } from '#app/writer.ts'
import { base } from '#app/command-meta.ts'
import { pnyx as runPnyx, parsed, startPnyx, until, type Pnyx } from './setup/pnyx.ts'

let pnyx: Pnyx

beforeAll(async () => {
  pnyx = await startPnyx()
})

test(
  'Hydra memory can replace and forget a key named constructor across restarts',
  async () => {
    const hydra = await pnyx.hydra()

    for (const text of [
      'First memory',
      'Replacement memory',
    ]) {
      await hydra.owner({
        args: [
          'hydra',
          'memory',
          'set',
          '--key',
          'constructor',
          '--text',
          text,
        ],
      })
      await pnyx.restart()
      expect((await hydra.owner({
        args: [
          'hydra',
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

    await hydra.owner({
      args: [
        'hydra',
        'memory',
        'forget',
        '--key',
        'constructor',
      ],
    })
    await pnyx.restart()
    expect((await hydra.owner({
      args: [
        'hydra',
        'memory',
        'list',
      ],
    })).memory).toBe('none: no Hydra memory yet')
  },
)

test(
  'a caught reducer failure leaves its event id available for a corrected append',
  async () => {
    const hydra = await pnyx.hydra()
    const failure = new Error('Injected reducer failure')
    const id = 'corrected-after-reducer-failure'
    await withWriter({
      hydraId: hydra.id,
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
              cardId: '$board',
            }),
            type: 'hydra.memory',
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
              cardId: '$board',
            }),
            type: 'hydra.memory',
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
    await pnyx.restart()
    expect((await hydra.owner({
      args: [
        'hydra',
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
    expect(readEvents({ hydraId: hydra.id }).filter(event => event.id === id)).toHaveLength(1)
  },
)

test(
  'offline configuration reads retain the canonical sequence and accepted event ids',
  async () => {
    const hydra = await pnyx.hydra()
    await hydra.owner({
      args: [
        'hydra',
        'set',
        '--name',
        'Offline configuration',
      ],
    })
    await pnyx.restart({
      whileStopped: () => {
        const entries = readFileSync(
          join(
            process.env.PNYX_HOME!,
            'hydras',
            hydra.id,
            'hydra.log',
          ),
          'utf8',
        )
          .trim()
          .split('\n')
          .map(line => JSON.parse(line) as { id: string })
        const offline = readNativeHydra({ hydraId: hydra.id }).state
        expect(offline.seq).toBe(entries.length)
        expect(offline.eventIds).toEqual(Object.fromEntries(entries.map((
          entry,
          index,
        ) => [
          entry.id,
          index + 1,
        ])))
      },
    })
  },
)

test.each([
  { eventId: 'native-create-once' },
  { eventId: '__proto__' },
])(
  'an acknowledged task decision survives restart with receipt $eventId',
  async ({ eventId }) => {
    const hydra = await pnyx.hydra()
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
    const created = await hydra.owner({ args })
    const task = created.card.id as string
    const folder = join(
      process.env.PNYX_HOME!,
      'hydras',
      hydra.id,
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
      hydraId: hydra.id,
      cardId: task,
    }).map(event => event.id)
    await pnyx.restart()
    expect((await hydra.task({ key: 'saved' })).title).toBe('Saved locally')
    expect((await hydra.owner({ args })).card.id).toBe(task)
    expect(readEvents({
      hydraId: hydra.id,
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
      process.env.PNYX_HOME!,
      'hydras',
      hydra.id,
      'snapshot.json',
    ))).toBe(true)
    expect(loadHydra({ hydraId: hydra.id }).state.cards[task]?.brief).toBe('Keep this intent')
  },
)

test(
  'moving a task renames its folder while its captured report path keeps the same file',
  async () => {
    const source = await pnyx.hydra()
    const destination = await pnyx.hydra()
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
      process.env.PNYX_HOME!,
      'hydras',
      source.id,
      'tasks',
      task,
    )
    const before = statSync(sourceFolder)
    const card = loadHydra({ hydraId: source.id }).state.cards[task]!
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
        '--to-hydra',
        destination.id,
      ],
    })
    const destinationFolder = join(
      process.env.PNYX_HOME!,
      'hydras',
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
    await pnyx.restart()
    expect((await destination.task({ key: task })).title).toBe('Keep the folder')
    expect(readEvents({
      hydraId: destination.id,
      cardId: task,
    }).some(event => event.type === 'task.created')).toBe(true)
  },
)

test(
  'a later owner message adds only its own words and both messages recover after restart',
  async () => {
    const hydra = await pnyx.hydra()
    await hydra.chat({ text: 'FIRST-NATIVE-WORDS-TO-KEEP' })
    const path = join(
      process.env.PNYX_HOME!,
      'hydras',
      hydra.id,
      'hydra.log',
    )
    const prefix = readFileSync(
      path,
      'utf8',
    )
    await hydra.chat({ text: 'SECOND-NATIVE-WORDS-TO-KEEP' })
    const suffix = readFileSync(
      path,
      'utf8',
    ).slice(prefix.length)
    expect(suffix).toContain('SECOND-NATIVE-WORDS-TO-KEEP')
    expect(suffix).not.toContain('FIRST-NATIVE-WORDS-TO-KEEP')
    await pnyx.restart()
    const saved = (await hydra.owner({
      args: [
        'hydra',
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
    const hydra = await pnyx.hydra()
    const bad = await hydra.owner({
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
    await hydra.owner({
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
    await hydra.owner({
      args: [
        'task',
        'rename',
        'bad',
        '--title',
        'Earlier saved title',
      ],
    })
    await hydra.owner({
      args: [
        'task',
        'rename',
        'bad',
        '--title',
        'Last saved title',
      ],
    })
    await pnyx.restart({
      whileStopped: () => {
        const folder = join(
          process.env.PNYX_HOME!,
          'hydras',
          hydra.id,
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
    const unreadable = await hydra.task({ key: bad.card.id as string })
    expect(unreadable.title).toContain('Unreadable task')
    expect((await hydra.ownerRefused({
      args: [
        'task',
        'rename',
        bad.card.id as string,
        '--title',
        'Refused',
      ],
    })).code).toBe('LOG_CORRUPT')
    await hydra.owner({
      args: [
        'task',
        'rename',
        'healthy',
        '--title',
        'Still saved locally',
      ],
    })
    await pnyx.restart()
    expect((await hydra.task({ key: 'healthy' })).title).toBe('Still saved locally')
  },
)

test(
  'a refused decision preserves live observations without writing them',
  async () => {
    const hydra = await pnyx.hydra()
    await hydra.owner({
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
    await hydra.owner({
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
    const task = async () => (await hydra.owner({
      args: [
        'task',
        'show',
        'volatile',
        '--full',
      ],
    })).task
    expect((await task()).attention).toContainEqual(expect.objectContaining({ key: 'volatile' }))
    await hydra.ownerRefused({
      args: [
        'task',
        'rename',
        'volatile',
        '--title',
        'Refused',
        '--if-revision',
        '0',
      ],
    })
    expect((await task()).attention).toContainEqual(expect.objectContaining({ key: 'volatile' }))
  },
)

test(
  'a permission cancelled during its write resolves after the committed view is published',
  async () => {
    const hydra = await pnyx.hydra()
    const { worker } = await hydra.startTask({ key: 'cancel-during-write' })
    const task = await hydra.task({ key: 'cancel-during-write' })
    const taskLog = join(
      process.env.PNYX_HOME!,
      'hydras',
      hydra.id,
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

    // eslint-disable-next-line pnyx/object-params -- Node owns the sync signature.
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
      check: async () => (await hydra.owner({
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
    await pnyx.restart()
    const restored = (await hydra.owner({
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
  'a moved worker resumes once across different Hydra histories and receives the next owner message',
  async () => {
    const source = await pnyx.hydra()
    const destination = await pnyx.hydra()

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

    pnyx.claude.plan({
      hydra: source.id,
      match: ({ text }) => text.includes('<pnyx-worker'),
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
    await source.owner({
      args: [
        'task',
        'move',
        task,
        '--to-hydra',
        destination.id,
      ],
    })
    await pnyx.restart()
    const resumed = await until({
      what: 'the moved worker resumes its saved turn in the destination',
      check: () => pnyx.claude.sessions.find(session => session.cwd === folder && session.resumed),
    })
    expect(resumed.id).toBe(worker.id)
    const resumedSessions = pnyx.claude.sessions.filter(session =>
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
    const hydra = await pnyx.hydra()
    const created = await hydra.owner({
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
        boardId: hydra.id,
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
      hydra: hydra.id,
      task,
      decide: () => [fact],
    })
    const path = join(
      process.env.PNYX_HOME!,
      'hydras',
      hydra.id,
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
      hydraId: hydra.id,
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
    const source = await pnyx.hydra()
    const target = await pnyx.hydra()
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
      process.env.PNYX_HOME!,
      'hydras',
      source.id,
      'tasks',
      task,
    )
    const destination = join(
      process.env.PNYX_HOME!,
      'hydras',
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
    await runPnyx({
      args: [
        'setup',
        'check',
        '--hydra',
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
    const checked = await runPnyx({
      args: [
        'setup',
        'check',
        '--hydra',
        source.id,
        '--json',
      ],
      env: process.env,
    })
    expect(parsed({ stdout: checked.stdout || checked.stderr }).hydraId).toBe(source.id)
  },
)

test(
  'retained batch receipts stay with their Hydra across restart and task moves, including no-ops',
  async () => {
    const source = await pnyx.hydra()
    const target = await pnyx.hydra()
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
      process.env.PNYX_HOME!,
      'hydras',
      source.id,
      'hydra.log',
    )
    const before = readFileSync(
      rootLog,
      'utf8',
    )
    await pnyx.restart()
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
        '--to-hydra',
        target.id,
      ],
    })
    await pnyx.restart()
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
