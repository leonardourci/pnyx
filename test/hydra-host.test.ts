import { project } from '../src/projects/cli.ts'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { WebSocket } from 'ws'
import { commands } from '../src/cli/commands.ts'
import { HYDRA_CARD, hydraEvent, wakesHydra } from '../src/core/hydra.ts'
import type { HydraEvent } from '../src/core/model.ts'
import { startTask } from '../src/cli/start.ts'
import { hydraCheck } from '../src/cli/workers.ts'
import { sendReply } from '../src/cli/reply.ts'
import { fakeDispatch } from './dispatch-fixture.ts'
import { loadHydra, readEvents, withWriter } from '../src/store/hydra-store.ts'
import { taskMention } from '../src/mentions/mentions.ts'
import { startServer } from '../src/server/server.ts'
import { askHost, localToken } from '../src/server/state.ts'
import { readThread } from '../src/thread/read.ts'
import { hydraSdk } from './hydra-host-fixture.ts'
import { fakeCodex } from './codex-fixture.ts'
import { configPath, writeConfig } from '../src/dispatch/config.ts'

// Keeps the default-login fallback away from the real harness logins.
const noLogin = join(
  mkdtempSync(join(
    tmpdir(),
    'pnyx-no-login-',
  )),
  'missing',
)
process.env.CLAUDE_CONFIG_DIR = join(
  noLogin,
  'claude',
)
process.env.CODEX_HOME = join(
  noLogin,
  'codex',
)

async function until({ check }: { check(): boolean }) {
  for (let i = 0; i < 200; i++) {
    if (check()) {
      return
    }

    await new Promise(resolve => setTimeout(
      resolve,
      10,
    ))
  }

  assert.fail('Hydra did not finish its turn')
}

