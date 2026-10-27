import assert from 'node:assert/strict'
import { test } from 'node:test'
import { HYDRA_CARD } from '../../src/core/hydra.ts'
import { openPage, scenarioGroup, until } from '../../src/test-harness/harness.ts'

// Retries wait longer than any test here, so only the owner's messages try to start Hydra.
const pnyx = scenarioGroup({ retryDelays: [600_000] })

test(
  'an owner message while Hydra is down tries the start again; once it works Hydra answers it, then recaps only what no turn took',
  async () => {
    const s = await pnyx.scenario()
    let page = await openPage({
      port: pnyx.port(),
      hydraId: s.hydraId,
    })
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
    page.close()
    await pnyx.restart()
    page = await openPage({
      port: pnyx.port(),
      hydraId: s.hydraId,
    })
    pnyx.codex.control.refuse = 'thread/resume'
    await say({ text: 'lost to the outage' })
    await until({
      what: 'Hydra down',
      check: () => s.state().hydraStatus?.state === 'down',
    })

    pnyx.codex.control.refuse = undefined
    await say({ text: 'back yet?' })
    // The resumed session only exists once a start works.
    await until({
      what: 'Hydra up',
      check: () => s.state().hydraStatus?.state === 'up',
    })
    const hydra = await s.agent({ hydra: true })
    const recap = await until({
      what: 'the recap after the owner’s turn',
      check: () => hydra.received.find(text => text.includes('back after outage')),
    })
    assert.ok(hydra.received[0]!.includes('back yet?'))
    assert.deepEqual(
      recap.slice(recap.indexOf('<pnyx-wake>')).split('\n')
        .filter(line => line.startsWith('- '))
        .map(line => line.replace(
          /^- \S+: /,
          '',
        )),
      ['lost to the outage'],
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
