import assert from 'node:assert/strict'
import { test } from 'node:test'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { codexProcesses } from './codex-processes.ts'

const LONG_COMMAND = 'sleep 120'

test(
  'Codex Stop terminates its foreground child and preserves completed background and unrelated children',
  async t => {
  // This process stands in for the app-server; its children are real OS processes.
    const app = spawn(
      process.execPath,
      [
        '-e',
        `
    const { spawn } = require('node:child_process');
    const readline = require('node:readline');
    readline.createInterface({input: process.stdin}).on('line', command => {
      const child = spawn('sh', ['-c', command], {stdio: 'ignore'});
      process.stdout.write(child.pid + '\\n');
    });
  `,
      ],
      {
        stdio: [
          'pipe',
          'pipe',
          'pipe',
        ],
      },
    )
    const children: number[] = []
    t.after(() => {
      for (const pid of children) {
        try {
          process.kill(
            pid,
            'SIGKILL',
          )
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
            throw error
          }
        }
      }

      app.kill('SIGKILL')
    })

    const launch = async ({ command }: { command: string }) => {
      const output = once(
        app.stdout,
        'data',
      )
      app.stdin.write(command + '\n')
      const [bytes] = await output
      const pid = Number(String(bytes).trim())
      children.push(pid)

      return pid
    }

    const tracker = codexProcesses({ pid: app.pid })
    const earlier = await launch({ command: LONG_COMMAND })
    await tracker.begin()
    tracker.command({
      id: 'background',
      command: 'sleep 121',
      completed: false,
    })
    const background = await launch({ command: 'sleep 121' })
    tracker.command({
      id: 'background',
      command: 'sleep 121',
      completed: true,
    })
    tracker.command({
      id: 'foreground',
      command: LONG_COMMAND,
      completed: false,
    })
    const foreground = await launch({ command: LONG_COMMAND })
    const cleanup = await tracker.capture()
    const stopped = await cleanup()
    assert.ok(stopped.includes(foreground))
    assert.doesNotThrow(() => process.kill(
      app.pid!,
      0,
    ))
    assert.doesNotThrow(() => process.kill(
      earlier,
      0,
    ))
    assert.doesNotThrow(() => process.kill(
      background,
      0,
    ))
    assert.throws(
      () => process.kill(
        foreground,
        0,
      ),
      { code: 'ESRCH' },
    )
  },
)
