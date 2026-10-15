import assert from 'node:assert/strict'
import { appendFileSync, cpSync, existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, test } from 'node:test'
import { syncHome } from '../src/integrations/firstmate/sync.ts'
import { homeKey } from '../src/integrations/firstmate/home.ts'
import { commands } from '../src/cli/commands.ts'
import { hydraCheck } from '../src/cli/workers.ts'
import { hydraConfig, hydraEvent } from '../src/core/hydra.ts'
import { emptyHydra, reduce, replay } from '../src/core/reducer.ts'
import { loadHydra, readEvents, withWriter } from '../src/store/hydra-store.ts'
import { fireReminders } from '../src/reminders/fire.ts'
import { reminderDeadline, waitingReminders } from '../src/reminders/state.ts'
import { reminderTime } from '../src/reminders/time.ts'
import { startServer, type RunningServer } from '../src/server/server.ts'

const hydraId = 'reminders'
const now = '2026-10-15T12:00:00.000Z'
const later = '2099-10-16T12:00:00.000Z'
let home: string
let previous: string | undefined
let server: RunningServer | undefined
const state = () => loadHydra({ hydraId }).state
const task = () => state().cards[state().keys.work!]!
const run = ({ args }: { args: string[] }) => commands.task([...args, '--hydra', hydraId])

beforeEach(() => {
  previous = process.env.PNYX_HOME
  home = mkdtempSync(join(tmpdir(), 'pnyx-reminders-'))
  process.env.PNYX_HOME = home
  process.env.PNYX_SEMANTIC = 'off'
  commands.hydra(['create', hydraId])
  run({ args: ['create', '--key', 'work', '--title', 'Review cursor pagination'] })
})

afterEach(async () => {
  await server?.close(); server = undefined

  if (previous === undefined) {
    delete process.env.PNYX_HOME
  } else {
    process.env.PNYX_HOME = previous
  }

  rmSync(home, { recursive: true, force: true })
})

test('reminder times are explicit, future, timezone-aware, and tomorrow means local 9:00', () => {
  assert.equal(reminderTime({ when: '2026-10-16T09:00:00-03:00', now }), '2026-10-16T12:00:00.000Z')
  assert.equal(reminderTime({ when: 'in 2 hours', now }), '2026-10-15T14:00:00.000Z')
  const expected = new Date(now)
  expected.setDate(expected.getDate() + 1); expected.setHours(9, 0, 0, 0)
  assert.equal(reminderTime({ when: 'tomorrow', now }), expected.toISOString())
  expected.setHours(15, 30, 0, 0)
  assert.equal(reminderTime({ when: 'tomorrow at 15:30', now }), expected.toISOString())

  for (const when of ['2027-02-30T12:00Z', 'yesterday', now, '2026-10-14T12:00Z', '2026-10-16T09:00', 'tomorrow 25:00', 'in 0 hours', 'in 999999999999999999 days']) {
    assert.throws(() => reminderTime({ when, now }), /future reminder time/)
  }
})

test('CLI sets, replaces and clears reminders with idempotency and revision checks', async () => {
  assert.deepEqual(run({ args: ['reminders'] }), { hydraId, count: 0, reminders: 'none: no waiting reminders' })
  const before = task().revision
  run({ args: ['remind', 'work', later, '--event-id', 'first', '--if-revision', String(before)] })
  assert.equal(task().reminder?.at, later)
  assert.equal(task().reminder?.id, 'first')
  assert.ok(existsSync(join(home, 'hydras', hydraId, 'events.jsonl')))
  assert.equal(existsSync(join(home, 'boards', hydraId)), false)
  assert.equal(task().revision, before + 1)
  const seq = state().seq
  run({ args: ['remind', 'work', later, '--event-id', 'first', '--if-revision', '0'] })
  assert.equal(state().seq, seq)
  assert.throws(() => run({ args: ['remind', 'work', 'in 2 hours', '--if-revision', '0'] }), /revision/)
  assert.equal((await run({ args: ['reminders'] })).count, 1)
  run({ args: ['remind', 'work', '2099-10-17T12:00:00Z'] })
  assert.equal(task().reminder?.at, '2099-10-17T12:00:00.000Z')
  assert.equal(waitingReminders({ state: state() }).length, 1)
  run({ args: ['remind', 'work', 'clear'] })
  assert.equal(task().reminder, undefined)
  assert.equal(reminderDeadline({ state: state() }), undefined)
  assert.equal(fireReminders({ hydraId, at: '2100-01-01T00:00:00Z' }), 0)
  assert.throws(() => run({ args: ['remind', '$hydra', later] }), /Choose a task/)
  assert.throws(() => run({ args: ['remind', 'absent', later] }), /not found/)
})

