// Inline answers to an agent's own question, permission or plan prompt: which
// requests the board can answer, the keys each harness's prompt expects, and the
// delivery through the session's terminal. Every host is the fake in
// test/fixtures/hosts on PATH: tests never type into a real session.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { answerPrompt, answerText, checkAnswer, requestId, type Answer, type Prompt } from '../src/core/answer.ts'
import type { Attention, BoardEvent, Card } from '../src/core/model.ts'
import { emptyBoard, replay } from '../src/core/reducer.ts'
import { KEY, answerKeys } from '../src/integrations/hooks/answer.ts'
import { attend, observe, type HookEnvelope } from '../src/integrations/hooks/observe.ts'

const ROOT = join(import.meta.dirname, '..')
const BIN = join(ROOT, 'dist', 'cli', 'pnyx-axi.js')
const HOST = join(ROOT, 'test', 'fixtures', 'hosts', 'host.sh')
const TTY = '/dev/ttys042'

const fixture = ({ name }: { name: string }) => JSON.parse(readFileSync(join(ROOT, 'test', 'fixtures', 'hooks', `${name}.json`), 'utf8'))

// The request a hook event opens on a card that had none.
const opened = ({ harness, event, name }: { harness: 'claude' | 'codex'; event: string; name: string }): Attention => {
  const envelope: HookEnvelope = { v: 1, id: 'hook-1', at: '2026-10-14T17:00:00Z', harness, event, payload: fixture({ name }) }

  return attend({ current: [], change: observe({ envelope }).at(-1)!.attend! })[0]!
}

const card = ({ provider, attention }: { provider: string; attention: Attention[] }): Card => ({
  id: 'c1',
  key: 'k',
  title: 'k',
  workspace: 'unassigned',
  tags: [],
  attention,
  links: [],
  sourceRefs: [],
  column: 'needs_you',
  revision: 1,
  createdSeq: 1,
  updatedSeq: 1,
  updatedAt: '2026-10-14T00:00:00Z',
  agent: { provider, sessionId: 's' },
  terminal: { tty: TTY, pid: '4242', program: 'tmux', tmux: '/tmp/tmux-1/default', tmuxPane: '%3' },
})

const multi = opened({ harness: 'claude', event: 'PermissionRequest', name: 'claude-permission-request-ask-multi' })
const single = opened({ harness: 'claude', event: 'PreToolUse', name: 'claude-pre-tool-ask' })
const permission = opened({ harness: 'claude', event: 'PermissionRequest', name: 'claude-permission-request' })
const plan = opened({ harness: 'claude', event: 'PermissionRequest', name: 'claude-permission-request-plan' })
const codex = opened({ harness: 'codex', event: 'PermissionRequest', name: 'codex-permission-request' })
const elicitation = opened({ harness: 'claude', event: 'Elicitation', name: 'claude-elicitation-form' })

const prompt = ({ provider, request }: { provider: string; request: Attention }): Prompt =>
  answerPrompt({ card: card({ provider, attention: [request] }), request })!

type Asked = { provider: string; request: Attention; value: unknown }

const checked = ({ provider, request, value }: Asked): Answer => {
  const result = checkAnswer({ prompt: prompt({ provider, request }), request, value })
  assert.ok('answer' in result, JSON.stringify(result))

  return result.answer
}

const keys = ({ provider, request, value }: Asked) =>
  answerKeys({ provider, request, answer: checked({ provider, request, value }) })
    .map(step => step.keys)

