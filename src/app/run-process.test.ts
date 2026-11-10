import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { closeLogs, logsDir, openLogs } from './diagnostics.ts'
import { runProcess } from './run-process.ts'

test(
  'a child process is logged under its tool, with the subcommand only for tools that have one, never a value',
  async t => {
    const bin = mkdtempSync(join(
      tmpdir(),
      'pnyx-tools-',
    ))
    openLogs()
    t.after(() => {
      closeLogs()
      rmSync(
        bin,
        {
          recursive: true,
          force: true,
        },
      )
    })

    // Each name stands for a real tool and runs `true`, so only the arguments' shapes matter.
    const tool = ({ name }: { name: string }) => {
      const path = join(
        bin,
        name,
      )
      symlinkSync(
        '/usr/bin/true',
        path,
      )

      return path
    }

    const runs = [
      {
        command: tool({ name: 'git' }),
        args: [
          '--no-optional-locks',
          '-C',
          '/some/project',
          '-c',
          'core.quotepath=false',
          'status',
        ],
      },
      {
        command: tool({ name: 'fm-send.sh' }),
        args: [
          'pnyx-logs-review',
          'a message',
        ],
      },
      {
        command: tool({ name: 'tmux' }),
        args: [
          '-L',
          'work',
          'send-keys',
        ],
      },
      {
        command: tool({ name: 'quota-axi' }),
        args: [
          '--provider',
          'claude',
        ],
      },
    ]

    for (const run of runs) {
      await runProcess(run)
    }

    const names = readdirSync(logsDir()).flatMap(name => readFileSync(
      join(
        logsDir(),
        name,
      ),
      'utf8',
    ).split('\n'))
      .filter(Boolean)
      .map(text => JSON.parse(text) as Record<string, unknown>)
      .filter(line => line.operation === 'exec')
      .map(line => line.name)
    assert.deepEqual(
      names,
      [
        'git status',
        'fm-send.sh',
        'tmux',
        'quota-axi',
      ],
    )
  },
)
