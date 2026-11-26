import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, expect, test, vi } from 'vitest'
import * as processes from '#app/run-process.ts'
import { operation, parsed, startOthrys, until, type Othrys } from './setup/othrys.ts'

let othrys: Othrys
beforeAll(async () => {
  othrys = await startOthrys()
})

test(
  'owner-memory revisions cannot cross a home-polis change',
  async () => {
    const titan = await othrys.titan()

    await titan.owner({
      args: [
        'titan',
        'set',
        '--polis',
        'revision-first',
      ],
    })

    const first = await titan.owner({
      args: [
        'owner',
        'memory',
        'set',
        '--key',
        'preferences',
        '--text',
        'revision-first',
      ],
    })
    await titan.owner({
      args: [
        'titan',
        'set',
        '--polis',
        'revision-next',
      ],
    })
    await titan.owner({
      args: [
        'owner',
        'memory',
        'set',
        '--key',
        'preferences',
        '--text',
        'revision-next',
      ],
    })

    expect((await titan.ownerRefused({
      args: [
        'owner',
        'memory',
        'set',
        '--key',
        'preferences',
        '--text',
        'stale replacement',
        '--if-revision',
        String(first.revision),
      ],
    })).code).toBe('REVISION_CONFLICT')
    expect((await titan.ownerRefused({
      args: [
        'owner',
        'memory',
        'move',
        '--key',
        'preferences',
        '--to',
        'revision-next',
        '--if-revision',
        String(first.revision),
      ],
    })).code).toBe('REVISION_CONFLICT')
    const current = await titan.owner({
      args: [
        'owner',
        'memory',
        'list',
      ],
    })
    expect(current.writable.preferences.text).toBe('revision-next')
    await titan.owner({
      args: [
        'owner',
        'memory',
        'set',
        '--key',
        'preferences',
        '--text',
        'fresh replacement',
        '--if-revision',
        String(current.revision),
      ],
    })
    expect((await titan.owner({
      args: [
        'owner',
        'memory',
        'list',
      ],
    })).writable.preferences.text).toBe('fresh replacement')
    await titan.owner({
      args: [
        'titan',
        'set',
        '--polis',
        'revision-final',
      ],
    })
    await titan.owner({
      args: [
        'owner',
        'memory',
        'set',
        '--key',
        'preferences',
        '--text',
        'revision-final',
      ],
    })
    await titan.owner({
      args: [
        'titan',
        'set',
        '--polis',
        'revision-next',
      ],
    })
    const path = join(
      process.env.OTHRYS_HOME!,
      'owner',
      'poleis',
      'revision-next',
      'memory.jsonl',
    )
    const beforeCorruption = readFileSync(path)
    const firstPath = join(
      process.env.OTHRYS_HOME!,
      'owner',
      'poleis',
      'revision-first',
      'memory.jsonl',
    )
    const beforeFirst = readFileSync(firstPath)

    try {
      const corruptMoves = readFileSync(
        new URL(
          './setup/fixtures/memory/corrupt-owner-moves.jsonl',
          import.meta.url,
        ),
        'utf8',
      ).trimEnd()
        .split('\n')

      for (const invalidEntry of corruptMoves.slice(
        0,
        3,
      )) {
        appendFileSync(
          path,
          `${invalidEntry}\n`,
        )
        const memory = await titan.owner({
          args: [
            'owner',
            'memory',
            'list',
          ],
        })
        expect(memory.writable.preferences.text).toBe('fresh replacement')
        expect(JSON.stringify(memory.memory)).not.toMatch(/Invalid (local sequence|imported sequence|source rewrite|destination rewrite)/)
        expect((await titan.ownerRefused({
          args: [
            'owner',
            'memory',
            'set',
            '--key',
            'preferences',
            '--text',
            'Overwrite corrupt log',
          ],
        })).code).toBe('LOG_CORRUPT')
        writeFileSync(
          path,
          beforeCorruption,
        )
      }

      appendFileSync(
        path,
        `${corruptMoves.slice(3).join('\n')}\n`,
      )
      appendFileSync(
        firstPath,
        readFileSync(new URL(
          './setup/fixtures/memory/owner-move-dependent.jsonl',
          import.meta.url,
        )),
      )
      expect((await titan.owner({
        args: [
          'owner',
          'memory',
          'list',
        ],
      })).writable.preferences.text).toBe('fresh replacement')
      const combined = await titan.owner({
        args: [
          'owner',
          'memory',
          'list',
        ],
      })
      expect(JSON.stringify(combined.memory)).not.toContain('conflicting replacement')
      expect(JSON.stringify(combined.memory)).not.toContain('Rejected source-position import')
      expect(JSON.stringify(combined.memory)).not.toContain('Rejected dependent-source import')
      expect(JSON.stringify(combined.memory)).toContain('revision-final')
      expect(JSON.stringify(combined.memory)).toContain('revision-first')
      expect((await titan.ownerRefused({
        args: [
          'owner',
          'memory',
          'set',
          '--key',
          'preferences',
          '--text',
          'Overwrite corrupt log',
        ],
      })).code).toBe('LOG_CORRUPT')
      writeFileSync(
        path,
        beforeCorruption,
      )
      writeFileSync(
        firstPath,
        beforeFirst,
      )
      appendFileSync(
        path,
        '{"seq":3,"key":"preferences","after":42}\n',
      )
      appendFileSync(
        path,
        readFileSync(
          new URL(
            './setup/fixtures/memory/owner-move-valid-source.jsonl',
            import.meta.url,
          ),
          'utf8',
        ).replace(
          '"seq":3,',
          '"seq":4,',
        ),
      )
      const invalidTail = await titan.owner({
        args: [
          'owner',
          'memory',
          'list',
        ],
      })
      expect(invalidTail.writable.preferences?.text).toBe('fresh replacement')
      expect(JSON.stringify(invalidTail.memory)).not.toContain('Rejected destination-conflict import')
      writeFileSync(
        path,
        beforeCorruption,
      )
      appendFileSync(
        path,
        '{"seq":3,"key":"learnings","after":null,"projectMove":{"project":42}}\n',
      )
      appendFileSync(
        path,
        readFileSync(
          new URL(
            './setup/fixtures/memory/owner-move-valid-source.jsonl',
            import.meta.url,
          ),
          'utf8',
        ).replace(
          '"seq":3,',
          '"seq":4,',
        ),
      )
      const malformedProjectMove = await titan.owner({
        args: [
          'owner',
          'memory',
          'list',
        ],
      })
      expect(malformedProjectMove.writable.preferences?.text).toBe('fresh replacement')
      expect(JSON.stringify(malformedProjectMove.memory)).not.toContain('Rejected destination-conflict import')
      writeFileSync(
        path,
        beforeCorruption,
      )
      appendFileSync(
        path,
        readFileSync(new URL(
          './setup/fixtures/memory/owner-move-gap.jsonl',
          import.meta.url,
        )),
      )
      const gap = await titan.owner({
        args: [
          'owner',
          'memory',
          'list',
        ],
      })
      expect(gap.writable.preferences.text).toBe('fresh replacement')
      expect(JSON.stringify(gap.memory)).not.toContain('Rejected source-gap import')
      expect(JSON.stringify(gap.memory)).toContain('revision-first')
      expect((await titan.ownerRefused({
        args: [
          'owner',
          'memory',
          'set',
          '--key',
          'preferences',
          '--text',
          'Overwrite gapped log',
        ],
      })).code).toBe('LOG_CORRUPT')
      await titan.owner({
        args: [
          'titan',
          'set',
          '--polis',
          'revision-first',
        ],
      })
      expect((await titan.ownerRefused({
        args: [
          'owner',
          'memory',
          'set',
          '--key',
          'preferences',
          '--text',
          'Reuse rejected destination position',
        ],
      })).code).toBe('LOG_CORRUPT')
      writeFileSync(
        path,
        beforeCorruption,
      )
      writeFileSync(
        firstPath,
        beforeFirst,
      )
      appendFileSync(
        path,
        readFileSync(new URL(
          './setup/fixtures/memory/owner-move-valid-source.jsonl',
          import.meta.url,
        )),
      )
      appendFileSync(
        firstPath,
        readFileSync(new URL(
          './setup/fixtures/memory/owner-move-destination-conflict.jsonl',
          import.meta.url,
        )),
      )
      await titan.owner({
        args: [
          'titan',
          'set',
          '--polis',
          'revision-next',
        ],
      })
      const rejectedDestination = await titan.owner({
        args: [
          'owner',
          'memory',
          'list',
        ],
      })
      expect(rejectedDestination.writable.preferences?.text).toBe('fresh replacement')
      expect(JSON.stringify(rejectedDestination.memory)).toContain('revision-first')
      expect(JSON.stringify(rejectedDestination.memory)).not.toContain('Rejected destination-conflict import')
      expect(JSON.stringify(rejectedDestination.memory)).not.toContain('Conflicting destination replacement')
      expect((await titan.ownerRefused({
        args: [
          'owner',
          'memory',
          'set',
          '--key',
          'preferences',
          '--text',
          'Overwrite rejected source move',
        ],
      })).code).toBe('LOG_CORRUPT')
      writeFileSync(
        path,
        beforeCorruption,
      )
      writeFileSync(
        firstPath,
        beforeFirst,
      )
      appendFileSync(
        path,
        [
          '{"v":1,"seq":4,"at":"2026-01-01T00:00:00Z","actor":"web","key":"preferences","before":"Earlier logical entry","after":"Out-of-order replacement"}',
          '{"v":1,"seq":3,"at":"2026-01-01T00:00:00Z","actor":"web","key":"preferences","before":"fresh replacement","after":"Earlier logical entry"}',
          '',
        ].join('\n'),
      )
      const outOfOrder = await titan.owner({
        args: [
          'owner',
          'memory',
          'list',
        ],
      })
      expect(outOfOrder.writable.preferences.text).toBe('fresh replacement')
      expect((await titan.ownerRefused({
        args: [
          'owner',
          'memory',
          'set',
          '--key',
          'preferences',
          '--text',
          'Overwrite out-of-order log',
        ],
      })).code).toBe('LOG_CORRUPT')
    } finally {
      writeFileSync(
        path,
        beforeCorruption,
      )
      writeFileSync(
        firstPath,
        beforeFirst,
      )
    }
  },
)