test('a Claude Code AskUserQuestion request keeps every question with its options', () => {
  assert.deepEqual(multi.questions, [
    {
      question: 'Pick a color',
      header: 'Color',
      options: [{ label: 'Red', description: 'Red' }, { label: 'Blue', description: 'Blue' }, { label: 'Green', description: 'Green' }],
    },
    {
      question: 'Pick sizes',
      header: 'Size',
      options: [{ label: 'Small', description: 'Small' }, { label: 'Medium', description: 'Medium' }, { label: 'Large', description: 'Large' }],
      multiSelect: true,
    },
  ])
  // A malformed question is left out entirely, so it is answered in the terminal.
  const broken = { ...fixture({ name: 'claude-pre-tool-ask' }), tool_input: { questions: [{ question: 'Which?', options: [] }] } }
  const envelope: HookEnvelope = { v: 1, id: 'hook-2', at: '2026-10-14T17:00:00Z', harness: 'claude', event: 'PreToolUse', payload: broken }
  const request = attend({ current: [], change: observe({ envelope })[0]!.attend! })[0]!
  assert.equal(request.text, 'Which?')
  assert.equal(request.questions, undefined)
  assert.equal(answerPrompt({ card: card({ provider: 'claude-code', attention: [request] }), request }), undefined)
})

test('only hook requests whose prompt keys were verified can be answered inline', () => {
  assert.deepEqual(prompt({ provider: 'claude-code', request: multi }), { kind: 'questions' })
  assert.deepEqual(prompt({ provider: 'claude-code', request: permission }).kind, 'choices')
  assert.deepEqual(prompt({ provider: 'codex', request: codex }), {
    kind: 'choices',
    choices: [{ choice: 'allow', label: 'Yes, proceed', text: 'none' }, { choice: 'deny', label: 'No', text: 'optional' }],
  })
  const none = ({ provider, request }: { provider: string; request: Attention }) =>
    assert.equal(answerPrompt({ card: card({ provider, attention: [request] }), request }), undefined, `${provider} ${request.key}`)
  none({ provider: 'claude-code', request: { kind: 'permission', key: 'hook:notification', blocking: true, text: 'Claude needs your permission' } })
  none({ provider: 'claude-code', request: { kind: 'input', key: 'hook:elicitation', blocking: true, text: 'server: name?' } })
  none({ provider: 'claude-code', request: { kind: 'decision', key: 'fm:decision', blocking: true, text: 'Ship it?' } })
  none({ provider: 'claude-code', request: { ...permission, answered: 'r1' } })
  none({ provider: 'codex', request: plan })
})

test('answers are checked against the prompt before anything is typed', () => {
  const error = ({ request, value }: { request: Attention; value: unknown }) => {
    const result = checkAnswer({ prompt: prompt({ provider: 'claude-code', request }), request, value })

    return 'error' in result ? result.error : undefined
  }

  assert.match(error({ request: multi, value: { answers: [{ pick: [1] }] } })!, /one answer for each of the 2 questions/)
  assert.match(error({ request: multi, value: { answers: [{ pick: [1, 2] }, { pick: [1] }] } })!, /takes one option/)
  assert.match(error({ request: multi, value: { answers: [{ pick: [4] }, { pick: [1] }] } })!, /from 1 to 3/)
  assert.match(error({ request: multi, value: { answers: [{ pick: [1] }, { pick: [2, 2] }] } })!, /each once/)
  assert.match(error({ request: multi, value: { answers: [{ pick: [1] }, { text: 'Huge' }] } })!, /takes several options/)
  assert.match(error({ request: permission, value: { choice: 'approve' } })!, /one of allow, deny/)
  assert.match(error({ request: permission, value: { choice: 'allow', text: 'and more' } })!, /takes no text/)
  assert.match(error({ request: plan, value: { choice: 'revise' } })!, /needs text/)
  assert.deepEqual(checked({ provider: 'claude-code', request: multi, value: { answers: [{ text: '  Teal\nplease ' }, { pick: [3, 1] }] } }).answers, [
    { text: 'Teal please' },
    { pick: [1, 3] },
  ])
})

test('an answer is recorded in words', () => {
  const answer = checked({ provider: 'claude-code', request: multi, value: { answers: [{ pick: [2] }, { pick: [1, 3] }] } })
  assert.equal(answerText({ prompt: prompt({ provider: 'claude-code', request: multi }), request: multi, answer }), 'Pick a color → Blue\nPick sizes → Small, Large')
  const deny = checked({ provider: 'codex', request: codex, value: { choice: 'deny', text: 'use a temp dir' } })
  assert.equal(answerText({ prompt: prompt({ provider: 'codex', request: codex }), request: codex, answer: deny }), 'No: use a temp dir')
})

