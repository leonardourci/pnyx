import { appendFileSync, existsSync, fdatasyncSync, fsyncSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, vi } from 'vitest'
import { appendLog, readLog, type LogEntry, type LogFact, type LogPosition } from '#store/log.ts'
import { readSnapshot, writeSnapshot } from '#store/snapshot.ts'
import { createHydraFiles } from '#store/file-home.ts'

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

const AT = '2026-11-21T03:00:00.000Z'
const EMPTY: LogPosition = {
  bytes: 0,
  n: 0,
}
const LARGE_MESSAGE = 'Native λ message. '.repeat(5000)

const folder = () => mkdtempSync(join(
  tmpdir(),
  'pnyx-file-store-',
))
const message = ({
  id,
  text,
}: {
  id: string
  text: string
}): LogFact => ({
  at: AT,
  by: 'owner',
  t: 'say',
  id,
  text,
})

async function recordSyncs({
  reject,
}: {
  reject?: ({ inode }: { inode: number }) => boolean
} = {}) {
  const filesystem = await vi.importActual<typeof import('node:fs')>('node:fs')
  const synced = new Set<number>()

  // eslint-disable-next-line pnyx/object-params -- Node's sync replacement receives a file descriptor.
  const syncFile: typeof filesystem.fsyncSync = fd => {
    const inode = filesystem.fstatSync(fd).ino

    if (reject?.({ inode })) {
      throw Object.assign(
        new Error('directory sync outage'),
        { code: 'EIO' },
      )
    }

    filesystem.fsyncSync(fd)
    synced.add(inode)
  }

  vi.mocked(fsyncSync).mockImplementation(syncFile)

  return {
    synced,
    restore: () => vi.mocked(fsyncSync).mockImplementation(filesystem.fsyncSync),
  }
}

test(
  'an append publishes the new log directory in its parent',
  async () => {
    const parent = folder()
    const syncs = await recordSyncs()

    try {
      appendLog({
        path: join(
          parent,
          'logs/task.log',
        ),
        after: EMPTY,
        entries: [
          message({
            id: 'new',
            text: 'Saved',
          }),
        ],
      })
      expect(syncs.synced.has(statSync(parent).ino)).toBe(true)
      expect(syncs.synced.has(statSync(join(
        parent,
        'logs',
      )).ino)).toBe(true)
    } finally {
      syncs.restore()
    }
  },
)

test(
  'recovery finishes a failed sync of a new log name before returning its position',
  async () => {
    const parent = folder()
    const inode = statSync(parent).ino
    const path = join(
      parent,
      'task.log',
    )
    let outage = true
    const syncs = await recordSyncs({
      reject: ({ inode: current }) => outage && existsSync(path) && current === inode,
    })

    try {
      expect(() => appendLog({
        path,
        after: EMPTY,
        entries: [
          message({
            id: 'uncertain',
            text: 'Saved',
          }),
        ],
      })).toThrow(/sync outage/)
      expect(existsSync(path)).toBe(true)
      outage = false
      syncs.synced.clear()
      expect(readLog({
        path,
        accept: () => undefined,
      }).n).toBe(1)
      expect(syncs.synced.has(inode)).toBe(true)
    } finally {
      syncs.restore()
    }
  },
)

test(
  'retrying Hydra creation syncs the home even when its hydras directory already exists',
  async () => {
    const home = folder()
    const inode = statSync(home).ino
    let outage = true
    const syncs = await recordSyncs({ reject: ({ inode: current }) => outage && current === inode })
    const creating = {
      home,
      hydra: 'a',
      entries: [
        {
          ...message({
            id: 'config',
            text: 'Config',
          }),
          t: 'config',
        },
      ],
    }

    try {
      expect(() => createHydraFiles(creating)).toThrow(/sync outage/)
      expect(existsSync(join(
        home,
        'hydras',
      ))).toBe(true)
      outage = false
      syncs.synced.clear()
      expect(createHydraFiles(creating).n).toBe(1)
      expect(syncs.synced.has(inode)).toBe(true)
    } finally {
      syncs.restore()
    }
  },
)

