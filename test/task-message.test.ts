import assert from 'node:assert/strict'
import { cpSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { commands } from '../src/cli/commands.ts'
import { sendTaskMessage } from '../src/cli/task-message.ts'
import { decidePush, decideReply } from '../src/core/decide.ts'
import { emptyHydra, replay } from '../src/core/reducer.ts'
import { loadHydra, readEvents, withWriter } from '../src/store/hydra-store.ts'
import { readThread, type ThreadEntry } from '../src/thread/read.ts'
import { paseoHistory } from '../src/integrations/paseo/history.ts'
import { taskConversation, taskUpdates, withTaskReceipts } from '../src/thread/task.ts'
import { taskPrompt } from '../src/cli/start.ts'

function fixture() {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'pnyx-task-message-')))
  process.env.PNYX_HOME = home; process.env.PNYX_SEMANTIC = 'off'
  commands.hydra(['create', 'default'])
  commands.task(['create', '--key', 'work', '--title', 'Keep task context', '--brief', 'Read the migration plan'])
  cpSync(join(import.meta.dirname, 'fixtures/firstmate-home'), join(home, 'firstmate'), { recursive: true })
  const state = () => loadHydra({ hydraId: 'default' }).state
  const card = () => state().cards[state().keys.work!]!
  const send = ({ id = 'message-1', text = 'Check the rollback path' }: { id?: string; text?: string } = {}) => sendTaskMessage({ hydraId: 'default', request: { card: card().id, id, text, homes: [join(home, 'firstmate')], actor: 'web' } })
  const thread = () => readThread({ hydraId: 'default', state: state(), card: card(), homes: [] })
  const agent = ({ firstmate = false }: { firstmate?: boolean } = {}) => withWriter({
    hydraId: 'default',
    fn: ({ writer }) => {
      const decision = decidePush({ state: writer.state, key: 'work', input: { agent: { provider: 'claude-code', sessionId: 'fixture' }, ...(firstmate ? { source: { adapter: 'firstmate', instanceId: join(home, 'firstmate'), objectId: 'work' } } : {}) }, meta: { at: new Date().toISOString(), actor: 'hydra' } })
      assert.ok('event' in decision); writer.append({ event: decision.event })
    },
  })

  return {
    home,
    state,
    card,
    send,
    thread,
    agent,
    close: () => rmSync(home, { recursive: true, force: true }),
  }
}

test('an unassigned task preserves its prompt and messages in one stream and queues Hydra once', async () => {
  const f = fixture()

  try {
    commands.task(['brief', 'work', '--brief', 'A revised plan'])
    const sent = await f.send()
    assert.deepEqual(sent.routes, { hydra: { state: 'queued' } })
    assert.equal(sent.state, 'queued')
    await f.send()
    assert.equal(f.state().hydraMessages?.filter(m => m.text === 'Check the rollback path').length, 1)
    assert.equal(f.state().hydraMessages?.at(-1)?.task, f.card().id)
    assert.equal(f.card().agent, undefined)
    const entries = taskConversation({ card: f.card(), entries: f.thread().entries })
    assert.deepEqual(entries.map(e => e.text), ['Read the migration plan', 'Check the rollback path'])
    const repeated = taskConversation({ card: f.card(), entries: [{ id: 'repeat', kind: 'message', role: 'You', text: 'Read the migration plan' }] })
    assert.equal(repeated.length, 2)
    assert.deepEqual(entries.at(-1)?.delivery, { hydra: { state: 'queued', detail: undefined } })
    assert.deepEqual(replay({ state: emptyHydra(), events: readEvents({ hydraId: 'default' }) }), f.state())
  } finally {
    f.close()
  }
})

test('the task conversation shows the brief once and hides hosted launch instructions', () => {
  const f = fixture()

  try {
    const entries = taskConversation({
      card: f.card(),
      entries: [
        { id: 'launch', kind: 'message', role: 'user', text: taskPrompt({ hydraId: 'default', card: f.card() }) },
        { id: 'answer', kind: 'message', role: 'assistant', text: 'I will read the plan.' },
      ],
    })
    assert.deepEqual(entries.map(e => e.text), ['Read the migration plan', 'I will read the plan.'])
  } finally {
    f.close()
  }
})

test('a missing worker route retains the message and exposes failure while Hydra remains queued', async () => {
  const f = fixture()

  try {
    f.agent()
    const receipt = await f.send()
    assert.equal(receipt.state, 'failed')
    assert.equal(receipt.routes.agent?.state, 'failed')
    assert.match(receipt.routes.agent?.detail ?? '', /no reply route/)
    assert.equal(receipt.routes.hydra.state, 'queued')
    assert.equal(f.thread().entries.at(-1)?.delivery?.agent?.state, 'failed')
    await f.send()
    assert.equal(f.thread().entries.length, 1)
  } finally {
    f.close()
  }
})

