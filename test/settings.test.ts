// Agent settings: model, effort, mode, fast mode and harness-specific settings read
// from hook payloads and recorded transcripts. Fixtures and a temp PNYX_HOME only.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { appendFileSync, copyFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { decidePush } from '../src/core/decide.ts'
import { emptyHydra, reduce } from '../src/core/reducer.ts'
import { loadHydra, readEvents, spoolWrite } from '../src/store/hydra-store.ts'

const BIN = join(
  import.meta.dirname,
  '..',
  'dist',
  'cli',
  'pnyx-axi.js',
)
const FIXTURES = join(
  import.meta.dirname,
  'fixtures',
)
const transcript = ({ name }: { name: string }) => join(
  FIXTURES,
  'transcripts',
  `${name}.jsonl`,
)

test(
  'pushed settings merge into the card, null removes one, and bad names or values are refused',
  () => {
    const meta = ({ id }: { id: string }) => ({
      id,
      at: '2026-10-14T09:00:00Z',
      actor: 'cli',
    })
    const apply = ({
      state,
      decision,
    }: {
      state: ReturnType<typeof emptyHydra>
      decision: ReturnType<typeof decidePush>
    }) =>
      ('event' in decision ? reduce({
        state,
        event: decision.event,
      }) : state)
    let state = apply({
      state: emptyHydra(),
      decision: decidePush({
        state: emptyHydra(),
        newCardId: `c${emptyHydra().seq + 1}`,
        key: 'k',
        input: {
          settings: {
            model: 'm1',
            fast: 'off',
          },
        },
        meta: meta({ id: 'e1' }),
      }),
    })
    state = apply({
      state,
      decision: decidePush({
        state,
        newCardId: `c${state.seq + 1}`,
        key: 'k',
        input: {
          settings: {
            fast: 'on',
            effort: 'high',
          },
        },
        meta: meta({ id: 'e2' }),
      }),
    })
    assert.deepEqual(
      state.cards.c1!.settings,
      {
        model: 'm1',
        fast: 'on',
        effort: 'high',
      },
    )
    state = apply({
      state,
      decision: decidePush({
        state,
        newCardId: `c${state.seq + 1}`,
        key: 'k',
        input: {
          settings: {
            model: null,
            fast: null,
            effort: null,
          },
        },
        meta: meta({ id: 'e3' }),
      }),
    })
    assert.equal(
      state.cards.c1!.settings,
      undefined,
    )
    assert.deepEqual(
      decidePush({
        state,
        newCardId: `c${state.seq + 1}`,
        key: 'k',
        input: { settings: {} },
        meta: meta({ id: 'e4' }),
      }),
      { skipped: 'unchanged' },
    )
    assert.throws(
      () => decidePush({
        state,
        newCardId: `c${state.seq + 1}`,
        key: 'k',
        input: { settings: { 'bad name': 'x' } },
        meta: meta({ id: 'e5' }),
      }),
      /camelCase/,
    )
    assert.throws(
      () => decidePush({
        state,
        newCardId: `c${state.seq + 1}`,
        key: 'k',
        input: { settings: { model: 3 } },
        meta: meta({ id: 'e5' }),
      }),
      /string/,
    )
  },
)

function hydraId() {
  const home = mkdtempSync(join(
    tmpdir(),
    'pnyx-settings-',
  ))
  process.env.PNYX_HOME = home
  const env = {
    ...process.env,
    PNYX_HOME: home,
  }
  const run = ({ args = [] }: { args?: string[] } = {}) => execFileSync(
    process.execPath,
    [
      BIN,
      ...args,
    ],
    {
      env,
      encoding: 'utf8',
      stdio: [
        'ignore',
        'pipe',
        'pipe',
      ],
    },
  )

  const nudge = () => {
    writeFileSync(
      join(
        home,
        'other.json',
      ),
      '{}',
    )
    run({
      args: [
        'push',
        '--key',
        'other',
        '--file',
        join(
          home,
          'other.json',
        ),
      ],
    })
  }

  return {
    home,
    run,
    nudge,
  }
}

const settingsOf = ({ key }: { key: string }) => {
  const { state } = loadHydra({ hydraId: 'default' })

  return state.cards[state.keys[key]!]!.settings
}

