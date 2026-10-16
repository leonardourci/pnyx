import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { commands } from '../src/cli/commands.ts'
import { decidePush } from '../src/core/decide.ts'
import { LABEL_COLORS, type HydraEvent } from '../src/core/model.ts'
import { emptyHydra, replay } from '../src/core/reducer.ts'
import { project } from '../src/projects/cli.ts'
import { hydraDir, loadHydra, readEvents, withWriter } from '../src/store/hydra-store.ts'

process.env.PNYX_SEMANTIC = 'off'

function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'pnyx-labels-'))
  process.env.PNYX_HOME = home
  const state = () => loadHydra({ hydraId: 'default' }).state
  const push = ({ key, input }: { key: string; input: unknown }) => withWriter({
    hydraId: 'default',
    fn: ({ writer }) => {
      const result = decidePush({ state: writer.state, key, input, meta: { actor: 'test', at: '2026-10-15T10:00:00Z' } })

      if ('event' in result) {
        writer.append({ event: result.event })
      }
    },
  })

  return { home, state, push }
}

test('project and tag colors are saved once, reused across tasks and survive movement and replay', () => {
  const { home, state, push } = fixture()

  try {
    push({ key: 'first', input: { title: 'First task', project: 'payments', tags: ['urgent'] } })
    const colors = state().labelColors
    assert.deepEqual(colors?.map(entry => entry.label), ['payments', 'urgent'])
    assert.ok(colors?.every(entry => LABEL_COLORS.includes(entry.color)))
    push({ key: 'second', input: { project: 'payments', tags: ['urgent'] } })
    commands.move(['first', 'done'])
    push({ key: 'first', input: { project: null, tags: [] } })
    push({ key: 'first', input: { project: 'payments', tags: ['urgent'] } })
    assert.deepEqual(state().labelColors, colors)
    const events = readEvents({ hydraId: 'default' })
    assert.equal(events.filter(event => event.labelColors?.length).length, 1)
    assert.deepEqual(events[0]?.labelColors, colors)
    rmSync(join(hydraDir({ hydraId: 'default' }), 'snapshot.json'))
    assert.deepEqual(state().labelColors, colors)
    assert.deepEqual(replay({ state: emptyHydra(), events }), state())
    const replayed = replay({ state: emptyHydra(), events })
    assert.deepEqual(replayed, replay({ state: emptyHydra(), events }))
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('existing labels load unchanged and receive saved colors on the next write without rewriting history', () => {
  const { home, state } = fixture()
  const event: HydraEvent = {
    v: 1,
    seq: 1,
    id: 'old',
    at: '2026-10-15T10:00:00Z',
    actor: 'test',
    cardId: 'task',
    type: 'card.pushed',
    data: { key: 'old', project: 'payments', tags: ['__proto__'] },
  }

  try {
    const dir = hydraDir({ hydraId: 'default' })
    mkdirSync(dir, { recursive: true })
    const original = `${JSON.stringify(event)}\n`
    writeFileSync(join(dir, 'events.jsonl'), original)
    assert.equal(state().labelColors, undefined)
    assert.equal(state().cards.task?.project, 'payments')
    commands.task(['rename', 'old', '--title', 'A saved task'])
    assert.deepEqual(state().labelColors?.map(entry => entry.label), ['payments', '__proto__'])
    assert.ok(readFileSync(join(dir, 'events.jsonl'), 'utf8').startsWith(original))
    const events = readEvents({ hydraId: 'default' })
    assert.deepEqual(replay({ state: emptyHydra(), events }), state())
    const saved = state().labelColors
    const last = events.at(-1)
    assert.ok(last)
    const recolor: HydraEvent = { ...last, id: 'recolor', seq: last.seq + 1, labelColors: [{ label: 'payments', color: 'rose' }] }
    assert.deepEqual(replay({ state: state(), events: [recolor] }).labelColors, saved)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('attached projects save their color before a task uses it and keep it on reassignment', async () => {
  const { home, state } = fixture()
  const folder = join(home, 'payments-api')
  mkdirSync(folder)

  try {
    await project(['add', folder])
    const colors = state().labelColors
    assert.equal(colors?.[0]?.label, folder)
    commands.task(['create', '--key', 'first', '--title', 'First task', '--project', folder])
    commands.task(['create', '--key', 'second', '--title', 'Second task'])
    commands.task(['project', 'second', '--project', folder])
    assert.deepEqual(state().labelColors, colors)
    assert.equal(state().cards[state().keys.second ?? '']?.project, folder)
    assert.equal(readEvents({ hydraId: 'default' }).filter(event => event.labelColors?.length).length, 1)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