test('due events fire once, reveal hidden tasks, use column roles and notify Hydra in one replayable event', async () => {
  const config = hydraConfig({ state: state(), id: hydraId })
  withWriter({
    hydraId,
    fn: ({ writer }) => {
      const decision = hydraEvent({ state: writer.state, meta: { at: now, actor: 'test' }, cardId: '$board', change: { type: 'board.columns', data: { columns: config.columns.map(column => column.role === 'needs_you' ? { ...column, id: 'custom:attention', title: 'Questions' } : column) } } })
      assert.ok('event' in decision); writer.append({ event: decision.event })
    },
  })
  run({ args: ['remind', 'work', later] })
  run({ args: ['hide', 'work'] })
  assert.equal(fireReminders({ hydraId, at: '2099-10-16T11:59:59.999Z' }), 0)
  assert.equal(fireReminders({ hydraId, at: later }), 1)
  assert.equal(fireReminders({ hydraId, at: later }), 0)
  assert.equal(task().column, 'custom:attention')
  assert.equal(task().hidden, false)
  assert.equal(task().status?.state, 'needs_you')
  assert.match(task().status!.note, /Reminder: Review cursor pagination/)
  assert.equal(task().reminder?.dueAt, later)
  assert.equal(waitingReminders({ state: state() }).length, 0)
  const messages = state().hydraMessages!
  assert.equal(messages.length, 1)
  assert.equal(messages[0]?.actor, 'hydra')
  assert.equal(messages[0]?.task, task().id)
  assert.deepEqual(replay({ state: emptyHydra(), events: readEvents({ hydraId }) }), state())
  const check = await hydraCheck({ args: ['check', '--after', '0', '--hydra', hydraId] })
  assert.match(JSON.stringify(check.changes), /task.reminder-due/)
  assert.match(JSON.stringify(commands.hydra(['messages', '--hydra', hydraId])), /Reminder: Review cursor pagination/)

  const due = readEvents({ hydraId }).find(event => event.type === 'task.reminder-due')!
  run({ args: ['remind', 'work', '2099-10-17T12:00:00Z'] })
  const current = state()
  const stale = reduce({ state: current, event: { ...due, seq: current.seq + 1, id: 'late-stale-due' } })
  assert.equal(stale.cards[task().id]?.reminder?.dueAt, undefined)
  assert.equal(stale.hydraMessages?.length, 1)
})

test('server catches missed reminders at startup and exposes the waiting list and count', async () => {
  run({ args: ['remind', 'work', later] })
  fireReminders({ hydraId, at: '2100-01-01T00:00:00Z' })
  run({ args: ['remind', 'work', 'clear'] })
  withWriter({
    hydraId,
    fn: ({ writer }) => {
      const decision = hydraEvent({ state: writer.state, meta: { at: now, actor: 'test' }, cardId: task().id, change: { type: 'task.reminder', data: { before: null, after: '2000-01-01T00:00:00.000Z' } } })
      assert.ok('event' in decision); writer.append({ event: decision.event })
    },
  })
  server = await startServer({ hydraId })
  await waitForDue()
  assert.equal(task().column, hydraConfig({ state: state() }).columns.find(column => column.role === 'needs_you')!.id)
  run({ args: ['remind', 'work', later] })
  let result: { count: number; reminders: { task: string }[] } | undefined

  for (let i = 0; i < 100; i++) {
    result = await fetch(new URL('reminders', server.url)).then(response => response.json()) as typeof result

    if (result?.count === 1) {
      break
    }

    await new Promise(resolve => setTimeout(resolve, 20))
  }

  assert.equal(result?.count, 1)
  assert.equal(result?.reminders[0]?.task, task().id)
  await server.close(); server = await startServer({ hydraId })
  await new Promise(resolve => setTimeout(resolve, 50))
  assert.equal(state().hydraMessages?.length, 2)
})

