import { appendFileSync, fdatasyncSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, vi } from 'vitest'
import { openFileStore } from '#store/file-store.ts'
import type { LogEntry, LogFact } from '#store/log.ts'

vi.hoisted(() => {
  vi.resetModules()
})

vi.mock(
  'node:fs',
  async () => {
    const filesystem = await vi.importActual<typeof import('node:fs')>('node:fs')

    return {
      ...filesystem,
      fdatasyncSync: vi.fn(filesystem.fdatasyncSync),
    }
  },
)

const AT = '2026-11-21T05:00:00.000Z'
interface Conversation {
  title: string
  latest?: string
  words: {
    id: string
    text: string
  }[]
  copy?: string
}

function conversation({
  state,
  entry,
}: {
  state?: Conversation
  entry: LogEntry
}): Conversation {
  if (entry.t === 'config' || entry.t === 'created') {
    return {
      title: String(entry.title ?? entry.name),
      words: [],
    }
  }

  if (!state) {
    throw new Error('A conversation must be created before it changes')
  }

  if (entry.t === 'say') {
    return {
      ...state,
      words: [
        ...state.words,
        {
          id: entry.id,
          text: String(entry.text),
        },
      ],
    }
  }

  if (entry.t === 'copy') {
    return {
      ...state,
      copy: String(entry.path),
    }
  }

  if (entry.t === 'worker') {
    return {
      ...state,
      latest: String(entry.text),
    }
  }

  if (entry.t === 'moved') {
    return state
  }

  throw new Error(`Unknown conversation fact: ${entry.t}`)
}

const fact = ({
  id,
  t = 'say',
  ...fields
}: {
  id: string
  t?: string
  [key: string]: unknown
}): LogFact => ({
  at: AT,
  by: 'owner',
  t,
  id,
  ...fields,
})
const homeFolder = () => mkdtempSync(join(
  process.env.TMPDIR!,
  'native-store-',
))
const store = ({ home }: { home: string }) => openFileStore({
  home,
  reduceHydra: conversation,
  reduceTask: conversation,
})

const create = async ({ home }: { home: ReturnType<typeof store> }) => {
  await home.createHydra({
    hydra: 'a',
    facts: [
      fact({
        id: 'config-a',
        t: 'config',
        name: 'A',
      }),
    ],
  })
  await home.createTask({
    hydra: 'a',
    task: 'task',
    facts: [
      fact({
        id: 'create-task',
        t: 'created',
        title: 'Task',
      }),
    ],
  })
}

test(
  'ordered decisions see prior writes, preserve native owner ids and acknowledge durable lines',
  async () => {
    const dir = homeFolder()
    const home = store({ home: dir })
    await create({ home })
    const first = home.changeTask({
      hydra: 'a',
      task: 'task',
      decide: ({ state }) => [
        fact({
          id: 'm_native-user-1',
          text: `words ${state.words.length + 1}`,
        }),
      ],
    })
    const second = home.changeTask({
      hydra: 'a',
      task: 'task',
      decide: ({ state }) => [
        fact({
          id: 'm_native-user-2',
          text: `words ${state.words.length + 1}`,
        }),
      ],
    })
    const receipts = await Promise.all([
      first,
      second,
    ])
    expect(receipts.map(receipt => receipt.map(entry => entry.id))).toEqual([
      ['m_native-user-1'],
      ['m_native-user-2'],
    ])
    const saved = readFileSync(
      join(
        dir,
        'hydras/a/tasks/task/task.log',
      ),
      'utf8',
    )
      .trim()
      .split('\n')
      .map(line => JSON.parse(line))
    expect(saved.map(entry => entry.id)).toEqual([
      'create-task',
      'm_native-user-1',
      'm_native-user-2',
    ])
    expect(saved.map(entry => entry.n)).toEqual([
      1,
      2,
      3,
    ])
    expect(saved.some(entry => 'seq' in entry || 'cardId' in entry || 'v' in entry)).toBe(false)
    expect(home.read({ hydra: 'a' })?.tasks.get('task')?.state?.words).toEqual([
      {
        id: 'm_native-user-1',
        text: 'words 1',
      },
      {
        id: 'm_native-user-2',
        text: 'words 2',
      },
    ])
    await home.close()
  },
)

