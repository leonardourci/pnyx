import { tmpdir } from 'node:os'
import { base as eventBase } from '#app/command-meta.ts'
import { eventReasons } from '#hydra/wake-reasons.ts'
import { readChanges } from '#app/event-log.ts'
import { loadHydra } from '#app/store.ts'
import { withWriter } from '#app/writer.ts'
import { applyDecision } from '#app/decision.ts'
import { decideSessionFacts } from '#workers/session-facts.ts'
import * as transcriptReader from '#workers/transcript-read.ts'
import { flushLogs } from '#app/diagnostics.ts'
import { logFiles } from '#diagnostics/log-files.ts'
import { spawn } from 'node:child_process'
import { createServer, type Socket } from 'node:net'
import { existsSync, mkdirSync, mkdtempSync, rmSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, expect, onTestFinished, test, vi } from 'vitest'
import { parsed, operation, startPnyx, until, type Pnyx } from './setup/pnyx.ts'
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
  'pnyx.js',
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

const sessionFacts = async ({
  session,
  hydra = 'default',
}: {
  session: string
  hydra?: string
}) => {
  const shown = await operation({
    args: [
      'task',
      'sessions',
      '--full',
      '--hydra',
      hydra,
    ],
    env: process.env,
  })

  if (shown.status !== 0) {
    return undefined
  }

  return parsed(shown).sessions.find((facts: { agent: { sessionId: string } }) =>
    facts.agent.sessionId === session)
}