async function waitForDue() {
  for (let i = 0; i < 200; i++) {
    if (task().reminder?.dueAt) {
      return
    }

    await new Promise(resolve => setTimeout(resolve, 20))
  }

  assert.fail('server did not fire the reminder')
}

test('a running server fires without a later command and cancels a replaced deadline', async () => {
  run({ args: ['remind', 'work', new Date(Date.now() + 1500).toISOString()] })
  server = await startServer({ hydraId })
  run({ args: ['remind', 'work', later] })
  await new Promise(resolve => setTimeout(resolve, 1700))
  assert.equal(task().reminder?.dueAt, undefined)
  run({ args: ['remind', 'work', new Date(Date.now() + 500).toISOString()] })
  await waitForDue()
  assert.equal(state().hydraMessages?.length, 1)
})

test('a due reminder restores Needs you when its role column was deleted', () => {
  withWriter({
    hydraId,
    fn: ({ writer }) => {
      const decision = hydraEvent({ state: writer.state, meta: { at: now, actor: 'test' }, cardId: '$board', change: { type: 'board.columns', data: { columns: [{ id: 'custom:only', title: 'Work' }] } } })
      assert.ok('event' in decision); writer.append({ event: decision.event })
    },
  })
  run({ args: ['remind', 'work', later] })
  assert.equal(fireReminders({ hydraId, at: later }), 1)
  const column = state().config!.columns.find(column => column.role === 'needs_you')!
  assert.equal(column.title, 'Needs you')
  assert.equal(task().column, column.id)
  assert.deepEqual(replay({ state: emptyHydra(), events: readEvents({ hydraId }) }), state())
})

test('an expanded-year reminder cannot delay a nearer due reminder', () => {
  const far = reminderTime({ when: 'in 4000000 days', now })
  assert.match(far, /^\+/)
  assert.equal(reminderTime({ when: far, now }), far)
  run({ args: ['remind', 'work', far] })
  run({ args: ['create', '--key', 'near', '--title', 'Near reminder'] })
  run({ args: ['remind', 'near', later] })
  assert.deepEqual(waitingReminders({ state: state() }).map(reminder => reminder.at), [later, far])
  assert.equal(reminderDeadline({ state: state() }), Date.parse(later))
  assert.equal(fireReminders({ hydraId, at: later }), 1)
  assert.equal(state().cards[state().keys.near!]?.reminder?.dueAt, later)
  assert.equal(task().reminder?.dueAt, undefined)
  assert.equal(fireReminders({ hydraId, at: later }), 0)
})

test('unchanged Firstmate records keep a due reminder in Needs you until cleared or updated', () => {
  const nativePath = join(home, 'firstmate-fixture')
  cpSync(join(import.meta.dirname, 'fixtures/firstmate-home'), nativePath, { recursive: true })
  const nativeHome = realpathSync(nativePath)
  commands.hydra(['set', '--hydra', hydraId, '--firstmate', nativeHome])
  syncHome({ hydraId, home: nativeHome, at: now })
  const ref = `${homeKey({ home: nativeHome })}:later-1`
  const id = state().keys[ref]!
  const card = () => state().cards[id]!
  const columns = hydraConfig({ state: state() }).columns
  const queued = columns.find(column => column.role === 'queued')!.id
  const needsYou = columns.find(column => column.role === 'needs_you')!.id
  assert.equal(card().column, queued)
  run({ args: ['remind', ref, later] })
  fireReminders({ hydraId, at: later })
  assert.equal(card().column, needsYou)
  const reason = card().status?.note
  syncHome({ hydraId, home: nativeHome, at: later })
  assert.equal(card().column, needsYou)
  assert.equal(card().status?.note, reason)
  run({ args: ['remind', ref, 'clear'] })
  syncHome({ hydraId, home: nativeHome, at: later })
  assert.equal(card().column, queued)
  run({ args: ['remind', ref, later] })
  fireReminders({ hydraId, at: later })
  appendFileSync(join(nativeHome, 'state/later-1.status'), 'working: started the task\n')
  syncHome({ hydraId, home: nativeHome, at: later })
  assert.equal(card().column, queued)
  assert.equal(card().status?.state, 'working')
})
