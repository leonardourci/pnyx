import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { AgentSession } from '../src/core/model.ts'
import { emptyBoard, replay } from '../src/core/reducer.ts'
import { decidePush, decideSession } from '../src/core/decide.ts'
import { checkAttachments, terminalPresence } from '../src/integrations/presence/check.ts'

const session: AgentSession = {
  id: 'claude-code:worker', agent: { provider: 'claude-code', sessionId: 'worker' }, originCardId: 'c1', taskId: 'c2', attention: [], sourceRefs: [], terminal: { pid: '123', tty: '/dev/ttys123' }, lastSeen: '2026-10-15T10:00:00Z',
}

test('agent presence uses reboot evidence and verified process ownership, with unknown for errors', () => {
  const bootedAt = Date.parse('2026-10-15T09:00:00Z')
  assert.equal(terminalPresence({ session, bootedAt, run: () => 'ttys123' }).state, 'present')
  assert.equal(terminalPresence({ session: { ...session, activity: 'ended' }, verifyProcess: true, bootedAt, run: () => 'ttys123' }).state, 'present')
  assert.equal(terminalPresence({
    session: { ...session, activity: 'ended' },
    verifyProcess: true,
    bootedAt,
    run: () => {
      throw Object.assign(new Error('exited'), { status: 1 })
    },
  }).state, 'gone')
  assert.equal(terminalPresence({ session, bootedAt, run: () => 'ttys999' }).state, 'gone')

  for (const current of ['ttys999', '?', '']) {
    assert.equal(terminalPresence({ session, verifyProcess: true, bootedAt, run: () => current }).state, 'unknown')
  }

  assert.equal(terminalPresence({ session, bootedAt: bootedAt + 7200000, run: () => assert.fail('must not probe a reused pid after reboot') }).state, 'gone')
  assert.equal(terminalPresence({
    session,
    bootedAt,
    run: () => {
      throw new Error('unavailable')
    },
  }).state, 'unknown')
  assert.equal(terminalPresence({ session: { ...session, terminal: undefined }, bootedAt }).state, 'unknown')
})

test('attachment metadata and last observation survive event replay and manual task edits', async () => {
  const meta = { actor: 'test', at: '2026-10-15T10:00:00Z' }
  let state = emptyBoard()
  const first = decidePush({ state, key: 'worker', input: { agent: session.agent, terminal: session.terminal, source: { adapter: 'hooks', objectId: 'worker', observedAt: meta.at } }, meta })
  assert.ok('event' in first)
  state = replay({ state, events: [first.event] })
  const task = decidePush({ state, key: 'task', input: { title: 'Task' }, meta })
  assert.ok('event' in task)
  state = replay({ state, events: [task.event] })
  const attached = decideSession({ state, ref: session.id, task: 'c2', meta })
  assert.ok('event' in attached)
  state = replay({ state, events: [attached.event] })
  const edit = decidePush({ state, key: 'task', input: { title: 'Renamed' }, meta: { ...meta, at: '2026-10-15T11:00:00Z' } })
  assert.ok('event' in edit)
  state = replay({ state, events: [edit.event] })
  assert.equal(state.sessions?.[session.id]?.lastSeen, meta.at)
  assert.equal(state.cards.c2?.launch?.via, 'hooks')
  const result = await checkAttachments({ state, probe: () => ({ state: 'gone', detail: 'fixture reboot' }) })
  assert.equal(result[0]?.task, 'c2')
  assert.equal(result[0]?.lastSeen, meta.at)
  assert.equal(result[0]?.state, 'gone')
})
