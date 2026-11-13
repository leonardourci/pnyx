import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test, type TestContext } from 'node:test'
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { HYDRA_CARD } from '#hydra/identity.ts'
import { runFixture } from '#test-harness/child-fixture.ts'
import { openPage, until } from '#test-harness/harness.ts'
import { pnyx, type Scenario } from '#test-harness/pnyx.ts'
import type { ThreadPage } from '#hydra/transcripts-read.ts'
import { assertConversation } from '#test-harness/conversation.ts'

const HELD = 'Held while compacting'

// Claude Code sends `compacting` when a compaction starts and again every 30 seconds while it runs, each under a new uuid.
const compacting = (): SDKMessage => ({
  type: 'system',
  subtype: 'status',
  status: 'compacting',
  uuid: randomUUID(),
  session_id: '',
})

const compacted = (): SDKMessage => ({
  type: 'system',
  subtype: 'status',
  status: null,
  compact_result: 'success',
  uuid: randomUUID(),
  session_id: '',
})

// Sends /compact to a Hydra that has answered once, holds it after `before` while the owner sends a message, and returns the operations once Hydra is back.
async function compact({
  t,
  s,
  before,
  after,
}: {
  t: TestContext
  s: Scenario
  before: SDKMessage[]
  after: SDKMessage[]
}) {
  await s.chat({ text: 'Ready to compact' })
  const agent = await s.agent({ hydra: true })
  await until({
    what: 'Hydra to finish its first turn',
    check: () => s.answered({ cwd: agent.cwd }) === 1 && s.state().cards[HYDRA_CARD]?.sessionActivity === 'finished',
  })
  const turn = pnyx.claude.plan({
    text: '/compact',
    hold: true,
    before,
    after,
  })
  const page = await openPage({
    port: pnyx.port(),
    hydraId: s.hydraId,
  })
  t.after(() => page.close())

  try {
    await s.chat({ text: '/compact' })
    await until({
      what: 'the compaction to run',
      check: () => s.state().cards[HYDRA_CARD]?.compaction?.operations.some(operation => operation.state === 'running'),
    })
    await s.owner({
      args: [
        'hydra',
        'send',
        '--text',
        HELD,
      ],
    })
    // The message waits in Hydra's queue while the compaction stops Hydra; nothing holds it apart.
    await until({
      what: 'the owner’s message to wait for the compaction',
      check: () => s.state().hydraOperation?.kind === 'compaction'
        && s.state().hydraMessages?.some(message => message.text === HELD),
    })
    assert.ok(!s.received({ cwd: agent.cwd }).some(text => text.includes(HELD)))
    // The page's queue row shows it held.
    const heldId = s.state().hydraMessages!.find(message => message.text === HELD)!.id
    const shown = await until({
      what: 'the page’s queue to hold the owner’s message',
      check: () => page.queue()?.chat?.held.includes(heldId) && page.queue()!.chat,
    })
    assert.deepEqual(
      {
        holding: shown.holding,
        compactionRunning: shown.compactionRunning,
        held: shown.held,
        inputs: shown.compactInputs.map(input => input.text),
      },
      {
        holding: true,
        compactionRunning: true,
        held: [heldId],
        inputs: [HELD],
      },
    )
  } finally {
    turn.release()
  }

  // Back from the compaction, Hydra's first turn recaps what waited, the owner's message among it.
  await until({
    what: 'the waiting message to reach Hydra in its recap after the compaction',
    check: () => !s.state().hydraOperation
      && s.received({ cwd: agent.cwd }).some(text => text.includes('back after a stop') && text.includes(HELD)),
  })
  assert.ok(s.state().hydraMessages?.some(message => message.kind === 'divider'))
  await until({
    what: 'the page’s queue to release the held message',
    check: () => {
      const chat = page.queue()?.chat

      return chat?.holding === false && chat.held.length === 0
    },
  })

  await until({
    what: 'the recap turn to finish',
    check: () => s.state().cards[HYDRA_CARD]?.sessionActivity === 'finished',
  })
  const final = (await page.command({
    name: 'thread',
    args: [HYDRA_CARD],
  })).thread as ThreadPage
  assertConversation({
    state: s.state(),
    page: final,
  })

  return s.state().cards[HYDRA_CARD]!.compaction!.operations
}

