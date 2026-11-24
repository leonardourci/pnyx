import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { expect, test } from 'vitest'
import { compatibleEnvironment } from '#store/legacy-env.ts'
import { CLI, othrys } from './setup/othrys.ts'

test(
  'both legacy executable paths still start the rebranded CLI',
  () => {
    for (const name of [
      'pnyx.js',
      'pnyx-axi.js',
    ]) {
      const output = execFileSync(
        process.execPath,
        [
          join(
            dirname(CLI),
            name,
          ),
          '--help',
        ],
        {
          env: process.env,
          encoding: 'utf8',
        },
      )
      expect(output).toContain('usage: othrys')
    }
  },
)

test(
  'new environment values take precedence while legacy identities and homes remain inputs',
  () => {
    expect(compatibleEnvironment({
      env: {
        PNYX_HOME: '/old',
        OTHRYS_HOME: '/new',
        PNYX_HYDRA: 'west',
        PNYX_ACTOR: 'worker:task',
        PNYX_TASK: 'task',
        PNYX_STEERING_WORKER: 'session',
        PNYX_WORKER_HOME: '/captured',
      },
    })).toMatchObject({
      OTHRYS_HOME: '/new',
      OTHRYS_TITAN: 'west',
      OTHRYS_ACTOR: 'worker:task',
      OTHRYS_TASK: 'task',
      OTHRYS_STEERING_WORKER: 'session',
      OTHRYS_WORKER_HOME: '/captured',
    })
  },
)

test(
  'an invalid default home reports a structured failure without changing the existing file',
  async () => {
    const userHome = mkdtempSync(join(
      process.env.TMPDIR!,
      'invalid-home-',
    ))
    const invalid = join(
      userHome,
      '.othrys',
    )
    writeFileSync(
      invalid,
      'Keep this existing file',
    )
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: userHome,
    }
    delete env.OTHRYS_HOME
    delete env.PNYX_HOME
    const result = await othrys({
      args: [
        'board',
        '--json',
      ],
      env,
    })
    expect(result.status).toBe(1)
    expect(JSON.parse(result.stderr)).toMatchObject({
      code: 'HOME_MIGRATION_FAILED',
      error: expect.stringContaining('Cannot select Othrys home'),
      help: expect.arrayContaining([expect.stringContaining('OTHRYS_HOME')]),
    })
    expect(readFileSync(
      invalid,
      'utf8',
    )).toBe('Keep this existing file')
  },
)

test(
  'a source-installed legacy login service can still invoke its saved CLI entry',
  () => {
    const output = execFileSync(
      process.execPath,
      [
        '--conditions=source',
        join(
          import.meta.dirname,
          '..',
          'src',
          'cli',
          'pnyx.ts',
        ),
        '--help',
      ],
      {
        env: process.env,
        encoding: 'utf8',
      },
    )
    expect(output).toContain('usage: othrys')
  },
)