test(
  'Hydra starts in its own folder, replies, resumes after restart and deduplicates sends',
  async () => {
    const home = mkdtempSync(join(
      tmpdir(),
      'pnyx-hydra-host-',
    ))
    process.env.PNYX_HOME = home
    process.env.CLAUDE_CONFIG_DIR = join(
      home,
      'claude',
    )
    process.env.PNYX_SEMANTIC = 'off'
    commands.hydra([
      'create',
      'existing',
      '--hydra',
      'existing',
    ])
    const projectPath = join(
      home,
      'project',
    )
    mkdirSync(projectPath)
    writeFileSync(
      join(
        projectPath,
        'AGENTS.md',
      ),
      'Use project conventions.',
    )
    await project([
      'add',
      projectPath,
      '--hydra',
      'existing',
    ])
    const memory = await project([
      'memory',
      'list',
      '--project',
      projectPath,
      '--hydra',
      'existing',
    ])
    await project([
      'memory',
      'set',
      '--project',
      projectPath,
      '--hydra',
      'existing',
      '--key',
      'profile',
      '--text',
      'Project validation: pnpm test.',
      '--sources',
      String(memory.fingerprint),
    ])
    await project([
      'memory',
      'set',
      '--project',
      projectPath,
      '--hydra',
      'existing',
      '--key',
      'preferences',
      '--text',
      'Prefer small project PRs.',
    ])
    commands.owner([
      'memory',
      'set',
      '--key',
      'preferences',
      '--text',
      'Hydra owner preference.',
    ])
    const sdk = hydraSdk()
    let server = await startServer({
      hydraId: 'existing',
      query: sdk.query,
    })
    const state = () => loadHydra({ hydraId: 'existing' }).state
    const send = ({
      text,
      id,
    }: {
      text: string
      id: string
    }) => commands.hydra([
      'send',
      '--text',
      text,
      '--event-id',
      id,
      '--hydra',
      'existing',
    ])

    try {
      await send({
        text: 'Hello Hydra',
        id: 'hello',
      })
      await until({ check: () => state().cards[HYDRA_CARD]?.sessionActivity === 'finished' })
      const agent = state().cards[HYDRA_CARD]!.agent!
      assert.equal(
        agent.host,
        'pnyx',
      )
      assert.equal(
        agent.cwd,
        join(
          home,
          'hydras',
          'existing',
          'agent',
        ),
      )
      assert.equal(
        readFileSync(
          join(
            agent.cwd!,
            'CLAUDE.md',
          ),
          'utf8',
        ),
        '@AGENTS.md\n',
      )
      assert.match(
        readFileSync(
          join(
            agent.cwd!,
            'AGENTS.md',
          ),
          'utf8',
        ),
        /^# Hydra\n[\s\S]*## Load before/,
      )
      assert.match(
        readFileSync(
          join(
            agent.cwd!,
            '.claude/skills/inscribe/SKILL.md',
          ),
          'utf8',
        ),
        /^---\nname: inscribe/,
      )
      assert.ok(!existsSync(join(
        agent.cwd!,
        '.agents/skills/pnyx-hydra',
      )))
      type SessionStart = () => Promise<{
        hookSpecificOutput: { additionalContext: string }
      }>
      const hooks = sdk.calls[0]!.options.hooks!.SessionStart![0]!.hooks
      const hook = hooks[0] as unknown as SessionStart
      const started = await hook()
      assert.match(
        started.hookSpecificOutput.additionalContext,
        /^<pnyx-digest hydra="existing" through="\d+">[\s\S]*Owner preferences/,
      )
      assert.match(
        started.hookSpecificOutput.additionalContext,
        /profile: current/,
      )
      assert.match(
        sdk.calls[0]!.raw[0]!,
        /Projects \(load memory on demand[\s\S]*profile: current/,
      )
      assert.match(
        sdk.calls[0]!.raw[0]!,
        /Hydra owner preference/,
      )
      writeFileSync(
        join(
          projectPath,
          'AGENTS.md',
        ),
        'Changed project conventions.',
      )
      await project([
        'memory',
        'set',
        '--project',
        projectPath,
        '--hydra',
        'existing',
        '--key',
        'preferences',
        '--text',
        'Prefer separate project commits.',
      ])
      assert.doesNotMatch(
        sdk.calls[0]!.raw[0]!,
        /Project validation: pnpm test|Prefer small project PRs/,
      )
      const compacted = await hook()
      assert.match(
        compacted.hookSpecificOutput.additionalContext,
        /profile: out of date/,
      )
      assert.doesNotMatch(
        compacted.hookSpecificOutput.additionalContext,
        /Prefer separate project commits/,
      )
      assert.deepEqual(
        (await project([
          'show',
          projectPath,
          '--hydra',
          'existing',
        ])).memory,
        {
          profile: 'Project validation: pnpm test.',
          preferences: 'Prefer separate project commits.',
        },
      )
      assert.equal(
        sdk.calls[0]!.options.hooks!.SessionStart![0]!.matcher,
        'compact',
      )
      assert.match(
        sdk.calls[0]!.raw[0]!,
        /^<pnyx-digest hydra="existing"[\s\S]*<\/pnyx-digest>\n\nHello Hydra$/,
      )
      assert.match(
        JSON.stringify(sdk.calls[0]!.options.systemPrompt),
        /You are Hydra.*existing/,
      )
      assert.ok(readThread({
        hydraId: 'existing',
        state: state(),
        card: state().cards[HYDRA_CARD]!,
        homes: [],
      }).entries.some(e => e.role === 'assistant' && e.text.includes('Hello Hydra')))
      await send({
        text: 'Hello Hydra',
        id: 'hello',
      })
      assert.equal(
        sdk.calls[0]!.messages.length,
        1,
      )
      await send({
        text: 'Continue',
        id: 'next',
      })
      await until({ check: () => sdk.calls[0]?.messages.length === 2 && state().cards[HYDRA_CARD]?.sessionActivity === 'finished' })
      await server.close()
      server = await startServer({
        hydraId: 'existing',
        query: sdk.query,
      })
      await send({
        text: 'After restart',
        id: 'restart',
      })
      await until({ check: () => sdk.calls.length === 2 && state().cards[HYDRA_CARD]?.sessionActivity === 'finished' })
      assert.equal(
        sdk.calls[1]!.options.resume,
        agent.sessionId,
      )
      assert.equal(
        state().config?.hydra.session,
        `claude-code:${agent.sessionId}`,
      )
    } finally {
      await server.close(); rmSync(
        home,
        {
          recursive: true,
          force: true,
        },
      )
    }
  },
)

test(
  'Hydra hosts Codex and resumes its thread after restart',
  async () => {
    const home = mkdtempSync(join(
      tmpdir(),
      'pnyx-hydra-codex-',
    ))
    process.env.PNYX_HOME = home
    process.env.PNYX_SEMANTIC = 'off'
    commands.hydra([
      'create',
      'lab',
    ])
    writeConfig({
      path: configPath({ hydraId: 'lab' }),
      value: {
        default: [
          {
            harness: 'codex',
            model: 'gpt-6-luna',
          },
        ],
      },
    })
    const codex = fakeCodex({ root: home })
    let server = await startServer({
      hydraId: 'lab',
      spawnCodex: codex.spawnCodex,
    })
    const state = () => loadHydra({ hydraId: 'lab' }).state

    try {
      await commands.hydra([
        'send',
        '--hydra',
        'lab',
        '--text',
        'Hello Codex',
      ])
      await until({ check: () => state().cards[HYDRA_CARD]?.sessionActivity === 'finished' })
      const session = state().config!.hydra.session
      assert.ok(codex.messages().some(m => m.method === 'thread/start'))
      await server.close()
      server = await startServer({
        hydraId: 'lab',
        spawnCodex: codex.spawnCodex,
      })
      await commands.hydra([
        'send',
        '--hydra',
        'lab',
        '--text',
        'Continue Codex',
      ])
      await until({ check: () => codex.messages().some(m => m.method === 'thread/resume') && state().cards[HYDRA_CARD]?.sessionActivity === 'finished' })
      assert.equal(
        state().config!.hydra.session,
        session,
      )
      assert.ok(codex.messages().some(m => m.method === 'thread/resume'))
      assert.match(
        String(codex.messages().find(m => m.method === 'thread/start')?.params?.developerInstructions),
        /You are Hydra/,
      )
      // The digest leads the first turn of each opened thread and the turn after a compaction.
      const inputs = () => codex.messages().filter(m => m.method === 'turn/start')
        .map(m => (m.params!.input as { text: string }[])[0]!.text)
      assert.match(
        inputs()[0]!,
        /^<pnyx-digest hydra="lab"[\s\S]*<\/pnyx-digest>\n\nHello Codex$/,
      )
      assert.match(
        inputs()[1]!,
        /^<pnyx-digest hydra="lab"[\s\S]*\n\nContinue Codex$/,
      )
      await commands.hydra([
        'send',
        '--hydra',
        'lab',
        '--text',
        'COMPACT',
      ])
      await until({ check: () => inputs().length === 3 && state().cards[HYDRA_CARD]?.sessionActivity === 'finished' })
      assert.equal(
        inputs()[2],
        'COMPACT',
      )
      await commands.hydra([
        'send',
        '--hydra',
        'lab',
        '--text',
        'After compaction',
      ])
      await until({ check: () => inputs().length === 4 && state().cards[HYDRA_CARD]?.sessionActivity === 'finished' })
      assert.match(
        inputs()[3]!,
        /^<pnyx-digest hydra="lab"[\s\S]*\n\nAfter compaction$/,
      )
      await commands.hydra([
        'send',
        '--hydra',
        'lab',
        '--text',
        'ALLOW',
      ])
      await until({ check: () => state().cards[HYDRA_CARD]?.permissions?.some(p => p.status === 'pending') ?? false })
      const request = state().cards[HYDRA_CARD]!.permissions!.find(p => p.status === 'pending')!
      await commands.task([
        'permission',
        HYDRA_CARD,
        request.id,
        'allow',
        '--hydra',
        'lab',
      ])
      await until({ check: () => state().cards[HYDRA_CARD]?.sessionActivity === 'finished' })
      assert.equal(
        state().cards[HYDRA_CARD]!.permissions!.find(p => p.id === request.id)?.status,
        'allow',
      )
    } finally {
      await server.close(); rmSync(
        home,
        {
          recursive: true,
          force: true,
        },
      )
    }
  },
)

test(
  'Hydra exposes provider failures and Firstmate Hydras never start a hosted agent',
  async () => {
    const home = mkdtempSync(join(
      tmpdir(),
      'pnyx-hydra-error-',
    ))
    process.env.PNYX_HOME = home
    process.env.CLAUDE_CONFIG_DIR = join(
      home,
      'claude',
    )
    process.env.PNYX_SEMANTIC = 'off'
    commands.hydra([
      'create',
      'lab',
    ])
    const sdk = hydraSdk(); sdk.control.fail = true
    const server = await startServer({
      hydraId: 'lab',
      query: sdk.query,
    })
    const state = () => loadHydra({ hydraId: 'lab' }).state

    try {
      await commands.hydra([
        'send',
        '--hydra',
        'lab',
        '--text',
        'Hello',
      ])
      await until({ check: () => state().cards[HYDRA_CARD]?.attention.some(a => a.kind === 'interrupted') ?? false })
      assert.match(
        state().cards[HYDRA_CARD]!.attention[0]!.text ?? '',
        /Harness login is missing/,
      )
      sdk.control.fail = false
      const session = state().cards[HYDRA_CARD]!.agent!.sessionId
      await commands.hydra([
        'send',
        '--hydra',
        'lab',
        '--text',
        'Retry after sign-in',
      ])
      await until({ check: () => sdk.calls[1]?.messages.length === 1 && state().cards[HYDRA_CARD]?.sessionActivity === 'finished' })
      assert.equal(
        sdk.calls[1]!.options.resume,
        undefined,
      )
      assert.equal(
        sdk.calls[1]!.options.sessionId,
        session,
      )
      assert.ok(!state().cards[HYDRA_CARD]!.attention.some(a => a.kind === 'interrupted'))
      commands.hydra([
        'set',
        '--hydra',
        'lab',
        '--firstmate',
        join(
          home,
          'firstmate',
        ),
      ])
      await commands.hydra([
        'send',
        '--hydra',
        'lab',
        '--text',
        'Firstmate message',
      ])
      assert.equal(
        sdk.calls.length,
        2,
      )
      assert.equal(
        state().hydraMessages?.at(-1)?.text,
        'Firstmate message',
      )
    } finally {
      await server.close(); rmSync(
        home,
        {
          recursive: true,
          force: true,
        },
      )
    }
  },
)

test(
  'messages queue during a running Hydra turn without blocking delivery',
  async () => {
    const home = mkdtempSync(join(
      tmpdir(),
      'pnyx-hydra-queue-',
    ))
    process.env.PNYX_HOME = home
    process.env.CLAUDE_CONFIG_DIR = join(
      home,
      'claude',
    )
    process.env.PNYX_SEMANTIC = 'off'
    commands.hydra([
      'create',
      'lab',
    ])
    const sdk = hydraSdk(); sdk.control.hold = true
    const server = await startServer({
      hydraId: 'lab',
      query: sdk.query,
    })

    try {
      await commands.hydra([
        'send',
        '--hydra',
        'lab',
        '--text',
        'First',
      ])
      await until({ check: () => sdk.calls[0]?.messages.length === 1 })
      await commands.hydra([
        'send',
        '--hydra',
        'lab',
        '--text',
        'Second',
        '--event-id',
        'second',
      ])
      await commands.hydra([
        'send',
        '--hydra',
        'lab',
        '--text',
        'Second',
        '--event-id',
        'second',
      ])
      assert.deepEqual(
        sdk.calls[0]?.messages,
        ['First'],
      )
      sdk.release()
      await until({ check: () => sdk.calls[0]?.messages.length === 2 })
      assert.deepEqual(
        sdk.calls[0]?.messages,
        [
          'First',
          'Second',
        ],
      )
    } finally {
      sdk.release(); await server.close(); rmSync(
        home,
        {
          recursive: true,
          force: true,
        },
      )
    }
  },
)

test(
  'a Hydra reply paragraph that starts with a task chip lands on that task with the message it answered',
  async () => {
    const home = mkdtempSync(join(
      tmpdir(),
      'pnyx-hydra-tag-',
    ))
    process.env.PNYX_HOME = home
    process.env.CLAUDE_CONFIG_DIR = join(
      home,
      'claude',
    )
    process.env.PNYX_SEMANTIC = 'off'
    commands.hydra([
      'create',
      'lab',
    ])

    for (const key of [
      'quick',
      'other',
    ]) {
      commands.task([
        'create',
        '--key',
        key,
        '--title',
        `Task ${key}`,
        '--hydra',
        'lab',
      ])
    }

    const state = () => loadHydra({ hydraId: 'lab' }).state
    const quick = state().keys.quick!
    const sdk = hydraSdk()
    sdk.control.stream = true
    sdk.control.reply = [
      'Here is where things stand.',
      `${taskMention({
        id: quick,
        title: 'Task quick',
      })} Quick Add gets its own feature folder.`,
      `Later, ${taskMention({
        id: state().keys.other!,
        title: 'Task other',
      })} only links.`,
    ].join('\n\n')
    const server = await startServer({
      hydraId: 'lab',
      query: sdk.query,
    })
    const notes = ({ card }: { card: string }) => readEvents({ hydraId: 'lab' })
      .flatMap(event => event.type === 'card.noted' && event.cardId === card ? [
        [
          event.data.source,
          event.data.text,
        ],
      ] : [])

    try {
      await commands.hydra([
        'send',
        '--hydra',
        'lab',
        '--text',
        'Is quick add its own page?',
        '--event-id',
        'ask-1',
      ])
      await until({ check: () => notes({ card: quick }).length === 2 })
      assert.deepEqual(
        notes({ card: quick }),
        [
          [
            'hydra',
            'Quick Add gets its own feature folder.',
          ],
          [
            'owner',
            'Is quick add its own page?',
          ],
        ],
      )
      assert.deepEqual(
        notes({ card: state().keys.other! }),
        [],
      )
    } finally {
      await server.close(); rmSync(
        home,
        {
          recursive: true,
          force: true,
        },
      )
    }
  },
)

test(
  'each tagged reply pairs with the message its turn answered, and only the owner’s chat becomes an ask',
  async () => {
    const home = mkdtempSync(join(
      tmpdir(),
      'pnyx-hydra-tag-turns-',
    ))
    process.env.PNYX_HOME = home
    process.env.CLAUDE_CONFIG_DIR = join(
      home,
      'claude',
    )
    process.env.PNYX_SEMANTIC = 'off'
    commands.hydra([
      'create',
      'lab',
    ])
    commands.task([
      'create',
      '--key',
      'quick',
      '--title',
      'Task quick',
      '--hydra',
      'lab',
    ])
    const state = () => loadHydra({ hydraId: 'lab' }).state
    const quick = state().keys.quick!
    const sdk = hydraSdk()
    sdk.control.stream = true
    sdk.control.hold = true
    sdk.control.reply = `${taskMention({
      id: quick,
      title: 'Task quick',
    })} Noted.`
    const server = await startServer({
      hydraId: 'lab',
      query: sdk.query,
    })
    const notes = ({ source }: { source: string }) => readEvents({ hydraId: 'lab' })
      .flatMap(event => event.type === 'card.noted' && event.cardId === quick && event.data.source === source ? [event.data.text] : [])
    const send = ({ args }: { args: string[] }) => commands.hydra([
      'send',
      '--hydra',
      'lab',
      ...args,
    ])

    try {
      await send({
        args: [
          '--text',
          'First',
        ],
      })
      await until({ check: () => sdk.calls[0]?.messages.length === 1 })

      for (const args of [
        [
          '--text',
          'Second',
        ],
        [
          '--task',
          quick,
          '--text',
          'A worker question',
          '--actor',
          `worker:${quick}`,
        ],
        [
          '--task',
          quick,
          '--text',
          'Already on the task',
        ],
      ]) {
        await send({ args })
      }

      sdk.control.hold = false
      sdk.release()
      await until({ check: () => notes({ source: 'hydra' }).length === 4 })
      assert.deepEqual(
        notes({ source: 'owner' }),
        [
          'First',
          'Second',
        ],
      )
    } finally {
      sdk.release(); await server.close(); rmSync(
        home,
        {
          recursive: true,
          force: true,
        },
      )
    }
  },
)

test(
  'changing Hydra harness preserves the earlier conversation',
  async () => {
    const home = mkdtempSync(join(
      tmpdir(),
      'pnyx-hydra-switch-',
    ))
    process.env.PNYX_HOME = home
    process.env.CLAUDE_CONFIG_DIR = join(
      home,
      'claude',
    )
    process.env.PNYX_SEMANTIC = 'off'
    commands.hydra([
      'create',
      'lab',
    ])
    const sdk = hydraSdk(), codex = fakeCodex({ root: home })
    const server = await startServer({
      hydraId: 'lab',
      query: sdk.query,
      spawnCodex: codex.spawnCodex,
    })
    const state = () => loadHydra({ hydraId: 'lab' }).state

    try {
      await commands.hydra([
        'send',
        '--hydra',
        'lab',
        '--text',
        'Earlier message',
      ])
      await until({ check: () => state().cards[HYDRA_CARD]?.sessionActivity === 'finished' })
      withWriter({
        hydraId: 'lab',
        fn: ({ writer }) => {
          const config = writer.state.config!
          const decision = hydraEvent({
            state: writer.state,
            meta: {
              at: new Date().toISOString(),
              actor: 'test',
            },
            cardId: HYDRA_CARD,
            change: {
              type: 'board.configured',
              data: {
                ...config,
                hydra: {
                  ...config.hydra,
                  agent: { harness: 'codex' },
                },
              },
            },
          })
          assert.ok('event' in decision); writer.append({ event: decision.event })
        },
      })
      await commands.hydra([
        'send',
        '--hydra',
        'lab',
        '--text',
        'Later message',
      ])
      await until({ check: () => state().cards[HYDRA_CARD]?.agent?.provider === 'codex' && state().cards[HYDRA_CARD]?.sessionActivity === 'finished' })
      const thread = readThread({
        hydraId: 'lab',
        state: state(),
        card: state().cards[HYDRA_CARD]!,
        homes: [],
      })
      assert.ok(thread.entries.some(e => e.role === 'assistant' && e.text === 'Hydra: Earlier message'))
      assert.ok(thread.entries.some(e => e.role === 'assistant' && e.text === 'Codex: Later message'))
    } finally {
      await server.close(); rmSync(
        home,
        {
          recursive: true,
          force: true,
        },
      )
    }
  },
)

test(
  'queued Hydra messages retain the settings selected when sent',
  async () => {
    const home = mkdtempSync(join(
      tmpdir(),
      'pnyx-hydra-settings-',
    ))
    process.env.PNYX_HOME = home
    process.env.CLAUDE_CONFIG_DIR = join(
      home,
      'claude',
    )
    process.env.PNYX_SEMANTIC = 'off'
    commands.hydra([
      'create',
      'lab',
    ])
    const sdk = hydraSdk(); sdk.control.hold = true
    const server = await startServer({
      hydraId: 'lab',
      query: sdk.query,
    })
    const choose = ({ model }: { model: string }) => withWriter({
      hydraId: 'lab',
      fn: ({ writer }) => {
        const config = writer.state.config!
        const decision = hydraEvent({
          state: writer.state,
          meta: {
            at: new Date().toISOString(),
            actor: 'test',
          },
          cardId: HYDRA_CARD,
          change: {
            type: 'board.configured',
            data: {
              ...config,
              hydra: {
                ...config.hydra,
                agent: {
                  harness: 'claude',
                  model,
                },
              },
            },
          },
        })
        assert.ok('event' in decision); writer.append({ event: decision.event })
      },
    })

    try {
      choose({ model: 'sonnet' })
      await commands.hydra([
        'send',
        '--hydra',
        'lab',
        '--text',
        'First',
      ])
      await until({ check: () => sdk.calls[0]?.messages.length === 1 })
      await commands.hydra([
        'send',
        '--hydra',
        'lab',
        '--text',
        'Second',
      ])
      choose({ model: 'opus' })
      await commands.hydra([
        'send',
        '--hydra',
        'lab',
        '--text',
        'Third',
      ])
      choose({ model: 'haiku' })
      sdk.release()
      await until({ check: () => sdk.calls.some(c => c.messages.includes('Third')) })
      assert.equal(
        sdk.calls.find(c => c.messages.includes('Second'))?.options.model,
        'sonnet',
      )
      assert.equal(
        sdk.calls.find(c => c.messages.includes('Third'))?.options.model,
        'opus',
      )
    } finally {
      sdk.release(); await server.close(); rmSync(
        home,
        {
          recursive: true,
          force: true,
        },
      )
    }
  },
)

test(
  'a running Hydra takes bypass permissions from its composer during the turn and keeps it',
  async () => {
    const home = mkdtempSync(join(
      tmpdir(),
      'pnyx-hydra-mode-',
    ))
    process.env.PNYX_HOME = home
    process.env.CLAUDE_CONFIG_DIR = join(
      home,
      'claude',
    )
    process.env.PNYX_SEMANTIC = 'off'
    commands.hydra([
      'create',
      'lab',
    ])
    const sdk = hydraSdk(); sdk.control.hold = true
    const server = await startServer({
      hydraId: 'lab',
      query: sdk.query,
    })
    const state = () => loadHydra({ hydraId: 'lab' }).state
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/hydra/lab/ws?token=${localToken()}`)

    const choose = ({ mode }: { mode: string }) => new Promise<void>((
      resolve,
      reject,
    ) => {
      const id = `agent-${mode}`

      // eslint-disable-next-line pnyx/object-params -- ws owns this listener signature.
      const receipt = (data: unknown) => {
        const message = JSON.parse(String(data)) as {
          id?: string
          type: string
        }

        if (message.id === id) {
          ws.off(
            'message',
            receipt,
          )
          void (message.type === 'receipt' ? resolve() : reject(new Error(String(data))))
        }
      }

      ws.on(
        'message',
        receipt,
      )
      ws.send(JSON.stringify({
        type: 'command',
        id,
        name: 'hydra-agent',
        args: [
          JSON.stringify({
            harness: 'claude',
            model: 'sonnet',
            effort: 'high',
            mode,
          }),
        ],
      }))
    })

    try {
      await new Promise(resolve => ws.once(
        'open',
        resolve,
      ))
      await choose({ mode: 'default' })
      await commands.hydra([
        'send',
        '--hydra',
        'lab',
        '--text',
        'First',
      ])
      await until({ check: () => sdk.calls[0]?.messages.length === 1 })
      assert.equal(
        sdk.calls[0]!.options.permissionMode,
        'default',
      )
      assert.equal(
        sdk.calls[0]!.options.allowDangerouslySkipPermissions,
        true,
      )
      await choose({ mode: 'bypassPermissions' })
      await until({ check: () => sdk.sets.includes('mode bypassPermissions') })
      assert.deepEqual(
        sdk.sets,
        ['mode bypassPermissions'],
      )
      assert.equal(
        state().cards[HYDRA_CARD]?.settings?.mode,
        'bypassPermissions',
      )
      sdk.release()
      await until({ check: () => state().cards[HYDRA_CARD]?.sessionActivity === 'finished' })
      await commands.hydra([
        'send',
        '--hydra',
        'lab',
        '--text',
        'Second',
      ])
      await until({ check: () => sdk.calls.some(c => c.messages.includes('Second')) })
      assert.deepEqual(
        sdk.calls.map(c => c.messages),
        [
          [
            'First',
            'Second',
          ],
        ],
      )
    } finally {
      ws.close(); sdk.release(); await server.close(); rmSync(
        home,
        {
          recursive: true,
          force: true,
        },
      )
    }
  },
)

test(
  'a hosted Hydra wakes once for worker changes, never for its own, and after a restart',
  async () => {
    const home = realpathSync(mkdtempSync(join(
      tmpdir(),
      'pnyx-hydra-wake-',
    )))
    process.env.PNYX_HOME = join(
      home,
      'pnyx',
    )
    process.env.PNYX_SEMANTIC = 'off'
    fakeDispatch({ root: home })
    process.env.CLAUDE_CONFIG_DIR = join(
      home,
      'claude',
    )
    const folder = join(
      home,
      'work',
    )
    mkdirSync(folder)
    commands.hydra([
      'create',
      'lab',
    ])
    await commands.task([
      'create',
      '--title',
      'Fix add',
      '--key',
      'fix',
      '--folder',
      folder,
      '--hydra',
      'lab',
    ])
    writeFileSync(
      join(
        folder,
        'AGENTS.md',
      ),
      'Project wake conventions.',
    )
    await project([
      'add',
      folder,
      '--hydra',
      'lab',
    ])
    await project([
      'memory',
      'set',
      '--project',
      folder,
      '--hydra',
      'lab',
      '--key',
      'preferences',
      '--text',
      'Initial project preference.',
    ])
    const sdk = hydraSdk()
    let server = await startServer({
      hydraId: 'lab',
      query: sdk.query,
      wakeDelay: 300,
    })
    const state = () => loadHydra({ hydraId: 'lab' }).state
    const hydra = () => sdk.calls.filter(c => c.options.cwd !== folder).flatMap(c => c.messages)
    const wakes = () => hydra().filter(m => m.includes('<pnyx-wake>'))
    const declare = ({
      status,
      actor = 'cli',
    }: {
      status: string
      actor?: string
    }) =>
      commands.task([
        'status',
        'fix',
        status,
        '--note',
        status,
        '--actor',
        actor,
        '--reason',
        'testing',
        '--hydra',
        'lab',
      ])

    try {
      await commands.hydra([
        'send',
        '--hydra',
        'lab',
        '--text',
        'Watch the fix',
      ])
      await until({ check: () => state().cards[HYDRA_CARD]?.sessionActivity === 'finished' })
      assert.equal(
        sdk.calls[0]!.options.env?.PNYX_ACTOR,
        'hydra',
      )
      const before = state().seq

      // The worker's finished turn and its declarations share one check turn.
      await startTask({
        hydraId: 'lab',
        task: 'fix',
        meta: {
          at: new Date().toISOString(),
          actor: 'hydra',
          reason: 'start it',
          id: 'start-fix',
        },
      })
      await until({ check: () => state().cards[state().keys.fix!]?.sessionActivity === 'finished' })
      await project([
        'memory',
        'set',
        '--project',
        folder,
        '--hydra',
        'lab',
        '--key',
        'preferences',
        '--text',
        'Updated project preference.',
      ])
      declare({ status: 'working' })
      declare({ status: 'done' })
      await until({ check: () => wakes().length === 1 && state().cards[HYDRA_CARD]?.sessionActivity === 'finished' })
      // It starts just before the first change it covers.
      const first = Number(/hydra check --after (\d+) --hydra lab/.exec(wakes()[0]!)![1])
      assert.ok(first >= before)
      assert.match(
        wakes()[0]!,
        /<\/pnyx-wake>\n\nMemory changed; load owner memory/,
      )
      assert.doesNotMatch(
        sdk.calls[0]!.raw[0]!,
        /Initial project preference/,
      )
      assert.doesNotMatch(
        wakes()[0]!,
        /Updated project preference|<pnyx-digest|Owner preferences/,
      )
      declare({ status: 'paused' })
      await until({ check: () => wakes().length === 2 && state().cards[HYDRA_CARD]?.sessionActivity === 'finished' })
      assert.doesNotMatch(
        wakes()[1]!,
        /Memory changed|<pnyx-digest|Owner preferences/,
      )
      const through = state().seq

      // Hydra's own writes and turns never wake it.
      declare({
        status: 'working',
        actor: 'hydra',
      })
      await new Promise(resolve => setTimeout(
        resolve,
        1000,
      ))
      assert.equal(
        wakes().length,
        2,
      )

      // The wake prompt is not an owner message in Hydra's chat.
      const thread = readThread({
        hydraId: 'lab',
        state: state(),
        card: state().cards[HYDRA_CARD]!,
        homes: [],
      })
      assert.ok(!thread.entries.some(e => e.text.includes('pnyx-wake') || e.text.includes('hydra check --after')))

      // A change while the server is stopped wakes Hydra when it is back, after the last wake.
      await server.close()
      declare({ status: 'done' })
      server = await startServer({
        hydraId: 'lab',
        query: sdk.query,
        wakeDelay: 300,
      })
      await until({ check: () => wakes().length === 3 })
      const after = Number(/--after (\d+)/.exec(wakes()[2]!)![1])
      assert.ok(
        after > first && after < through,
        `${after} resumes after the first wake`,
      )

      // A change to owner memory alone is noted on the next wake.
      await until({ check: () => state().cards[HYDRA_CARD]?.sessionActivity === 'finished' })
      await commands.owner([
        'memory',
        'set',
        '--key',
        'learnings',
        '--text',
        'Releases ship on Fridays.',
      ])
      declare({ status: 'paused' })
      await until({ check: () => wakes().length === 4 })
      assert.match(
        wakes()[3]!,
        /<\/pnyx-wake>\n\nMemory changed; load owner memory/,
      )
      assert.doesNotMatch(
        wakes()[3]!,
        /Releases ship on Fridays/,
      )
    } finally {
      await server.close(); rmSync(
        home,
        {
          recursive: true,
          force: true,
        },
      )
    }
  },
)

test(
  'wakes come from new questions, pending permissions, finished turns and due reminders on tasks',
  async () => {
    const home = mkdtempSync(join(
      tmpdir(),
      'pnyx-hydra-wakes-',
    ))
    process.env.PNYX_HOME = home
    process.env.CLAUDE_CONFIG_DIR = join(
      home,
      'claude',
    )
    process.env.PNYX_SEMANTIC = 'off'
    commands.hydra([
      'create',
      'lab',
    ])
    await commands.task([
      'create',
      '--title',
      'Fix add',
      '--key',
      'fix',
      '--hydra',
      'lab',
    ])
    const id = loadHydra({ hydraId: 'lab' }).state.keys.fix!
    const event = ({
      change,
      actor = 'pnyx',
      cardId = id,
    }: {
      change: object
      actor?: string
      cardId?: string
    }) =>
      ({
        v: 1,
        seq: 999,
        id: 'e',
        at: new Date().toISOString(),
        actor,
        cardId,
        ...change,
      }) as HydraEvent
    const ask = {
      key: 'q',
      kind: 'question',
      blocking: true,
      text: 'Which schema?',
    }
    const pushed = ({
      data,
      actor,
    }: {
      data: object
      actor?: string
    }) =>
      event({
        change: {
          type: 'card.pushed',
          data: {
            key: 'fix',
            ...data,
          },
        },
        actor,
      })
    const permission = ({ status }: { status: string }) =>
      event({
        change: {
          type: 'task.permission',
          data: {
            id: 'p',
            session: 's',
            tool: 'Bash',
            input: {},
            status,
          },
        },
      })
    const due = event({
      change: {
        type: 'task.reminder-due',
        data: {
          reminder: 'r',
          column: 'needs_you',
          message: {},
        },
      },
    })
    let server: Awaited<ReturnType<typeof startServer>> | undefined

    try {
    // A Hydra the server does not run is never woken.
      assert.equal(
        wakesHydra({
          state: loadHydra({ hydraId: 'lab' }).state,
          event: due,
        }),
        false,
      )
      server = await startServer({
        hydraId: 'lab',
        query: hydraSdk().query,
      })
      await commands.hydra([
        'send',
        '--hydra',
        'lab',
        '--text',
        'Hello',
      ])
      await until({ check: () => loadHydra({ hydraId: 'lab' }).state.cards[HYDRA_CARD]?.sessionActivity === 'finished' })
      await server.close()
      server = undefined
      const state = loadHydra({ hydraId: 'lab' }).state
      const wakes = ({ e }: { e: HydraEvent }) => wakesHydra({
        state,
        event: e,
      })
      const asked = ({ before }: { before: object[] }) =>
        wakes({
          e: pushed({
            data: {
              attention: [ask],
              before: { attention: before },
            },
          }),
        })
      assert.equal(
        asked({ before: [] }),
        true,
      )
      assert.equal(
        asked({ before: [ask] }),
        false,
      )
      assert.equal(
        wakes({ e: pushed({ data: { attention: [ask] } }) }),
        false,
      )
      assert.equal(
        wakes({ e: permission({ status: 'pending' }) }),
        true,
      )
      assert.equal(
        wakes({ e: permission({ status: 'expired' }) }),
        false,
      )
      assert.equal(
        wakes({ e: due }),
        true,
      )
      assert.equal(
        wakes({
          e: event({
            change: {
              type: 'task.reminder-due',
              data: due.data,
            },
            actor: 'hydra',
          }),
        }),
        false,
      )
      assert.equal(
        wakes({
          e: event({
            change: {
              type: 'task.permission',
              data: permission({ status: 'pending' }).data,
            },
            cardId: HYDRA_CARD,
          }),
        }),
        false,
      )
      // A person's edit, such as continuing a session, is not a worker's finished turn.
      const finished = ({ actor }: { actor: string }) => pushed({
        data: {
          activity: 'finished',
          before: { activity: 'working' },
        },
        actor,
      })
      assert.equal(
        wakes({ e: finished({ actor: 'pnyx' }) }),
        true,
      )
      assert.equal(
        wakes({ e: finished({ actor: 'hook:claude' }) }),
        true,
      )
      assert.equal(
        wakes({ e: finished({ actor: 'cli' }) }),
        false,
      )
    } finally {
      await server?.close(); rmSync(
        home,
        {
          recursive: true,
          force: true,
        },
      )
    }
  },
)

test(
  'a busy Hydra gets one wake after its turn, and a failed wake waits for the owner',
  async () => {
    const home = mkdtempSync(join(
      tmpdir(),
      'pnyx-hydra-busy-',
    ))
    process.env.PNYX_HOME = home
    process.env.CLAUDE_CONFIG_DIR = join(
      home,
      'claude',
    )
    process.env.PNYX_SEMANTIC = 'off'
    commands.hydra([
      'create',
      'lab',
    ])
    await commands.task([
      'create',
      '--title',
      'Fix add',
      '--key',
      'fix',
      '--hydra',
      'lab',
    ])
    const sdk = hydraSdk()
    let server = await startServer({
      hydraId: 'lab',
      query: sdk.query,
      wakeDelay: 50,
    })
    const state = () => loadHydra({ hydraId: 'lab' }).state
    const wakes = () => sdk.calls.flatMap(c => c.messages).filter(m => m.includes('<pnyx-wake>'))
    const declare = ({ status }: { status: string }) => commands.task([
      'status',
      'fix',
      status,
      '--note',
      status,
      '--hydra',
      'lab',
    ])
    const settle = () => new Promise(resolve => setTimeout(
      resolve,
      300,
    ))

    try {
      await commands.hydra([
        'send',
        '--hydra',
        'lab',
        '--text',
        'Hello',
      ])
      await until({ check: () => state().cards[HYDRA_CARD]?.sessionActivity === 'finished' })

      // Changes during a held wake turn wait for it, then share one more wake.
      sdk.control.hold = true
      declare({ status: 'working' })
      await until({ check: () => wakes().length === 1 })
      const first = state().seq
      declare({ status: 'blocked' })
      declare({ status: 'working' })
      await settle()
      assert.equal(
        wakes().length,
        1,
      )
      sdk.release()
      await until({ check: () => wakes().length === 2 && state().cards[HYDRA_CARD]?.sessionActivity === 'finished' })
      assert.ok(Number(/--after (\d+)/.exec(wakes()[1]!)![1]) < first)

      // A wake whose turn fails leaves Hydra interrupted: later changes wait for the owner's
      // next message, and the wake after it starts where the last started wake ended.
      const started = () => Math.max(...Object.keys(state().eventIds)
        .flatMap(id => /^wake:(\d+):hosted$/.exec(id)?.[1] ?? [])
        .map(Number))
      await server.close()
      sdk.control.fail = true
      declare({ status: 'done' })
      server = await startServer({
        hydraId: 'lab',
        query: sdk.query,
        wakeDelay: 50,
      })
      await until({ check: () => state().cards[HYDRA_CARD]?.attention.some(a => a.kind === 'interrupted') ?? false })
      const calls = sdk.calls.length, through = started()
      declare({ status: 'working' })
      await settle()
      assert.equal(
        sdk.calls.length,
        calls,
      )
      sdk.control.fail = false
      await commands.hydra([
        'send',
        '--hydra',
        'lab',
        '--text',
        'Carry on',
      ])
      await until({ check: () => wakes().length === 3 })
      assert.match(
        wakes()[2]!,
        new RegExp(`--after ${through} `),
      )
    } finally {
      sdk.release(); await server.close(); rmSync(
        home,
        {
          recursive: true,
          force: true,
        },
      )
    }
  },
)

test(
  'a stalled request or a quiet working worker wakes Hydra once, and hydra check lists what waits',
  async () => {
    const home = realpathSync(mkdtempSync(join(
      tmpdir(),
      'pnyx-hydra-stall-',
    )))
    process.env.PNYX_HOME = join(
      home,
      'pnyx',
    )
    process.env.PNYX_SEMANTIC = 'off'
    fakeDispatch({ root: home })
    process.env.CLAUDE_CONFIG_DIR = join(
      home,
      'claude',
    )
    const folder = join(
      home,
      'work',
    )
    mkdirSync(folder)
    commands.hydra([
      'create',
      'lab',
    ])
    await commands.task([
      'create',
      '--title',
      'Fix add',
      '--key',
      'fix',
      '--folder',
      folder,
      '--hydra',
      'lab',
    ])
    const sdk = hydraSdk()
    const server = await startServer({
      hydraId: 'lab',
      query: sdk.query,
      wakeDelay: 50,
      stallDelay: 600,
    })
    const state = () => loadHydra({ hydraId: 'lab' }).state
    const task = () => state().cards[state().keys.fix!]!
    const stalls = () => sdk.calls.filter(c => c.options.cwd !== folder).flatMap(c => c.messages)
      .filter(m => m.startsWith('<pnyx-wake>Stalled'))
    const settled = () => state().cards[HYDRA_CARD]?.sessionActivity === 'finished'

    try {
      await commands.hydra([
        'send',
        '--hydra',
        'lab',
        '--text',
        'Watch the fix',
      ])
      await until({ check: settled })

      // The worker's request stays pending; its own wake comes first, the stall wake later.
      sdk.control.ask = true
      await startTask({
        hydraId: 'lab',
        task: 'fix',
        meta: {
          at: new Date().toISOString(),
          actor: 'hydra',
          reason: 'start it',
          id: 'start-fix',
        },
      })
      await until({ check: () => task().permissions?.some(p => p.status === 'pending') ?? false })
      sdk.control.ask = false
      const worker = sdk.calls.find(c => c.options.cwd === folder)!
      assert.equal(
        worker.options.env?.PNYX_ACTOR,
        `worker:${task().id}`,
      )
      const request = task().permissions![0]!
      assert.ok(request.at)

      const check = await hydraCheck({
        args: [
          'check',
          '--after',
          '0',
          '--hydra',
          'lab',
        ],
      }) as {
        requests: {
          id: string
          task: string
          tool: string
          command: string
        }[]
        changes: { actor: string }[]
        agents: {
          task: string
          quiet: string
          activity: string
        }[]
      }
      assert.deepEqual(
        check.requests.map(r => [
          r.id,
          r.task,
          r.tool,
          r.command,
        ]),
        [
          [
            request.id,
            task().id,
            'Bash',
            'ls',
          ],
        ],
      )
      assert.ok(check.changes.some(c => c.actor === 'owner (cli)'))
      assert.match(
        check.agents.find(a => a.task === task().id)!.quiet,
        /^\d+s$/,
      )

      for (let i = 0; i < 150 && !(stalls().length && settled()); i++) {
        await new Promise(resolve => setTimeout(
          resolve,
          10,
        ))
      }

      assert.equal(
        stalls().length,
        1,
      )
      assert.match(
        stalls()[0]!,
        /Bash on .* has waited \d+ s for an answer/,
      )
      await new Promise(resolve => setTimeout(
        resolve,
        900,
      ))
      assert.equal(
        stalls().length,
        1,
        'one wake per stalled request',
      )

      // Answered, the worker finishes; a later turn that goes quiet wakes Hydra again.
      await commands.task([
        'permission',
        'fix',
        request.id,
        'allow',
        '--hydra',
        'lab',
      ])
      await until({ check: () => task().sessionActivity === 'finished' })
      // Hydra's wake for that finished turn must not hold too.
      await new Promise(resolve => setTimeout(
        resolve,
        300,
      ))
      await until({ check: settled })
      sdk.control.hold = true
      await sendReply({
        hydraId: 'lab',
        request: {
          card: 'fix',
          text: 'Keep going',
          homes: [],
          actor: 'test',
        },
      })

      for (let i = 0; i < 150 && stalls().length < 2; i++) {
        await new Promise(resolve => setTimeout(
          resolve,
          10,
        ))
      }

      assert.match(
        stalls()[1] ?? '',
        /working with no sign of life/,
      )
      sdk.release()
    } finally {
      await server.close(); rmSync(
        home,
        {
          recursive: true,
          force: true,
        },
      )
    }
  },
)

test(
  'a cut Hydra turn resumes once with fresh memory and the unanswered message range',
  async () => {
    const home = mkdtempSync(join(
      tmpdir(),
      'pnyx-hydra-resume-',
    ))
    process.env.PNYX_HOME = home
    process.env.CLAUDE_CONFIG_DIR = join(
      home,
      'claude',
    )
    process.env.PNYX_SEMANTIC = 'off'
    commands.hydra([
      'create',
      'lab',
    ])
    const state = () => loadHydra({ hydraId: 'lab' }).state
    const first = hydraSdk()
    const second = hydraSdk()
    let server = await startServer({
      hydraId: 'lab',
      query: first.query,
    })

    try {
      await commands.hydra([
        'send',
        '--hydra',
        'lab',
        '--text',
        'Already answered',
      ])
      await until({ check: () => state().cards[HYDRA_CARD]?.sessionActivity === 'finished' })
      const after = state().seq
      const session = state().cards[HYDRA_CARD]!.agent!.sessionId
      first.control.hold = true
      first.control.leaveTurnUnfinishedOnClose = true
      await commands.hydra([
        'send',
        '--hydra',
        'lab',
        '--text',
        'I just merged the PR',
        '--event-id',
        'merged',
      ])
      await until({ check: () => first.calls[0]?.messages.length === 2 })
      await commands.hydra([
        'send',
        '--hydra',
        'lab',
        '--text',
        'Please finish the reply',
        '--event-id',
        'follow-up',
      ])
      await server.close()
      commands.owner([
        'memory',
        'set',
        '--key',
        'preferences',
        '--text',
        'New owner preference after shutdown',
      ])
      commands.hydra([
        'memory',
        'set',
        '--hydra',
        'lab',
        '--key',
        'context',
        '--text',
        'New Hydra memory after shutdown',
        '--event-id',
        'resume:unrelated:hosted',
      ])
      second.control.hold = true
      second.control.leaveTurnUnfinishedOnClose = true
      server = await startServer({
        hydraId: 'lab',
        query: second.query,
      })
      await until({ check: () => second.calls[0]?.messages.length === 1 })
      const prompt = second.calls[0]!.messages[0]!
      assert.match(
        prompt,
        /restart cut your last turn/,
      )
      assert.ok(prompt.includes(`messages seq ${state().eventIds.merged} to ${state().eventIds['follow-up']}`))
      assert.ok(prompt.includes(`hydra messages --after ${after} --hydra lab`))
      assert.ok(prompt.includes(`hydra check --after ${after} --hydra lab`))
      assert.equal(
        second.calls[0]!.options.resume,
        session,
      )
      const raw = second.calls[0]!.raw[0]!
      assert.match(
        raw,
        /^<pnyx-digest hydra="lab"/,
      )
      assert.match(
        raw,
        /New owner preference after shutdown/,
      )
      assert.match(
        raw,
        /New Hydra memory after shutdown/,
      )
      assert.equal(
        raw.match(/<pnyx-digest /g)?.length,
        1,
      )
      assert.ok(!state().cards[HYDRA_CARD]!.attention.some(attention => attention.kind === 'interrupted'))
      await server.close()

      const third = hydraSdk()
      server = await startServer({
        hydraId: 'lab',
        query: third.query,
        wakeDelay: 50,
      })
      await until({ check: () => state().cards[HYDRA_CARD]?.attention.some(attention => attention.kind === 'interrupted') ?? false })
      await new Promise(resolve => setTimeout(
        resolve,
        200,
      ))
      assert.equal(
        third.calls.length,
        0,
      )
      await commands.hydra([
        'send',
        '--hydra',
        'lab',
        '--text',
        'Continue after the second cut',
      ])
      await until({ check: () => state().cards[HYDRA_CARD]?.sessionActivity === 'finished' })
      assert.deepEqual(
        third.calls[0]!.messages,
        ['Continue after the second cut'],
      )
      assert.ok(!state().cards[HYDRA_CARD]!.attention.some(attention => attention.kind === 'interrupted'))
    } finally {
      await server.close()
      first.release()
      second.release()
      rmSync(
        home,
        {
          recursive: true,
          force: true,
        },
      )
    }
  },
)

test(
  'a cut Codex Hydra resumes its thread with current memory on startup',
  async () => {
    const home = mkdtempSync(join(
      tmpdir(),
      'pnyx-hydra-codex-resume-',
    ))
    process.env.PNYX_HOME = home
    process.env.CODEX_HOME = join(
      home,
      'codex',
    )
    process.env.PNYX_SEMANTIC = 'off'
    commands.hydra([
      'create',
      'lab',
    ])
    writeConfig({
      path: configPath({ hydraId: 'lab' }),
      value: {
        default: [
          {
            harness: 'codex',
            model: 'gpt-6-luna',
          },
        ],
      },
    })
    const codex = fakeCodex({ root: home })
    const state = () => loadHydra({ hydraId: 'lab' }).state
    let server = await startServer({
      hydraId: 'lab',
      spawnCodex: codex.spawnCodex,
    })

    try {
      await commands.hydra([
        'send',
        '--hydra',
        'lab',
        '--text',
        'HOLD',
        '--event-id',
        'cut-codex',
      ])
      await until({ check: () => codex.messages().some(rpcMessage => rpcMessage.method === 'turn/start') })
      const session = state().cards[HYDRA_CARD]!.agent!.sessionId
      await server.close()
      commands.owner([
        'memory',
        'set',
        '--key',
        'preferences',
        '--text',
        'Current Codex owner preference',
      ])
      commands.hydra([
        'memory',
        'set',
        '--hydra',
        'lab',
        '--key',
        'context',
        '--text',
        'Current Codex Hydra memory',
      ])
      server = await startServer({
        hydraId: 'lab',
        spawnCodex: codex.spawnCodex,
      })
      await until({ check: () => state().cards[HYDRA_CARD]?.sessionActivity === 'finished' })
      assert.ok(codex.messages().some(rpcMessage => rpcMessage.method === 'thread/resume' && rpcMessage.params?.threadId === session))
      const turns = codex.messages().filter(rpcMessage => rpcMessage.method === 'turn/start')
      assert.equal(
        turns.length,
        2,
      )
      const prompt = JSON.stringify(turns[1]!.params?.input)
      assert.match(
        prompt,
        /<pnyx-digest hydra=/,
      )
      assert.match(
        prompt,
        /Current Codex owner preference/,
      )
      assert.match(
        prompt,
        /Current Codex Hydra memory/,
      )
      assert.match(
        prompt,
        /restart cut your last turn/,
      )
      assert.ok(prompt.includes(`messages seq ${state().eventIds['cut-codex']}`))
      assert.ok(!state().cards[HYDRA_CARD]!.attention.some(attention => attention.kind === 'interrupted'))
    } finally {
      await server.close()
      rmSync(
        home,
        {
          recursive: true,
          force: true,
        },
      )
    }
  },
)

for (const resumeFails of [
  false,
  true,
]) {
  test(
    resumeFails ? 'a failed wake resume waits for an owner message' : 'a cut wake resumes with the change cursor',
    async () => {
      const home = mkdtempSync(join(
        tmpdir(),
        'pnyx-hydra-wake-resume-',
      ))
      process.env.PNYX_HOME = home
      process.env.CLAUDE_CONFIG_DIR = join(
        home,
        'claude',
      )
      process.env.PNYX_SEMANTIC = 'off'
      commands.hydra([
        'create',
        'lab',
      ])
      await commands.task([
        'create',
        '--hydra',
        'lab',
        '--key',
        'fix',
        '--title',
        'Fix',
      ])
      const state = () => loadHydra({ hydraId: 'lab' }).state
      const first = hydraSdk()
      let server = await startServer({
        hydraId: 'lab',
        query: first.query,
        wakeDelay: 10,
      })

      try {
        await commands.hydra([
          'send',
          '--hydra',
          'lab',
          '--text',
          'Watch the worker',
        ])
        await until({ check: () => state().cards[HYDRA_CARD]?.sessionActivity === 'finished' })
        first.control.hold = true
        first.control.leaveTurnUnfinishedOnClose = true
        await commands.task([
          'status',
          'fix',
          'working',
          '--hydra',
          'lab',
        ])
        await until({ check: () => first.calls[0]?.messages.length === 2 })
        const cutWakeTurnId = Object.keys(state().eventIds).findLast(turnId => /^wake:\d+:hosted$/.test(turnId))!
        const wakeThroughSeq = cutWakeTurnId.split(':')[1]!
        await server.close()
        const second = hydraSdk()
        second.control.fail = resumeFails
        server = await startServer({
          hydraId: 'lab',
          query: second.query,
        })

        if (!resumeFails) {
          await until({ check: () => state().cards[HYDRA_CARD]?.sessionActivity === 'finished' })
          assert.ok(second.calls[0]!.messages[0]!.includes(`a wake check through seq ${wakeThroughSeq}`))
          assert.equal(
            second.calls[0]!.messages.length,
            1,
          )

          return
        }

        await until({ check: () => state().cards[HYDRA_CARD]?.attention.some(attention => attention.text?.includes('Harness login is missing')) ?? false })
        const resumeTurnIds = Object.keys(state().eventIds).filter(turnId => /^resume:.*:hosted$/.test(turnId))
        assert.equal(
          resumeTurnIds.length,
          1,
        )
        await server.close()
        const third = hydraSdk()
        server = await startServer({
          hydraId: 'lab',
          query: third.query,
          wakeDelay: 10,
        })
        await new Promise(resolve => setTimeout(
          resolve,
          100,
        ))
        assert.equal(
          third.calls.length,
          0,
        )
        assert.equal(
          state().cards[HYDRA_CARD]!.sessionActivity,
          'interrupted',
        )
        await commands.hydra([
          'send',
          '--hydra',
          'lab',
          '--text',
          'Try again after sign-in',
        ])
        await until({ check: () => third.calls[0]?.messages.length === 1 && state().cards[HYDRA_CARD]?.sessionActivity === 'finished' })
        assert.deepEqual(
          third.calls[0]!.messages,
          ['Try again after sign-in'],
        )
      } finally {
        await server.close()
        first.release()
        rmSync(
          home,
          {
            recursive: true,
            force: true,
          },
        )
      }
    },
  )
}

test(
  'a failed Codex resume open is not retried on another server restart',
  async () => {
    const home = mkdtempSync(join(
      tmpdir(),
      'pnyx-hydra-resume-open-fail-',
    ))
    process.env.PNYX_HOME = home
    process.env.CODEX_HOME = join(
      home,
      'codex',
    )
    process.env.PNYX_SEMANTIC = 'off'
    commands.hydra([
      'create',
      'lab',
    ])
    writeConfig({
      path: configPath({ hydraId: 'lab' }),
      value: {
        default: [
          {
            harness: 'codex',
            model: 'gpt-6-luna',
          },
        ],
      },
    })
    const first = fakeCodex({ root: home })
    const state = () => loadHydra({ hydraId: 'lab' }).state
    let server = await startServer({
      hydraId: 'lab',
      spawnCodex: first.spawnCodex,
    })

    try {
      await commands.hydra([
        'send',
        '--hydra',
        'lab',
        '--text',
        'HOLD',
      ])
      await until({ check: () => first.messages().some(rpcMessage => rpcMessage.method === 'turn/start') })
      await server.close()
      const second = fakeCodex({
        root: home,
        refuse: 'thread/resume',
      })
      server = await startServer({
        hydraId: 'lab',
        spawnCodex: second.spawnCodex,
      })
      await until({ check: () => state().hydraMessages?.some(message => message.text.includes('fixture refused thread')) ?? false })
      assert.equal(
        state().cards[HYDRA_CARD]!.sessionActivity,
        'interrupted',
      )
      await server.close()
      const third = fakeCodex({ root: home })
      server = await startServer({
        hydraId: 'lab',
        spawnCodex: third.spawnCodex,
      })
      await new Promise(resolve => setTimeout(
        resolve,
        100,
      ))
      assert.equal(
        third.children.length,
        0,
      )
      assert.equal(
        state().cards[HYDRA_CARD]!.sessionActivity,
        'interrupted',
      )
    } finally {
      await server.close()
      rmSync(
        home,
        {
          recursive: true,
          force: true,
        },
      )
    }
  },
)

test(
  'startup leaves Firstmate Hydras and Hydras without hosted sessions alone',
  async () => {
    const home = mkdtempSync(join(
      tmpdir(),
      'pnyx-hydra-no-resume-',
    ))
    process.env.PNYX_HOME = home
    process.env.CLAUDE_CONFIG_DIR = join(
      home,
      'claude',
    )
    process.env.PNYX_SEMANTIC = 'off'
    commands.hydra([
      'create',
      'lab',
    ])
    const first = hydraSdk()
    let server = await startServer({
      hydraId: 'lab',
      query: first.query,
    })

    try {
      await commands.hydra([
        'send',
        '--hydra',
        'lab',
        '--text',
        'Finish normally',
      ])
      const state = () => loadHydra({ hydraId: 'lab' }).state
      await until({ check: () => state().cards[HYDRA_CARD]?.sessionActivity === 'finished' })
      first.control.hold = true
      first.control.leaveTurnUnfinishedOnClose = true
      await commands.hydra([
        'send',
        '--hydra',
        'lab',
        '--text',
        'Cut before Firstmate switch',
      ])
      await until({ check: () => first.calls[0]?.messages.length === 2 })
      await server.close()
      commands.hydra([
        'set',
        '--hydra',
        'lab',
        '--firstmate',
        join(
          home,
          'firstmate',
        ),
      ])
      const second = hydraSdk()
      server = await startServer({
        hydraId: 'lab',
        query: second.query,
      })
      assert.equal(
        state().cards[HYDRA_CARD]!.sessionActivity,
        'interrupted',
      )
      await new Promise(resolve => setTimeout(
        resolve,
        100,
      ))
      assert.equal(
        second.calls.length,
        0,
      )
      await server.close()
      commands.hydra([
        'create',
        'empty',
        '--hydra',
        'empty',
      ])
      server = await startServer({
        hydraId: 'empty',
        query: second.query,
      })
      await new Promise(resolve => setTimeout(
        resolve,
        100,
      ))
      assert.equal(
        second.calls.length,
        0,
      )
      assert.equal(
        loadHydra({ hydraId: 'empty' }).state.config?.hydra.session,
        undefined,
      )
    } finally {
      await server.close()
      first.release()
      rmSync(
        home,
        {
          recursive: true,
          force: true,
        },
      )
    }
  },
)

test(
  'a cut turn without unanswered messages or a wake or stall names the unrecorded work',
  async () => {
    const home = mkdtempSync(join(
      tmpdir(),
      'pnyx-hydra-unrecorded-resume-',
    ))
    process.env.PNYX_HOME = home
    process.env.CLAUDE_CONFIG_DIR = join(
      home,
      'claude',
    )
    process.env.PNYX_SEMANTIC = 'off'
    commands.hydra([
      'create',
      'lab',
    ])
    const state = () => loadHydra({ hydraId: 'lab' }).state
    const first = hydraSdk()
    let server = await startServer({
      hydraId: 'lab',
      query: first.query,
    })

    try {
      await commands.hydra([
        'send',
        '--hydra',
        'lab',
        '--text',
        'Already answered',
      ])
      await until({ check: () => state().cards[HYDRA_CARD]?.sessionActivity === 'finished' })
      const lastFinishedTurnSeq = state().seq
      first.control.hold = true
      first.control.leaveTurnUnfinishedOnClose = true
      await askHost({
        hydraId: 'lab',
        body: {
          action: 'hydra',
          id: 'internal-check',
          text: 'Check previous work',
          actor: 'pnyx',
        },
      })
      await until({ check: () => first.calls[0]?.messages.length === 2 })
      await server.close()
      const second = hydraSdk()
      server = await startServer({
        hydraId: 'lab',
        query: second.query,
      })
      await until({ check: () => second.calls[0]?.messages.length === 1 && state().cards[HYDRA_CARD]?.sessionActivity === 'finished' })
      const resumeMessage = second.calls[0]!.messages[0]!
      assert.match(
        resumeMessage,
        /before you answered a turn\. Run/,
      )
      assert.ok(resumeMessage.includes(`hydra messages --after ${lastFinishedTurnSeq} --hydra lab`))
      assert.doesNotMatch(
        resumeMessage,
        /messages seq|a wake check|a stall check/,
      )
    } finally {
      await server.close()
      first.release()
      rmSync(
        home,
        {
          recursive: true,
          force: true,
        },
      )
    }
  },
)

test(
  'hydra stop ends only Hydra’s running turn and keeps its session for the next message',
  async () => {
    const home = mkdtempSync(join(
      tmpdir(),
      'pnyx-hydra-stop-',
    ))
    process.env.PNYX_HOME = home
    process.env.CLAUDE_CONFIG_DIR = join(
      home,
      'claude',
    )
    process.env.PNYX_SEMANTIC = 'off'
    commands.hydra([
      'create',
      'lab',
    ])
    const state = () => loadHydra({ hydraId: 'lab' }).state
    const sdk = hydraSdk()
    const server = await startServer({
      hydraId: 'lab',
      query: sdk.query,
    })

    try {
      assert.deepEqual(
        await commands.hydra([
          'stop',
          '--hydra',
          'lab',
        ]),
        { stopped: 'none: Hydra is not working on a turn' },
      )
      sdk.control.hold = true
      await commands.hydra([
        'send',
        '--hydra',
        'lab',
        '--text',
        'Take a long look',
      ])
      await until({ check: () => sdk.calls[0]?.messages.length === 1 && state().cards[HYDRA_CARD]?.sessionActivity === 'working' })
      const since = state().cards[HYDRA_CARD]!.workingSince
      assert.ok(since && Date.parse(since) <= Date.now())
      assert.deepEqual(
        await commands.hydra([
          'stop',
          '--hydra',
          'lab',
        ]),
        { stopped: 'hydra' },
      )
      await until({ check: () => state().cards[HYDRA_CARD]?.sessionActivity === 'finished' })
      assert.equal(
        sdk.interrupts.length,
        1,
      )
      assert.equal(
        state().cards[HYDRA_CARD]!.workingSince,
        undefined,
      )
      assert.ok(!state().cards[HYDRA_CARD]!.attention.some(a => a.kind === 'interrupted'))
      sdk.control.hold = false
      await commands.hydra([
        'send',
        '--hydra',
        'lab',
        '--text',
        'Carry on',
      ])
      await until({ check: () => sdk.calls[0]?.messages.length === 2 && state().cards[HYDRA_CARD]?.sessionActivity === 'finished' })
      assert.equal(
        sdk.calls.length,
        1,
      )
    } finally {
      await server.close()
      sdk.release()
      rmSync(
        home,
        {
          recursive: true,
          force: true,
        },
      )
    }
  },
)

test(
  'hydra usage reports the context in use, its window, the session cost and the plan windows the agent reported',
  async () => {
    const home = mkdtempSync(join(
      tmpdir(),
      'pnyx-hydra-usage-',
    ))
    process.env.PNYX_HOME = home
    process.env.CLAUDE_CONFIG_DIR = join(
      home,
      'claude',
    )
    process.env.PNYX_SEMANTIC = 'off'
    commands.hydra([
      'create',
      'lab',
    ])
    const state = () => loadHydra({ hydraId: 'lab' }).state
    const sdk = hydraSdk()
    sdk.control.usage = {
      context: 581_000,
      window: 1_000_000,
      cost: 1.25,
      limit: {
        rateLimitType: 'five_hour',
        utilization: 0.34,
        resetsAt: 1_800_000_000,
      },
    }
    const server = await startServer({
      hydraId: 'lab',
      query: sdk.query,
    })

    try {
      assert.deepEqual(
        await commands.hydra([
          'usage',
          '--hydra',
          'lab',
        ]),
        { usage: 'none: Hydra has not started a session' },
      )
      await commands.hydra([
        'send',
        '--hydra',
        'lab',
        '--text',
        'How big is the context?',
      ])
      await until({ check: () => state().cards[HYDRA_CARD]?.sessionActivity === 'finished' })
      const usage = await commands.hydra([
        'usage',
        '--hydra',
        'lab',
      ]) as Record<string, unknown>
      assert.equal(
        usage.harness,
        'claude',
      )
      assert.equal(
        usage.used,
        581_000,
      )
      assert.equal(
        usage.window,
        1_000_000,
      )
      assert.equal(
        usage.cost,
        1.25,
      )
      assert.deepEqual(
        usage.windows,
        [
          {
            label: 'session',
            used: 34,
            resetsAt: new Date(1_800_000_000_000).toISOString(),
          },
        ],
      )
    } finally {
      await server.close()
      sdk.release()
      rmSync(
        home,
        {
          recursive: true,
          force: true,
        },
      )
    }
  },
)
