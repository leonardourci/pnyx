import assert from 'node:assert/strict'
import { execFile, execFileSync, fork } from 'node:child_process'
import { once } from 'node:events'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'
import type { HydraState } from '../src/core/model.ts'

const bin = join(
  import.meta.dirname,
  '../dist/cli/pnyx-axi.js',
)
const execFileAsync = promisify(execFile)

function fixture() {
  const root = mkdtempSync(join(
    tmpdir(),
    'pnyx-workers-',
  ))
  mkdirSync(join(
    root,
    'work',
  ))
  const folder = realpathSync(join(
    root,
    'work',
  ))
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PNYX_HOME: root,
    PNYX_SEMANTIC: 'off',
    PASEO_TERMINAL_ID: '',
    PASEO_WORKSPACE_ID: '',
    TMUX_PANE: '',
    HERDR_PANE_ID: '',
    PNYX_ACTOR: '',
  }
  const run = ({
    args,
    extra = {},
  }: {
    args: string[]
    extra?: NodeJS.ProcessEnv
  }) =>
    execFileSync(
      process.execPath,
      [
        bin,
        ...args,
      ],
      {
        env: {
          ...env,
          ...extra,
        },
        encoding: 'utf8',
      },
    )
      .replace(
        /\\(["\\])/g,
        '$1',
      )

  const fail = ({
    args,
    extra = {},
  }: {
    args: string[]
    extra?: NodeJS.ProcessEnv
  }): string => {
    try {
      run({
        args,
        extra,
      })
    } catch (error) {
      return String((error as { stdout?: string }).stdout)
    }

    return assert.fail(`${args.join(' ')} succeeded`)
  }

  const state = (): HydraState => JSON.parse(readFileSync(
    join(
      root,
      'hydras/default/snapshot.json',
    ),
    'utf8',
  )).state
  let n = 0

  const hook = ({
    session,
    cwd,
    terminal,
  }: {
    session: string
    cwd: string
    terminal: string
  }) => {
    const spool = join(
      root,
      'hydras/default/spool',
    )
    mkdirSync(
      spool,
      { recursive: true },
    )
    n++
    writeFileSync(
      join(
        spool,
        `${String(n).padStart(
          4,
          '0',
        )}.json`,
      ),
      JSON.stringify({
        id: `worker-hook-${n}`,
        at: `2026-10-14T12:00:${String(n).padStart(
          2,
          '0',
        )}Z`,
        harness: 'claude',
        event: 'SessionStart',
        terminal: {
          tty: '/dev/ttys009',
          pid: '9',
          paseoTerminal: terminal,
        },
        payload: {
          session_id: session,
          cwd,
        },
      }),
    )
    run({
      args: [
        'task',
        'create',
        '--title',
        `probe ${n}`,
      ],
    })
  }

  return {
    root,
    folder,
    run,
    fail,
    state,
    hook,
  }
}

test(
  'hydra check lists only tracked changes by others and waits for the next one',
  { timeout: 30_000 },
  async t => {
    const f = fixture()
    f.run({
      args: [
        'task',
        'create',
        '--key',
        'a',
        '--title',
        'First',
      ],
    })
    const start = f.state().seq
    assert.match(
      f.run({
        args: [
          'hydra',
          'check',
        ],
      }),
      new RegExp(`none: nothing Hydra tracks changed after seq ${start}`),
    )
    f.run({
      args: [
        'task',
        'create',
        '--key',
        'b',
        '--title',
        'By Hydra',
        '--reason',
        'split out the docs',
      ],
      extra: { PNYX_ACTOR: 'hydra' },
    })
    f.run({
      args: [
        'task',
        'rename',
        'a',
        '--title',
        'First, renamed',
      ],
    })
    f.run({
      args: [
        'task',
        'status',
        'a',
        'needs_you',
        '--note',
        'which db?',
      ],
      extra: { PNYX_ACTOR: 'worker:c1' },
    })
    const out = f.run({
      args: [
        'hydra',
        'check',
        '--after',
        String(start),
      ],
    })
    assert.match(
      out,
      /evt_\d+,task\.declared,task-[0-9a-f-]{36},none,"worker:c1","needs_you: which db\?"/,
    )
    assert.doesNotMatch(
      out,
      /task\.created,task-[0-9a-f-]{36},none,hydra|card\.pushed/,
    )
    assert.doesNotMatch(
      out,
      /Hydra: Created By Hydra: split out the docs/,
    )
    const through = Number(/through: (\d+)/.exec(out)![1])
    assert.equal(
      through,
      f.state().seq,
    )

    const preload = join(
      f.root,
      'wait-gate.mjs',
    )
    writeFileSync(
      preload,
      `
      import timers from 'node:timers/promises'
      import { syncBuiltinESMExports } from 'node:module'
      let now = Date.now()
      Date.now = () => now
      timers.setTimeout = delay => new Promise(resolve => {
        process.once('message', ({ advance }) => { now += advance; resolve() })
        process.send({ waiting: delay })
      })
      syncBuiltinESMExports()
    `,
    )

    const check = ({
      after,
      seconds,
    }: {
      after: number
      seconds: number
    }) => {
      const child = fork(
        bin,
        [
          'hydra',
          'check',
          '--after',
          String(after),
          '--wait',
          String(seconds),
        ],
        {
          execArgv: [
            '--import',
            preload,
          ],
          env: {
            ...process.env,
            PNYX_HOME: f.root,
            PNYX_SEMANTIC: 'off',
          },
          silent: true,
        },
      )
      let stdout = ''
      let stderr = ''
      child.stdout!.on(
        'data',
        chunk => {
          stdout += chunk
        },
      )
      child.stderr!.on(
        'data',
        chunk => {
          stderr += chunk
        },
      )
      const done = once(
        child,
        'close',
      ).then(([code]) => {
        assert.equal(
          code,
          0,
          stderr,
        )

        return stdout
      })
      const nextWait = () => Promise.race([
        once(
          child,
          'message',
        ).then(([message]) => message as { waiting: number }),
        done.then(() => {
          throw new Error('hydra check exited without registering its wait')
        }),
      ])

      return {
        child,
        done,
        registered: nextWait(),
        nextWait,
      }
    }

    const waiting = check({
      after: through,
      seconds: 20,
    })
    t.after(() => {
      waiting.child.kill()
    })
    assert.deepEqual(
      await waiting.registered,
      { waiting: 2000 },
    )
    f.run({
      args: [
        'hydra',
        'send',
        '--text',
        'plan the week',
      ],
    })
    waiting.child.send({ advance: 0 })
    const stdout = await waiting.done
    assert.match(
      stdout,
      /hydra\.message,none,send,owner \(cli\),"Send to Hydra: plan the week"/,
    )

    const before = f.state().seq
    await Promise.all(Array.from(
      { length: 22 },
      (
        _,
        i,
      ) => execFileAsync(
        process.execPath,
        [
          bin,
          'hydra',
          'send',
          '--text',
          `note ${i}`,
        ],
        {
          env: {
            ...process.env,
            PNYX_HOME: f.root,
            PNYX_SEMANTIC: 'off',
          },
        },
      ),
    ))
    const first = f.run({
      args: [
        'hydra',
        'check',
        '--after',
        String(before),
      ],
    })
    assert.equal(
      (first.match(/note \d+/g) ?? []).length,
      20,
    )
    const next = Number(/through: (\d+)/.exec(first)![1])
    assert.equal(
      next,
      before + 20,
    )
    assert.equal(
      (f.run({
        args: [
          'hydra',
          'check',
          '--after',
          String(next),
        ],
      }).match(/note \d+/g) ?? []).length,
      2,
    )

    const quiet = f.state().seq
    f.run({
      args: [
        'task',
        'hide',
        'b',
        '--reason',
        'the owner closed it',
      ],
      extra: { PNYX_ACTOR: 'hydra' },
    })
    const ownWait = check({
      after: quiet,
      seconds: 1,
    })
    t.after(() => {
      ownWait.child.kill()
    })
    assert.deepEqual(
      await ownWait.registered,
      { waiting: 1000 },
    )
    const beforeDeadline = ownWait.nextWait()
    ownWait.child.send({ advance: 999 })
    assert.deepEqual(
      await beforeDeadline,
      { waiting: 1 },
    )
    ownWait.child.send({ advance: 1 })
    const own = await ownWait.done
    assert.match(
      own,
      /none: nothing Hydra tracks changed/,
    )
  },
)