test(
  'completed project confirmation retries keep their pinned revision',
  async () => {
    const titan = await othrys.titan()
    const path = titan.folder({ name: 'confirmation-retry' })
    await titan.owner({
      args: [
        'project',
        'add',
        path,
      ],
    })
    const saved = await titan.owner({
      args: [
        'project',
        'memory',
        'set',
        '--project',
        path,
        '--key',
        'learnings',
        '--text',
        'Retry this learning',
        '--reason',
        'test',
      ],
    })
    const args = [
      'project',
      'memory',
      'confirm',
      '--project',
      path,
      '--text',
      'Retry this learning',
      '--reason',
      'Evidence',
      '--event-id',
      'confirmation-retry',
      '--if-revision',
      String(saved.revision),
    ]
    const first = await titan.owner({ args })
    const retry = await titan.owner({ args })
    expect(retry.skipped).toBe('duplicate')
    expect(retry.revision).toBe(first.revision)
    expect((await titan.ownerRefused({
      args: [
        ...args.slice(
          0,
          -4,
        ),
        '--event-id',
        'new-confirmation',
        '--if-revision',
        String(saved.revision),
      ],
    })).code).toBe('REVISION_CONFLICT')
  },
)

test(
  'owner journals, Titan notes and project notes stay readable across Titans without access rules',
  async () => {
    const owner = await othrys.titan()
    const caller = await othrys.titan()
    const project = owner.folder({ name: 'unrestricted-memory' })
    await owner.owner({
      args: [
        'project',
        'add',
        project,
      ],
    })
    await owner.owner({
      args: [
        'project',
        'memory',
        'set',
        '--project',
        project,
        '--key',
        'preferences',
        '--text',
        'Project note available to every caller',
      ],
    })
    await owner.owner({
      args: [
        'titan',
        'memory',
        'set',
        '--key',
        'context',
        '--text',
        'Titan note available to every caller',
      ],
    })
    await owner.owner({
      args: [
        'titan',
        'set',
        '--polis',
        'old-private',
      ],
    })
    await owner.owner({
      args: [
        'owner',
        'memory',
        'set',
        '--key',
        'preferences',
        '--text',
        'Owner journal previously private',
      ],
    })
    const source = await owner.owner({
      args: [
        'owner',
        'memory',
        'list',
      ],
    })
    await caller.owner({
      args: [
        'titan',
        'set',
        '--polis',
        'moved-journal',
      ],
    })
    const emptyDestination = await caller.owner({
      args: [
        'owner',
        'memory',
        'list',
      ],
    })
    expect(emptyDestination.revision).toBe('moved-journal:0')
    await caller.owner({
      args: [
        'owner',
        'memory',
        'set',
        '--key',
        'context',
        '--text',
        'Destination changed independently',
      ],
    })
    const changedDestination = await caller.owner({
      args: [
        'owner',
        'memory',
        'list',
      ],
    })
    expect(changedDestination.revision).toBe('moved-journal:1')
    expect((await owner.ownerRefused({
      args: [
        'owner',
        'memory',
        'move',
        '--key',
        'preferences',
        '--to',
        'moved-journal',
        '--if-revision',
        String(source.revision),
        '--if-destination-revision',
        '0',
      ],
    })).code).toBe('REVISION_CONFLICT')
    expect((await owner.owner({
      args: [
        'owner',
        'memory',
        'list',
      ],
    })).writable).toEqual(source.writable)
    expect((await caller.owner({
      args: [
        'owner',
        'memory',
        'list',
      ],
    })).writable).toEqual(changedDestination.writable)
    await owner.owner({
      args: [
        'owner',
        'memory',
        'move',
        '--key',
        'preferences',
        '--to',
        'moved-journal',
        '--if-revision',
        String(source.revision),
        '--if-destination-revision',
        '1',
      ],
    })
    const moved = await owner.owner({
      args: [
        'owner',
        'memory',
        'list',
      ],
    })
    expect(moved.writable).not.toHaveProperty('preferences')
    expect(moved.archived).not.toContainEqual(expect.objectContaining({ text: 'Owner journal previously private' }))
    await owner.owner({
      args: [
        'titan',
        'set',
        '--polis',
        'moved-journal',
      ],
    })
    expect((await owner.owner({
      args: [
        'owner',
        'memory',
        'list',
      ],
    })).writable.preferences.text).toBe('Owner journal previously private')
    await owner.owner({
      args: [
        'owner',
        'memory',
        'set',
        '--key',
        'learnings',
        '--text',
        'Keep importer conventions with its project',
      ],
    })
    await owner.owner({
      args: [
        'owner',
        'memory',
        'confirm',
        '--text',
        'Keep importer conventions with its project',
        '--reason',
        'Verified against the importer',
      ],
    })
    const confirmed = await owner.owner({
      args: [
        'owner',
        'memory',
        'list',
      ],
    })
    const projectMemory = await owner.owner({
      args: [
        'project',
        'memory',
        'list',
        '--project',
        project,
      ],
    })
    await owner.owner({
      args: [
        'project',
        'memory',
        'set',
        '--project',
        project,
        '--key',
        'preferences',
        '--text',
        'Project destination changed independently',
      ],
    })
    const changedProject = await owner.owner({
      args: [
        'project',
        'memory',
        'list',
        '--project',
        project,
      ],
    })
    expect((await owner.ownerRefused({
      args: [
        'owner',
        'memory',
        'move',
        '--project',
        project,
        '--text',
        'Keep importer conventions with its project',
        '--if-revision',
        String(confirmed.revision),
        '--if-destination-revision',
        String(projectMemory.revision),
      ],
    })).code).toBe('REVISION_CONFLICT')
    expect((await owner.owner({
      args: [
        'owner',
        'memory',
        'list',
      ],
    })).writable).toEqual(confirmed.writable)
    expect((await owner.owner({
      args: [
        'project',
        'memory',
        'list',
        '--project',
        project,
      ],
    })).memory).toEqual(changedProject.memory)
    await owner.owner({
      args: [
        'owner',
        'memory',
        'move',
        '--project',
        project,
        '--text',
        'Keep importer conventions with its project',
        '--if-revision',
        String(confirmed.revision),
        '--if-destination-revision',
        String(changedProject.revision),
      ],
    })
    expect((await owner.owner({
      args: [
        'owner',
        'memory',
        'list',
      ],
    })).writable).not.toHaveProperty('learnings')
    const destination = await owner.owner({
      args: [
        'project',
        'memory',
        'list',
        '--project',
        project,
      ],
    })
    expect(destination.memory.learnings).toBe('Keep importer conventions with its project')
    expect(destination.learnings).toEqual(confirmed.writable.learnings.lines)
    expect(destination.learnings).toContainEqual(expect.objectContaining({ evidence: 'Verified against the importer' }))
    const session = await owner.chat({ text: 'Inspect the moved project memory records' })
    const context = session.received.at(-1)!
    const ownerLog = join(
      process.env.OTHRYS_HOME!,
      'owner',
      'poleis',
      'moved-journal',
      'memory.jsonl',
    )
    expect(context).toContain(ownerLog)
    expect(context).toContain('projectMove.event')
    expect(context).toContain('polisMove.entry')
    expect(readFileSync(
      ownerLog,
      'utf8',
    )).toContain('Keep importer conventions with its project')
    await owner.owner({
      args: [
        'project',
        'memory',
        'archive',
        '--project',
        project,
        '--text',
        'Keep importer conventions with its project',
        '--reason',
        'Importer changed',
      ],
    })
    const archived = await owner.owner({
      args: [
        'project',
        'memory',
        'list',
        '--project',
        project,
      ],
    })
    expect(archived.memory).not.toHaveProperty('learnings')
    expect(archived.archived).toContainEqual(expect.objectContaining({
      key: 'learnings',
      text: 'Keep importer conventions with its project',
      reason: 'Importer changed',
    }))
    const settingsPath = join(
      process.env.OTHRYS_HOME!,
      'settings',
      'events.jsonl',
    )
    appendFileSync(
      settingsPath,
      `${JSON.stringify({
        v: 1,
        id: 'retired-readers',
        at: new Date().toISOString(),
        actor: 'cli',
        before: {},
        after: {
          poleis: {
            shared: { readers: [] },
            'old-private': { readers: [] },
          },
          projectPoleis: {},
          keyboard: { bindings: {} },
          theme: 'dark',
        },
      })}\n`,
    )
    const worker = await caller.startTask({ key: 'memory-reader' })

    const read = async ({ args }: { args: string[] }) => {
      const output = await operation({
        args: [
          ...args,
          '--titan',
          owner.id,
        ],
        env: {
          ...process.env,
          OTHRYS_ACTOR: 'worker:memory-reader',
          OTHRYS_TASK: worker.worker.env.OTHRYS_TASK,
          OTHRYS_TITAN: caller.id,
        },
      })
      expect(
        output.status,
        output.stdout + output.stderr,
      ).toBe(0)

      return parsed(output)
    }

    expect(JSON.stringify((await read({
      args: [
        'owner',
        'memory',
        'list',
      ],
    })).memory)).toContain('Owner journal previously private')
    expect(JSON.stringify((await read({
      args: [
        'titan',
        'memory',
        'list',
      ],
    })).memory)).toContain('Titan note available to every caller')
    expect((await read({
      args: [
        'project',
        'memory',
        'list',
        '--project',
        project,
      ],
    })).memory.preferences).toBe('Project destination changed independently')
    const settings = (await read({
      args: [
        'settings',
        'show',
      ],
    })).settings
    expect(settings.theme).toBe('dark')
    expect(settings).not.toHaveProperty('poleis')
    expect(settings).not.toHaveProperty('projectPoleis')
    expect(settings).not.toHaveProperty('keyboard')
    const results = await read({
      args: [
        'oracle',
        'previously private',
      ],
    })
    expect(JSON.stringify(results).replaceAll(
      '[',
      '',
    )
      .replaceAll(
        ']',
        '',
      )).toContain('Owner journal previously private')
  },
)