test('partial and uncertain deliveries retry only failed worker sends and keep route receipts', async () => {
  const f = fixture()
  const native = join(f.home, 'firstmate')
  cpSync(join(import.meta.dirname, 'fixtures/firstmate-home'), native, { recursive: true })

  try {
    f.agent({ firstmate: true })
    writeFileSync(join(native, 'send-exit'), '2')
    assert.equal((await f.send()).routes.agent?.state, 'failed')
    rmSync(join(native, 'send-exit'))
    assert.equal((await f.send()).routes.agent?.state, 'delivered')
    const log = readFileSync(join(native, 'sent.log'), 'utf8')
    await f.send()
    assert.equal(readFileSync(join(native, 'sent.log'), 'utf8'), log)
    const retried = await sendTaskMessage({ hydraId: 'default', request: { card: f.card().id, text: 'Check the rollback path', id: 'message-1', homes: [] } })
    assert.equal(retried.routes.agent?.state, 'delivered')
    assert.equal(f.state().hydraMessages?.filter(m => m.text === 'Check the rollback path').length, 1)
    assert.equal(f.thread().entries.length, 1)
    assert.equal(f.thread().entries[0]?.delivery?.agent?.state, 'delivered')
    writeFileSync(join(native, 'send-exit'), '3')
    const unknown = await f.send({ id: 'message-2', text: 'Confirm the canary' })
    assert.equal(unknown.state, 'delivery_unknown')
    const uncertain = readFileSync(join(native, 'sent.log'), 'utf8')
    await f.send({ id: 'message-2', text: 'Confirm the canary' })
    assert.equal(readFileSync(join(native, 'sent.log'), 'utf8'), uncertain)
  } finally {
    f.close()
  }
})

test('factual declarations use the same task reference in the card stream and Hydra updates', () => {
  const f = fixture()

  try {
    commands.task(['status', 'work', 'working', '--note', 'The migration passes locally', '--actor', 'worker'])
    commands.task(['status', 'work', 'working', '--note', 'A user state edit', '--actor', 'web'])
    const updates = taskUpdates({ card: f.card() })
    assert.equal(updates.length, 1)
    assert.equal(updates[0]?.role, 'assistant')
    assert.equal(updates[0]?.task, f.card().id)
    assert.equal(updates[0]?.text, 'The migration passes locally')
    assert.deepEqual(taskConversation({ card: f.card(), entries: [] }).slice(1), updates)
  } finally {
    f.close()
  }
})

test('a failed Hydra inbox route is reported and repaired without resending a delivered worker message', async () => {
  const f = fixture()
  const native = join(f.home, 'firstmate')

  try {
    f.agent({ firstmate: true })
    commands.hydra(['set', '--firstmate', native])
    writeFileSync(join(native, 'inbox-exit'), '1')
    const failed = await f.send()
    assert.equal(failed.state, 'failed')
    assert.equal(failed.routes.agent?.state, 'delivered')
    assert.equal(failed.routes.hydra.state, 'failed')
    assert.equal(f.thread().entries[0]?.delivery?.hydra.state, 'failed')
    const sent = readFileSync(join(native, 'sent.log'), 'utf8')
    rmSync(join(native, 'inbox-exit'))
    assert.equal((await f.send()).state, 'delivered')
    assert.equal(readFileSync(join(native, 'sent.log'), 'utf8'), sent)
    assert.equal(f.state().hydraMessages?.filter(m => m.text === 'Check the rollback path').length, 1)
    const notes = JSON.parse(readFileSync(join(native, 'inbox.json'), 'utf8')) as { body: string }[]
    assert.equal(notes.length, 1)
    assert.match(notes[0]?.body ?? '', new RegExp(f.card().id))
  } finally {
    f.close()
  }
})

test('an unassigned Firstmate task addresses Hydra and never sends to a worker', async () => {
  const f = fixture()
  const native = join(f.home, 'firstmate')

  try {
    commands.hydra(['set', '--firstmate', native])
    const sent = await f.send()
    assert.equal(sent.routes.agent, undefined)
    assert.equal(sent.routes.hydra.state, 'delivered')
    assert.equal(f.card().agent, undefined)
    await f.send()
    const notes = JSON.parse(readFileSync(join(native, 'inbox.json'), 'utf8')) as unknown[]
    assert.equal(notes.length, 1)
  } finally {
    f.close()
  }
})

