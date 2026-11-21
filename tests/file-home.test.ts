import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { appendLog, type LogFact } from '#store/log.ts'
import { createHydraFiles, createTaskFiles, moveTaskFiles, readHomeFiles, readHydraFiles, taskFiles } from '#store/file-home.ts'
import { writeSnapshot } from '#store/snapshot.ts'

const AT = '2026-11-21T03:00:00.000Z'
const homeFolder = () => mkdtempSync(join(
  tmpdir(),
  'pnyx-home-files-',
))
const created = ({ id }: { id: string }): LogFact => ({
  at: AT,
  by: 'owner',
  t: 'created',
  id,
  title: id,
  project: 'project',
  kind: 'task',
  ask: 'Owner words',
})
const configured = (): LogFact => ({
  at: AT,
  by: 'owner',
  t: 'config',
  id: 'hydra-config',
  name: 'Hydra',
})

test(
  'task directory membership overrides old snapshots and new tasks are read from their first native line',
  () => {
    const home = homeFolder()
    const hydra = createHydraFiles({
      home,
      hydra: 'a',
      entries: [configured()],
    })
    const task = createTaskFiles({
      home,
      hydra: 'a',
      task: 'first',
      entries: [created({ id: 'native-first' })],
    })
    writeSnapshot({
      dir: join(
        home,
        'hydras',
        'a',
      ),
      snapshot: {
        v: 1,
        at: AT,
        hydra,
        tasks: {
          first: {
            task,
            worker: 0,
          },
          removed: {
            task,
            worker: 0,
          },
        },
        state: {
          tasks: [
            'first',
            'removed',
          ],
        },
      },
    })
    createTaskFiles({
      home,
      hydra: 'a',
      task: 'second',
      entries: [created({ id: 'native-second' })],
    })
    appendLog({
      path: join(
        taskFiles({
          home,
          hydra: 'a',
          task: 'first',
        }),
        'task.log',
      ),
      after: task,
      entries: [
        {
          at: AT,
          by: 'owner',
          t: 'say',
          id: 'm_native-input',
          text: 'New words',
        },
      ],
    })
    const files = readHydraFiles({
      home,
      hydra: 'a',
    })
    expect(Object.keys(files.tasks).sort()).toEqual([
      'first',
      'second',
    ])
    expect(files.tasks.first?.entries.map(entry => entry.id)).toEqual(['m_native-input'])
    expect(files.tasks.second?.entries.map(entry => entry.id)).toEqual(['native-second'])
    expect(files.tasks.second?.fromStart).toBe(true)
  },
)

test(
  'a task move renames its folder, keeps its copy reference, and resumes a crash before rename once',
  () => {
    for (const interrupted of [
      false,
      true,
    ]) {
      const home = homeFolder()
      createHydraFiles({
        home,
        hydra: 'a',
        entries: [configured()],
      })
      createHydraFiles({
        home,
        hydra: 'b',
        entries: [configured()],
      })
      const copy = join(
        home,
        'copies',
        'project-1',
      )
      mkdirSync(
        copy,
        { recursive: true },
      )
      writeFileSync(
        join(
          copy,
          'proof.txt',
        ),
        'The copy stays here',
      )
      const after = createTaskFiles({
        home,
        hydra: 'a',
        task: 'moving',
        entries: [
          created({ id: 'native-created' }),
          {
            at: AT,
            by: 'daemon',
            t: 'copy',
            id: 'native-copy',
            path: copy,
          },
        ],
      })
      const source = taskFiles({
        home,
        hydra: 'a',
        task: 'moving',
      })
      writeFileSync(
        join(
          source,
          'worker.log',
        ),
        'note: still working\n',
      )

      if (interrupted) {
        appendLog({
          path: join(
            source,
            'task.log',
          ),
          after,
          entries: [
            {
              at: AT,
              by: 'owner',
              t: 'moved',
              id: 'native-move',
              from: 'a',
              to: 'b',
            },
          ],
        })
      } else {
        moveTaskFiles({
          home,
          from: 'a',
          to: 'b',
          task: 'moving',
          after,
          at: AT,
          by: 'owner',
          id: 'native-move',
        })
        expect(existsSync(source)).toBe(false)
        expect(existsSync(taskFiles({
          home,
          hydra: 'b',
          task: 'moving',
        }))).toBe(true)
      }

      expect(readHydraFiles({
        home,
        hydra: 'a',
      }).tasks).toEqual({})
      const destination = readHydraFiles({
        home,
        hydra: 'b',
      }).tasks.moving!
      expect(destination.entries.map(entry => entry.id)).toEqual([
        'native-created',
        'native-copy',
        'native-move',
      ])
      expect(destination.entries[1]?.path).toBe(copy)
      expect(readFileSync(
        join(
          copy,
          'proof.txt',
        ),
        'utf8',
      )).toBe('The copy stays here')
      expect(readFileSync(
        join(
          taskFiles({
            home,
            hydra: 'b',
            task: 'moving',
          }),
          'worker.log',
        ),
        'utf8',
      )).toBe('note: still working\n')
      expect(existsSync(source)).toBe(false)
      expect(readHydraFiles({
        home,
        hydra: 'b',
      }).tasks.moving?.position.n).toBe(3)
    }
  },
)