test(
  'snapshot tails restore state and idempotency, and a changed cache falls back to the logs',
  async () => {
    const dir = homeFolder()
    let home = store({ home: dir })
    await create({ home })
    const native = fact({
      id: 'm_native-input',
      text: 'Read these exact words',
    })
    await home.changeTask({
      hydra: 'a',
      task: 'task',
      decide: () => [native],
    })
    await home.close()
    const taskLog = join(
      dir,
      'hydras/a/tasks/task/task.log',
    )
    appendFileSync(
      taskLog,
      `${JSON.stringify({
        n: 3,
        ...fact({
          id: 'm_after-snapshot',
          text: 'Tail words',
        }),
      })}\n`,
    )
    const replay = vi.fn(conversation)
    home = openFileStore({
      home: dir,
      reduceHydra: conversation,
      reduceTask: replay,
    })
    expect(replay.mock.calls.map(([call]) => call.entry.id)).toEqual(['m_after-snapshot'])
    const retry = await home.changeTask({
      hydra: 'a',
      task: 'task',
      decide: () => [
        {
          ...native,
          at: '2026-11-21T05:01:00.000Z',
        },
      ],
    })
    expect(retry).toMatchObject([
      {
        id: 'm_native-input',
        n: 2,
        duplicate: true,
      },
    ])
    expect(home.read({ hydra: 'a' })?.tasks.get('task')?.state?.words.map(word => word.id)).toEqual([
      'm_native-input',
      'm_after-snapshot',
    ])
    await expect(home.changeTask({
      hydra: 'a',
      task: 'task',
      decide: () => [
        fact({
          id: 'm_native-input',
          text: 'Different intent',
        }),
      ],
    })).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' })
    await home.close()
    const path = join(
      dir,
      'hydras/a/snapshot.json',
    )
    const snapshot = JSON.parse(readFileSync(
      path,
      'utf8',
    ))
    snapshot.state.content.tasks.task.value.words = []
    writeFileSync(
      path,
      JSON.stringify(snapshot),
    )
    home = store({ home: dir })
    expect(home.read({ hydra: 'a' })?.tasks.get('task')?.state?.words).toHaveLength(2)
    await home.close()
  },
)

test(
  'a task move carries its history and retry keys while keeping its copy path',
  async () => {
    const dir = homeFolder()
    const home = store({ home: dir })
    await create({ home })
    await home.createHydra({
      hydra: 'b',
      facts: [
        fact({
          id: 'config-b',
          t: 'config',
          name: 'B',
        }),
      ],
    })
    const copy = join(
      dir,
      'copies/project-1',
    )
    expect(home.hydras().sort()).toEqual([
      'a',
      'b',
    ])
    await home.changeTask({
      hydra: 'a',
      task: 'task',
      decide: () => [
        fact({
          id: 'copy-task',
          t: 'copy',
          path: copy,
        }),
      ],
    })
    const moving = {
      from: 'a',
      to: 'b',
      task: 'task',
      id: 'native-move',
      at: AT,
      by: 'owner' as const,
    }
    await home.moveTask(moving)
    expect(home.locateTask({ task: 'task' })).toEqual({
      hydra: 'b',
      dir: join(
        dir,
        'hydras/b/tasks/task',
      ),
    })
    expect(home.read({ hydra: 'a' })?.tasks.has('task')).toBe(false)
    expect(home.read({ hydra: 'b' })?.tasks.get('task')?.state?.copy).toBe(copy)
    expect(await home.moveTask(moving)).toMatchObject([
      {
        id: 'native-move',
        duplicate: true,
      },
    ])
    await home.changeTask({
      hydra: 'b',
      task: 'task',
      decide: () => [
        fact({
          id: 'm_after-move',
          text: 'Still the same task',
        }),
      ],
    })
    await home.close()
    const reopened = store({ home: dir })
    expect(reopened.read({ hydra: 'b' })?.tasks.get('task')?.state).toMatchObject({
      copy,
      words: [
        {
          id: 'm_after-move',
          text: 'Still the same task',
        },
      ],
    })
    await reopened.close()
  },
)

