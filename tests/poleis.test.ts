import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, expect, test } from 'vitest'
import { pnyxAxi, parsed, startPnyx, type Pnyx } from './setup/pnyx.ts'

let pnyx: Pnyx
beforeAll(async () => {
  pnyx = await startPnyx()
})

test(
  'owner-memory revisions cannot cross a home-polis change',
  async () => {
    const hydra = await pnyx.hydra()

    await hydra.owner({
      args: [
        'hydra',
        'set',
        '--polis',
        'revision-first',
      ],
    })

    const first = await hydra.owner({
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
    await hydra.owner({
      args: [
        'hydra',
        'set',
        '--polis',
        'revision-next',
      ],
    })
    await hydra.owner({
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

    expect((await hydra.ownerRefused({
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
    expect((await hydra.ownerRefused({
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
    const current = await hydra.owner({
      args: [
        'owner',
        'memory',
        'list',
      ],
    })
    expect(current.writable.preferences.text).toBe('revision-next')
    await hydra.owner({
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
    expect((await hydra.owner({
      args: [
        'owner',
        'memory',
        'list',
      ],
    })).writable.preferences.text).toBe('fresh replacement')
    await hydra.owner({
      args: [
        'hydra',
        'set',
        '--polis',
        'revision-final',
      ],
    })
    await hydra.owner({
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
    await hydra.owner({
      args: [
        'hydra',
        'set',
        '--polis',
        'revision-next',
      ],
    })
    const path = join(
      process.env.PNYX_HOME!,
      'owner',
      'poleis',
      'revision-next',
      'memory.jsonl',
    )
    const beforeCorruption = readFileSync(path)
    const firstPath = join(
      process.env.PNYX_HOME!,
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
        const memory = await hydra.owner({
          args: [
            'owner',
            'memory',
            'list',
          ],
        })
        expect(memory.writable.preferences.text).toBe('fresh replacement')
        expect(JSON.stringify(memory.memory)).not.toMatch(/Invalid (local sequence|imported sequence|source rewrite|destination rewrite)/)
        expect((await hydra.ownerRefused({
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
      expect((await hydra.owner({
        args: [
          'owner',
          'memory',
          'list',
        ],
      })).writable.preferences.text).toBe('fresh replacement')
      const combined = await hydra.owner({
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
      expect((await hydra.ownerRefused({
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
        readFileSync(new URL(
          './setup/fixtures/memory/owner-move-valid-source.jsonl',
          import.meta.url,
        )),
      )
      const invalidTail = await hydra.owner({
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
        readFileSync(new URL(
          './setup/fixtures/memory/owner-move-valid-source.jsonl',
          import.meta.url,
        )),
      )
      const malformedProjectMove = await hydra.owner({
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
      const gap = await hydra.owner({
        args: [
          'owner',
          'memory',
          'list',
        ],
      })
      expect(gap.writable.preferences.text).toBe('fresh replacement')
      expect(JSON.stringify(gap.memory)).not.toContain('Rejected source-gap import')
      expect(JSON.stringify(gap.memory)).toContain('revision-first')
      expect((await hydra.ownerRefused({
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
      await hydra.owner({
        args: [
          'hydra',
          'set',
          '--polis',
          'revision-first',
        ],
      })
      expect((await hydra.ownerRefused({
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
      await hydra.owner({
        args: [
          'hydra',
          'set',
          '--polis',
          'revision-next',
        ],
      })
      const rejectedDestination = await hydra.owner({
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
      expect((await hydra.ownerRefused({
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
      const outOfOrder = await hydra.owner({
        args: [
          'owner',
          'memory',
          'list',
        ],
      })
      expect(outOfOrder.writable.preferences.text).toBe('fresh replacement')
      expect((await hydra.ownerRefused({
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
    const hydra = await pnyx.hydra()
    const path = hydra.folder({ name: 'confirmation-retry' })
    await hydra.owner({
      args: [
        'project',
        'add',
        path,
      ],
    })
    const saved = await hydra.owner({
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
    const first = await hydra.owner({ args })
    const retry = await hydra.owner({ args })
    expect(retry.skipped).toBe('duplicate')
    expect(retry.revision).toBe(first.revision)
    expect((await hydra.ownerRefused({
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
  'owner journals, Hydra notes and project notes stay readable across Hydras without access rules',
  async () => {
    const owner = await pnyx.hydra()
    const caller = await pnyx.hydra()
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
        'hydra',
        'memory',
        'set',
        '--key',
        'context',
        '--text',
        'Hydra note available to every caller',
      ],
    })
    await owner.owner({
      args: [
        'hydra',
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
    const settingsPath = join(
      process.env.PNYX_HOME!,
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
      const output = await pnyxAxi({
        args: [
          ...args,
          '--hydra',
          owner.id,
        ],
        env: {
          ...process.env,
          PNYX_ACTOR: 'worker:memory-reader',
          PNYX_TASK: worker.worker.env.PNYX_TASK,
          PNYX_HYDRA: caller.id,
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
        'hydra',
        'memory',
        'list',
      ],
    })).memory)).toContain('Hydra note available to every caller')
    expect((await read({
      args: [
        'project',
        'memory',
        'list',
        '--project',
        project,
      ],
    })).memory.preferences).toBe('Project note available to every caller')
    const settings = (await read({
      args: [
        'settings',
        'show',
      ],
    })).settings
    expect(settings.theme).toBe('dark')
    expect(settings).not.toHaveProperty('poleis')
    expect(settings).not.toHaveProperty('projectPoleis')
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
