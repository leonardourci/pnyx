import assert from 'node:assert/strict'
import { test } from 'node:test'
import { hydraEvent, HYDRA_CARD } from '../../src/core/hydra.ts'
import { withWriter } from '../../src/store/hydra-store.ts'
import type { HelperChange } from '../../src/helper/state.ts'
import { browserGroup } from './browser.ts'
import { claudeRecording } from './fake-agents.ts'
import { scenarioGroup, until } from './harness.ts'

const pnyx = scenarioGroup()
const chrome = browserGroup()

test(
  'the queue counts updates across tasks, lists reading and waiting kinds, and separates helper usage',
  async () => {
    const s = await pnyx.scenario()

    for (const [
      key,
      title,
    ] of [
        [
          'dates',
          'Fix date parsing',
        ],
        [
          'csv',
          'Add CSV export',
        ],
      ]) {
      await s.owner({
        args: [
          'task',
          'create',
          '--key',
          key!,
          '--title',
          title!,
        ],
      })
    }

    const append = ({ change }: { change: HelperChange }) => withWriter({
      hydraId: s.hydraId,
      fn: ({ writer }) => {
        const decision = hydraEvent({
          state: writer.state,
          cardId: HYDRA_CARD,
          meta: {
            at: new Date().toISOString(),
            actor: 'pnyx',
          },
          change,
        })
        assert.ok('event' in decision)
        writer.append({ event: decision.event })
      },
    })
    append({
      change: {
        type: 'hydra.helper-started',
        data: {
          id: 'measured',
          tasks: [s.task({ key: 'dates' }).id],
          seqs: [],
          prompt: 'Progress',
        },
      },
    })
    append({
      change: {
        type: 'hydra.helper-finished',
        data: {
          batch: 'measured',
          outcomes: [],
          usage: {
            cost: 0.18,
            used: 2400,
            inputTokens: 4800,
          },
        },
      },
    })
    await s.chat({ text: 'Watch the reports' })
    await until({
      what: 'the opening turn to finish',
      check: () => s.state().cards[HYDRA_CARD]?.sessionActivity === 'finished',
    })
    const held = pnyx.claude.plan({
      text: '</pnyx-wake>',
      hold: true,
      reply: 'NO_REPLY',
    })
    const page = await chrome.open({ url: `http://127.0.0.1:${pnyx.port()}/hydra/${s.hydraId}/` })
    const reports = ({ keys }: { keys: string[] }) => withWriter({
      hydraId: s.hydraId,
      fn: ({ writer }) => {
        for (const key of keys) {
          const task = writer.state.keys[key]!
          const decision = hydraEvent({
            state: writer.state,
            cardId: HYDRA_CARD,
            meta: {
              at: new Date().toISOString(),
              actor: `worker:${task}`,
            },
            change: {
              type: 'hydra.message',
              data: {
                hydra: 'hydra',
                action: 'send',
                task,
                text: 'Checks are ready.',
              },
            },
          })
          assert.ok('event' in decision)
          writer.append({ event: decision.event })
        }
      },
    })

    let releaseNext = () => {}

    try {
      reports({
        keys: [
          'dates',
          'dates',
          'csv',
        ],
      })
      await page.shows({
        what: 'three update records across two tasks',
        check: () => document.querySelector('.chat-running')?.textContent?.includes('Reading 3 updates across 2 tasks'),
      })
      reports({ keys: ['csv'] })
      await page.shows({
        what: 'a waiting update beside the three being read',
        check: () => document.querySelector('.chat-running')?.textContent?.includes('+1 waiting'),
      })
      const inventory = await page.shows({
        what: 'the queue inventory on keyboard focus',
        check: () => {
          document.querySelector<HTMLElement>('.chat-running .tooltip-anchor > span')?.focus()

          return document.querySelector('[role="tooltip"]')?.textContent
        },
      })
      assert.match(
        inventory,
        /Reading 3 updates/,
      )
      assert.match(
        inventory,
        /Waiting 1 update/,
      )
      assert.equal(
        inventory.split('Fix date parsing · report').length - 1,
        2,
      )
      assert.equal(
        inventory.split('Add CSV export · report').length - 1,
        2,
      )
      const result = claudeRecording.turn.find(message => message.type === 'result' && 'total_cost_usd' in message)
      assert.ok(result?.type === 'result')
      const usage = await page.shows({
        what: 'separate Hydra and helper cost on focus',
        check: () => {
          document.querySelector<HTMLElement>('.usage-ring')?.focus()
          const text = document.querySelector('[role="tooltip"]')?.textContent

          return text?.includes('Routine helper') && text
        },
      })
      assert.ok(usage.includes(`Hydra session $${result.total_cost_usd.toFixed(2)}`))
      assert.ok(usage.includes('Routine helper · 1 batch'))
      assert.ok(usage.includes('Cost $0.18'))
      assert.ok(usage.includes('Total input 5k tokens'))
      assert.ok(usage.includes(`Combined $${(result.total_cost_usd + 0.18).toFixed(2)}`))
      const next = pnyx.claude.plan({
        text: '</pnyx-wake>',
        hold: true,
        reply: 'NO_REPLY',
      })
      releaseNext = next.release
      append({
        change: {
          type: 'hydra.helper-started',
          data: {
            id: 'unknown',
            tasks: [s.task({ key: 'dates' }).id],
            seqs: [],
            prompt: 'Progress',
          },
        },
      })
      append({
        change: {
          type: 'hydra.helper-finished',
          data: {
            batch: 'unknown',
            outcomes: [],
          },
        },
      })
      held.release()
      await page.shows({
        what: 'the next single-task update without a multiple-task count',
        check: () => {
          const text = document.querySelector('.chat-running')?.textContent

          return text?.includes('Reading 1 update') && !text.includes('across')
        },
      })
      await page.click({ selector: '.usage-ring' })
      await page.press({ key: 'Tab' })
      const partial = await page.shows({
        what: 'unmeasured helper spend kept visibly incomplete',
        check: () => {
          document.querySelector<HTMLElement>('.usage-ring')?.focus()
          const text = document.querySelector('[role="tooltip"]')?.textContent

          return text?.includes('measured 1/2 batches') && text
        },
      })
      assert.ok(!partial.includes('Combined'))
    } finally {
      held.release()
      releaseNext()
      await page.close()
    }
  },
)
