import { appendFileSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { appendLog, readLog, type LogEntry, type LogFact, type LogPosition } from '#store/log.ts'
import { readSnapshot, writeSnapshot } from '#store/snapshot.ts'

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

    expect(loaded).toEqual(entries.map((
      entry,
      index,
    ) => ({
      n: index + 2,
      ...entry,
    })))
    expect(resumed).toEqual(end)
    expect(end).toEqual({
      bytes: statSync(path).size,
      n: 3,
    })
    expect(readFileSync(
      path,
      'utf8',
    ).startsWith(`{"n":1,"at":"${AT}","by":"owner","t":"say","id":"${first.id}"`)).toBe(true)
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
        n: 0,
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
  },
)

test(
  'a canonical log symlink cannot repair or append to another file',
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
  },
)
