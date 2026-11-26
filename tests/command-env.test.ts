import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, expect, test, vi } from 'vitest'
import { runCommand } from '#integrations/command/run.ts'
import { until } from './setup/until.ts'

afterEach(() => vi.unstubAllEnvs())

test(
  'command workers do not inherit their parent actor or hosted authority',
  async () => {
    vi.stubEnv(
      'OTHRYS_ACTOR',
      'titan',
    )
    vi.stubEnv(
      'OTHRYS_HOSTED',
      '1',
    )

    const cwd = mkdtempSync(join(
      process.env.TMPDIR!,
      'command-env-',
    ))
    const output = join(
      cwd,
      'inherited.env',
    )
    runCommand({
      command: 'env > inherited.env',
      cwd,
      env: { OTHRYS_TASK: 'worker-task' },
    })
    const inherited = await until({
      what: 'the command worker to record its environment',
      check: () => existsSync(output) && readFileSync(
        output,
        'utf8',
      ).includes('OTHRYS_TASK=worker-task') && readFileSync(
        output,
        'utf8',
      ),
    })
    expect(inherited).not.toMatch(/^OTHRYS_(?:ACTOR|HOSTED)=/m)
  },
)