test('each harness gets the keys its own prompt expects', () => {
  const claude = ({ request, value }: { request: Attention; value: unknown }) => keys({ provider: 'claude-code', request, value })
  // A number picks a single-choice option and moves on; a multiple-choice question
  // toggles numbers and moves on with Right; several questions end on the review's Submit.
  assert.deepEqual(claude({ request: multi, value: { answers: [{ pick: [2] }, { pick: [1, 3] }] } }), ['2', '1', '3', KEY.right, '1'])
  assert.deepEqual(claude({ request: single, value: { answers: [{ pick: [2] }] } }), ['2'])
  // Free text goes on the line after the options, then Enter.
  assert.deepEqual(claude({ request: single, value: { answers: [{ text: 'Purple' }] } }), ['3', 'Purple', KEY.enter])
  assert.deepEqual(claude({ request: permission, value: { choice: 'allow' } }), ['1'])
  assert.deepEqual(claude({ request: permission, value: { choice: 'deny' } }), [KEY.escape])
  assert.deepEqual(claude({ request: permission, value: { choice: 'deny', text: 'not that' } }), [KEY.up, KEY.tab, 'not that', KEY.enter])
  assert.deepEqual(claude({ request: plan, value: { choice: 'approve' } }), ['2'])
  assert.deepEqual(claude({ request: plan, value: { choice: 'revise', text: 'smaller' } }), ['3', 'smaller', KEY.enter])
  assert.deepEqual(keys({ provider: 'codex', request: codex, value: { choice: 'allow' } }), ['y'])
  assert.deepEqual(keys({ provider: 'codex', request: codex, value: { choice: 'deny' } }), [KEY.escape])
  assert.deepEqual(keys({ provider: 'codex', request: codex, value: { choice: 'deny', text: 'skip it' } }), [KEY.escape, 'skip it', KEY.enter])
  const settles = ({ text }: { text: string }) => answerKeys({ provider: 'codex', request: codex, answer: { choice: 'deny', text } })
    .map(step => step.settleMs)
  assert.deepEqual(settles({ text: '/review' }), [1200, 1500, 400], 'a leading / waits out the completion popup')
  assert.deepEqual(settles({ text: 'skip it' }), [1200, 400, 400])
})

