import assert from 'node:assert/strict'
import { test } from 'node:test'
import { HYDRA_CARD } from '../../src/core/hydra.ts'
import { openPage, scenarioGroup, until } from './harness.ts'

const pnyx = scenarioGroup({
  retryDelays: [
    100,
    200,
  ],
})

// A Hydra on Codex that has answered once and whose session a restart closed, so its next start resumes the thread.
const codexHydra = async () => {
  const s = await pnyx.scenario()
  const page = await openPage({
    port: pnyx.port(),
    hydraId: s.hydraId,
  })
  // The owner picks Codex for Hydra in the composer's agent picker.
  await page.command({
    name: 'hydra-agent',
    args: [JSON.stringify({ harness: 'codex' })],
  })
  await page.command({
    name: 'hydra',
    args: [
      'send',
      '--text=Hello',
    ],
  })
  const finished = () => s.state().cards[HYDRA_CARD]?.sessionActivity === 'finished'
  await until({
    what: 'Hydra to answer its first message',
    check: finished,
  })
  page.close()
  await pnyx.restart()
  const reopened = await openPage({
    port: pnyx.port(),
    hydraId: s.hydraId,
  })

  return {
    s,
    page: reopened,
    finished,
    say: ({ text }: { text: string }) => reopened.command({
      name: 'hydra',
      args: [
        'send',
        `--text=${text}`,
      ],
    }),
    pnyxLines: () => (s.state().hydraMessages ?? []).filter(m => m.actor === 'pnyx').map(m => m.text),
    statuses: () => s.events().flatMap(e => e.type === 'hydra.status' ? [e.data.state] : []),
  }
}

test(
  'Hydra that cannot start is shown down in Pnyx’s voice, retried quietly, and comes back with a recap of the owner’s unanswered messages',
  async () => {
    const {
      s,
      page,
      finished,
      say,
      pnyxLines,
      statuses,
    } = await codexHydra()
    pnyx.codex.control.refuse = 'thread/resume'

    await say({ text: 'is it working now?' })
    const down = await page.shows({
      what: 'Hydra down on the page',
      check: ({ state }) => state.hydraStatus?.state === 'down' && state.hydraStatus,
    })
    assert.match(
      down.detail ?? '',
      /refused thread\/resume/,
    )
    assert.deepEqual(
      pnyxLines().map(line => /^Hydra could not start: .+ Pnyx is retrying/.test(line)),
      [true],
    )

    const folder = s.folder({ name: 'app' })
    await s.owner({
      args: [
        'task',
        'create',
        '--title',
        'Ship it',
        '--key',
        'ship',
        '--folder',
        folder,
      ],
    })
    await s.owner({
      args: [
        'task',
        'start',
        'ship',
      ],
    })
    const worker = s.as({ agent: await s.agent({ cwd: folder }) })

    // Each owner message tries again and hears of its own failure; a worker's wake and the timer stay quiet.
    await say({ text: 'how is the release going?' })
    await worker.run({
      args: [
        'hydra',
        'send',
        '--task',
        'ship',
        '--text',
        'Release notes are written.',
      ],
    })
    const refused = pnyx.codex.control.refused
    await until({
      what: 'more retries after the worker report',
      check: () => pnyx.codex.control.refused >= refused + 2,
    })
    assert.equal(
      pnyxLines().length,
      2,
    )

    pnyx.codex.control.refuse = undefined
    // The resumed session only exists once a start works.
    await until({
      what: 'Hydra up',
      check: () => s.state().hydraStatus?.state === 'up',
    })
    const hydra = await s.agent({ hydra: true })
    const recap = await until({
      what: 'the recap turn',
      check: () => hydra.received.find(text => text.includes('back after outage')),
    })
    assert.deepEqual(
      recap.slice(recap.indexOf('<pnyx-wake>')).split('\n')
        .filter(line => line.startsWith('- '))
        .map(line => line.replace(
          /^- \S+: /,
          '',
        )),
      [
        'is it working now?',
        'how is the release going?',
      ],
    )
    assert.match(
      recap,
      /A worker report and any other changes from the outage reach you in your next wake\./,
    )
    assert.match(
      recap,
      /\nOpen decisions: none\n/,
    )
    // The worker's report comes once, in its own wake after the recap.
    await until({
      what: 'the worker report to reach Hydra',
      check: () => hydra.received.some(text => text.includes('Release notes are written.')) && finished(),
    })
    assert.equal(
      hydra.received.filter(text => text.includes('Release notes are written.')).length,
      1,
    )
    assert.match(
      pnyxLines().at(-1)!,
      /^Hydra is back after \d+ min\.$/,
    )
    assert.deepEqual(
      statuses(),
      [
        'down',
        'up',
      ],
    )

    // A later message is answered in a turn of its own; the outage never starts a second recap.
    await say({ text: 'thanks' })
    await until({
      what: 'Hydra to answer the later message',
      check: () => hydra.received.some(text => text.includes('thanks')) && finished(),
    })
    assert.equal(
      s.events().filter(e => /^back:\d+:hosted$/.test(e.id)).length,
      1,
    )
    assert.equal(
      pnyxLines().length,
      3,
    )
    page.close()
  },
)

test(
  'a server restart while Hydra is down keeps retrying until Hydra is back, with no message from the owner',
  async () => {
    const {
      s,
      page,
      say,
      statuses,
    } = await codexHydra()
    pnyx.codex.control.refuse = 'thread/resume'
    await say({ text: 'are you there?' })
    await until({
      what: 'Hydra down',
      check: () => s.state().hydraStatus?.state === 'down',
    })
    page.close()
    await pnyx.restart()
    pnyx.codex.control.refuse = undefined
    await until({
      what: 'Hydra up after the restart',
      check: () => s.state().hydraStatus?.state === 'up',
    })
    assert.deepEqual(
      statuses(),
      [
        'down',
        'up',
      ],
    )
  },
)
