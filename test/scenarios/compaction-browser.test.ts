import assert from 'node:assert/strict'
import { test } from 'node:test'
import { HYDRA_CARD } from '../../src/core/hydra.ts'
import { browserGroup } from './browser.ts'
import { scenarioGroup, until } from './harness.ts'

const pnyx = scenarioGroup()
const chrome = browserGroup()

for (const harness of [
  'claude',
  'codex',
] as const) {
  test(
    `${harness}: compact picker, queue and Send now preserve selected-first delivery in the browser`,
    async () => {
      const s = await pnyx.scenario()
      await s.owner({
        args: [
          'rule',
          'set',
          'hydra',
          '--harness',
          harness,
        ],
      })
      const held = pnyx[harness].plan({
        text: '/compact',
        hold: true,
      })
      const page = await chrome.open({ url: `http://127.0.0.1:${pnyx.port()}/hydra/${s.hydraId}/` })

      try {
        await until({
          what: 'the initial harness settings save',
          check: () => {
            const agent = s.state().config?.hydra.agent

            return agent?.harness === harness && agent.model && agent.effort && agent.mode && agent.fast === false
          },
        })
        await page.shows({
          what: 'the connected composer and saved settings',
          check: () => document.querySelector('button[aria-label="Fast mode"]:not(:disabled)'),
        })
        await page.click({ selector: '.hydra-chat textarea' })
        await page.type({ text: '/comp' })
        await page.shows({
          what: 'native compact offered before the first turn',
          check: () => document.querySelector('.slash-menu [role=option] strong')?.textContent === '/compact',
        })
        await page.press({ key: 'Enter' })
        await page.shows({
          what: 'compact command selected in the draft',
          check: () => document.querySelector('.hydra-chat .draft-skill')?.textContent?.includes('/compact')
            && !document.querySelector('.slash-menu'),
        })
        await page.press({ key: 'Enter' })
        await until({
          what: 'recorded compact operation',
          check: () => s.state().cards[HYDRA_CARD]?.compaction?.operations.length,
        })
        assert.equal(
          s.state().cards[HYDRA_CARD]!.compaction!.operations.at(-1)!.state,
          'running',
          JSON.stringify(s.state().cards[HYDRA_CARD]!.compaction),
        )
        await page.shows({
          what: 'running compaction with elapsed time and Stop',
          check: () => /Compacting… \d+:\d{2}/.test(document.querySelector('.compaction-row[data-state=running]')?.textContent ?? '')
            && document.querySelector('.composer-stop'),
        })

        for (const text of [
          'First queued',
          'Second queued',
        ]) {
          await page.click({ selector: '.hydra-chat textarea' })
          await page.type({ text })
          await page.press({ key: 'Enter' })
          await page.shows({
            what: 'saved message clears the draft before typing another',
            check: () => document.querySelector<HTMLTextAreaElement>('.hydra-chat textarea')?.value === '',
          })
          await until({
            what: `durable queued message ${text}`,
            check: () => s.state().cards[HYDRA_CARD]?.compaction?.inputs
              .some(input => input.text === text),
          })
        }

        await page.shows({
          what: 'two queued messages above the composer, absent from chat',
          check: () => document.querySelector('.compaction-queue')?.textContent?.includes('Queued messages (2)')
            && !document.querySelector('.hydra-chat .messages')?.textContent?.includes('First queued')
            && !document.querySelector('.hydra-chat .messages')?.textContent?.includes('Second queued'),
        })
        await page.click({ selector: '.compaction-queue summary' })
        await page.shows({
          what: 'both pending controls expanded',
          check: () => document.querySelectorAll('.compaction-queued button[aria-label="Send now"]').length === 2,
        })
        await page.click({ selector: '.compaction-queued:last-child button[aria-label="Send now"]' })
        await until({
          what: 'selected message reaches the native provider first',
          check: () => s.state().cards[HYDRA_CARD]?.compaction?.inputs.length === 0
            && s.state().cards[HYDRA_CARD]?.sessionActivity === 'finished',
        })
        const agent = await s.agent({ hydra: true })
        assert.deepEqual(
          s.received({ cwd: agent.cwd }).map(text => text.split('\n\n').at(-1)
            ?.trim()),
          [
            '/compact',
            'Second queued',
            'First queued',
          ],
        )
        await page.shows({
          what: 'one cancelled row and the delivered messages once each',
          check: () => document.querySelectorAll('.compaction-row[data-state=cancelled]').length === 1
            && !document.querySelector('.compaction-queue')
            && [...document.querySelectorAll('.hydra-chat .message.mine')].filter(message => message.textContent?.includes('First queued')).length === 1
            && [...document.querySelectorAll('.hydra-chat .message.mine')].filter(message => message.textContent?.includes('Second queued')).length === 1,
        })
      } catch (error) {
        const visible = await page.shows({
          what: 'failure diagnostic',
          check: () => document.querySelector('.hydra-chat')?.textContent || '(empty chat)',
        })
        throw new Error(
          `${(error as Error).message}\n${JSON.stringify(s.state().cards[HYDRA_CARD]?.compaction)}\n${visible}`,
          { cause: error },
        )
      } finally {
        held.release()
        await page.close()
      }
    },
  )
}