test(
  'one corrupt task is quarantined while healthy task logs remain readable',
  () => {
    const home = homeFolder()
    createHydraFiles({
      home,
      hydra: 'a',
      entries: [configured()],
    })
    createTaskFiles({
      home,
      hydra: 'a',
      task: 'broken',
      entries: [created({ id: 'broken-first' })],
    })
    createTaskFiles({
      home,
      hydra: 'a',
      task: 'healthy',
      entries: [created({ id: 'healthy-first' })],
    })
    const path = join(
      taskFiles({
        home,
        hydra: 'a',
        task: 'broken',
      }),
      'task.log',
    )
    appendFileSync(
      path,
      '{bad}\n',
    )
    appendFileSync(
      path,
      `${JSON.stringify({
        n: 3,
        ...created({ id: 'later' }),
      })}\n`,
    )
    const before = readFileSync(path)
    const files = readHydraFiles({
      home,
      hydra: 'a',
    })
    expect(files.tasks.broken?.issue?.code).toBe('LOG_CORRUPT')
    expect(files.tasks.broken?.entries).toEqual([])
    expect(files.tasks.healthy?.entries[0]?.id).toBe('healthy-first')
    expect(readFileSync(path)).toEqual(before)
  },
)

test(
  'home recovery reloads a destination that was read before the interrupted move',
  () => {
    const home = homeFolder()
    createHydraFiles({
      home,
      hydra: 'a',
      entries: [configured()],
    })
    createHydraFiles({
      home,
      hydra: 'z',
      entries: [configured()],
    })
    const after = createTaskFiles({
      home,
      hydra: 'z',
      task: 'moving',
      entries: [created({ id: 'native-created' })],
    })
    appendLog({
      path: join(
        taskFiles({
          home,
          hydra: 'z',
          task: 'moving',
        }),
        'task.log',
      ),
      after,
      entries: [
        {
          at: AT,
          by: 'owner',
          t: 'moved',
          id: 'native-move',
          from: 'z',
          to: 'a',
        },
      ],
    })
    const loaded = readHomeFiles({ home })
    expect(loaded.get('z')?.tasks).toEqual({})
    expect(loaded.get('a')?.tasks.moving?.entries.map(entry => entry.id)).toEqual([
      'native-created',
      'native-move',
    ])
  },
)

test(
  'a conflicting task folder refuses a move before changing either log',
  () => {
    const home = homeFolder()
    createHydraFiles({
      home,
      hydra: 'a',
      entries: [configured()],
    })
    createHydraFiles({
      home,
      hydra: 'b',
      entries: [configured()],
    })
    const after = createTaskFiles({
      home,
      hydra: 'a',
      task: 'same',
      entries: [created({ id: 'source-created' })],
    })
    createTaskFiles({
      home,
      hydra: 'b',
      task: 'same',
      entries: [created({ id: 'destination-created' })],
    })
    const source = join(
      taskFiles({
        home,
        hydra: 'a',
        task: 'same',
      }),
      'task.log',
    )
    const destination = join(
      taskFiles({
        home,
        hydra: 'b',
        task: 'same',
      }),
      'task.log',
    )
    const original = {
      source: readFileSync(source),
      destination: readFileSync(destination),
    }
    expect(() => moveTaskFiles({
      home,
      from: 'a',
      to: 'b',
      task: 'same',
      after,
      at: AT,
      by: 'owner',
      id: 'native-move',
    })).toThrow(/already exists/)
    expect(readFileSync(source)).toEqual(original.source)
    expect(readFileSync(destination)).toEqual(original.destination)
  },
)

test(
  'old homes are left untouched and a missing created fact quarantines only its task',
  () => {
    const home = homeFolder()
    const legacy = join(
      home,
      'hydras',
      'legacy',
    )
    mkdirSync(
      legacy,
      { recursive: true },
    )
    const old = join(
      legacy,
      'events.jsonl',
    )
    writeFileSync(
      old,
      'Old data is not imported or rewritten\n',
    )
    createHydraFiles({
      home,
      hydra: 'a',
      entries: [configured()],
    })
    const after = createTaskFiles({
      home,
      hydra: 'a',
      task: 'healthy',
      entries: [created({ id: 'native-created' })],
    })
    expect(() => moveTaskFiles({
      home,
      from: 'a',
      to: 'legacy',
      task: 'healthy',
      after,
      at: AT,
      by: 'owner',
      id: 'move-to-legacy',
    })).toThrow(/no regular native log/)
    expect(existsSync(join(
      legacy,
      'tasks',
    ))).toBe(false)
    mkdirSync(taskFiles({
      home,
      hydra: 'a',
      task: 'empty',
    }))
    const loaded = readHomeFiles({ home })
    expect([...loaded.keys()]).toEqual(['a'])
    expect(loaded.get('a')?.tasks.empty?.issue?.code).toBe('LOG_CORRUPT')
    expect(loaded.get('a')?.tasks.healthy?.entries[0]?.id).toBe('native-created')
    expect(readFileSync(
      old,
      'utf8',
    )).toBe('Old data is not imported or rewritten\n')

    const unexpected = homeFolder()
    createHydraFiles({
      home,
      hydra: 'b',
      entries: [configured()],
    })
    symlinkSync(
      unexpected,
      join(
        home,
        'hydras/b/tasks',
      ),
    )
    expect(() => moveTaskFiles({
      home,
      from: 'a',
      to: 'b',
      task: 'healthy',
      after,
      at: AT,
      by: 'owner',
      id: 'move-through-alias',
    })).toThrow(/not a file-store directory/)
    expect(existsSync(join(
      unexpected,
      'healthy',
    ))).toBe(false)
    expect(readHomeFiles({ home }).get('a')?.tasks.healthy?.position).toEqual(after)
  },
)
