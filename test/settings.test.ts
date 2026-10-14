// Agent settings: model, effort, mode, fast mode and harness-specific settings read
// from hook payloads and recorded transcripts. Fixtures and a temp PNYX_HOME only.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { appendFileSync, copyFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { decidePush } from '../src/core/decide.ts'
import { emptyBoard, reduce } from '../src/core/reducer.ts'
import { hookSettings, transcriptSettings, type FoundSettings } from '../src/integrations/hooks/settings.ts'
import { loadBoard, readEvents, spoolWrite } from '../src/store/board-store.ts'

const BIN = join(import.meta.dirname, '..', 'dist', 'cli', 'pnyx-axi.js')
const FIXTURES = join(import.meta.dirname, 'fixtures')
const transcript = (name: string) => join(FIXTURES, 'transcripts', `${name}.jsonl`)
const payload = (name: string) => JSON.parse(readFileSync(join(FIXTURES, 'hooks', `${name}.json`), 'utf8')) as Record<string, unknown>

// What reading a whole transcript reports: later records win, null clears.
function fold(...paths: string[]): FoundSettings {
  const found: FoundSettings = {}

  for (const path of paths) {
    for (const line of readFileSync(path, 'utf8').split('\n')
      .filter(Boolean)) {
      Object.assign(found, transcriptSettings(JSON.parse(line)))
    }
  }

  return found
}

test('hook payloads report the model, effort and permission mode they carry', () => {
  assert.deepEqual(hookSettings(payload('claude-session-start')), { model: 'claude-opus-5-5', mode: 'default' })
  assert.deepEqual(hookSettings(payload('claude-stop-effort')), { effort: 'xhigh', mode: 'acceptEdits' })
  assert.deepEqual(hookSettings(payload('codex-session-start')), { model: 'gpt-6', mode: 'default' })
  assert.equal(hookSettings(payload('claude-subagent-start')), undefined)
})