test(
  'failed native compaction releases queued input and keeps its unavailable command disabled',
  async () => {
    const s = await pnyx.scenario()
    const held = pnyx.claude.plan({
      text: '/compact',
      hold: true,
      fail: 'Native compact is not supported',
    })
    const page = await chrome.open({ url: `http://127.0.0.1:${pnyx.port()}/hydra/${s.hydraId}/` })

    try {
      await s.owner({
        args: [
          'hydra',
          'send',
          '--text',
          '/compact',
        ],
      })
      await until({
        what: 'recorded compact operation',
        check: () => s.state().cards[HYDRA_CARD]?.compaction?.operations.length,
      })
      assert.equal(
        s.state().cards[HYDRA_CARD]!.compaction!.operations.at(-1)!.state,
        'running',
        JSON.stringify(s.state().cards[HYDRA_CARD]!.compaction),
      )
      await page.shows({
        what: 'running compact',
        check: () => document.querySelector('.compaction-row[data-state=running]'),
      })
      await page.click({ selector: '.hydra-chat textarea' })
      await page.type({ text: 'Continue after failure' })
      await page.press({ key: 'Enter' })
      await until({
        what: 'durable queued input',
        check: () => s.state().cards[HYDRA_CARD]?.compaction?.inputs.length === 1,
      })
      held.release()
      await page.shows({
        what: 'failed compact reason and released input',
        check: () => document.querySelector('.compaction-row[data-state=failed]')?.textContent?.includes('Native compact is not supported')
          && !document.querySelector('.compaction-queue')
          && document.querySelector('.hydra-chat .messages')?.textContent?.includes('Continue after failure'),
      })
      const agent = await s.agent({ hydra: true })
      await until({
        what: 'continuation finished',
        check: () => s.state().cards[HYDRA_CARD]?.sessionActivity === 'finished',
      })
      assert.equal(
        s.received({ cwd: agent.cwd }).filter(text => text.includes('Continue after failure')).length,
        1,
      )
      await page.click({ selector: '.hydra-chat textarea' })
      await page.type({ text: '/comp' })
      await page.shows({
        what: 'unavailable native compact remains visible with its reason',
        check: () => document.querySelector<HTMLButtonElement>('.slash-menu [role=option]')?.disabled
          && document.querySelector('.slash-menu')?.textContent?.includes('Unavailable: Native compact is not supported'),
      })
      await page.press({ key: 'Enter' })
      await page.shows({
        what: 'disabled command cannot be picked with the keyboard',
        check: () => document.querySelector<HTMLTextAreaElement>('.hydra-chat textarea')?.value === '/comp'
          && !document.querySelector('.draft-skill'),
      })
      assert.equal(
        s.received({ cwd: agent.cwd }).filter(text => text.trim() === '/compact').length,
        1,
      )
    } finally {
      held.release()
      await page.close()
    }
  },
)