test(
  'facts that change during JSON encoding are refused before a log is created',
  () => {
    const path = join(
      folder(),
      'task.log',
    )
    expect(() => appendLog({
      path,
      after: EMPTY,
      entries: [
        {
          ...message({
            id: 'spoofed',
            text: 'Original',
          }),
          toJSON: () => ({ unexpected: true }),
        },
      ],
    })).toThrow(/plain JSON/)
    expect(existsSync(path)).toBe(false)
  },
)

test(
  'task logs retain native ids and Unicode while resuming at a saved byte position',
  () => {
    const path = join(
      folder(),
      'task.log',
    )
    const first = message({
      id: 'm_native-user-input',
      text: 'Owner words',
    })
    const saved = appendLog({
      path,
      after: EMPTY,
      entries: [first],
    })
    const entries = [
      message({
        id: 'm_native-user-followup',
        text: LARGE_MESSAGE,
      }),
      message({
        id: 'm_native-user-answer',
        text: 'Owner answer',
      }),
    ]
    const end = appendLog({
      path,
      after: saved,
      entries,
    })
    const loaded: LogEntry[] = []
    const resumed = readLog({
      path,
      after: saved,
      accept: ({ entry }) => loaded.push(entry),
    })

    expect(loaded).toEqual([
      {
        n: 2,
        ...entries[0],
      },
      {
        n: 3,
        ...entries[1],
      },
    ])
    expect(resumed).toEqual(end)
    expect(end).toEqual({
      bytes: statSync(path).size,
      n: 3,
    })
    expect(JSON.parse(readFileSync(
      path,
      'utf8',
    ).split('\n')[0]!)).toEqual({
      n: 1,
      ...first,
    })
    const before = readFileSync(path)
    expect(() => appendLog({
      path,
      after: saved,
      entries: [first],
    })).toThrow(/changed/)
    expect(readFileSync(path)).toEqual(before)
  },
)

test(
  'a torn or invalid final log line is removed before the next durable append',
  () => {
    for (const tail of [
      '{"n":2,"text":"torn',
      '{invalid}\n',
    ]) {
      const path = join(
        folder(),
        'task.log',
      )
      const saved = appendLog({
        path,
        after: EMPTY,
        entries: [
          message({
            id: 'm_first',
            text: 'Saved before the crash',
          }),
        ],
      })
      appendFileSync(
        path,
        tail,
      )
      const loaded: LogEntry[] = []
      const recovered = readLog({
        path,
        accept: ({ entry }) => loaded.push(entry),
      })
      expect(recovered).toEqual(saved)
      expect(statSync(path).size).toBe(saved.bytes)
      expect(loaded.map(entry => entry.id)).toEqual(['m_first'])
      appendLog({
        path,
        after: recovered,
        entries: [
          message({
            id: 'm_after',
            text: 'After recovery',
          }),
        ],
      })
      const ids: string[] = []
      readLog({
        path,
        accept: ({ entry }) => ids.push(entry.id),
      })
      expect(ids).toEqual([
        'm_first',
        'm_after',
      ])
    }
  },
)

test(
  'corruption before the last line reports its file and byte without damaging another task',
  () => {
    const dir = folder()
    const path = join(
      dir,
      'broken-task.log',
    )
    const saved = appendLog({
      path,
      after: EMPTY,
      entries: [
        message({
          id: 'm_saved',
          text: 'Saved',
        }),
      ],
    })
    appendFileSync(
      path,
      '{invalid}\n',
    )
    appendFileSync(
      path,
      `${JSON.stringify({
        n: 3,
        ...message({
          id: 'm_later',
          text: 'Later',
        }),
      })}\n`,
    )
    const before = readFileSync(path)
    expect(() => readLog({
      path,
      accept: () => undefined,
    })).toThrow(`${path} is corrupt at byte ${saved.bytes}`)
    expect(readFileSync(path)).toEqual(before)
    const healthy = join(
      dir,
      'healthy-task.log',
    )
    const end = appendLog({
      path: healthy,
      after: EMPTY,
      entries: [
        message({
          id: 'm_healthy',
          text: 'Healthy',
        }),
      ],
    })
    expect(readLog({
      path: healthy,
      accept: () => undefined,
    })).toEqual(end)
  },
)