test(
  'concurrent writes to one task sync once, and a failed sync returns no success receipt',
  async () => {
    const dir = homeFolder()
    const home = store({ home: dir })
    await create({ home })
    vi.mocked(fdatasyncSync).mockClear()
    await Promise.all([
      'one',
      'two',
    ].map(id => home.changeTask({
      hydra: 'a',
      task: 'task',
      decide: () => [
        fact({
          id,
          text: id,
        }),
      ],
    })))
    expect(fdatasyncSync).toHaveBeenCalledTimes(1)
    vi.mocked(fdatasyncSync).mockImplementationOnce(() => {
      throw new Error('injected sync failure')
    })
    const uncertain = fact({
      id: 'm_uncertain',
      text: 'Accepted only after durability',
    })
    await expect(home.changeTask({
      hydra: 'a',
      task: 'task',
      decide: () => [uncertain],
    })).rejects.toMatchObject({ code: 'WRITE_FAILED' })
    expect(await home.changeTask({
      hydra: 'a',
      task: 'task',
      decide: () => [uncertain],
    }))
      .toMatchObject([
        {
          id: 'm_uncertain',
          duplicate: true,
        },
      ])
    expect(home.read({ hydra: 'a' })?.tasks.get('task')?.state?.words.filter(word => word.id === uncertain.id)).toHaveLength(1)
    await home.close()
  },
)

test(
  'a refused decision rolls back its draft and does not discard adjacent valid commands',
  async () => {
    const home = store({ home: homeFolder() })
    await create({ home })
    const writes = await Promise.allSettled([
      home.changeTask({
        hydra: 'a',
        task: 'task',
        decide: () => [
          fact({
            id: 'valid-before',
            text: 'Before',
          }),
        ],
      }),
      home.changeTask({
        hydra: 'a',
        task: 'task',
        decide: ({ state }) => {
          state.words.length = 0

          throw new Error('invalid command')
        },
      }),
      home.changeTask({
        hydra: 'a',
        task: 'task',
        decide: ({ state }) => [
          fact({
            id: 'valid-after',
            text: `After ${state.words.length}`,
          }),
        ],
      }),
    ])
    expect(writes.map(write => write.status)).toEqual([
      'fulfilled',
      'rejected',
      'fulfilled',
    ])
    expect(home.read({ hydra: 'a' })?.tasks.get('task')?.state?.words.map(word => word.text)).toEqual([
      'Before',
      'After 1',
    ])
    await expect(home.changeTask({
      hydra: 'a',
      task: 'task',
      decide: () => [
        fact({
          id: 'invalid-time',
          at: 'not a date',
          text: 'Refuse this header',
        }),
      ],
    })).rejects.toMatchObject({ code: 'INVALID_EVENT' })
    await home.close()
  },
)

