import assert from 'node:assert/strict'
import { test } from 'node:test'
import { HYDRA_CARD } from '../../src/core/hydra.ts'
import { hydraPill } from '../../web/src/hydra/chat.ts'
import { openPage, scenarioGroup, until } from './harness.ts'

const pnyx = scenarioGroup({
  retryDelays: [
    100,
    200,
  ],
})

test(
  'Hydra that cannot start is shown down in Pnyx’s voice, retried quietly, and comes back with a recap of what it missed',
  async () => {
    const s = await pnyx.scenario()
    let page = await openPage({
      port: pnyx.port(),
      hydraId: s.hydraId,
    })
    // The owner picks Codex for Hydra in the composer's agent picker.
    await page.command({
      name: 'hydra-agent',
      args: [JSON.stringify({ harness: 'codex' })],
    })
    const say = ({ text }: { text: string }) => page.command({
      name: 'hydra',
      args: [
        'send',
        `--text=${text}`,
      ],
    })
    const finished = () => s.state().cards[HYDRA_CARD]?.sessionActivity === 'finished'
    await say({ text: 'Hello' })
    await until({
      what: 'Hydra to answer its first message',
      check: finished,
    })
    // A restart closes Hydra's session, so the next message has to resume its thread.
    page.close()
    await pnyx.restart()
    page = await openPage({
      port: pnyx.port(),
      hydraId: s.hydraId,
    })
    pnyx.codex.control.refuse = 'thread/resume'
    const pnyxLines = () => (s.state().hydraMessages ?? []).filter(m => m.actor === 'pnyx').map(m => m.text)

    await say({ text: 'is it working now?' })
    const down = await page.shows({
      what: 'Hydra down in the header',
      check: ({ state }) => state.hydraStatus?.state === 'down' && state.hydraStatus,
    })
    assert.match(
      down.detail ?? '',
      /refused thread\/resume/,
    )
    assert.ok(hydraPill({
      status: down,
      working: false,
      starting: false,
    }).down)
    assert.deepEqual(
      pnyxLines().map(line => /^Hydra could not start: .+ Pnyx keeps trying/.test(line)),
      [true],
    )

    // Each owner message tries again and hears of its own failure; timer retries stay quiet.
    await say({ text: 'how is the release going?' })
    await until({
      what: 'timer retries after the owner\'s two tries',
      check: () => pnyx.codex.control.refused >= 4,
    })
    assert.equal(
      pnyxLines().length,
      2,
    )

    pnyx.codex.control.refuse = undefined
    await page.shows({
      what: 'Hydra up again in the header',
      check: ({ state }) => state.hydraStatus?.state === 'up',
    })
    const hydra = await s.agent({ hydra: true })
    const recap = await until({
      what: 'the recap turn',
      check: () => hydra.received.find(text => text.includes('back after outage')),
    })
    assert.match(
      pnyxLines().at(-1)!,
      /^Hydra is back after \d+ min\.$/,
    )
    assert.match(
      recap,
      /- the owner at \S+: is it working now\?\n- the owner at \S+: how is the release going\?/,
    )
    await until({
      what: 'Hydra to finish the recap',
      check: finished,
    })
    assert.equal(
      hydra.received.filter(text => text.includes('back after outage')).length,
      1,
    )
    page.close()
  },
)

test(
  'the Hydra Pnyx runs is refused hydra check --wait, which would hold the owner\'s messages, and the owner is not',
  async () => {
    const s = await pnyx.scenario()
    await s.owner({
      args: [
        'hydra',
        'send',
        '--text',
        'Hello',
      ],
    })
    const hydra = s.as({ agent: await s.agent({ hydra: true }) })
    assert.equal(
      await hydra.refused({
        args: [
          'hydra',
          'check',
          '--wait',
          '1',
        ],
      }),
      'VALIDATION_ERROR',
    )
    await hydra.run({
      args: [
        'hydra',
        'check',
      ],
    })
    await s.owner({
      args: [
        'hydra',
        'check',
        '--wait',
        '1',
      ],
    })
  },
)