test(
  'a clean manual compaction with no queued owner question needs no recap turn',
  async t => {
    const s = await pnyx.scenario()
    await s.chat({ text: 'Ready to compact' })
    const agent = await s.agent({ hydra: true })
    await until({
      what: 'the initial owner turn to finish',
      check: () => s.state().cards[HYDRA_CARD]?.sessionActivity === 'finished',
    })
    const turn = pnyx.claude.plan({
      text: '/compact',
      hold: true,
      before: [compacting()],
      after: [compacted()],
    })
    t.after(() => turn.release())
    await s.chat({ text: '/compact' })
    await until({
      what: 'the manual compaction to start',
      check: () => s.state().hydraOperation?.kind === 'compaction',
    })
    turn.release()
    await until({
      what: 'the manual compaction to finish',
      check: () => !s.state().hydraOperation && s.state().cards[HYDRA_CARD]?.sessionActivity === 'finished',
    })
    await s.chat({ text: 'Anything new?' })
    await until({
      what: 'the next owner turn to finish',
      check: () => s.received({ cwd: agent.cwd }).at(-1)
        ?.includes('Anything new?')
        && s.state().cards[HYDRA_CARD]?.sessionActivity === 'finished',
    })
    assert.deepEqual(
      s.received({ cwd: agent.cwd }).filter(text => text.includes('<pnyx-wake>'))
        .map(text => text.slice(text.indexOf('<pnyx-wake>'))),
      [],
    )
  },
)

test(
  'a long manual /compact stays one operation through Claude Code’s repeated statuses, and its result releases held input',
  async t => {
    const s = await pnyx.scenario()
    const operations = await compact({
      t,
      s,
      before: [compacting()],
      after: [
        compacting(),
        compacting(),
        compacted(),
      ],
    })
    assert.deepEqual(
      operations.map(({
        trigger,
        state,
      }) => ({
        trigger,
        state,
      })),
      [
        {
          trigger: 'manual',
          state: 'done',
        },
      ],
    )
  },
)

test(
  'a compaction that leads straight into another shows them one after the other, and held input waits for the last',
  async t => {
    const s = await pnyx.scenario()
    const operations = await compact({
      t,
      s,
      before: [compacting()],
      after: [
        compacted(),
        compacting(),
        compacting(),
        compacted(),
      ],
    })
    assert.deepEqual(
      operations.map(({
        trigger,
        state,
      }) => ({
        trigger,
        state,
      })),
      [
        {
          trigger: 'manual',
          state: 'done',
        },
        {
          trigger: 'auto',
          state: 'done',
        },
      ],
    )
    assert.equal(
      s.state().historyMilestones?.filter(item => item.kind === 'compaction' && item.state === 'finished').length,
      2,
    )
    assert.equal(
      s.state().hydraMessages?.filter(message => message.kind === 'divider' && message.text === 'Compacted').length,
      2,
    )
    // One recap, after the second compaction ended, carries what waited through both.
    const agent = await s.agent({ hydra: true })
    const recaps = s.received({ cwd: agent.cwd }).filter(text => text.includes('back after a stop'))
    assert.equal(
      recaps.length,
      1,
    )
    // Both compactions are one stop of Hydra: it starts once and ends once.
    assert.deepEqual(
      s.events().filter(event => event.type === 'hydra.operation')
        .map(event => event.data.state),
      [
        'started',
        'finished',
      ],
    )
  },
)

test(
  'compactions stay one operation through late statuses, fail at their deadline and hold input until the last ends',
  async t => {
    assert.match(
      await runFixture({
        t,
        name: 'compaction-deadline',
      }),
      /Compactions kept one operation each, failed at their deadline and released held input after the last/,
    )
  },
)