test(
  'a corrupt task is refused while another task keeps accepting durable commands',
  async () => {
    const dir = homeFolder()
    let home = store({ home: dir })
    await create({ home })
    await home.createTask({
      hydra: 'a',
      task: 'healthy',
      facts: [
        fact({
          id: 'create-healthy',
          t: 'created',
          title: 'Healthy',
        }),
      ],
    })
    await home.close()
    const path = join(
      dir,
      'hydras/a/tasks/task/task.log',
    )
    appendFileSync(
      path,
      '{invalid-middle}\n{"n":2}\n',
    )
    home = store({ home: dir })
    expect(home.read({ hydra: 'a' })?.tasks.get('task')?.issue).toMatchObject({ code: 'LOG_CORRUPT' })
    await expect(home.changeTask({
      hydra: 'a',
      task: 'task',
      decide: ({ state }) => [
        fact({
          id: 'refused',
          text: state.title,
        }),
      ],
    }))
      .rejects.toMatchObject({ code: 'LOG_CORRUPT' })
    await home.changeTask({
      hydra: 'a',
      task: 'healthy',
      decide: () => [
        fact({
          id: 'm_healthy',
          text: 'Still readable',
        }),
      ],
    })
    await home.close()
    home = store({ home: dir })
    expect(home.read({ hydra: 'a' })?.tasks.get('healthy')?.state?.words).toEqual([
      {
        id: 'm_healthy',
        text: 'Still readable',
      },
    ])
    await home.close()
  },
)

test(
  'worker byte cursors advance once and survive snapshots with their native receipt ids',
  async () => {
    const dir = homeFolder()
    let home = store({ home: dir })
    await create({ home })
    const line = fact({
      id: 'worker:task:37',
      t: 'worker',
      by: 'worker',
      off: 37,
      code: 'note',
      text: 'Recorded once',
    })
    await home.changeTask({
      hydra: 'a',
      task: 'task',
      decide: () => [line],
    })
    await expect(home.changeTask({
      hydra: 'a',
      task: 'task',
      decide: () => [
        {
          ...line,
          id: 'different-id-at-same-offset',
          text: 'Duplicate bytes',
        },
      ],
    })).rejects.toMatchObject({ code: 'INVALID_EVENT' })
    await home.close()
    const snapshot = JSON.parse(readFileSync(
      join(
        dir,
        'hydras/a/snapshot.json',
      ),
      'utf8',
    ))
    expect(snapshot.tasks.task.worker).toBe(37)
    home = store({ home: dir })
    expect(home.read({ hydra: 'a' })?.tasks.get('task')).toMatchObject({
      worker: 37,
      state: { latest: 'Recorded once' },
    })
    expect(await home.changeTask({
      hydra: 'a',
      task: 'task',
      decide: () => [line],
    }))
      .toMatchObject([
        {
          id: line.id,
          duplicate: true,
        },
      ])
    await home.close()
  },
)

test(
  'failed move recovery refuses further writes until the home can be reopened',
  async () => {
    const dir = homeFolder()
    const home = store({ home: dir })
    await create({ home })
    await home.createHydra({
      hydra: 'b',
      facts: [
        fact({
          id: 'config-b',
          t: 'config',
          name: 'B',
        }),
      ],
    })
    const filesystem = await vi.importActual<typeof import('node:fs')>('node:fs')
    vi.mocked(fdatasyncSync).mockImplementation(() => {
      throw Object.assign(
        new Error('injected storage outage'),
        { code: 'EIO' },
      )
    })

    try {
      await expect(home.moveTask({
        from: 'a',
        to: 'b',
        task: 'task',
        id: 'move-during-outage',
        at: AT,
        by: 'owner',
      }))
        .rejects.toMatchObject({ code: 'WRITE_FAILED' })
      await expect(home.changeTask({
        hydra: 'a',
        task: 'task',
        decide: () => [
          fact({
            id: 'must-refuse',
            text: 'No false success',
          }),
        ],
      }))
        .rejects.toMatchObject({ code: 'STORE_UNAVAILABLE' })
    } finally {
      vi.mocked(fdatasyncSync).mockImplementation(filesystem.fdatasyncSync)
    }

    const reopened = store({ home: dir })
    expect(reopened.read({ hydra: 'a' })?.tasks.has('task')).toBe(false)
    expect(reopened.read({ hydra: 'b' })?.tasks.get('task')?.state?.title).toBe('Task')
    await reopened.close()
  },
)
