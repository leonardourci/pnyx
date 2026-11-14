import { spawn } from 'node:child_process'
import { createServer, type Socket } from 'node:net'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, expect, test } from 'vitest'
import { parsed, pnyxAxi, startPnyx, until, type Pnyx } from './setup/pnyx.ts'
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
// A hook that has not ended by itself after this long is stuck; the test then stops it and fails. It is no speed target.
const HOOK_STUCK_MS = 30_000

let pnyx: Pnyx

beforeAll(async () => {
  pnyx = await startPnyx()
})

// The installed hook as Claude Code runs it: from the session's folder, with the event's payload on stdin.
const hook = ({
  event,
  payload,
  env = process.env,
}: {
  event: string
  payload: Record<string, unknown> & { cwd: string }
  env?: NodeJS.ProcessEnv
}) => new Promise<{
  status: number | null
  stdout: string
  // Whether the hook ended by itself instead of being stopped as stuck.
  ended: boolean
}>(resolve => {
  mkdirSync(
    payload.cwd,
    { recursive: true },
  )
  let ended = true
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
      env,
    },
  )
  const stuck = setTimeout(
    () => {
      ended = false
      child.kill('SIGKILL')
    },
    HOOK_STUCK_MS,
  )
  let stdout = ''
  child.stdout.on(
    'data',
    data => stdout += String(data),
  )
  child.once(
    'close',
    status => {
      clearTimeout(stuck)
      resolve({
        status,
        stdout,
        ended,
      })
    },
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

  return shown.status === 0 ? parsed(shown).task : undefined
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
    expect(working).toMatchObject({
      title: 'Fix the flaky login test',
      activity: 'working',
    })

    runs.push(await hook({
      event: 'Stop',
      payload: base,
    }))
    await until({
      what: 'Stop to end the turn',
      check: async () => [
        'finished',
        'idle',
      ].includes((await card({ session: 'outside-1' }))?.activity),
    })

    for (const run of runs) {
      expect(run).toMatchObject({
        status: 0,
        stdout: '',
        ended: true,
      })
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
      ended: true,
    })
    expect((await until({
      what: 'the spooled report to land',
      check: () => card({ session: 'offline-1' }),
    })).title).toBe('Written while Pnyx was down')
  },
)

test(
  'a hook whose server accepts the report and never answers still ends by itself, exits 0 and prints nothing',
  async () => {
    const home = join(
      process.env.TMPDIR!,
      'silent-home',
    )
    const dir = join(
      home,
      'hydras',
      'default',
    )
    mkdirSync(
      dir,
      { recursive: true },
    )
    const connections: Socket[] = []
    const silent = createServer(connection => connections.push(connection))
    await new Promise<void>(resolve => silent.listen(
      join(
        dir,
        'server.sock',
      ),
      resolve,
    ))

    try {
      const run = await hook({
        event: 'SessionStart',
        payload: {
          session_id: 'silent-1',
          cwd: join(
            process.env.TMPDIR!,
            'silent',
          ),
          source: 'startup',
        },
        env: {
          ...process.env,
          PNYX_HOME: home,
        },
      })

      expect(run).toMatchObject({
        status: 0,
        stdout: '',
        ended: true,
      })
      expect(connections).toHaveLength(1)
    } finally {
      for (const connection of connections) {
        connection.destroy()
      }

      silent.close()
    }
  },
)

// task-c36e45ad: hooks on a Hydra without a legacy events.jsonl are dropped; remove the skip when #389 or another fix lands.
test.skip(
  'an outside session reporting with PNYX_HYDRA set lands on that Hydra, not the default one',
  async () => {
    const hydra = await pnyx.hydra()
    const cwd = join(
      process.env.TMPDIR!,
      'named',
    )
    const run = await hook({
      event: 'UserPromptSubmit',
      payload: {
        session_id: 'named-1',
        cwd,
        prompt: 'Reported to a named Hydra',
      },
      env: {
        ...process.env,
        PNYX_HYDRA: hydra.id,
      },
    })
    expect(run).toMatchObject({
      status: 0,
      stdout: '',
    })
    expect((await until({
      what: 'the session\'s card on its own Hydra',
      check: async () => {
        const shown = await pnyxAxi({
          args: [
            'task',
            'show',
            'claude:named-1',
            '--hydra',
            hydra.id,
          ],
          env: process.env,
        })

        return shown.status === 0 ? parsed(shown).task : undefined
      },
    })).title).toBe('Reported to a named Hydra')
  },
)