test('an MCP form keeps its fields, is checked, and is filled with the keys its prompt expects', () => {
  assert.deepEqual(elicitation.form, [
    { name: 'name', title: 'Name', type: 'string', required: true },
    { name: 'color', title: 'Color', type: 'string', options: ['red', 'blue'] },
    { name: 'ok', title: 'Agree', type: 'boolean' },
  ])
  assert.deepEqual(prompt({ provider: 'claude-code', request: elicitation }), { kind: 'form' })
  const url = { ...fixture({ name: 'claude-elicitation-form' }), mode: 'url', url: 'https://example.com/auth' }
  const envelope: HookEnvelope = { v: 1, id: 'hook-3', at: '2026-10-14T17:00:00Z', harness: 'claude', event: 'Elicitation', payload: url }
  assert.equal(attend({ current: [], change: observe({ envelope })[0]!.attend! })[0]!.form, undefined, 'a URL elicitation is answered in the session')

  const error = ({ value }: { value: unknown }) => {
    const result = checkAnswer({ prompt: { kind: 'form' }, request: elicitation, value })

    return 'error' in result ? result.error : undefined
  }

  assert.match(error({ value: { choice: 'accept', values: {} } })!, /Name is required/)
  assert.match(error({ value: { choice: 'accept', values: { name: 'Ada', color: 'green' } } })!, /one of red, blue/)
  assert.match(error({ value: { choice: 'accept', values: { name: 'Ada', ok: 'yes' } } })!, /true or false/)
  assert.match(error({ value: { choice: 'accept', values: { name: 'Ada', age: 3 } } })!, /no field age/)
  assert.match(error({ value: { choice: 'allow' } })!, /takes \{"choice":"accept"/)

  const form = ({ value }: { value: unknown }) => keys({ provider: 'claude-code', request: elicitation, value })
  assert.deepEqual(form({ value: { choice: 'accept', values: { name: 'Grace Hopper', color: 'blue', ok: true } } }), [
    'Grace Hopper', KEY.down, KEY.right, KEY.down, KEY.space, KEY.down, KEY.space, KEY.down, KEY.enter,
  ])
  assert.deepEqual(form({ value: { choice: 'accept', values: { name: 'Ada', ok: false } } }), ['Ada', KEY.down, KEY.down, KEY.down, KEY.enter])
  assert.deepEqual(form({ value: { choice: 'decline' } }), [KEY.down, KEY.down, KEY.down, KEY.right, KEY.enter])
  const answer = checked({ provider: 'claude-code', request: elicitation, value: { choice: 'accept', values: { name: 'Ada', ok: true } } })
  assert.equal(answerText({ prompt: { kind: 'form' }, request: elicitation, answer }), 'Accept\nName: Ada\nAgree: yes')
})

test('a form field the board cannot fill as the terminal would leaves the whole form to the terminal', () => {
  const base = fixture({ name: 'claude-elicitation-form' })

  const formWith = ({ property }: { property: Record<string, unknown> }) => {
    const payload = { ...base, requested_schema: { type: 'object', properties: { pick: property } } }
    const envelope: HookEnvelope = { v: 1, id: 'hook-4', at: '2026-10-14T17:00:00Z', harness: 'claude', event: 'Elicitation', payload }

    return attend({ current: [], change: observe({ envelope })[0]!.attend! })[0]!.form
  }

  assert.deepEqual(formWith({ property: { type: 'string', title: 'Pick', enum: ['a', 'b'] } }), [{ name: 'pick', title: 'Pick', type: 'string', options: ['a', 'b'] }])
  assert.equal(formWith({ property: { type: 'string', default: 'a' } }), undefined, 'a default prefills the field')
  assert.equal(formWith({ property: { type: 'string', oneOf: [{ const: 'a', title: 'A' }] } }), undefined)
  assert.equal(formWith({ property: { type: 'integer', minimum: 1 } }), undefined)
  assert.equal(formWith({ property: { type: 'string', enum: 'abcdefghi'.split('') } }), undefined, 'a long choice list')
})

test('an answered request no longer holds back a new one', () => {
  const answered = { ...permission, answered: 'r1' }
  const note = { kind: 'permission', key: 'hook:notification', blocking: true, text: 'Claude needs your permission' }
  const change = { add: note, ifNone: true }
  assert.deepEqual(attend({ current: [answered], change }), [note, answered])
  assert.deepEqual(attend({ current: [permission], change }), [permission])
})

test('a delivered answer marks its request answered and frees the card until the session moves on', () => {
  const event = ({ seq, type, data }: { seq: number; type: string; data: unknown }): BoardEvent =>
    ({ v: 1, seq, id: `e${seq}`, at: `2026-10-14T17:00:0${seq}Z`, actor: 'cli', cardId: 'c1', type, data }) as BoardEvent
  const pushed = event({ seq: 1, type: 'card.pushed', data: { key: 'claude:s', agent: { provider: 'claude-code', sessionId: 's' }, attention: [permission] } })
  type Receipt = { seq: number; state: string; answers?: string }
  const reply = ({ seq, state, answers = requestId({ request: permission }) }: Receipt) =>
    event({ seq, type: 'card.replied', data: { reply: `r${seq}`, state, route: 'terminal:tmux', answers } })
  const queued = replay({ state: emptyBoard(), events: [pushed, reply({ seq: 2, state: 'queued' })] })
  assert.equal(queued.cards.c1!.attention[0]!.answered, undefined)
  // An answer written for an earlier request under the same key leaves this one open.
  const stale = replay({
    state: queued,
    events: [reply({ seq: 3, state: 'delivered', answers: `${permission.key}#00000000` })],
  })
  assert.equal(stale.cards.c1!.attention[0]!.answered, undefined)
  const delivered = replay({ state: queued, events: [reply({ seq: 3, state: 'delivered' })] })
  assert.deepEqual(delivered.cards.c1!.attention, [{ ...permission, answered: 'r3' }])
  assert.equal(delivered.sessions!['claude-code:s']!.attention[0]!.answered, 'r3')
})

function hosts() {
  const root = mkdtempSync(join(tmpdir(), 'pnyx-a-'))
  const bin = join(root, 'bin')
  const stub = join(root, 'stub')
  mkdirSync(bin)
  mkdirSync(stub)

  for (const name of ['tmux', 'paseo', 'herdr', 'osascript', 'ps']) {
    symlinkSync(HOST, join(bin, name))
  }

  writeFileSync(join(stub, 'ps.out'), 'ttys042\n')
  writeFileSync(join(stub, 'tmux.out'), `${TTY}\n`)
  const env = { ...process.env, PNYX_HOME: join(root, 'pnyx'), STUB_DIR: stub, PATH: `${bin}:/usr/bin:/bin` }
  const run = ({ args }: { args: string[] }) => execFileSync(process.execPath, [BIN, ...args], { env, encoding: 'utf8' })
  const fails = ({ args, pattern }: { args: string[]; pattern: RegExp }) =>
    assert.throws(() => run({ args }), (e: { stdout?: string }) => pattern.test(String(e.stdout)))

  const calls = () => {
    const log = join(stub, 'calls.log')

    return existsSync(log) ? readFileSync(log, 'utf8').split('---\n')
      .filter(Boolean) : []
  }

  type Terminal = Record<string, string>
  type Session = { key: string; provider: string; terminal: Terminal; attention: Attention[] }

  const session = ({ key, provider, terminal, attention }: Session) => {
    const file = join(root, `${key}.json`)
    writeFileSync(file, JSON.stringify({ agent: { provider, sessionId: key }, terminal: { tty: TTY, pid: '4242', ...terminal }, attention }))
    run({ args: ['push', '--key', key, '--file', file] })
  }

  const set = ({ file, text }: { file: string; text: string }) =>
    writeFileSync(join(stub, file), text)

  return { root, run, fails, calls, session, set }
}

const TMUX = { program: 'tmux', tmux: '/tmp/tmux-1/default', tmuxPane: '%3' }

test('an answer is typed as keys into the tmux pane, once, and marks the request answered', () => {
  const { root, run, fails, calls, session } = hosts()
  session({ key: 's1', provider: 'claude-code', terminal: TMUX, attention: [multi] })
  const answer = JSON.stringify({ answers: [{ pick: [2] }, { pick: [1, 3] }] })
  const seen = requestId({ request: multi })
  fails({ args: ['reply', 's1', '--answer', multi.key, '--json', answer, '--seen', `${multi.key}#00000000`], pattern: /code: REVISION_CONFLICT/ })
  fails({ args: ['reply', 's1', '--answer', 'hook:tool:Bash', '--json', answer], pattern: /no open request with key hook:tool:Bash/ })
  fails({ args: ['reply', 's1', '--answer', multi.key, '--json', '{"answers":[]}'], pattern: /one answer for each/ })
  fails({ args: ['reply', 's1', '--answer', multi.key, '--json', 'nope'], pattern: /not valid JSON/ })
  assert.equal(calls().length, 0)

  assert.match(run({ args: ['reply', 's1', '--answer', multi.key, `--json=${answer}`, `--seen=${seen}`, '--idempotency-key', 'a1'] }), /state: delivered/)
  const sent = calls().filter(c => c.includes('arg=send-keys'))
    .map(c => c.split('arg=--\narg=')[1]!.replace(/\n$/, ''))
  assert.deepEqual(sent, ['2', '1', '3', KEY.right, '1'])
  assert.ok(calls().every(c => !/load-buffer|paste-buffer/.test(c)), 'keys are typed, never pasted')
  assert.match(calls()[1]!, /arg=display-message/)
  assert.match(run({ args: ['card', 's1'] }), /answered: a1/)
  assert.ok(readFileSync(join(root, 'pnyx', 'boards', 'default', 'events.jsonl'), 'utf8')
    .includes(`"text":"Pick a color → Blue\\nPick sizes → Small, Large","answers":"${seen}"`))
  // The same key never answers twice, and an answered request takes no other answer.
  assert.match(run({ args: ['reply', 's1', '--answer', multi.key, '--json', answer, '--idempotency-key', 'a1'] }), /sent: false/)
  fails({ args: ['reply', 's1', '--answer', multi.key, '--json', answer], pattern: /no open request/ })
})

test('Codex takes keys in tmux too; Paseo, Herdr, iTerm2 and Terminal are answered in the session', () => {
  const { run, fails, calls, session } = hosts()
  session({ key: 's1', provider: 'codex', terminal: TMUX, attention: [codex] })
  assert.match(run({ args: ['reply', 's1', '--answer', codex.key, '--json', '{"choice":"deny","text":"skip it"}'] }), /state: delivered/)
  const sent = calls().filter(c => c.includes('arg=send-keys'))
    .map(c => c.split('arg=--\narg=')[1]!.replace(/\n$/, ''))
  assert.deepEqual(sent, [KEY.escape, 'skip it', KEY.enter])

  const others: Record<string, string>[] = [
    { program: 'kitty', paseoTerminal: 'term-1' },
    { program: 'kitty', herdrSession: 'h1', herdrPane: 'p1' },
    { program: 'iTerm.app' },
    { program: 'Apple_Terminal' },
  ]

  for (const [i, terminal] of others.entries()) {
    session({ key: `o${i}`, provider: 'claude-code', terminal, attention: [permission] })
    fails({ args: ['reply', `o${i}`, '--answer', permission.key, '--json', '{"choice":"allow"}'], pattern: /that can be answered here/ })
  }

  fails({ args: ['reply', 'o0', '--answer', permission.key, '--json', '{"choice":"allow"}', '--text', 'hi'], pattern: /--answer takes --json/ })
  fails({ args: ['reply', 'o0', '--text', 'hi', '--json', '{}'], pattern: /--json and --seen go with --answer/ })
  assert.equal(calls().filter(c => /call=(paseo|herdr|osascript)/.test(c)).length, 0)
})

test('a failure after the first key leaves the answer unconfirmed, never retyped', () => {
  const { run, calls, session, set } = hosts()
  session({ key: 's1', provider: 'claude-code', terminal: TMUX, attention: [plan] })
  // tmux call 1 checks the pane, call 2 types 3, call 3 (the text) fails.
  set({ file: 'tmux.exit.3', text: '1' })
  const args = ['reply', 's1', '--answer', plan.key, '--json', '{"choice":"revise","text":"smaller"}', '--idempotency-key', 'p1']
  assert.match(run({ args }), /state: delivery_unknown\n {2}detail: "the answer was typed only in part/)
  assert.equal(calls().filter(c => c.includes('arg=send-keys')).length, 2)
  assert.match(run({ args }), /sent: false/)
  // Keys from another answer could land on the next prompt, so none is typed.
  const again = ['reply', 's1', '--answer', plan.key, '--json', '{"choice":"approve"}', '--idempotency-key', 'p2']
  assert.throws(() => run({ args: again }), (e: { stdout?: string }) => /code: SESSION_WAITING/.test(String(e.stdout)))
  assert.equal(calls().filter(c => c.includes('arg=send-keys')).length, 2)
  assert.doesNotMatch(run({ args: ['card', 's1'] }), /answered/)
})
