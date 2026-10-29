import assert from 'node:assert/strict'
import { test } from 'node:test'
import { openPage } from '#test-harness/harness.ts'
import { pnyx } from '#test-harness/pnyx.ts'

test(
  'one apply reaches the live page, history and Oracle and survives a server restart',
  async () => {
    const s = await pnyx.scenario()
    const page = await openPage({
      port: pnyx.port(),
      hydraId: s.hydraId,
    })
    await s.owner({
      args: [
        'oracle',
        'Quasar',
      ],
    })
    const document = {
      version: 1,
      changes: [
        {
          op: 'task.create',
          as: 'research',
          key: 'research',
          title: 'Synthetic Quasar research',
        },
        {
          op: 'task.create',
          as: 'build',
          key: 'build',
          title: 'Synthetic Quasar export',
        },
        {
          op: 'task.depend',
          task: '$build',
          on: ['$research'],
        },
        {
          op: 'task.brief',
          task: '$build',
          brief: 'Use Quasar findings',
        },
        {
          op: 'task.status',
          task: '$research',
          status: 'working',
          note: 'Comparing Quasar formats',
        },
      ],
    }
    const result = await s.owner({
      args: [
        'apply',
        '--file',
        '-',
        '--event-id',
        'quasar-plan',
      ],
      input: JSON.stringify(document),
    })
    assert.match(
      result,
      /applied: true/,
    )
    const research = s.task({ key: 'research' }).id
    const build = s.task({ key: 'build' }).id
    await page.shows({
      what: 'both tasks and their complete dependency and status changes',
      check: ({ state }) =>
        state.cards[build]?.prerequisites?.includes(research)
      && state.cards[build]?.brief === 'Use Quasar findings'
      && state.cards[research]?.status?.state === 'working',
    })
    const history = await s.owner({
      args: [
        'task',
        'history',
        build,
        '--full',
      ],
    })
    assert.match(
      JSON.stringify(history),
      /task.dependencies/,
    )
    assert.match(
      JSON.stringify(history),
      /Use Quasar findings/,
    )
    const oracle = await s.owner({
      args: [
        'oracle',
        'Quasar',
      ],
    })
    assert.match(
      JSON.stringify(oracle),
      /Synthetic Quasar export/,
    )
    assert.match(
      JSON.stringify(oracle),
      /Synthetic Quasar research/,
    )
    page.close()
    await pnyx.restart()
    const restored = await openPage({
      port: pnyx.port(),
      hydraId: s.hydraId,
    })
    await restored.shows({
      what: 'the apply state after restart',
      check: ({ state }) =>
        state.cards[build]?.prerequisites?.includes(research)
      && state.cards[research]?.status?.state === 'working',
    })
    const retry = await s.owner({
      args: [
        'apply',
        '--file',
        '-',
        '--event-id',
        'quasar-plan',
      ],
      input: JSON.stringify(document),
    })
    assert.match(
      retry,
      /duplicate: true/,
    )
    assert.match(
      retry,
      new RegExp(research),
    )
    assert.match(
      retry,
      new RegExp(build),
    )
    restored.close()
  },
)