test('a Claude Code session transcript reports each turn\'s model, effort, speed and context, skipping subagent and synthetic turns', () => {
  assert.deepEqual(fold(transcript('claude-settings')), {
    mode: 'default',
    model: 'claude-opus-5-5',
    effort: 'high',
    fast: 'off',
    context: '1M',
    client: 'cli',
    version: '2.1.299',
  })
  // Plan mode, a higher effort and fast mode later in the session; the 1M context is gone.
  assert.deepEqual(fold(transcript('claude-settings'), transcript('claude-settings-later')), {
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
  assert.deepEqual(fold(transcript('codex-settings')), {
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
  assert.equal(transcriptSettings({ type: 'response_item', payload: { type: 'message' } }), undefined)
})

test('pushed settings merge into the card, null removes one, and bad names or values are refused', () => {
  const meta = (id: string) => ({ id, at: '2026-10-14T09:00:00Z', actor: 'cli' })
  const apply = (state: ReturnType<typeof emptyBoard>, decision: ReturnType<typeof decidePush>) =>
    ('event' in decision ? reduce(state, decision.event) : state)
  let state = apply(emptyBoard(), decidePush(emptyBoard(), 'k', { settings: { model: 'm1', fast: 'off' } }, meta('e1')))
  state = apply(state, decidePush(state, 'k', { settings: { fast: 'on', effort: 'high' } }, meta('e2')))
  assert.deepEqual(state.cards.c1!.settings, { model: 'm1', fast: 'on', effort: 'high' })
  state = apply(state, decidePush(state, 'k', { settings: { model: null, fast: null, effort: null } }, meta('e3')))
  assert.equal(state.cards.c1!.settings, undefined)
  assert.deepEqual(decidePush(state, 'k', { settings: {} }, meta('e4')), { skipped: 'unchanged' })
  assert.throws(() => decidePush(state, 'k', { settings: { 'bad name': 'x' } }, meta('e5')), /camelCase/)
  assert.throws(() => decidePush(state, 'k', { settings: { model: 3 } }, meta('e5')), /string/)
})

function board() {
  // Tests never touch the real ~/.pnyx.
  const home = mkdtempSync(join(tmpdir(), 'pnyx-settings-'))
  process.env.PNYX_HOME = home
  const env = { ...process.env, PNYX_HOME: home }
  const run = (...args: string[]) => execFileSync(process.execPath, [BIN, ...args], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

  const nudge = () => {
    writeFileSync(join(home, 'other.json'), '{}')
    // Any write drains the spool first.
    run('push', '--key', 'other', '--file', join(home, 'other.json'))
  }

  return { home, run, nudge }
}

const settingsOf = (key: string) => {
  const { state } = loadBoard('default')

  return state.cards[state.keys[key]!]!.settings
}

test('hook events and the transcript keep a Claude Code card\'s settings current as they change mid-session', () => {
  const { home, run, nudge } = board()
  const path = join(home, 's1.jsonl')
  copyFileSync(transcript('claude-settings'), path)
  const base = { session_id: 's1', transcript_path: path, cwd: '/work' }
  spoolWrite('default', { v: 1, id: 'h1', at: '2026-10-14T09:00:00Z', harness: 'claude', event: 'SessionStart', payload: { ...base, model: 'claude-opus-5-5', permission_mode: 'default', source: 'startup' } })
  nudge()
  assert.deepEqual(settingsOf('claude:s1'), { model: 'claude-opus-5-5', mode: 'default' })

  // The turn ends: the Stop hook and the transcript fill in the rest.
  spoolWrite('default', { v: 1, id: 'h2', at: '2026-10-14T09:00:10Z', harness: 'claude', event: 'Stop', payload: { ...base, permission_mode: 'default', effort: { level: 'high' } } })
  nudge()
  assert.deepEqual(settingsOf('claude:s1'), {
    model: 'claude-opus-5-5',
    mode: 'default',
    effort: 'high',
    fast: 'off',
    context: '1M',
    client: 'cli',
    version: '2.1.299',
  })
  const card = run('card', 'claude:s1')
  assert.match(card, /^ {2}settings:\n {4}model: claude-opus-5-5\n {4}mode: default\n {4}effort: high\n/m)

  // The user switches to plan mode and fast mode; the next turn reports both.
  appendFileSync(path, readFileSync(transcript('claude-settings-later'), 'utf8'))
  spoolWrite('default', { v: 1, id: 'h3', at: '2026-10-14T09:10:10Z', harness: 'claude', event: 'Stop', payload: { ...base, permission_mode: 'plan', effort: { level: 'xhigh' } } })
  nudge()
  assert.deepEqual(settingsOf('claude:s1'), {
    model: 'claude-opus-5-5',
    mode: 'plan',
    effort: 'xhigh',
    fast: 'on',
    client: 'cli',
    version: '2.1.299',
  })

  // Reading the transcript again, even from the start, changes nothing.
  const events = readEvents('default').length
  writeFileSync(join(home, 'boards', 'default', 'harvest.json'), '{}')
  run('harvest')
  assert.equal(readEvents('default').length, events)
  // Settings from a transcript are a source observation.
  const observed = readEvents('default').findLast(e => e.type === 'card.pushed' && e.actor === 'harvest')!
  assert.throws(() => run('undo', observed.id), (error: { stdout: string }) => /code: NOT_UNDOABLE/.test(error.stdout))
})

test('a Codex session reports its model on every hook and the rest from its rollout', () => {
  const { home, nudge } = board()
  const path = join(home, 'x2.jsonl')
  copyFileSync(transcript('codex-settings'), path)
  spoolWrite('default', { v: 1, id: 'h1', at: '2026-10-14T09:05:10Z', harness: 'codex', event: 'Stop', payload: { session_id: 'x2', transcript_path: path, cwd: '/work', model: 'gpt-6.1-sol', permission_mode: 'plan' } })
  nudge()
  assert.deepEqual(settingsOf('codex:x2'), {
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
  const { home, nudge } = board()
  const path = join(home, 'agent-a1.jsonl')
  // A subagent's own transcript holds only sidechain records.
  writeFileSync(path, readFileSync(transcript('claude-settings'), 'utf8').split('\n')
    .filter(line => line.includes('"isSidechain":true'))
    .map(line => `${line}\n`)
    .join(''))
  spoolWrite('default', { v: 1, id: 'h1', at: '2026-10-14T09:00:10Z', harness: 'claude', event: 'SubagentStop', payload: { session_id: 's1', transcript_path: join(home, 's1.jsonl'), cwd: '/work', permission_mode: 'default', agent_id: 'agent-a1', agent_type: 'Explore', agent_transcript_path: path } })
  nudge()
  assert.deepEqual(settingsOf('claude:s1/agent-a1'), {
    mode: 'default',
    model: 'claude-haiku-5-5',
    effort: 'low',
    fast: 'off',
    client: 'cli',
    version: '2.1.299',
  })
})