test(
  'invalid log positions and numbered records are refused without truncating saved words',
  () => {
    const path = join(
      folder(),
      'task.log',
    )
    const end = appendLog({
      path,
      after: EMPTY,
      entries: [
        message({
          id: 'm_saved',
          text: 'Saved',
        }),
      ],
    })
    const before = readFileSync(path)

    for (const after of [
      {
        bytes: end.bytes + 1,
        n: 1,
      },
      {
        bytes: end.bytes - 1,
        n: 1,
      },
    ]) {
      expect(() => readLog({
        path,
        after,
        accept: () => undefined,
      })).toThrow(/position/)
      expect(readFileSync(path)).toEqual(before)
    }

    appendFileSync(
      path,
      `${JSON.stringify({
        n: 3,
        ...message({
          id: 'm_gap',
          text: 'No second line',
        }),
      })}\n`,
    )
    const numbered = readFileSync(path)
    expect(() => readLog({
      path,
      accept: () => undefined,
    })).toThrow(/corrupt/)
    expect(readFileSync(path)).toEqual(numbered)
  },
)

test(
  'snapshots preserve native identities and log positions, and an unfinished replacement never wins',
  () => {
    const dir = folder()
    const snapshot = {
      v: 1 as const,
      at: AT,
      hydra: {
        bytes: 100,
        n: 1,
      },
      tasks: {
        task: {
          task: {
            bytes: 200,
            n: 2,
          },
          worker: 30,
        },
      },
      state: {
        messages: [
          {
            id: 'm_native-input',
            text: 'Saved owner words',
          },
        ],
      },
    }
    expect(readSnapshot({ dir })).toBeUndefined()
    writeSnapshot({
      dir,
      snapshot,
    })
    expect(readSnapshot({ dir })).toEqual(snapshot)
    writeFileSync(
      join(
        dir,
        'snapshot.json.next',
      ),
      '{unfinished',
    )
    expect(readSnapshot({ dir })).toEqual(snapshot)
    writeFileSync(
      join(
        dir,
        'snapshot.json',
      ),
      '{invalid',
    )
    expect(readSnapshot({ dir })).toBeUndefined()
    const path = join(
      dir,
      'snapshot.json',
    )
    rmSync(path)
    mkdirSync(path)
    expect(readSnapshot({ dir })).toBeUndefined()
  },
)

test(
  'canonical logs refuse symlinks and directories',
  () => {
    const dir = folder()
    const protectedPath = join(
      dir,
      'owner-words.txt',
    )
    const path = join(
      dir,
      'task.log',
    )
    const words = 'Owner words must survive'
    writeFileSync(
      protectedPath,
      words,
    )
    symlinkSync(
      protectedPath,
      path,
    )
    expect(() => readLog({
      path,
      accept: () => undefined,
    })).toThrow()
    expect(() => appendLog({
      path,
      after: {
        bytes: Buffer.byteLength(words),
        n: 1,
      },
      entries: [
        message({
          id: 'm_new',
          text: 'New words',
        }),
      ],
    })).toThrow()
    expect(readFileSync(
      protectedPath,
      'utf8',
    )).toBe(words)
    rmSync(path)
    mkdirSync(path)
    expect(() => appendLog({
      path,
      after: EMPTY,
      entries: [
        message({
          id: 'm_new',
          text: 'New words',
        }),
      ],
    })).toThrow(/corrupt at byte 0/)
  },
)

test(
  'recovery exposes no owner words until a complete log tail is synced',
  () => {
    const path = join(
      folder(),
      'task.log',
    )
    const end = appendLog({
      path,
      after: EMPTY,
      entries: [
        message({
          id: 'm_saved',
          text: 'Owner words',
        }),
      ],
    })
    const accepted = vi.fn()
    vi.mocked(fdatasyncSync).mockImplementationOnce(() => {
      throw new Error('disk sync failed')
    })
    expect(() => readLog({
      path,
      accept: accepted,
    })).toThrow('disk sync failed')
    expect(accepted).not.toHaveBeenCalled()
    expect(readLog({
      path,
      accept: accepted,
    })).toEqual(end)
    expect(accepted).toHaveBeenCalledWith({
      entry: expect.objectContaining({
        id: 'm_saved',
        text: 'Owner words',
      }),
    })
  },
)
