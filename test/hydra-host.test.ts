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
import { loadHydra, withWriter } from '../src/store/hydra-store.ts'
import { startServer } from '../src/server/server.ts'
import { localToken } from '../src/server/state.ts'
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
    commands.hydra([
      'memory',
      'set',
      '--key',
      'preferences',
      '--text',
      'Hydra owner preference.',
      '--hydra',
      'existing',
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
        /<\/pnyx-wake>\n\nMemory changed; load Hydra memory/,
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