test(
  'hook events and the transcript keep a Claude Code card\'s settings current as they change mid-session',
  () => {
    const {
      home,
      run,
      nudge,
    } = hydraId()
    const path = join(
      home,
      's1.jsonl',
    )
    copyFileSync(
      transcript({ name: 'claude-settings' }),
      path,
    )
    const base = {
      session_id: 's1',
      transcript_path: path,
      cwd: '/work',
    }
    spoolWrite({
      hydraId: 'default',
      entry: {
        v: 1,
        id: 'h1',
        at: '2026-10-14T09:00:00Z',
        harness: 'claude',
        event: 'SessionStart',
        payload: {
          ...base,
          model: 'claude-opus-5-5',
          permission_mode: 'default',
          source: 'startup',
        },
      },
    })
    nudge()
    assert.deepEqual(
      settingsOf({ key: 'claude:s1' }),
      {
        model: 'claude-opus-5-5',
        mode: 'default',
      },
    )

    spoolWrite({
      hydraId: 'default',
      entry: {
        v: 1,
        id: 'h2',
        at: '2026-10-14T09:00:10Z',
        harness: 'claude',
        event: 'Stop',
        payload: {
          ...base,
          permission_mode: 'default',
          effort: { level: 'high' },
        },
      },
    })
    nudge()
    assert.deepEqual(
      settingsOf({ key: 'claude:s1' }),
      {
        model: 'claude-opus-5-5',
        mode: 'default',
        effort: 'high',
        fast: 'off',
        context: '1M',
        client: 'cli',
        version: '2.1.299',
      },
    )
    const card = run({
      args: [
        'card',
        'claude:s1',
      ],
    })
    assert.match(
      card,
      /^ {2}settings:\n {4}model: claude-opus-5-5\n {4}mode: default\n {4}effort: high\n/m,
    )

    appendFileSync(
      path,
      readFileSync(
        transcript({ name: 'claude-settings-later' }),
        'utf8',
      ),
    )
    spoolWrite({
      hydraId: 'default',
      entry: {
        v: 1,
        id: 'h3',
        at: '2026-10-14T09:10:10Z',
        harness: 'claude',
        event: 'Stop',
        payload: {
          ...base,
          permission_mode: 'plan',
          effort: { level: 'xhigh' },
        },
      },
    })
    nudge()
    assert.deepEqual(
      settingsOf({ key: 'claude:s1' }),
      {
        model: 'claude-opus-5-5',
        mode: 'plan',
        effort: 'xhigh',
        fast: 'on',
        client: 'cli',
        version: '2.1.299',
      },
    )

    const events = readEvents({ hydraId: 'default' }).length
    writeFileSync(
      join(
        home,
        'hydras',
        'default',
        'harvest.json',
      ),
      '{}',
    )
    run({ args: ['harvest'] })
    assert.equal(
      readEvents({ hydraId: 'default' }).length,
      events,
    )
  },
)

test(
  'a Codex session reports its model on every hook and the rest from its rollout',
  () => {
    const {
      home,
      nudge,
    } = hydraId()
    const path = join(
      home,
      'x2.jsonl',
    )
    copyFileSync(
      transcript({ name: 'codex-settings' }),
      path,
    )
    spoolWrite({
      hydraId: 'default',
      entry: {
        v: 1,
        id: 'h1',
        at: '2026-10-14T09:05:10Z',
        harness: 'codex',
        event: 'Stop',
        payload: {
          session_id: 'x2',
          transcript_path: path,
          cwd: '/work',
          model: 'gpt-6.1-sol',
          permission_mode: 'plan',
        },
      },
    })
    nudge()
    assert.deepEqual(
      settingsOf({ key: 'codex:x2' }),
      {
        model: 'gpt-6.1-sol',
        mode: 'plan',
        client: 'codex-tui',
        version: '0.160.1',
        effort: 'xhigh',
        fast: 'on',
        approval: 'granular',
        sandbox: 'workspace-write',
        collaboration: 'plan',
        summary: 'concise',
      },
    )
  },
)

test(
  'a subagent card reports the settings its own transcript records',
  () => {
    const {
      home,
      nudge,
    } = hydraId()
    const path = join(
      home,
      'agent-a1.jsonl',
    )
    // A subagent's own transcript holds only sidechain records.
    writeFileSync(
      path,
      readFileSync(
        transcript({ name: 'claude-settings' }),
        'utf8',
      ).split('\n')
        .filter(line => line.includes('"isSidechain":true'))
        .map(line => `${line}\n`)
        .join(''),
    )
    spoolWrite({
      hydraId: 'default',
      entry: {
        v: 1,
        id: 'h1',
        at: '2026-10-14T09:00:10Z',
        harness: 'claude',
        event: 'SubagentStop',
        payload: {
          session_id: 's1',
          transcript_path: join(
            home,
            's1.jsonl',
          ),
          cwd: '/work',
          permission_mode: 'default',
          agent_id: 'agent-a1',
          agent_type: 'Explore',
          agent_transcript_path: path,
        },
      },
    })
    nudge()
    assert.deepEqual(
      settingsOf({ key: 'claude:s1/agent-a1' }),
      {
        mode: 'default',
        model: 'claude-haiku-5-5',
        effort: 'low',
        fast: 'off',
        client: 'cli',
        version: '2.1.299',
      },
    )
  },
)
