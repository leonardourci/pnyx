import { appendFileSync, chmodSync, existsSync, fdatasyncSync, fsyncSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, vi } from 'vitest'
import { openFileStore } from '#store/file-store.ts'
import { readLog, type LogEntry, type LogFact } from '#store/log.ts'

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
      fsyncSync: vi.fn(filesystem.fsyncSync),
    }
  },
)

const AT = '2026-11-21T05:00:00.000Z'
const LARGE_BATCH_SIZE = 150_000
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
  tmpdir(),
  'native-store-',
))
const store = ({ home }: { home: string }) => openFileStore({
  home,
  reduceTitan: conversation,
  reduceTask: conversation,
})

const create = async ({ home }: { home: ReturnType<typeof store> }) => {
  await home.createTitan({
    titan: 'a',
    facts: [
      fact({
        id: 'config-a',
        t: 'config',
        name: 'A',
      }),
    ],
  })
  await home.createTask({
    titan: 'a',
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
  'a command validates all changed scopes before writing any of its facts',
  async () => {
    const path = homeFolder()
    const home = store({ home: path })
    await create({ home })
    const logPath = join(
      path,
      'titans',
      'a',
      'tasks',
      'task',
      'task.log',
    )
    const before = readFileSync(
      logPath,
      'utf8',
    )

    try {
      await expect(home.change({
        decide: () => [
          {
            titan: 'a',
            task: 'task',
            facts: [
              fact({
                id: 'first',
                text: 'Must not land alone',
              }),
            ],
          },
          {
            titan: 'missing',
            facts: [
              fact({
                id: 'second',
                text: 'Invalid later scope',
              }),
            ],
          },
        ],
      })).rejects.toMatchObject({ code: 'NOT_FOUND' })
      expect(readFileSync(
        logPath,
        'utf8',
      )).toBe(before)
      expect(home.read({ titan: 'a' })?.tasks.get('task')?.state?.words).toEqual([])
      const receipts = await home.change({
        decide: ({ read }) => {
          expect(read({ titan: 'a' })?.tasks.get('task')?.state?.words).toEqual([])

          return [
            {
              titan: 'a',
              task: 'task',
              facts: [
                fact({
                  id: 'first',
                  text: 'Both can land',
                }),
              ],
            },
            {
              titan: 'a',
              facts: [
                fact({
                  id: 'second',
                  text: 'Titan decision',
                }),
              ],
            },
          ]
        },
      })
      expect(receipts).toEqual([
        {
          id: 'first',
          n: 2,
          at: AT,
          duplicate: false,
        },
        {
          id: 'second',
          n: 2,
          at: AT,
          duplicate: false,
        },
      ])
    } finally {
      await home.close()
    }

    const reopened = store({ home: path })

    try {
      expect(reopened.read({ titan: 'a' })?.tasks.get('task')?.state?.words)
        .toEqual([
          {
            id: 'first',
            text: 'Both can land',
          },
        ])
      expect(reopened.read({ titan: 'a' })?.state?.words)
        .toEqual([
          {
            id: 'second',
            text: 'Titan decision',
          },
        ])
    } finally {
      await reopened.close()
    }
  },
)

test(
  'a command reads the durable queue prefix and later commands see all its changed scopes',
  async () => {
    const path = homeFolder()
    const home = store({ home: path })
    await create({ home })

    try {
      const first = home.changeTask({
        titan: 'a',
        task: 'task',
        decide: () => [
          fact({
            id: 'prefix',
            text: 'Earlier command',
          }),
        ],
      })
      const batch = home.change({
        decide: ({ read }) => {
          expect(read({ titan: 'a' })?.tasks.get('task')?.state?.words.at(-1)?.id).toBe('prefix')
          const lines = readFileSync(
            join(
              path,
              'titans/a/tasks/task/task.log',
            ),
            'utf8',
          ).trim()
            .split('\n')
          expect(JSON.parse(lines.at(-1)!).id).toBe('prefix')

          return [
            {
              titan: 'a',
              facts: [
                fact({
                  id: 'titan',
                  text: 'Titan decision',
                }),
              ],
            },
            {
              titan: 'a',
              task: 'task',
              facts: [
                fact({
                  id: 'task',
                  text: 'Task decision',
                }),
              ],
            },
          ]
        },
      })
      const next = home.change({
        decide: ({ read }) => {
          const titan = read({ titan: 'a' })
          expect(titan?.state?.words.at(-1)?.id).toBe('titan')
          expect(titan?.tasks.get('task')?.state?.words.at(-1)?.id).toBe('task')

          return []
        },
      })
      await Promise.all([
        first,
        batch,
        next,
      ])
    } finally {
      await home.close()
    }
  },
)

test(
  'submitted creation facts are captured before the queue runs',
  async () => {
    const home = store({ home: homeFolder() })
    const titanFacts = [
      fact({
        id: 'submitted-config',
        t: 'config',
        name: 'Submitted',
      }),
    ]
    const creatingTitan = home.createTitan({
      titan: 'a',
      facts: titanFacts,
    })
    titanFacts[0]!.name = 'Changed'
    titanFacts.push(fact({
      id: 'extra',
      text: 'Not submitted',
    }))
    await creatingTitan
    expect(home.read({ titan: 'a' })?.state).toEqual({
      title: 'Submitted',
      words: [],
    })
    const taskFacts = [
      fact({
        id: 'submitted-task',
        t: 'created',
        title: 'Submitted task',
      }),
    ]
    const creatingTask = home.createTask({
      titan: 'a',
      task: 'task',
      facts: taskFacts,
    })
    taskFacts[0]!.title = 'Changed task'
    taskFacts.length = 0
    await creatingTask
    expect(home.read({ titan: 'a' })?.tasks.get('task')?.state)
      .toEqual({
        title: 'Submitted task',
        words: [],
      })
    await home.close()
  },
)

test(
  'one canonical home stays owned until close drains, without filesystem locks',
  async () => {
    const dir = homeFolder()
    const alias = join(
      homeFolder(),
      'alias',
    )
    symlinkSync(
      dir,
      alias,
    )
    const home = store({ home: dir })
    await create({ home })
    expect(() => store({ home: alias })).toThrow(/already open/)
    const closing = home.close()
    expect(() => store({ home: dir })).toThrow(/already open/)
    await closing
    const reopened = store({ home: alias })
    expect(reopened.read({ titan: 'a' })?.tasks.has('task')).toBe(true)
    const otherHome = homeFolder()
    rmSync(alias)
    symlinkSync(
      otherHome,
      alias,
    )
    await reopened.createTitan({
      titan: 'pinned',
      facts: [
        fact({
          id: 'pinned-config',
          t: 'config',
          name: 'Pinned',
        }),
      ],
    })
    await reopened.close()
    expect(existsSync(join(
      otherHome,
      'titans',
    ))).toBe(false)
    rmSync(join(
      dir,
      'titans/a/snapshot.json',
    ))
    vi.mocked(fdatasyncSync).mockImplementationOnce(() => {
      throw Object.assign(
        new Error('injected open failure'),
        { code: 'EIO' },
      )
    })
    expect(() => store({ home: dir })).toThrow(/injected open failure/)
    const recovered = store({ home: dir })
    expect(recovered.read({ titan: 'a' })?.tasks.has('task')).toBe(true)
    expect(recovered.titans()).toContain('pinned')
    await recovered.close()
  },
)

test(
  'an unreadable task is isolated and an unreadable snapshot falls back to native logs',
  async () => {
    const dir = homeFolder()
    let home = store({ home: dir })
    await create({ home })
    await home.createTask({
      titan: 'a',
      task: 'healthy',
      facts: [
        fact({
          id: 'healthy',
          t: 'created',
          title: 'Healthy',
        }),
      ],
    })
    await home.close()
    const log = join(
      dir,
      'titans/a/tasks/task/task.log',
    )
    const cache = join(
      dir,
      'titans/a/snapshot.json',
    )
    const saved = readFileSync(
      log,
      'utf8',
    )
    chmodSync(
      log,
      0o400,
    )
    chmodSync(
      cache,
      0o000,
    )

    try {
      home = store({ home: dir })
      expect(home.read({ titan: 'a' })?.tasks.get('task')?.issue?.code).toBe('LOG_UNREADABLE')
      await expect(home.changeTask({
        titan: 'a',
        task: 'task',
        decide: () => [
          fact({
            id: 'refused',
            text: 'Refused',
          }),
        ],
      })).rejects.toMatchObject({ code: 'LOG_UNREADABLE' })
      await home.changeTask({
        titan: 'a',
        task: 'healthy',
        decide: () => [
          fact({
            id: 'saved',
            text: 'Available',
          }),
        ],
      })
      expect(readFileSync(
        log,
        'utf8',
      )).toBe(saved)
      await home.close()
    } finally {
      chmodSync(
        log,
        0o600,
      )
      chmodSync(
        cache,
        0o600,
      )
    }

    home = store({ home: dir })
    expect(home.read({ titan: 'a' })?.tasks.get('healthy')?.state?.words)
      .toEqual([
        {
          id: 'saved',
          text: 'Available',
        },
      ])
    await home.close()
  },
)

test(
  'a large queued decision commits every receipt before publishing its state',
  async () => {
    const dir = homeFolder()
    const count = ({ state = 0 }: { state?: number }) => state + 1
    let home = openFileStore({
      home: dir,
      reduceTitan: count,
      reduceTask: count,
    })
    await home.createTitan({
      titan: 'a',
      facts: [
        fact({
          id: 'config',
          t: 'config',
        }),
      ],
    })
    await home.createTask({
      titan: 'a',
      task: 'task',
      facts: [
        fact({
          id: 'created',
          t: 'created',
        }),
      ],
    })
    const batch = Array.from(
      { length: LARGE_BATCH_SIZE },
      (
        _,
        i,
      ) => fact({
        id: `bulk-${i}`,
        text: 'Saved',
      }),
    )
    const [
      first,
      many,
    ] = await Promise.all([
      home.changeTask({
        titan: 'a',
        task: 'task',
        decide: () => [
          fact({
            id: 'first',
            text: 'First',
          }),
        ],
      }),
      home.changeTask({
        titan: 'a',
        task: 'task',
        decide: () => batch,
      }),
    ])
    expect(first).toMatchObject([
      {
        id: 'first',
        n: 2,
      },
    ])
    expect(many).toHaveLength(batch.length)
    expect(many.at(-1)).toMatchObject({
      id: 'bulk-149999',
      n: 150_002,
    })
    await home.close()
    home = openFileStore({
      home: dir,
      reduceTitan: count,
      reduceTask: count,
    })
    expect(home.read({ titan: 'a' })?.tasks.get('task')?.state).toBe(150_002)
    await home.close()
  },
)

test(
  'ordered decisions see prior writes, preserve native owner ids and acknowledge durable lines',
  async () => {
    const dir = homeFolder()
    const home = store({ home: dir })
    await create({ home })
    const context = home.changeTitan({
      titan: 'a',
      decide: () => [
        fact({
          id: 'titan-context',
          text: 'Root',
        }),
      ],
    })
    const first = home.changeTask({
      titan: 'a',
      task: 'task',
      decide: ({
        state,
        read,
      }) => [
        fact({
          id: 'm_native-user-1',
          text: `${read({ titan: 'a' })?.state?.words[0]?.text} words ${state.words.length + 1}`,
        }),
      ],
    })
    const second = home.changeTask({
      titan: 'a',
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
    await context
    expect(receipts.map(receipt => receipt.map(entry => entry.id))).toEqual([
      ['m_native-user-1'],
      ['m_native-user-2'],
    ])
    const saved = readFileSync(
      join(
        dir,
        'titans/a/tasks/task/task.log',
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
    expect(home.read({ titan: 'a' })?.tasks.get('task')?.state?.words).toEqual([
      {
        id: 'm_native-user-1',
        text: 'Root words 1',
      },
      {
        id: 'm_native-user-2',
        text: 'words 2',
      },
    ])
    await home.close()
    const reopened = store({ home: dir })
    expect(reopened.read({ titan: 'a' })?.state?.words).toEqual([
      {
        id: 'titan-context',
        text: 'Root',
      },
    ])
    expect(reopened.read({ titan: 'a' })?.tasks.get('task')?.state?.words[0]?.text).toBe('Root words 1')
    await reopened.close()
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
    const written = home.changeTask({
      titan: 'a',
      task: 'task',
      decide: () => [native],
    })
    await home.snapshot()
    await written
    expect(JSON.parse(readFileSync(
      join(
        dir,
        'titans/a/snapshot.json',
      ),
      'utf8',
    )).tasks.task.task.n).toBe(2)
    const queued = home.changeTitan({
      titan: 'a',
      decide: () => [
        fact({
          id: 'm_before-close',
          text: 'Before close',
        }),
      ],
    })
    const closing = home.close()
    await expect(home.changeTask({
      titan: 'a',
      task: 'task',
      decide: () => [
        fact({
          id: 'late',
          text: 'Too late',
        }),
      ],
    }))
      .rejects.toMatchObject({ code: 'STORE_CLOSED' })
    await Promise.all([
      queued,
      closing,
    ])
    const taskLog = join(
      dir,
      'titans/a/tasks/task/task.log',
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
      reduceTitan: conversation,
      reduceTask: replay,
    })
    expect(replay.mock.calls.map(([call]) => call.entry.id)).toEqual(['m_after-snapshot'])
    expect(home.read({ titan: 'a' })?.state?.words).toEqual([
      {
        id: 'm_before-close',
        text: 'Before close',
      },
    ])
    const retry = await home.changeTask({
      titan: 'a',
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
        at: AT,
        duplicate: true,
      },
    ])
    expect(home.read({ titan: 'a' })?.tasks.get('task')?.state?.words.map(word => word.id)).toEqual([
      'm_native-input',
      'm_after-snapshot',
    ])
    await expect(home.changeTask({
      titan: 'a',
      task: 'task',
      decide: () => [
        fact({
          id: 'm_native-input',
          text: 'Different intent',
        }),
      ],
    })).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' })
    await expect(home.changeTask({
      titan: 'a',
      task: 'task',
      decide: () => [
        {
          ...native,
          n: 2,
        },
      ],
    })).rejects.toMatchObject({ code: 'INVALID_EVENT' })
    await home.close()
    const path = join(
      dir,
      'titans/a/snapshot.json',
    )
    writeFileSync(
      path,
      readFileSync(
        path,
        'utf8',
      ).replace(
        'Read these exact words',
        'Changed cache words',
      ),
    )
    home = store({ home: dir })
    expect(home.read({ titan: 'a' })?.tasks.get('task')?.state?.words).toEqual([
      {
        id: 'm_native-input',
        text: 'Read these exact words',
      },
      {
        id: 'm_after-snapshot',
        text: 'Tail words',
      },
    ])
    await home.close()
  },
)

test(
  'a task move carries its history and retry keys while keeping its copy path',
  async () => {
    const dir = homeFolder()
    const home = store({ home: dir })
    await create({ home })
    await home.createTitan({
      titan: 'b',
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
    expect(home.titans().sort()).toEqual([
      'a',
      'b',
    ])
    await expect(home.createTask({
      titan: 'b',
      task: 'task',
      facts: [
        fact({
          id: 'duplicate-task',
          t: 'created',
          title: 'Duplicate',
        }),
      ],
    }))
      .rejects.toMatchObject({ code: 'CONFLICT' })
    await home.changeTask({
      titan: 'a',
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
      titan: 'b',
      dir: join(
        realpathSync(dir),
        'titans/b/tasks/task',
      ),
    })
    expect(home.read({ titan: 'a' })?.tasks.has('task')).toBe(false)
    expect(home.read({ titan: 'b' })?.tasks.get('task')?.state?.copy).toBe(copy)
    expect(await home.moveTask(moving)).toMatchObject([
      {
        id: 'native-move',
        duplicate: true,
      },
    ])
    await home.changeTask({
      titan: 'b',
      task: 'task',
      decide: () => [
        fact({
          id: 'm_after-move',
          text: 'Still the same task',
        }),
      ],
    })
    await home.moveTask({
      from: 'b',
      to: 'a',
      task: 'task',
      id: 'move-back',
      at: AT,
      by: 'owner',
    })
    expect(await home.moveTask(moving)).toMatchObject([
      {
        id: 'native-move',
        n: 3,
        at: AT,
        duplicate: true,
      },
    ])
    expect(home.locateTask({ task: 'task' })?.titan).toBe('a')
    await home.close()
    rmSync(join(
      dir,
      'titans/a/snapshot.json',
    ))
    rmSync(join(
      dir,
      'titans/b/snapshot.json',
    ))
    const reopened = store({ home: dir })
    expect(reopened.read({ titan: 'a' })?.tasks.get('task')?.state).toMatchObject({
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
  'concurrent writes sync once and recovery syncs a failed write before acknowledging its retry',
  async () => {
    const dir = homeFolder()
    const home = store({ home: dir })
    await create({ home })
    vi.mocked(fdatasyncSync).mockClear()
    await Promise.all([
      'one',
      'two',
    ].map(id => home.changeTask({
      titan: 'a',
      task: 'task',
      decide: () => [
        fact({
          id,
          text: id,
        }),
      ],
    })))
    expect(fdatasyncSync).toHaveBeenCalledTimes(1)
    const filesystem = await vi.importActual<typeof import('node:fs')>('node:fs')
    const inode = filesystem.statSync(join(
      dir,
      'titans/a/tasks/task/task.log',
    )).ino
    let recovered = false
    vi.mocked(fdatasyncSync).mockImplementationOnce(() => {
      throw new Error('injected sync failure')
    })

    // eslint-disable-next-line othrys/object-params -- Node's sync replacement receives a file descriptor.
    const syncFile: typeof filesystem.fdatasyncSync = fd => {
      filesystem.fdatasyncSync(fd)

      if (filesystem.fstatSync(fd).ino === inode) {
        recovered = true
      }
    }

    vi.mocked(fdatasyncSync).mockImplementation(syncFile)
    const uncertain = fact({
      id: 'm_uncertain',
      text: 'Accepted only after durability',
    })
    await expect(home.changeTask({
      titan: 'a',
      task: 'task',
      decide: () => [uncertain],
    })).rejects.toMatchObject({ code: 'WRITE_FAILED' })
    expect(await home.changeTask({
      titan: 'a',
      task: 'task',
      decide: () => [uncertain],
    }))
      .toMatchObject([
        {
          id: 'm_uncertain',
          duplicate: true,
        },
      ])
    expect(recovered).toBe(true)
    vi.mocked(fdatasyncSync).mockImplementation(filesystem.fdatasyncSync)
    expect(home.read({ titan: 'a' })?.tasks.get('task')?.state?.words.filter(word => word.id === uncertain.id)).toHaveLength(1)
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
        titan: 'a',
        task: 'task',
        decide: () => [
          fact({
            id: 'valid-before',
            text: 'Before',
          }),
        ],
      }),
      home.changeTask({
        titan: 'a',
        task: 'task',
        decide: ({ state }) => {
          state.words.length = 0

          throw new Error('invalid command')
        },
      }),
      home.changeTask({
        titan: 'a',
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
    expect(home.read({ titan: 'a' })?.tasks.get('task')?.state?.words.map(word => word.text)).toEqual([
      'Before',
      'After 1',
    ])
    await expect(home.changeTask({
      titan: 'a',
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
      titan: 'a',
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
      'titans/a/tasks/task/task.log',
    )
    const prefix = readFileSync(
      path,
      'utf8',
    )
    const badMiddle = '{invalid-middle}\n'
    const badTail = '{invalid-final}\n'
    appendFileSync(
      path,
      badMiddle + badTail,
    )
    const cachePath = join(
      dir,
      'titans/a/snapshot.json',
    )
    const changedCache = JSON.parse(readFileSync(
      cachePath,
      'utf8',
    ))
    changedCache.tasks.task.task = {
      bytes: Buffer.byteLength(prefix + badMiddle),
      n: 2,
    }
    writeFileSync(
      cachePath,
      JSON.stringify(changedCache),
    )
    home = store({ home: dir })
    expect(home.read({ titan: 'a' })?.tasks.get('task')?.issue).toMatchObject({ code: 'LOG_CORRUPT' })
    expect(readFileSync(
      path,
      'utf8',
    )).toBe(prefix + badMiddle + badTail)
    await expect(home.changeTask({
      titan: 'a',
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
      titan: 'a',
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
    expect(home.read({ titan: 'a' })?.tasks.get('healthy')?.state?.words).toEqual([
      {
        id: 'm_healthy',
        text: 'Still readable',
      },
    ])
    await home.close()
  },
)

test(
  'read views cannot change saved receipts or remove their idempotency checks',
  async () => {
    const home = store({ home: homeFolder() })
    await create({ home })
    const message = fact({
      id: 'saved-message',
      text: 'Keep this receipt',
    })
    const titanReceipt = await home.changeTitan({
      titan: 'a',
      decide: () => [message],
    })
    const taskReceipt = await home.changeTask({
      titan: 'a',
      task: 'task',
      decide: () => [message],
    })

    for (const view of [
      home.read({ titan: 'a' })!,
      home.positions({ titan: 'a' })!,
    ]) {
      for (const accepted of [
        view.accepted,
        view.tasks.get('task')!.accepted,
      ]) {
        const receipt = accepted.get(message.id)!
        receipt.n = 999
        receipt.digest = 'changed outside the writer'
        accepted.clear()
      }
    }

    expect(await home.changeTitan({
      titan: 'a',
      decide: () => [message],
    })).toEqual([
      {
        ...titanReceipt[0],
        duplicate: true,
      },
    ])
    expect(await home.changeTask({
      titan: 'a',
      task: 'task',
      decide: () => [message],
    })).toEqual([
      {
        ...taskReceipt[0],
        duplicate: true,
      },
    ])
    await home.close()
  },
)

test(
  'bounded readers reject mismatched positions without truncating the log',
  async () => {
    const dir = homeFolder()
    const home = store({ home: dir })
    await create({ home })
    const path = join(
      dir,
      'titans/a/tasks/task/task.log',
    )
    const through = home.read({ titan: 'a' })!.tasks.get('task')!.position
    await home.close()
    const contents = readFileSync(
      path,
      'utf8',
    )

    for (const position of [
      {
        ...through,
        n: 0,
      },
      {
        ...through,
        n: through.n + 1,
      },
      {
        ...through,
        bytes: through.bytes - 1,
      },
    ]) {
      const accepted: string[] = []
      expect(() => readLog({
        path,
        through: position,
        accept: ({ entry }) => accepted.push(entry.id),
      })).toThrow()
      expect(readFileSync(
        path,
        'utf8',
      )).toBe(contents)

      if (position.n === 0) {
        expect(accepted).toEqual([])
      }
    }

    expect(readLog({
      path,
      through,
      accept: () => {},
    })).toEqual(through)
  },
)

test(
  'snapshot replay preserves an empty worker identity for inherited truncation reports',
  async () => {
    const dir = homeFolder()
    let home = store({ home: dir })
    await create({ home })
    await home.changeTask({
      titan: 'a',
      task: 'task',
      decide: () => [
        fact({
          id: 'worker-empty',
          t: 'worker',
          by: 'worker',
          identity: '',
          off: 37,
          text: 'Before truncation',
        }),
      ],
    })
    await home.close()
    appendFileSync(
      join(
        dir,
        'titans/a/tasks/task/task.log',
      ),
      `${JSON.stringify({
        n: 3,
        ...fact({
          id: 'worker-truncated',
          t: 'worker',
          by: 'worker',
          off: 37,
          code: 'invalid',
          text: 'Truncation recorded',
        }),
      })}\n`,
    )
    home = store({ home: dir })
    expect(home.read({ titan: 'a' })?.tasks.get('task')).toMatchObject({
      worker: 37,
      state: { latest: 'Truncation recorded' },
      issue: undefined,
    })
    await home.close()
  },
)

test(
  'readers page only acknowledged bytes and never repair a canonical log',
  async () => {
    const dir = homeFolder()
    const home = store({ home: dir })
    await create({ home })
    await home.changeTask({
      titan: 'a',
      task: 'task',
      decide: () => [
        fact({
          id: 'kept',
          text: 'Acknowledged',
        }),
      ],
    })
    const through = home.read({ titan: 'a' })!.tasks.get('task')!.position
    const path = join(
      dir,
      'titans/a/tasks/task/task.log',
    )
    await home.close()
    appendFileSync(
      path,
      '{torn',
    )
    const contents = readFileSync(
      path,
      'utf8',
    )

    for (const limit of [
      NaN,
      1.5,
    ]) {
      expect(() => readLog({
        path,
        through,
        readOnly: true,
        limit,
        accept: () => {},
      })).toThrow()
    }

    const first: string[] = []
    const cursor = readLog({
      path,
      through,
      readOnly: true,
      limit: 1,
      accept: ({ entry }) => first.push(entry.id),
    })
    expect(first).toEqual(['create-task'])
    const second: string[] = []
    expect(readLog({
      path,
      after: cursor,
      through,
      readOnly: true,
      accept: ({ entry }) => second.push(entry.id),
    })).toEqual(through)
    expect(second).toEqual(['kept'])
    expect(() => readLog({
      path,
      readOnly: true,
      accept: () => {},
    })).toThrow(expect.objectContaining({ code: 'LOG_CORRUPT' }))
    expect(readFileSync(
      path,
      'utf8',
    )).toBe(contents)
  },
)

test(
  'a replaced worker file starts its own cursor and truncation warnings survive restart',
  async () => {
    const dir = homeFolder()
    let home = store({ home: dir })
    await create({ home })
    const append = ({
      id,
      identity,
      off,
      code = 'note',
    }: {
      id: string
      identity: string
      off: number
      code?: string
    }) => home.changeTask({
      titan: 'a',
      task: 'task',
      decide: () => [
        fact({
          id,
          t: 'worker',
          by: 'worker',
          identity,
          off,
          code,
          text: id,
        }),
      ],
    })
    await append({
      id: 'first',
      identity: 'file-a',
      off: 100,
    })
    await expect(append({
      id: 'same-offset',
      identity: 'file-a',
      off: 100,
    })).rejects.toMatchObject({ code: 'INVALID_EVENT' })
    await append({
      id: 'truncated',
      identity: 'file-a',
      off: 100,
      code: 'invalid',
    })
    await home.close()
    home = store({ home: dir })
    expect(home.read({ titan: 'a' })?.tasks.get('task')?.state?.latest).toBe('truncated')
    await append({
      id: 'replaced',
      identity: 'file-b',
      off: 12,
    })
    await home.close()
    home = store({ home: dir })
    expect(home.read({ titan: 'a' })?.tasks.get('task')).toMatchObject({
      worker: 12,
      state: { latest: 'replaced' },
    })
    await expect(append({
      id: 'older',
      identity: 'file-b',
      off: 10,
    })).rejects.toMatchObject({ code: 'INVALID_EVENT' })
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
      titan: 'a',
      task: 'task',
      decide: () => [line],
    })
    const titanWorker = fact({
      id: 'titan-worker:100',
      t: 'worker',
      by: 'worker',
      off: 100,
      text: 'Titan report',
    })
    const olderTitanWorker = {
      ...titanWorker,
      id: 'titan-worker:50',
      off: 50,
    }
    await home.changeTitan({
      titan: 'a',
      decide: () => [titanWorker],
    })
    await expect(home.changeTitan({
      titan: 'a',
      decide: () => [olderTitanWorker],
    }))
      .rejects.toMatchObject({ code: 'INVALID_EVENT' })
    await expect(home.changeTask({
      titan: 'a',
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
        'titans/a/snapshot.json',
      ),
      'utf8',
    ))
    expect(snapshot.tasks.task.worker).toBe(37)
    const replay = vi.fn(conversation)
    const titanReplay = vi.fn(conversation)
    home = openFileStore({
      home: dir,
      reduceTitan: titanReplay,
      reduceTask: replay,
    })
    expect(home.read({ titan: 'a' })?.tasks.get('task')?.worker).toBe(37)
    expect(home.read({ titan: 'a' })?.worker).toBe(100)
    expect(replay).not.toHaveBeenCalled()
    expect(titanReplay).not.toHaveBeenCalled()
    await expect(home.changeTitan({
      titan: 'a',
      decide: () => [olderTitanWorker],
    }))
      .rejects.toMatchObject({ code: 'INVALID_EVENT' })
    expect(await home.changeTask({
      titan: 'a',
      task: 'task',
      decide: () => [line],
    })).toMatchObject([
      {
        id: line.id,
        duplicate: true,
      },
    ])
    await home.close()
    rmSync(join(
      dir,
      'titans/a/snapshot.json',
    ))
    home = store({ home: dir })
    expect(home.read({ titan: 'a' })?.worker).toBe(100)
    await expect(home.changeTitan({
      titan: 'a',
      decide: () => [olderTitanWorker],
    }))
      .rejects.toMatchObject({ code: 'INVALID_EVENT' })
    expect(home.read({ titan: 'a' })?.tasks.get('task')).toMatchObject({
      worker: 37,
      state: { latest: 'Recorded once' },
    })
    expect(await home.changeTask({
      titan: 'a',
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
    await home.createTitan({
      titan: 'b',
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
        titan: 'a',
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

    await expect(home.close()).rejects.toMatchObject({ code: 'STORE_UNAVAILABLE' })
    const reopened = store({ home: dir })
    expect(reopened.read({ titan: 'a' })?.tasks.has('task')).toBe(false)
    expect(reopened.read({ titan: 'b' })?.tasks.get('task')?.state?.title).toBe('Task')
    await reopened.close()
  },
)

test(
  'general decisions cannot record a folder move',
  async () => {
    const dir = homeFolder()
    const home = store({ home: dir })
    await create({ home })
    await home.createTitan({
      titan: 'b',
      facts: [
        fact({
          id: 'config-b',
          t: 'config',
          name: 'B',
        }),
      ],
    })
    await expect(home.changeTask({
      titan: 'a',
      task: 'task',
      decide: () => [
        fact({
          id: 'raw-move',
          t: 'moved',
          from: 'a',
          to: 'b',
        }),
      ],
    }))
      .rejects.toMatchObject({ code: 'INVALID_EVENT' })
    await expect(home.createTask({
      titan: 'a',
      task: 'raw-create',
      facts: [
        fact({
          id: 'raw-create',
          t: 'created',
          title: 'No raw move',
        }),
        fact({
          id: 'raw-create-move',
          t: 'moved',
          from: 'a',
          to: 'b',
        }),
      ],
    })).rejects.toMatchObject({ code: 'INVALID_EVENT' })
    let reads = 0
    await expect(home.changeTask({
      titan: 'a',
      task: 'task',
      decide: () => [
        {
          ...fact({
            id: 'changing-move',
            from: 'a',
            to: 'b',
          }),
          get t() {
            reads += 1

            return reads === 1 ? 'say' : 'moved'
          },
        },
      ],
    })).rejects.toMatchObject({ code: 'INVALID_EVENT' })
    expect(home.locateTask({ task: 'task' })?.titan).toBe('a')
    expect(home.locateTask({ task: 'raw-create' })).toBeUndefined()
    await home.close()

    appendFileSync(
      join(
        dir,
        'titans/a/tasks/task/task.log',
      ),
      `${JSON.stringify({
        n: 2,
        ...fact({
          id: 'create-task',
          t: 'moved',
          from: 'a',
          to: 'b',
        }),
      })}\n`,
    )
    const reopened = store({ home: dir })
    expect(reopened.locateTask({ task: 'task' })?.titan).toBe('a')
    expect(reopened.read({ titan: 'a' })?.tasks.get('task')?.issue?.code).toBe('LOG_CORRUPT')
    await reopened.close()
  },
)

test(
  'existing dotted Titan ids remain valid in native folders and discovery',
  async () => {
    const dir = homeFolder()
    const home = store({ home: dir })
    await home.createTitan({
      titan: 'dot.name',
      facts: [
        fact({
          id: 'dot-config',
          t: 'config',
          name: 'Dotted',
        }),
      ],
    })
    await home.createTask({
      titan: 'dot.name',
      task: 'task',
      facts: [
        fact({
          id: 'dot-task',
          t: 'created',
          title: 'Dotted task',
        }),
      ],
    })
    await home.close()
    const reopened = store({ home: dir })
    expect(reopened.titans()).toEqual(['dot.name'])
    expect(reopened.read({ titan: 'dot.name' })?.tasks.get('task')?.state?.title).toBe('Dotted task')
    await reopened.close()
  },
)

test(
  'a directory in place of one task log does not prevent healthy tasks from opening',
  async () => {
    const dir = homeFolder()
    const home = store({ home: dir })
    await create({ home })
    await home.createTask({
      titan: 'a',
      task: 'healthy',
      facts: [
        fact({
          id: 'healthy-create',
          t: 'created',
          title: 'Healthy',
        }),
      ],
    })
    await home.close()
    const path = join(
      dir,
      'titans/a/tasks/task/task.log',
    )
    rmSync(path)
    mkdirSync(path)
    const reopened = store({ home: dir })
    expect(reopened.read({ titan: 'a' })?.tasks.get('task')?.issue).toMatchObject({ code: 'LOG_CORRUPT' })
    await reopened.changeTask({
      titan: 'a',
      task: 'healthy',
      decide: () => [
        fact({
          id: 'healthy-word',
          text: 'Still working',
        }),
      ],
    })
    expect(reopened.read({ titan: 'a' })?.tasks.get('healthy')?.state?.words).toEqual([
      {
        id: 'healthy-word',
        text: 'Still working',
      },
    ])
    await reopened.close()
  },
)

test(
  'a dependent decision cannot survive when the preceding scope write failed',
  async () => {
    const dir = homeFolder()
    const home = store({ home: dir })
    await create({ home })
    await home.createTask({
      titan: 'a',
      task: 'second',
      facts: [
        fact({
          id: 'second-create',
          t: 'created',
          title: 'Second',
        }),
      ],
    })
    appendFileSync(
      join(
        dir,
        'titans/a/tasks/second/task.log',
      ),
      '{unacknowledged-tail}\n',
    )
    const writes = await Promise.allSettled([
      home.changeTask({
        titan: 'a',
        task: 'task',
        decide: () => [
          fact({
            id: 'first',
            text: 'First',
          }),
        ],
      }),
      home.changeTask({
        titan: 'a',
        task: 'second',
        decide: () => [
          fact({
            id: 'middle',
            text: 'Middle',
          }),
        ],
      }),
      home.changeTask({
        titan: 'a',
        task: 'task',
        decide: ({ read }) => {
          let text: string | undefined

          try {
            text = read({ titan: 'a' })?.tasks.get('second')?.state?.words[0]?.text
          } catch (error) {
            if (!(error instanceof Error)) {
              throw error
            }

            text = error.message
          }

          return [
            fact({
              id: 'dependent',
              text: `Saw ${text}`,
            }),
          ]
        },
      }),
    ])
    expect(writes.map(write => write.status)).toEqual([
      'rejected',
      'rejected',
      'rejected',
    ])
    expect(writes[2]).toMatchObject({
      reason: { code: 'WRITE_FAILED' },
    })
    expect(home.read({ titan: 'a' })?.tasks.get('task')?.state?.words).toEqual([
      {
        id: 'first',
        text: 'First',
      },
    ])
    expect(home.read({ titan: 'a' })?.tasks.get('second')?.state?.words).toEqual([])
    await home.changeTask({
      titan: 'a',
      task: 'second',
      decide: () => [
        fact({
          id: 'middle',
          text: 'Middle',
        }),
      ],
    })
    expect(await home.changeTask({
      titan: 'a',
      task: 'task',
      decide: ({ read }) => [
        fact({
          id: 'dependent',
          text: `Saw ${read({ titan: 'a' })?.tasks.get('second')?.state?.words[0]?.text}`,
        }),
      ],
    })).toMatchObject([
      {
        id: 'dependent',
        duplicate: false,
      },
    ])
    await home.close()
    const reopened = store({ home: dir })
    expect(reopened.read({ titan: 'a' })?.tasks.get('task')?.state?.words).toEqual([
      {
        id: 'first',
        text: 'First',
      },
      {
        id: 'dependent',
        text: 'Saw Middle',
      },
    ])
    await reopened.close()
  },
)

test.each([
  {
    operation: 'titan',
    target: 'titans/b',
    parents: ['titans'],
    request: ({ home }: { home: ReturnType<typeof store> }) => home.createTitan({
      titan: 'b',
      facts: [
        fact({
          id: 'published-titan',
          t: 'config',
          name: 'B',
        }),
      ],
    }),
  },
  {
    operation: 'task',
    target: 'titans/a/tasks/new',
    parents: ['titans/a/tasks'],
    request: ({ home }: { home: ReturnType<typeof store> }) => home.createTask({
      titan: 'a',
      task: 'new',
      facts: [
        fact({
          id: 'published-task',
          t: 'created',
          title: 'New',
        }),
      ],
    }),
  },
  {
    operation: 'move',
    target: 'titans/b/tasks/task',
    parents: [
      'titans/a/tasks',
      'titans/b/tasks',
    ],
    request: ({ home }: { home: ReturnType<typeof store> }) => home.moveTask({
      from: 'a',
      to: 'b',
      task: 'task',
      id: 'published-move',
      at: AT,
      by: 'owner',
    }),
  },
])(
  'a $operation publication stays unacknowledged while its directory sync fails',
  async ({
    operation,
    target: relativeTarget,
    parents: relativeParents,
    request: submit,
  }) => {
    const dir = homeFolder()
    let home = store({ home: dir })
    await create({ home })

    if (operation === 'move') {
      await home.createTitan({
        titan: 'b',
        facts: [
          fact({
            id: 'b-config',
            t: 'config',
            name: 'B',
          }),
        ],
      })
    }

    const target = join(
      dir,
      relativeTarget,
    )
    const parents = relativeParents.map(path => join(
      dir,
      path,
    ))
    const request = () => submit({ home })

    const filesystem = await vi.importActual<typeof import('node:fs')>('node:fs')
    const synced = new Set<string>()
    let outage = true

    // eslint-disable-next-line othrys/object-params -- Node's fsync replacement receives a file descriptor.
    const directorySync: typeof filesystem.fsyncSync = fd => {
      const metadata = filesystem.fstatSync(fd)
      const parent = existsSync(target) && metadata.isDirectory() ? parents.find(path =>
        existsSync(path) && filesystem.statSync(path).ino === metadata.ino) : undefined

      if (parent) {
        if (outage) {
          throw Object.assign(
            new Error('directory sync outage after rename'),
            { code: 'EIO' },
          )
        }

        filesystem.fsyncSync(fd)
        synced.add(parent)

        return
      }

      filesystem.fsyncSync(fd)
    }

    vi.mocked(fsyncSync).mockImplementation(directorySync)

    try {
      await expect(request()).rejects.toMatchObject({ code: 'WRITE_FAILED' })
      await expect(request()).rejects.toMatchObject({ code: 'STORE_UNAVAILABLE' })
      outage = false
      await expect(home.close()).rejects.toMatchObject({ code: 'STORE_UNAVAILABLE' })
      home = store({ home: dir })
      expect(parents.every(parent => synced.has(parent))).toBe(true)
      expect(await request()).toMatchObject([
        {
          duplicate: true,
          at: AT,
        },
      ])
      await home.close()
    } finally {
      vi.mocked(fsyncSync).mockImplementation(filesystem.fsyncSync)
    }
  },
)

test(
  'a multi-file sync failure reconciles both native receipts once after recovery',
  async () => {
    const dir = homeFolder()
    const home = store({ home: dir })
    await create({ home })
    await home.createTask({
      titan: 'a',
      task: 'second',
      facts: [
        fact({
          id: 'second-create',
          t: 'created',
          title: 'Second',
        }),
      ],
    })
    const filesystem = await vi.importActual<typeof import('node:fs')>('node:fs')
    vi.mocked(fdatasyncSync).mockImplementationOnce(filesystem.fdatasyncSync)
      .mockImplementationOnce(() => {
        throw new Error('second file sync failure')
      })
    const writes = await Promise.allSettled([
      home.changeTask({
        titan: 'a',
        task: 'task',
        decide: () => [
          fact({
            id: 'file-a',
            text: 'A',
          }),
        ],
      }),
      home.changeTask({
        titan: 'a',
        task: 'second',
        decide: () => [
          fact({
            id: 'file-b',
            text: 'B',
          }),
        ],
      }),
      home.snapshot(),
    ])
    expect(writes.map(write => write.status)).toEqual([
      'rejected',
      'rejected',
      'rejected',
    ])
    expect(writes[2]).toMatchObject({ reason: { code: 'WRITE_FAILED' } })
    expect(await home.changeTask({
      titan: 'a',
      task: 'task',
      decide: () => [
        fact({
          id: 'file-a',
          text: 'A',
        }),
      ],
    }))
      .toMatchObject([
        {
          id: 'file-a',
          duplicate: true,
        },
      ])
    expect(await home.changeTask({
      titan: 'a',
      task: 'second',
      decide: () => [
        fact({
          id: 'file-b',
          text: 'B',
        }),
      ],
    }))
      .toMatchObject([
        {
          id: 'file-b',
          duplicate: true,
        },
      ])
    expect(home.read({ titan: 'a' })?.tasks.get('task')?.state?.words).toEqual([
      {
        id: 'file-a',
        text: 'A',
      },
    ])
    expect(home.read({ titan: 'a' })?.tasks.get('second')?.state?.words).toEqual([
      {
        id: 'file-b',
        text: 'B',
      },
    ])
    await home.close()
  },
)
