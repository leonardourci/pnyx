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
import { hookSettings, transcriptSettings, type FoundSettings } from '../src/integrations/hooks/settings.ts'
import { loadHydra, readEvents, spoolWrite } from '../src/store/hydra-store.ts'

const BIN = join(import.meta.dirname, '..', 'dist', 'cli', 'pnyx-axi.js')
const FIXTURES = join(import.meta.dirname, 'fixtures')
const transcript = ({ name }: { name: string }) => join(FIXTURES, 'transcripts', `${name}.jsonl`)
const payload = ({ name }: { name: string }) => JSON.parse(readFileSync(join(FIXTURES, 'hooks', `${name}.json`), 'utf8')) as Record<string, unknown>

function fold({ paths = [] }: { paths?: string[] } = {}): FoundSettings {
  const found: FoundSettings = {}

  for (const path of paths) {
    for (const line of readFileSync(path, 'utf8').split('\n')
      .filter(Boolean)) {
      Object.assign(found, transcriptSettings({ record: JSON.parse(line) }))
    }
  }

  return found
}

test('hook payloads report the model, effort and permission mode they carry', () => {
  assert.deepEqual(hookSettings({ payload: payload({ name: 'claude-session-start' }) }), { model: 'claude-opus-5-5', mode: 'default' })
  assert.deepEqual(hookSettings({ payload: payload({ name: 'claude-stop-effort' }) }), { effort: 'xhigh', mode: 'acceptEdits' })
  assert.deepEqual(hookSettings({ payload: payload({ name: 'codex-session-start' }) }), { model: 'gpt-6', mode: 'default' })
  assert.equal(hookSettings({ payload: payload({ name: 'claude-subagent-start' }) }), undefined)
  assert.deepEqual(hookSettings({ payload: payload({ name: 'claude-post-model-switch' }) }), { model: 'claude-haiku-5-5' })
})

test('a Claude Code session transcript reports each turn\'s model, effort, speed and context, skipping subagent and synthetic turns', () => {
  assert.deepEqual(fold({ paths: [transcript({ name: 'claude-settings' })] }), {
    mode: 'default',
    model: 'claude-opus-5-5',
    effort: 'high',
    fast: 'off',
    context: '1M',
    client: 'cli',
    version: '2.1.299',
  })
  // Plan mode, a higher effort and fast mode later in the session; the 1M context is gone.
  assert.deepEqual(fold({ paths: [transcript({ name: 'claude-settings' }), transcript({ name: 'claude-settings-later' })] }), {
    mode: 'plan',
    model: 'claude-opus-5-5',
    effort: 'xhigh',
    fast: 'on',
    context: null,
    client: 'cli',
    version: '2.1.299',
  })
})

test('a Codex rollout reports its session meta, thread settings and turn context', () => {
  assert.deepEqual(fold({ paths: [transcript({ name: 'codex-settings' })] }), {
    client: 'codex-tui',
    version: '0.160.1',
    model: 'gpt-6.1-sol',
    effort: 'xhigh',
    fast: 'on',
    approval: 'granular',
    sandbox: 'workspace-write',
    collaboration: 'plan',
    summary: 'concise',
  })
  assert.equal(transcriptSettings({ record: { type: 'response_item', payload: { type: 'message' } } }), undefined)
})

test('pushed settings merge into the card, null removes one, and bad names or values are refused', () => {
  const meta = ({ id }: { id: string }) => ({ id, at: '2026-10-14T09:00:00Z', actor: 'cli' })
  const apply = ({ state, decision }: {
    state: ReturnType<typeof emptyHydra>
    decision: ReturnType<typeof decidePush>
  }) =>
    ('event' in decision ? reduce({ state, event: decision.event }) : state)
  let state = apply({ state: emptyHydra(), decision: decidePush({ state: emptyHydra(), newCardId: `c${emptyHydra().seq + 1}`, key: 'k', input: { settings: { model: 'm1', fast: 'off' } }, meta: meta({ id: 'e1' }) }) })
  state = apply({ state, decision: decidePush({ state, newCardId: `c${state.seq + 1}`, key: 'k', input: { settings: { fast: 'on', effort: 'high' } }, meta: meta({ id: 'e2' }) }) })
  assert.deepEqual(state.cards.c1!.settings, { model: 'm1', fast: 'on', effort: 'high' })
  state = apply({ state, decision: decidePush({ state, newCardId: `c${state.seq + 1}`, key: 'k', input: { settings: { model: null, fast: null, effort: null } }, meta: meta({ id: 'e3' }) }) })
  assert.equal(state.cards.c1!.settings, undefined)
  assert.deepEqual(decidePush({ state, newCardId: `c${state.seq + 1}`, key: 'k', input: { settings: {} }, meta: meta({ id: 'e4' }) }), { skipped: 'unchanged' })
  assert.throws(() => decidePush({ state, newCardId: `c${state.seq + 1}`, key: 'k', input: { settings: { 'bad name': 'x' } }, meta: meta({ id: 'e5' }) }), /camelCase/)
  assert.throws(() => decidePush({ state, newCardId: `c${state.seq + 1}`, key: 'k', input: { settings: { model: 3 } }, meta: meta({ id: 'e5' }) }), /string/)
})

