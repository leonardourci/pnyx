import assert from 'node:assert/strict'
import { test } from 'node:test'
import { HYDRA_CARD } from '#hydra/identity.ts'
import { until } from '#test-harness/harness.ts'
import { runFixture } from '#test-harness/child-fixture.ts'
import { pnyx } from '#test-harness/pnyx.ts'

test(
  'a recorded wait resumes its worker exactly once through server restarts',
  async () => {
    const s = await pnyx.scenario()
    const folder = s.folder({ name: 'client' })
    await s.owner({
      args: [
        'task',
        'create',
        '--key',
        'base',
        '--title',
        'Shared component',
      ],
    })
    await s.owner({
      args: [
        'task',
        'create',
        '--key',
        'client',
        '--title',
        'Client task',
        '--folder',
        folder,
      ],
    })
    await s.owner({
      args: [
        'task',
        'start',
        'client',
        '--harness',
        'codex',
      ],
    })
    const first = await s.agent({ cwd: folder })
    await until({
      what: 'opening worker turn',
      check: () => first.answered === 1,
    })
    await s.as({ agent: first }).run({
      args: [
        'task',
        'status',
        'client',
        'paused',
        '--wait-for',
        'base',
        '--ready-when',
        'pr-opened',
      ],
    })
    await pnyx.restart()
    assert.equal(
      s.task({ key: 'client' }).wait?.condition,
      'pr-opened',
    )
    assert.equal(
      s.received({ cwd: folder }).length,
      1,
    )
    const url = s.pullRequest({
      number: 42,
      title: 'Shared component',
      state: 'open',
    })
    await s.owner({
      args: [
        'link',
        'base',
        '--url',
        url,
      ],
    })
    await until({
      what: 'dependency steer to resume the worker',
      check: () => s.received({ cwd: folder }).some(text => text.includes('Dependency ready: Shared component')),
    })
    assert.equal(
      s.task({ key: 'client' }).wait,
      undefined,
    )
    assert.ok(s.received({ cwd: folder }).at(-1)!.includes(url))
    await until({
      what: 'resume steer marked read',
      check: () => s.task({ key: 'client' }).steering?.[0]?.ack?.outcome === 'read',
    })
    await pnyx.restart()
    await s.owner({
      args: [
        'reply',
        'client',
        '--text',
        'Synthetic restart boundary',
      ],
    })
    await until({
      what: 'worker to drain the restarted delivery queue',
      check: () => s.received({ cwd: folder }).some(text => text.includes('Synthetic restart boundary'))
      && s.task({ key: 'client' }).sessionActivity === 'finished',
    })
    assert.equal(
      s.events().filter(event => event.type === 'task.wait-resumed').length,
      1,
    )
    assert.equal(
      s.received({ cwd: folder }).filter(text => text.includes('Dependency ready: Shared component')).length,
      1,
    )
  },
)

test(
  'an owner answer stays quiet and reaches Hydra once on its next turn after restart',
  async () => {
    const s = await pnyx.scenario()
    const folder = s.folder({ name: 'client' })
    const hydra = await s.chat({ text: 'Track the synthetic task.' })
    await until({
      what: 'Hydra opening turn',
      check: () => s.state().cards[HYDRA_CARD]?.sessionActivity === 'finished',
    })
    await s.owner({
      args: [
        'task',
        'create',
        '--key',
        'client',
        '--title',
        'Client task',
        '--folder',
        folder,
      ],
    })
    await s.owner({
      args: [
        'task',
        'start',
        'client',
        '--harness',
        'codex',
      ],
    })
    const worker = await s.agent({ cwd: folder })
    await until({
      what: 'worker opening turn',
      check: () => worker.answered === 1,
    })
    await s.as({ agent: worker }).run({
      args: [
        'task',
        'status',
        'client',
        'paused',
        '--note',
        'Waiting for an answer',
      ],
    })
    await s.as({ agent: worker }).run({
      args: [
        'task',
        'ask',
        'client',
        '--question',
        'Which format should be used?',
      ],
    })
    const ask = s.task({ key: 'client' }).asks!.at(-1)!
    await until({
      what: 'question turn to finish',
      check: () => hydra.received.some(text => text.includes(ask.id))
      && s.state().cards[HYDRA_CARD]?.sessionActivity === 'finished',
    })
    const heard = hydra.received.length
    await s.owner({
      args: [
        'task',
        'answer',
        'client',
        ask.id,
        '--text',
        'Use the compact format.',
      ],
    })
    assert.ok(
      s.state().contextNotes?.some(note => note.text.includes('Use the compact format.')),
      JSON.stringify(s.events().slice(-10)),
    )
    await until({
      what: 'worker answer turn to finish',
      check: () => s.received({ cwd: folder }).some(text => text.includes('Use the compact format.'))
      && s.task({ key: 'client' }).sessionActivity === 'finished',
    })
    assert.equal(
      hydra.received.length,
      heard,
    )
    await pnyx.restart()
    const resumed = await s.chat({ text: 'Continue the next turn.' })
    const delivered = await until({
      what: 'context on the next Hydra turn',
      check: () => resumed.received.find(text => text.includes('Since your last turn')),
    })
    assert.match(
      delivered,
      /context only; these facts need no action or reply/,
    )
    assert.match(
      delivered,
      /Which format should be used\?.*Use the compact format\./,
    )
    await until({
      what: 'delivered notes removed',
      check: () => s.state().contextNotes?.length === 0,
    })
    await s.chat({ text: 'Another turn.' })
    assert.doesNotMatch(
      resumed.received.at(-1)!,
      /Owner answered/,
    )
  },
)

test(
  'failed turns retain context and active-turn joins defer new notes',
  async t => {
    const output = await runFixture({
      t,
      name: 'quiet-context',
    })
    assert.match(
      output,
      /Failed turns retain context and active-turn joins defer new notes/,
    )
  },
)