test.each([
  { detached: false },
  { detached: true },
])(
  'worker context shares the attachment check (detached: $detached)',
  async ({ detached }) => {
    const titan = await othrys.titan()
    const project = titan.folder({ name: 'worker-snapshot' })
    await titan.owner({
      args: [
        'project',
        'add',
        project,
      ],
    })
    await titan.owner({
      args: [
        'project',
        'memory',
        'set',
        '--project',
        project,
        '--key',
        'preferences',
        '--text',
        'Project context marker',
      ],
    })
    await titan.owner({
      args: [
        'project',
        'memory',
        'set',
        '--project',
        project,
        '--key',
        'workers',
        '--text',
        'Standing project instruction marker',
      ],
    })
    await titan.owner({
      args: [
        'task',
        'create',
        '--no-start',
        '--key',
        'snapshot-worker',
        '--title',
        'Snapshot worker',
        '--project',
        project,
      ],
    })
    const resume = Promise.withResolvers<void>()
    let entered = false
    const nativeRun = processes.runProcess
    const spy = vi.spyOn(
      processes,
      'runProcess',
    ).mockImplementation(async ({
      command,
      args,
      ...options
    }) => {
      if (!entered && command === 'git' && args.includes(project) && args.includes('remote')) {
        entered = true
        await resume.promise
      }

      return nativeRun({
        command,
        args,
        ...options,
      })
    })
    const pending = titan.owner({
      args: [
        'task',
        'start',
        'snapshot-worker',
        '--folder',
        project,
        '--harness',
        'claude',
      ],
    })

    try {
      await until({
        what: 'the worker project read',
        check: () => entered,
      })

      if (detached) {
        await titan.owner({
          args: [
            'project',
            'remove',
            project,
          ],
        })
      }
    } finally {
      resume.resolve()
      spy.mockRestore()
    }

    await pending
    const worker = await until({
      what: 'the worker prompt',
      check: () => othrys.claude.sessions.find(session =>
        session.cwd === project && session.received.length > 0),
    })
    const prompt = worker.received.join('\n')

    if (detached) {
      expect(prompt).not.toContain('Project context marker')
      expect(prompt).not.toContain('Standing project instruction marker')
    } else {
      expect(prompt).toContain('Project context marker')
      expect(prompt).toContain('Standing project instruction marker')
    }
  },
)