function hydraId() {
  const home = mkdtempSync(join(tmpdir(), 'pnyx-settings-'))
  process.env.PNYX_HOME = home
  const env = { ...process.env, PNYX_HOME: home }
  const run = ({ args = [] }: { args?: string[] } = {}) => execFileSync(process.execPath, [BIN, ...args], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

  const nudge = () => {
    writeFileSync(join(home, 'other.json'), '{}')
    run({ args: ['push', '--key', 'other', '--file', join(home, 'other.json')] })
  }

  return { home, run, nudge }
}

const settingsOf = ({ key }: { key: string }) => {
  const { state } = loadHydra({ hydraId: 'default' })

  return state.cards[state.keys[key]!]!.settings
}

test('hook events and the transcript keep a Claude Code card\'s settings current as they change mid-session', () => {
  const { home, run, nudge } = hydraId()
  const path = join(home, 's1.jsonl')
  copyFileSync(transcript({ name: 'claude-settings' }), path)
  const base = { session_id: 's1', transcript_path: path, cwd: '/work' }
  spoolWrite({ hydraId: 'default', entry: { v: 1, id: 'h1', at: '2026-10-14T09:00:00Z', harness: 'claude', event: 'SessionStart', payload: { ...base, model: 'claude-opus-5-5', permission_mode: 'default', source: 'startup' } } })
  nudge()
  assert.deepEqual(settingsOf({ key: 'claude:s1' }), { model: 'claude-opus-5-5', mode: 'default' })

  spoolWrite({ hydraId: 'default', entry: { v: 1, id: 'h2', at: '2026-10-14T09:00:10Z', harness: 'claude', event: 'Stop', payload: { ...base, permission_mode: 'default', effort: { level: 'high' } } } })
  nudge()
  assert.deepEqual(settingsOf({ key: 'claude:s1' }), {
    model: 'claude-opus-5-5',
    mode: 'default',
    effort: 'high',
    fast: 'off',
    context: '1M',
    client: 'cli',
    version: '2.1.299',
  })
  const card = run({ args: ['card', 'claude:s1'] })
  assert.match(card, /^ {2}settings:\n {4}model: claude-opus-5-5\n {4}mode: default\n {4}effort: high\n/m)

  appendFileSync(path, readFileSync(transcript({ name: 'claude-settings-later' }), 'utf8'))
  spoolWrite({ hydraId: 'default', entry: { v: 1, id: 'h3', at: '2026-10-14T09:10:10Z', harness: 'claude', event: 'Stop', payload: { ...base, permission_mode: 'plan', effort: { level: 'xhigh' } } } })
  nudge()
  assert.deepEqual(settingsOf({ key: 'claude:s1' }), {
    model: 'claude-opus-5-5',
    mode: 'plan',
    effort: 'xhigh',
    fast: 'on',
    client: 'cli',
    version: '2.1.299',
  })

  const events = readEvents({ hydraId: 'default' }).length
  writeFileSync(join(home, 'boards', 'default', 'harvest.json'), '{}')
  run({ args: ['harvest'] })
  assert.equal(readEvents({ hydraId: 'default' }).length, events)
  const observed = readEvents({ hydraId: 'default' }).findLast(e => e.type === 'card.pushed' && e.actor === 'harvest')!
  assert.throws(() => run({ args: ['undo', observed.id] }), (error: { stdout: string }) => /code: NOT_UNDOABLE/.test(error.stdout))
})

test('a transcript record written before the latest hook never overrides what hooks reported live', () => {
  const { home, run, nudge } = hydraId()
  const path = join(home, 's2.jsonl')
  const base = { session_id: 's2', transcript_path: path, cwd: '/work' }
  // The prompt went in under auto mode and the turn ran at medium effort; the
  // starting-mode record repeats auto even after Shift+Tab moved the session on.
  writeFileSync(path, [
    { type: 'permission-mode', permissionMode: 'auto', sessionId: 's2' },
    { type: 'user', timestamp: '2026-10-14T10:00:00.000Z', sessionId: 's2', permissionMode: 'auto', message: { role: 'user', content: 'Go.' } },
    { type: 'assistant', timestamp: '2026-10-14T10:00:05.000Z', sessionId: 's2', effort: 'medium', message: { model: 'claude-sonnet-5-5', role: 'assistant', content: [{ type: 'text', text: 'Done.' }], usage: { speed: 'standard' } } },
  ].map(r => `${JSON.stringify(r)}\n`).join(''))
  spoolWrite({ hydraId: 'default', entry: { v: 1, id: 'h1', at: '2026-10-14T10:01:00Z', harness: 'claude', event: 'Stop', payload: { ...base, permission_mode: 'acceptEdits', effort: { level: 'high' } } } })
  nudge()
  assert.deepEqual(settingsOf({ key: 'claude:s2' }), { mode: 'acceptEdits', effort: 'high', model: 'claude-sonnet-5-5', fast: 'off' })

  appendFileSync(path, [
    { type: 'permission-mode', permissionMode: 'auto', sessionId: 's2' },
    { type: 'user', timestamp: '2026-10-14T10:02:00.000Z', sessionId: 's2', permissionMode: 'plan', message: { role: 'user', content: 'Plan it.' } },
    { type: 'assistant', timestamp: '2026-10-14T10:02:05.000Z', sessionId: 's2', effort: 'max', message: { model: 'claude-opus-5-5', role: 'assistant', content: [{ type: 'text', text: 'Planned.' }], usage: { speed: 'standard' } } },
  ].map(r => `${JSON.stringify(r)}\n`).join(''))
  spoolWrite({ hydraId: 'default', entry: { v: 1, id: 'h2', at: '2026-10-14T10:02:00Z', harness: 'claude', event: 'Notification', payload: { ...base, notification_type: 'idle_prompt' } } })
  nudge()
  run({ args: ['harvest'] })
  assert.deepEqual(settingsOf({ key: 'claude:s2' }), { mode: 'plan', effort: 'max', model: 'claude-opus-5-5', fast: 'off' })
})

test('a Codex session reports its model on every hook and the rest from its rollout', () => {
  const { home, nudge } = hydraId()
  const path = join(home, 'x2.jsonl')
  copyFileSync(transcript({ name: 'codex-settings' }), path)
  spoolWrite({ hydraId: 'default', entry: { v: 1, id: 'h1', at: '2026-10-14T09:05:10Z', harness: 'codex', event: 'Stop', payload: { session_id: 'x2', transcript_path: path, cwd: '/work', model: 'gpt-6.1-sol', permission_mode: 'plan' } } })
  nudge()
  assert.deepEqual(settingsOf({ key: 'codex:x2' }), {
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
  })
})

test('a subagent card reports the settings its own transcript records', () => {
  const { home, nudge } = hydraId()
  const path = join(home, 'agent-a1.jsonl')
  // A subagent's own transcript holds only sidechain records.
  writeFileSync(path, readFileSync(transcript({ name: 'claude-settings' }), 'utf8').split('\n')
    .filter(line => line.includes('"isSidechain":true'))
    .map(line => `${line}\n`)
    .join(''))
  spoolWrite({ hydraId: 'default', entry: { v: 1, id: 'h1', at: '2026-10-14T09:00:10Z', harness: 'claude', event: 'SubagentStop', payload: { session_id: 's1', transcript_path: join(home, 's1.jsonl'), cwd: '/work', permission_mode: 'default', agent_id: 'agent-a1', agent_type: 'Explore', agent_transcript_path: path } } })
  nudge()
  assert.deepEqual(settingsOf({ key: 'claude:s1/agent-a1' }), {
    mode: 'default',
    model: 'claude-haiku-5-5',
    effort: 'low',
    fast: 'off',
    client: 'cli',
    version: '2.1.299',
  })
})
