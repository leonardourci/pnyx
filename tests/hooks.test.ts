import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, expect, test } from 'vitest'
import { pnyxAxi, startPnyx, until, type Pnyx } from './setup/pnyx.ts'
import { git } from './setup/upgrade.ts'

const HOOK = join(
  import.meta.dirname,
  '..',
  'setup',
  'hooks',
  'pnyx-hook.sh',
)
const CLI = join(
  import.meta.dirname,
  '..',
  'dist',
  'cli',
  'pnyx-axi.js',
)
// A harness waits on its hooks; one must never hold an agent up.
const HOOK_BOUND_MS = 2000

let pnyx: Pnyx

beforeAll(async () => {
  pnyx = await startPnyx()
})

// The installed hook as Claude Code runs it: from the session's folder, with the event's payload on stdin.
const hook = ({
  event,
  payload,
}: {
  event: string
  payload: Record<string, unknown> & { cwd: string }
}) => new Promise<{
  status: number | null
  stdout: string
  ms: number
}>(resolve => {
  mkdirSync(
    payload.cwd,
    { recursive: true },
  )
  const started = performance.now()
  const child = spawn(
    'sh',
    [
      HOOK,
      'claude',
      event,
      CLI,
    ],
    {
      cwd: payload.cwd,
      env: process.env,
    },
  )
  let stdout = ''
  child.stdout.on(
    'data',
    data => stdout += String(data),
  )
  child.once(
    'close',
    status => resolve({
      status,
      stdout,
      ms: performance.now() - started,
    }),
  )
  child.stdin.end(JSON.stringify({
    hook_event_name: event,
    ...payload,
  }))
})

// The card an outside session's hooks keep on the default Hydra, the one outside sessions report to.
const card = async ({ session }: { session: string }) => {
  const shown = await pnyxAxi({
    args: [
      'task',
      'show',
      `claude:${session}`,
      '--full',
      '--hydra',
      'default',
    ],
    env: process.env,
  })

  return shown.status === 0 ? shown.stdout : undefined
}

test(
  'an outside session\'s hooks keep its card: the prompt names it, Stop ends its turn, and every hook exits 0 at once',
  async () => {
    await pnyx.hydra()
    const cwd = join(
      process.env.TMPDIR!,
      'outside',
    )
    const base = {
      session_id: 'outside-1',
      cwd,
      transcript_path: join(
        cwd,
        'transcript.jsonl',
      ),
    }

    const runs = [
      await hook({
        event: 'SessionStart',
        payload: {
          ...base,
          source: 'startup',
        },
      }),
      await hook({
        event: 'UserPromptSubmit',
        payload: {
          ...base,
          prompt: 'Fix the flaky login test\nwith more detail below',
        },
      }),
    ]
    const working = await until({
      what: 'the session\'s card',
      check: () => card({ session: 'outside-1' }),
    })
    expect(working).toContain('title: Fix the flaky login test\n')
    expect(working).toMatch(/activity: working/)

    runs.push(await hook({
      event: 'Stop',
      payload: base,
    }))
    await until({
      what: 'Stop to end the turn',
      check: async () => (await card({ session: 'outside-1' }))?.match(/activity: (finished|idle)/),
    })

    for (const run of runs) {
      expect(run).toMatchObject({
        status: 0,
        stdout: '',
      })
      expect(run.ms).toBeLessThan(HOOK_BOUND_MS)
    }
  },
)

test(
  'session start prints the open tasks of the attached project holding the folder, and nothing for any other folder',
  async () => {
    const project = join(
      process.env.TMPDIR!,
      'checkout',
    )
    git({
      cwd: process.env.TMPDIR!,
      args: [
        'init',
        '-q',
        '-b',
        'main',
        project,
      ],
    })
    writeFileSync(
      join(
        project,
        'README.md',
      ),
      'checkout\n',
    )

    for (const args of [
      [
        'project',
        'add',
        project,
      ],
      [
        'task',
        'create',
        '--title',
        'Speed up checkout',
        '--project',
        'checkout',
      ],
    ]) {
      expect((await pnyxAxi({
        args: [
          ...args,
          '--hydra',
          'default',
        ],
        env: process.env,
      })).status).toBe(0)
    }

    const inProject = await hook({
      event: 'SessionStart',
      payload: {
        session_id: 'inside-1',
        cwd: project,
        source: 'startup',
      },
    })
    expect(inProject.status).toBe(0)
    expect(inProject.stdout).toContain('Speed up checkout')

    const elsewhere = await hook({
      event: 'SessionStart',
      payload: {
        session_id: 'elsewhere-1',
        cwd: join(
          process.env.TMPDIR!,
          'elsewhere',
        ),
        source: 'startup',
      },
    })
    expect(elsewhere).toMatchObject({
      status: 0,
      stdout: '',
    })
  },
)

test(
  'a hook that runs while the server is down exits 0 at once and its report lands when the server is back',
  async () => {
    const cwd = join(
      process.env.TMPDIR!,
      'offline',
    )
    let offline: Awaited<ReturnType<typeof hook>> | undefined
    await pnyx.restart({
      whileStopped: async () => {
        offline = await hook({
          event: 'UserPromptSubmit',
          payload: {
            session_id: 'offline-1',
            cwd,
            prompt: 'Written while Pnyx was down',
          },
        })
      },
    })
    expect(offline).toMatchObject({
      status: 0,
      stdout: '',
    })
    expect(offline!.ms).toBeLessThan(HOOK_BOUND_MS)
    expect(await until({
      what: 'the spooled report to land',
      check: () => card({ session: 'offline-1' }),
    })).toContain('title: Written while Pnyx was down')
  },
)