test('native timelines retain task delivery receipts and show failed sends absent from the timeline', () => {
  const base = { card: 'task', route: true, watching: 'unknown' as const }
  const delivery = { agent: { state: 'delivered' as const }, hydra: { state: 'queued' as const } }
  const sent = { id: 'sent', replyId: 'reply-1', kind: 'message' as const, role: 'You', text: 'Context', delivery }
  const failed = { ...sent, id: 'failed', replyId: 'reply-2', text: 'Follow up', delivery: { ...delivery, agent: { state: 'failed' as const } } }
  const result = withTaskReceipts({
    native: { ...base, entries: [{ ...sent, id: 'native', role: 'user', delivery: undefined }] },
    saved: { ...base, entries: [sent, failed] },
  })
  assert.deepEqual(result.entries, [sent, failed])
})

test('old snapshots rebuild the original prompt after the working brief changed', () => {
  const f = fixture()

  try {
    commands.task(['brief', 'work', '--brief', 'The revised plan'])
    const path = join(f.home, 'hydras', 'default', 'snapshot.json')
    const snapshot = JSON.parse(readFileSync(path, 'utf8'))
    snapshot.rules = 11
    delete snapshot.state.cards[f.card().id].initialPrompt
    writeFileSync(path, JSON.stringify(snapshot))
    assert.equal(f.card().initialPrompt, 'Read the migration plan')
    assert.equal(f.card().brief, 'The revised plan')
  } finally {
    f.close()
  }
})

test('repeated text cannot replace a different native message with a failed receipt', () => {
  const base = { card: 'task', route: true, watching: 'unknown' as const }
  const native = { id: 'older', replyId: 'older-reply', kind: 'message' as const, role: 'user', text: 'Yes' }
  const failed = { id: 'newer', replyId: 'newer-reply', kind: 'message' as const, role: 'You', text: 'Yes', receipt: 'failed' as const }
  const result = withTaskReceipts({
    native: { ...base, entries: [native] }, saved: { ...base, entries: [failed] },
  })
  assert.deepEqual(result.entries, [native, failed])
  assert.deepEqual(withTaskReceipts({ native: { ...base, entries: [{ ...native, replyId: undefined }] }, saved: { ...base, entries: [failed] } }).entries.map(e => e.id), ['older', 'newer'])
})

test('saved task history remains pageable after the native timeline has no older page', async () => {
  const f = fixture()

  try {
    withWriter({
      hydraId: 'default',
      fn: ({ writer }) => {
        for (let i = 0; i < 135; i++) {
          const decision = decideReply({ state: writer.state, ref: 'work', data: { reply: `reply-${i}`, route: 'hydra', state: 'queued', taskMessage: true, text: `Context ${i}` }, meta: { at: new Date(1700000000000 + i).toISOString(), actor: 'web' } })
          assert.ok('event' in decision); writer.append({ event: decision.event })
        }
      },
    })
    let reads = 0
    const conversation = {
      read: async () => {
        reads++

        return { card: f.card().id, route: true, watching: 'unknown' as const, entries: [{ id: 'native', kind: 'message' as const, role: 'assistant', text: 'Native reply' }] }
      },
    }
    const entries: ThreadEntry[] = []
    let before: string | undefined

    do {
      const page = await paseoHistory({ card: f.card().id, conversation, readSaved: ({ before }) => readThread({ hydraId: 'default', state: f.state(), card: f.card(), homes: [], before }), before })
      entries.push(...page.entries)
      before = page.older
    } while (before)

    assert.equal(reads, 1)
    assert.equal(entries.filter(e => e.text.startsWith('Context ')).length, 135)
    assert.equal(new Set(entries.map(e => e.id)).size, 136)
  } finally {
    f.close()
  }
})

test('native and saved pagination advance independently and reapply current receipt states', async () => {
  const f = fixture()

  try {
    await f.send()
    const saved = f.thread()
    const first = saved.entries[0]!
    let nativeReads = 0
    const nativeBefore = `p${Buffer.from(JSON.stringify({ epoch: 'fixture', seq: 2 })).toString('base64url')}`
    const conversation = {
      read: async ({ before }: { before?: string }) => {
        nativeReads++

        return { ...saved, entries: [{ ...first, receipt: undefined, delivery: undefined, role: 'user' }], older: before ? undefined : nativeBefore }
      },
    }
    const page = await paseoHistory({ card: f.card().id, conversation, readSaved: () => saved })
    assert.ok(page.older)
    const earlier = await paseoHistory({
      card: f.card().id,
      conversation,
      readSaved: () => {
        throw new Error('Saved source must stay exhausted')
      },
      before: page.older,
    })
    assert.equal(nativeReads, 2)
    assert.equal(earlier.older, undefined)
    const projected = taskConversation({ card: f.card(), entries: earlier.entries })
    assert.equal(projected.at(-1)?.receipt, 'queued')
    assert.equal(projected.at(-1)?.delivery?.hydra.state, 'queued')
  } finally {
    f.close()
  }
})