test(
  'outside hooks keep facts without an implicit card, and the assigned chat shows its typed prompt without a steering notice',
  async () => {
    const hydra = await pnyx.hydra()
    await hydra.owner({
      args: [
        'settings',
        'set',
        '--json',
        '{"logs":"on"}',
      ],
    })
    await flushLogs()
    const onStart = logFiles().map(file => readFileSync(
      file.path,
      'utf8',
    ))
      .join('').length
    const beforeTasks = parsed(await operation({
      args: [
        'task',
        'list',
        '--hydra',
        'default',
      ],
      env: process.env,
    })).tasks
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

    const userLine = ({ content }: { content: string }) => `${JSON.stringify({
      type: 'user',
      timestamp: new Date().toISOString(),
      message: {
        role: 'user',
        content,
      },
    })}\n`
    mkdirSync(
      cwd,
      { recursive: true },
    )
    writeFileSync(
      base.transcript_path,
      [
        userLine({ content: 'Fix the flaky login test' }),
        userLine({ content: `New instructions for task outside, in order (Pnyx inbox IDs ["earlier"]):\n\n${'Keep the retry loop bounded. '.repeat(60)}` }),
      ].join(''),
    )
    const terminalEnv = {
      ...process.env,
      TMUX: '/tmp/pnyx-hook-tmux,123,0',
      TMUX_PANE: '%7',
      HERDR_SESSION: 'hook-session',
      HERDR_PANE_ID: 'hook-pane',
    }
    const runs = [
      await hook({
        event: 'SessionStart',
        env: terminalEnv,
        payload: {
          ...base,
          source: 'startup',
        },
      }),
    ]
    const started = await until({
      what: 'SessionStart pane facts',
      check: () => sessionFacts({ session: 'outside-1' }),
    })
    expect(started.terminal).toMatchObject({
      tmux: '/tmp/pnyx-hook-tmux',
      tmuxPane: '%7',
      herdrSession: 'hook-session',
      herdrPane: 'hook-pane',
    })
    runs.push(await hook({
      event: 'UserPromptSubmit',
      env: {
        ...terminalEnv,
        TMUX_PANE: '%8',
        HERDR_PANE_ID: 'prompt-pane',
      },
      payload: {
        ...base,
        prompt: 'Fix the flaky login test\nwith more detail below',
      },
    }))
    const working = await until({
      what: 'the session facts',
      check: async () => {
        const facts = await sessionFacts({ session: 'outside-1' })

        return facts?.terminal?.tmuxPane === '%8' && facts?.terminal?.herdrPane === 'prompt-pane' && facts
      },
    })
    expect(working).toMatchObject({
      title: 'Fix the flaky login test',
      activity: 'working',
      terminal: {
        tmux: '/tmp/pnyx-hook-tmux',
        tmuxPane: '%8',
        herdrSession: 'hook-session',
        herdrPane: 'prompt-pane',
      },
    })
    withWriter({
      hydraId: 'default',
      fn: ({ writer }) => applyDecision({
        writer,
        decision: {
          event: {
            ...eventBase({
              state: writer.state,
              cardId: 'legacy-hook-observation',
              meta: {
                at: new Date().toISOString(),
                actor: 'hook:claude',
                id: 'legacy-outside-observation',
              },
            }),
            type: 'card.pushed',
            data: {
              key: 'claude:outside-1',
              agent: working.agent,
              terminal: { tty: '/dev/ttys99998' },
              settings: { fast: 'on' },
              activity: 'working',
              source: {
                adapter: 'hooks',
                instanceId: 'claude',
                objectId: 'outside-1',
                observedAt: new Date().toISOString(),
              },
            },
          },
        },
      }),
    })
    expect(await sessionFacts({ session: 'outside-1' })).toMatchObject({
      terminal: { tty: '/dev/ttys99998' },
      settings: { fast: 'true' },
    })
    withWriter({
      hydraId: 'default',
      fn: ({ writer }) => applyDecision({
        writer,
        decision: {
          event: {
            ...eventBase({
              state: writer.state,
              cardId: 'legacy-hook-observation',
              meta: {
                at: new Date().toISOString(),
                actor: 'hook:claude',
                id: 'legacy-outside-settings',
              },
            }),
            type: 'card.pushed',
            data: {
              key: 'claude:outside-1',
              settings: {
                model: 'recorded-hook-model',
                fast: 'off',
              },
              source: {
                adapter: 'transcript',
                objectId: base.transcript_path,
                observedAt: new Date().toISOString(),
              },
            },
          },
        },
      }),
    })
    expect((await sessionFacts({ session: 'outside-1' })).settings).toMatchObject({
      model: 'recorded-hook-model',
      fast: 'false',
    })
    const allCards = parsed(await operation({
      args: [
        'page',
        '--hidden',
        '--full',
        '--hydra',
        'default',
      ],
      env: process.env,
    })).page.cards
    expect(allCards).not.toHaveProperty('legacy-hook-observation')
    await hook({
      event: 'PreToolUse',
      payload: {
        ...base,
        tool_name: 'AskUserQuestion',
        tool_input: {
          questions: [
            {
              question: 'Which file should I read?',
              header: 'File',
              options: [
                {
                  label: 'file.ts',
                  description: 'Read the source',
                },
                {
                  label: 'test.ts',
                  description: 'Read the test',
                },
              ],
            },
          ],
        },
      },
    })
    await until({
      what: 'the tool hook request',
      check: async () => (await sessionFacts({ session: 'outside-1' }))?.attention.some((item: { text?: string }) => item.text?.includes('Which file should I read?')),
    })
    expect((await sessionFacts({ session: 'outside-1' })).title).toBe('Fix the flaky login test')
    const tasks = await operation({
      args: [
        'task',
        'list',
        '--hydra',
        'default',
      ],
      env: process.env,
    })
    expect(parsed(tasks).tasks).toEqual(beforeTasks)
    const assignedHydra = await pnyx.hydra({
      id: 'default',
      create: false,
    })
    await assignedHydra.owner({
      args: [
        'task',
        'create',
        '--key',
        'outside-hook-chat',
        '--title',
        'Outside hook chat',
        '--no-start',
      ],
    })
    await assignedHydra.owner({
      args: [
        'push',
        '--key',
        'outside-1',
        '--file',
        '-',
      ],
      input: JSON.stringify({
        agent: working.agent,
        terminal: { tty: '/dev/ttys99999' },
      }),
    })
    await assignedHydra.owner({
      args: [
        'task',
        'attach',
        'outside-hook-chat',
        '--session',
        working.id,
      ],
    })
    const chat = await assignedHydra.owner({
      args: [
        'task',
        'chat',
        'outside-hook-chat',
      ],
    })
    expect((chat.thread.entries as {
      role: string
      text: string
    }[])
      .filter(entry => entry.role === 'user' || entry.role === 'You')
      .map(entry => entry.text)).toEqual(['Fix the flaky login test'])

    const replacement = {
      ...working.agent,
      sessionId: 'outside-replacement',
    }
    await assignedHydra.owner({
      args: [
        'push',
        '--key',
        'outside-replacement',
        '--file',
        '-',
      ],
      input: JSON.stringify({
        agent: replacement,
        terminal: { tty: '/dev/ttys99998' },
      }),
    })
    const replacementId = (await sessionFacts({ session: 'outside-replacement' })).id
    const replaced = await assignedHydra.owner({
      args: [
        'task',
        'attach',
        'outside-hook-chat',
        '--session',
        replacementId,
      ],
    })
    expect(replaced.notices).toBeDefined()
    expect((await assignedHydra.task({ key: 'outside-hook-chat' })).worker).toBe(replacementId)
    const sessions = await assignedHydra.owner({
      args: [
        'task',
        'sessions',
      ],
    })
    expect(sessions.sessions).toContainEqual(expect.objectContaining({
      id: working.id,
      task: 'none',
    }))
    const project = assignedHydra.folder({ name: 'queued-attachment' })
    await assignedHydra.owner({
      args: [
        'project',
        'add',
        project,
      ],
    })
    await assignedHydra.owner({
      args: [
        'task',
        'rename',
        'outside-hook-chat',
        '--project',
        project,
      ],
    })
    await assignedHydra.owner({
      args: [
        'task',
        'create',
        '--no-start',
        '--key',
        'queued-attachment',
        '--title',
        'Queued work',
        '--project',
        project,
      ],
    })
    await assignedHydra.owner({
      args: [
        'task',
        'queue',
        'queued-attachment',
        '--behind',
        'outside-hook-chat',
      ],
    })
    expect((await assignedHydra.task({ key: 'queued-attachment' })).queue).toBeDefined()
    const attached = await assignedHydra.owner({
      args: [
        'task',
        'attach',
        'queued-attachment',
        '--session',
        replacementId,
      ],
    })
    expect(attached.notices).toBeDefined()
    expect((await assignedHydra.task({ key: 'queued-attachment' })).queue).toBeUndefined()
    expect((await assignedHydra.task({ key: 'queued-attachment' })).worker).toBe(replacementId)

    await flushLogs()
    const onLogs = logFiles().map(file => readFileSync(
      file.path,
      'utf8',
    ))
      .join('')
      .slice(onStart)
    expect(onLogs).not.toContain('hook.push')
    expect(onLogs).not.toContain('card.observed')
    await hydra.owner({
      args: [
        'settings',
        'set',
        '--json',
        '{"logs":"detailed"}',
      ],
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
      ].includes((await sessionFacts({ session: 'outside-1' }))?.activity),
    })

    await flushLogs()
    const logs = logFiles().map(file => readFileSync(
      file.path,
      'utf8',
    ))
      .join('')
    expect(logs).toContain('hook.push')
    expect(logs).not.toContain('Fix the flaky login test')
    expect(logs).not.toContain('with more detail below')

    for (const run of runs) {
      expect(run).toMatchObject({
        status: 0,
        stdout: '',
        ended: true,
      })
    }

    await hook({
      event: 'UserPromptSubmit',
      payload: {
        ...base,
        prompt: 'Resume the outside task',
      },
    })
    await until({
      what: 'the outside turn to start',
      check: async () => {
        const facts = await sessionFacts({ session: 'outside-1' })

        return facts?.activity === 'working' && facts
      },
    })
    await hook({
      event: 'PermissionRequest',
      payload: {
        ...base,
        tool_name: 'Bash',
        tool_input: { command: 'inspect-package' },
      },
    })
    const running = await until({
      what: 'the prompt to be recorded before restart',
      check: async () => {
        const facts = await sessionFacts({ session: 'outside-1' })

        return facts?.attention.some((item: { blocking?: boolean }) => item.blocking) && facts
      },
    })
    const brokenTranscript = join(
      cwd,
      'unreadable-transcript',
    )
    mkdirSync(brokenTranscript)
    await hook({
      event: 'SessionStart',
      payload: {
        ...base,
        session_id: 'broken-transcript',
        transcript_path: brokenTranscript,
      },
    })
    await until({
      what: 'the unreadable transcript session to be registered',
      check: () => sessionFacts({ session: 'broken-transcript' }),
    })
    const settingsTranscript = join(
      cwd,
      'settings-only.jsonl',
    )
    await hook({
      event: 'SessionStart',
      payload: {
        ...base,
        session_id: 'settings-only',
        transcript_path: settingsTranscript,
      },
    })
    await until({
      what: 'settings-only session to be observed',
      check: () => sessionFacts({ session: 'settings-only' }),
    })
    const nextTurnAt = new Date(Date.parse(running.lastSeen) + 1).toISOString()
    const legacyAt = running.lastSeen.replace(
      /\.\d{3}Z$/,
      'Z',
    )
    const legacyTranscript = join(
      cwd,
      'legacy-clock.jsonl',
    )
    writeFileSync(
      join(
        process.env.PNYX_HOME!,
        'hydras',
        'default',
        'spool',
        'legacy-clock.json',
      ),
      JSON.stringify({
        v: 1,
        id: 'legacy-clock',
        at: legacyAt,
        harness: 'claude',
        event: 'UserPromptSubmit',
        payload: {
          session_id: 'legacy-clock',
          cwd,
          prompt: 'Legacy clock',
          transcript_path: legacyTranscript,
        },
      }),
    )
    await until({
      what: 'legacy hook clock to be observed',
      check: async () => (await sessionFacts({ session: 'legacy-clock' }))?.activity === 'working',
    })
    await pnyx.restart({
      whileStopped: () => {
        writeFileSync(
          settingsTranscript,
          `${JSON.stringify({
            type: 'assistant',
            timestamp: '2025-01-01T00:00:00.001Z',
            message: {
              stop_reason: 'end_turn',
              content: [],
            },
          })}\n`,
        )
        writeFileSync(
          legacyTranscript,
          `${JSON.stringify({
            type: 'assistant',
            timestamp: new Date(Date.parse(legacyAt) + 1).toISOString(),
            message: {
              stop_reason: 'end_turn',
              content: [
                {
                  type: 'text',
                  text: 'Legacy turn ended',
                },
              ],
            },
          })}\n`,
        )
        writeFileSync(
          base.transcript_path,
          `${JSON.stringify({
            type: 'assistant',
            timestamp: nextTurnAt,
            message: {
              stop_reason: 'end_turn',
              content: [
                {
                  type: 'text',
                  text: 'Completed while offline',
                },
              ],
            },
          })}\n${JSON.stringify({
            type: 'user',
            timestamp: nextTurnAt,
            message: {
              role: 'user',
              content: 'A second offline turn',
            },
          })}\n`,
        )
      },
    })
    expect(await sessionFacts({ session: 'outside-1' })).toMatchObject({
      activity: 'working',
      attention: [],
      turnStartedAt: nextTurnAt,
      turnEndedSeq: expect.any(Number),
      activityCursor: { pos: expect.any(Number) },
    })
    expect(await sessionFacts({ session: 'settings-only' })).toMatchObject({ activity: 'finished' })
    expect(await sessionFacts({ session: 'legacy-clock' })).toMatchObject({ activity: 'finished' })
    const recovered = await sessionFacts({ session: 'outside-1' })
    expect(recovered.activityCursor.pos).toBe(Buffer.byteLength(readFileSync(base.transcript_path)))
    await pnyx.restart()
    expect(await sessionFacts({ session: 'outside-1' })).toMatchObject(recovered)
    await hook({
      event: 'SessionEnd',
      payload: base,
    })
    await until({
      what: 'the outside session to end',
      check: async () => (await sessionFacts({ session: 'outside-1' }))?.activity === 'ended',
    })
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
        '--no-start',
        '--title',
        'Speed up checkout',
        '--project',
        'checkout',
      ],
    ]) {
      expect((await operation({
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
        const envelopes = readdirSync(join(
          process.env.PNYX_HOME!,
          'hydras',
          'default',
          'spool',
        )).map(file => JSON.parse(readFileSync(
          join(
            process.env.PNYX_HOME!,
            'hydras',
            'default',
            'spool',
            file,
          ),
          'utf8',
        )))
        const envelope = envelopes.find(entry => entry.payload?.session_id === 'offline-1')
        expect(envelope.at).toMatch(/\.\d{3}Z$/)
      },
    })
    expect(offline).toMatchObject({
      status: 0,
      stdout: '',
      ended: true,
    })
    expect((await until({
      what: 'the spooled report to land',
      check: () => sessionFacts({ session: 'offline-1' }),
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

test(
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
      what: 'the session facts on its own Hydra',
      check: () => sessionFacts({
        session: 'named-1',
        hydra: hydra.id,
      }),
    })).title).toBe('Reported to a named Hydra')
  },
)

test(
  'with the server down a hook keeps its event in the spool of its Hydra, in boards/ for one not yet moved, and drops an unknown Hydra without making a folder',
  async () => {
    const home = join(
      process.env.TMPDIR!,
      'folders-home',
    )

    const spool = ({ dir }: { dir: string }) => {
      const path = join(
        home,
        dir,
        'spool',
      )

      return existsSync(path) ? readdirSync(path) : []
    }

    mkdirSync(
      join(
        home,
        'hydras',
        'h1',
      ),
      { recursive: true },
    )
    mkdirSync(
      join(
        home,
        'boards',
        'b1',
      ),
      { recursive: true },
    )

    for (const hydra of [
      'h1',
      'b1',
      'never-created',
    ]) {
      expect(await hook({
        event: 'UserPromptSubmit',
        payload: {
          session_id: `folders-${hydra}`,
          cwd: join(
            process.env.TMPDIR!,
            'folders',
          ),
          prompt: `Reported to ${hydra}`,
        },
        env: {
          ...process.env,
          PNYX_HOME: home,
          PNYX_HYDRA: hydra,
        },
      })).toMatchObject({
        status: 0,
        stdout: '',
      })
    }

    expect(spool({ dir: 'hydras/h1' })).toHaveLength(1)
    expect(spool({ dir: 'boards/b1' })).toHaveLength(1)
    expect(existsSync(join(
      home,
      'hydras',
      'b1',
    ))).toBe(false)

    for (const dir of [
      'hydras/never-created',
      'boards/never-created',
    ]) {
      expect(existsSync(join(
        home,
        dir,
      ))).toBe(false)
    }
  },
)

test(
  'subagent hooks keep session facts and wake Hydra for a prompt on the attached task',
  async () => {
    const hydra = await pnyx.hydra()
    const first = pnyx.claude.plan({
      hydra: hydra.id,
      text: 'Watch hook questions',
      hold: true,
    })
    const supervisor = await hydra.chat({ text: 'Watch hook questions' })
    const cwd = hydra.folder({ name: 'outside-agent' })
    await hydra.owner({
      args: [
        'task',
        'create',
        '--no-start',
        '--key',
        'attached',
        '--title',
        'Assigned outside work',
      ],
    })
    const assigned = await hydra.task({ key: 'attached' })
    const env = {
      ...process.env,
      PNYX_HYDRA: hydra.id,
      PNYX_TASK: assigned.id,
    }
    const base = {
      session_id: 'root-agent',
      cwd,
    }
    await hook({
      event: 'UserPromptSubmit',
      payload: {
        ...base,
        prompt: 'Inspect the package',
      },
      env,
    })
    await until({
      what: 'outside root session',
      check: () => sessionFacts({
        session: 'root-agent',
        hydra: hydra.id,
      }),
    })
    const child = {
      ...base,
      agent_id: 'child-agent',
      agent_type: 'Explore',
    }
    await hook({
      event: 'SubagentStart',
      payload: child,
      env,
    })
    await until({
      what: 'subagent session without a task card',
      check: async () => {
        const shown = await hydra.owner({
          args: [
            'task',
            'sessions',
            '--full',
          ],
        })

        return shown.sessions.some((session: { agent: { agentId?: string } }) => session.agent.agentId === 'child-agent')
      },
    })
    expect((await hydra.owner({
      args: [
        'task',
        'list',
      ],
    })).tasks).toHaveLength(1)
    const settingsOnly = await hydra.owner({
      args: [
        'push',
        '--key',
        assigned.id,
        '--actor',
        'pnyx',
        '--file',
        '-',
      ],
      input: JSON.stringify({
        agent: {
          provider: 'claude',
          sessionId: 'root-agent',
          agentId: 'child-agent',
        },
        settings: { model: 'test-model' },
      }),
    })
    await hook({
      event: 'PermissionRequest',
      payload: {
        ...child,
        tool_name: 'Bash',
        tool_input: { command: 'inspect-package' },
      },
      env,
    })
    await until({
      what: 'child prompt projected to the task',
      check: async () => (await hydra.task({ key: 'attached' })).status === 'needs you',
    })
    const childFacts = await hydra.owner({
      args: [
        'task',
        'sessions',
        '--full',
      ],
    })
    const childSession = childFacts.sessions.find((session: { agent: { agentId?: string } }) =>
      session.agent.agentId === 'child-agent')
    await hydra.owner({
      args: [
        'push',
        '--key',
        assigned.id,
        '--file',
        '-',
      ],
      input: JSON.stringify({
        agent: childSession.agent,
        activity: 'ended',
        attention: [],
        source: {
          adapter: 'transcript',
          instanceId: 'recovered',
          objectId: 'child-agent',
          observedAt: '2025-01-01T00:00:00Z',
        },
      }),
    })
    expect((await hydra.task({ key: 'attached' })).status).toBe('needs you')
    const changes = await hydra.owner({
      args: [
        'hydra',
        'check',
        '--after',
        '0',
      ],
    })
    expect.soft(changes.changes).toContainEqual(expect.objectContaining({
      type: 'session.observed',
      summary: expect.stringContaining('inspect-package'),
    }))
    const stateAfterQuestion = loadHydra({ hydraId: hydra.id }).state
    const settingsEvent = readChanges({
      hydraId: hydra.id,
      seqs: [settingsOnly.event.seq],
    })[0]!
    expect(eventReasons({
      state: stateAfterQuestion,
      event: settingsEvent,
    })).toEqual([])
    const questionEvent = readChanges({
      hydraId: hydra.id,
      after: settingsOnly.event.seq,
    })
      .find(event => event.type === 'session.observed'
        && 'fields' in event.data && event.data.fields.attention?.some(item => item.text?.includes('inspect-package')))!
    expect(eventReasons({
      state: stateAfterQuestion,
      event: questionEvent,
    })).toContainEqual(
      expect.objectContaining({
        kind: 'asked',
        detail: expect.stringContaining('inspect-package'),
      }),
    )
    first.release()
    await until({
      what: 'Hydra to hear the native question',
      check: () => supervisor.received.some(text => text.includes('asked:') && text.includes('inspect-package')),
    })
    const history = await hydra.owner({
      args: [
        'task',
        'history',
        'attached',
        '--full',
      ],
    })
    expect(history.events).not.toContainEqual(expect.objectContaining({
      type: 'session.observed',
    }))
    await hook({
      event: 'SubagentStop',
      payload: child,
      env,
    })
    await until({
      what: 'finished subagent prompt to clear',
      check: async () => (await hydra.task({ key: 'attached' })).status === 'running',
    })
  },
)

test(
  'outside recovery resets rotated snapshots and ignores rebound transcript batches',
  async () => {
    const hydra = await pnyx.hydra()
    const folder = hydra.folder({ name: 'recovery-races' })
    const rotated = join(
      folder,
      'rotated.jsonl',
    )
    const rebound = join(
      folder,
      'rebound.jsonl',
    )
    const replacement = join(
      folder,
      'replacement.jsonl',
    )
    const timestamp = Date.now()
    const startedAt = new Date(timestamp).toISOString()
    const finishedAt = new Date(timestamp + 1).toISOString()
    const start = `${JSON.stringify({
      type: 'user',
      timestamp: startedAt,
      message: {
        role: 'user',
        content: 'Offline work',
      },
    })}\n`
    const finish = `${JSON.stringify({
      type: 'assistant',
      timestamp: finishedAt,
      message: {
        stop_reason: 'end_turn',
        content: [],
      },
    })}\n`
    const padding = `${JSON.stringify({
      type: 'padding',
      text: 'x'.repeat(1024),
    })}\n`

    for (const [
      sessionId,
      path,
    ] of [
        [
          'rotated-recovery',
          rotated,
        ],
        [
          'rebound-recovery',
          rebound,
        ],
      ]) {
      await hydra.owner({
        args: [
          'push',
          '--key',
          sessionId!,
          '--file',
          '-',
        ],
        input: JSON.stringify({
          agent: {
            provider: 'claude',
            sessionId,
            transcriptPath: path,
          },
        }),
      })
    }

    const nativeRead = transcriptReader.readTranscript
    let rotatedOnce = false
    let reboundReads = 0
    const spy = vi.spyOn(
      transcriptReader,
      'readTranscript',
    ).mockImplementation(({
      cursor,
      ...options
    }) => {
      const tail = nativeRead({
        cursor,
        ...options,
      })

      if (cursor.source === rotated && tail && !rotatedOnce) {
        rotatedOnce = true
        const next = `${rotated}.next`
        writeFileSync(
          next,
          start + padding.repeat(3000) + finish,
        )
        renameSync(
          next,
          rotated,
        )
      }

      if (cursor.source === rebound && tail) {
        reboundReads++
      }

      if (cursor.source === rebound && tail && reboundReads === 1 && cursor.pos === 0) {
        withWriter({
          hydraId: hydra.id,
          fn: ({ writer }) => {
            const session = writer.state.sessions!['claude:rebound-recovery']!
            applyDecision({
              writer,
              decision: decideSessionFacts({
                state: writer.state,
                session,
                fields: {
                  agent: {
                    ...session.agent,
                    transcriptPath: replacement,
                  },
                  activity: 'working',
                },
                meta: {
                  actor: 'pnyx',
                  at: startedAt,
                },
              }),
            })
          },
        })
      }

      return tail
    })
    onTestFinished(() => spy.mockRestore())
    await pnyx.restart({
      whileStopped: () => {
        writeFileSync(
          rotated,
          start + padding.repeat(2000),
        )
        writeFileSync(
          rebound,
          finish + padding.repeat(2000),
        )
        writeFileSync(
          replacement,
          start,
        )
      },
    })
    const sessions = (await hydra.owner({
      args: [
        'task',
        'sessions',
        '--full',
      ],
    })).sessions
    expect(rotatedOnce).toBe(true)
    expect(reboundReads).toBe(1)
    expect.soft(sessions).toContainEqual(expect.objectContaining({
      id: 'claude:rotated-recovery',
      activity: 'finished',
      activityCursor: expect.objectContaining({ pos: Buffer.byteLength(readFileSync(rotated)) }),
    }))
    const bound = sessions.find((session: { id: string }) => session.id === 'claude:rebound-recovery')
    expect(bound.agent.transcriptPath).toBe(replacement)
    expect.soft(bound.activity).toBe('working')
    expect.soft(bound.activityCursor?.source).not.toBe(rebound)
  },
)

test(
  'setup preserves a custom skill and reports how to install the shipped one',
  async () => {
    const home = mkdtempSync(join(
      tmpdir(),
      'pnyx-skill-conflict-',
    ))
    onTestFinished(() => rmSync(
      home,
      {
        recursive: true,
        force: true,
      },
    ))
    const env = {
      ...process.env,
      HOME: home,
      PNYX_HOME: join(
        home,
        '.pnyx',
      ),
    }
    const customSkill = join(
      home,
      '.agents',
      'skills',
      'pnyx-cli',
    )
    mkdirSync(
      customSkill,
      { recursive: true },
    )
    writeFileSync(
      join(
        customSkill,
        'SKILL.md',
      ),
      'Keep my local skill',
    )
    const installed = await operation({
      args: [
        'setup',
        'skills',
      ],
      env,
    })
    expect(
      installed.status,
      installed.stdout,
    ).toBe(0)
    expect(parsed(installed).notices).toContainEqual(expect.objectContaining({
      reason: expect.stringContaining(customSkill),
      clear: expect.stringContaining('pnyx setup skills'),
    }))
    expect(readFileSync(
      join(
        customSkill,
        'SKILL.md',
      ),
      'utf8',
    )).toBe('Keep my local skill')
    expect(existsSync(join(
      home,
      '.agents',
      'skills',
      'pnyx-report-progress',
      'SKILL.md',
    ))).toBe(true)
  },
)
