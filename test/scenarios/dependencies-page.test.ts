import assert from 'node:assert/strict'
import { test } from 'node:test'
import { browserGroup } from './browser.ts'
import { scenarioGroup } from './harness.ts'

const pnyx = scenarioGroup()
const chrome = browserGroup()

test(
  'task detail names the prerequisite and updates after completion and reconnect',
  async () => {
    const s = await pnyx.scenario()
    await s.owner({
      args: [
        'task',
        'create',
        '--key',
        'base',
        '--title',
        'Prepare API',
      ],
    })
    await s.owner({
      args: [
        'task',
        'create',
        '--key',
        'client',
        '--title',
        'Build client',
      ],
    })
    const page = await chrome.open({ url: `http://127.0.0.1:${pnyx.port()}/hydra/${s.hydraId}/` })
    const card = `.card[data-task="${s.task({ key: 'client' }).id}"]`
    await page.shows({
      what: 'the connected Hydra and its closed client card',
      arg: { card },
      check: ({ card }) => document.querySelector('[data-connected="true"]')
        && document.querySelector(card)?.classList.contains('selected') === false,
    })
    await page.click({ selector: `${card} .card-state` })
    await page.shows({
      what: 'task detail before prerequisites',
      check: () => document.querySelector('[aria-label="Details for Build client"]'),
    })
    await s.owner({
      args: [
        'task',
        'depend',
        'client',
        '--on',
        'base',
      ],
    })
    const detailText = await page.shows({
      what: 'prerequisites in task detail',
      check: () => document.querySelector('[aria-label="Details for Build client"] [aria-label="Prerequisites"]')?.textContent,
    })
    assert.match(
      detailText,
      /Prepare API.*Waiting: not completed/s,
    )
    await s.owner({
      args: [
        'task',
        'status',
        'base',
        'done',
      ],
    })
    await page.shows({
      what: 'completed prerequisite',
      check: () => document.querySelector('[aria-label="Details for Build client"] [aria-label="Prerequisites"]')?.textContent?.includes('Complete'),
    })
    await pnyx.restart()
    await page.shows({
      what: 'completion after reconnect',
      check: () => document.querySelector('[aria-label="Details for Build client"] [aria-label="Prerequisites"]')?.textContent?.includes('Complete'),
    })
    await s.owner({
      args: [
        'task',
        'status',
        'base',
        'working',
      ],
    })
    await page.shows({
      what: 'reopened prerequisite',
      check: () => document.querySelector('[aria-label="Details for Build client"] [aria-label="Prerequisites"]')?.textContent?.includes('Waiting: working'),
    })
    await page.close()
  },
)
