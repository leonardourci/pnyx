import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { openDecisions } from '../../src/core/decisions.ts'
import { browserGroup } from './browser.ts'
import { scenarioGroup } from './harness.ts'

const pnyx = scenarioGroup()
const chrome = browserGroup()

test(
  'report choices survive completion, origin hiding and restart, and the strip records the owner answer',
  async () => {
    const s = await pnyx.scenario()
    const folder = s.folder({ name: 'research' })
    await s.owner({
      args: [
        'task',
        'create',
        '--key',
        'report',
        '--title',
        'Cache investigation',
        '--kind',
        'investigation',
        '--folder',
        folder,
      ],
    })
    await s.owner({
      args: [
        'task',
        'start',
        'report',
      ],
    })
    const worker = s.as({ agent: await s.agent({ cwd: folder }) })
    const file = join(
      folder,
      'report.md',
    )
    writeFileSync(
      file,
      'The cache is slow. The owner must choose whether to retain historical entries.',
    )
    await worker.run({
      args: [
        'task',
        'report',
        'report',
        '--file',
        file,
      ],
    })
    const report = s.task({ key: 'report' }).report!
    assert.equal(
      await worker.refused({
        args: [
          'task',
          'ask',
          'report',
          '--from-report',
          'report',
          '--question',
          'Worker cannot link a Hydra question',
        ],
      }),
      'VALIDATION_ERROR',
    )
    assert.equal(
      await worker.refused({
        args: [
          'task',
          'status',
          'report',
          'done',
        ],
      }),
      'NOT_LANDED',
    )
    assert.equal(
      await s.ownerRefused({
        args: [
          'task',
          'hide',
          'report',
        ],
      }),
      'REPORT_REVIEW_REQUIRED',
    )
    const doneColumn = s.column({ role: 'done' })
    assert.ok(doneColumn)
    assert.equal(
      await s.ownerRefused({
        args: [
          'move',
          'report',
          doneColumn,
        ],
      }),
      'REPORT_REVIEW_REQUIRED',
    )
    assert.equal(
      await s.ownerRefused({
        args: [
          'outcome',
          'report',
          'done',
        ],
      }),
      'REPORT_REVIEW_REQUIRED',
    )
    assert.equal(
      await s.ownerRefused({
        args: [
          'task',
          'build',
          'report',
        ],
      }),
      'REPORT_REVIEW_REQUIRED',
    )
    await s.owner({
      args: [
        'task',
        'create',
        '--key',
        'cache',
        '--title',
        'Fix cache retention',
      ],
    })
    const hydra = s.as({ agent: await s.chat({ text: 'Review the cache report and ask about retention.' }) })
    await hydra.run({
      args: [
        'task',
        'ask',
        'cache',
        '--from-report',
        'report',
        '--question',
        'Retain historical cache entries?',
        '--choice',
        'Retain',
        '--choice',
        'Remove',
      ],
    })
    const ask = s.task({ key: 'cache' }).asks![0]!
    const call = `${s.task({ key: 'cache' }).id}/${ask.id}`
    assert.deepEqual(
      ask.origin,
      {
        task: s.task({ key: 'report' }).id,
        report: report.id,
      },
    )
    assert.equal(
      await worker.refused({
        args: [
          'task',
          'report-review',
          'report',
          '--report',
          report.id,
          '--none',
        ],
      }),
      'VALIDATION_ERROR',
    )
    assert.equal(
      await worker.refused({
        args: [
          'task',
          'report-review',
          'report',
          '--report',
          report.id,
          '--call',
          `${s.task({ key: 'cache' }).id}/missing`,
        ],
      }),
      'VALIDATION_ERROR',
    )
    await worker.run({
      args: [
        'task',
        'report-review',
        'report',
        '--report',
        report.id,
        '--call',
        call,
      ],
    })
    const count = s.events().filter(event => event.type === 'task.report-reviewed').length
    await worker.run({
      args: [
        'task',
        'report-review',
        'report',
        '--report',
        report.id,
        '--call',
        call,
      ],
    })
    assert.equal(
      s.events().filter(event => event.type === 'task.report-reviewed').length,
      count,
    )
    await worker.run({
      args: [
        'task',
        'status',
        'report',
        'done',
      ],
    })
    await s.owner({
      args: [
        'task',
        'hide',
        'report',
      ],
    })
    assert.equal(
      await s.ownerRefused({
        args: [
          'task',
          'hide',
          'cache',
        ],
      }),
      'OWNER_DECISION_PENDING',
    )
    assert.equal(
      s.task({ key: 'cache' }).column,
      s.column({ role: 'needs_you' }),
    )
    assert.equal(
      openDecisions({ state: s.state() }).filter(item => item.id === ask.id).length,
      1,
    )
    const page = await chrome.open({ url: `http://127.0.0.1:${pnyx.port()}/hydra/${s.hydraId}/` })
    await page.shows({
      what: 'the retained report choice above chat',
      check: () => document.querySelector('.waiting-decisions')?.textContent?.includes('Retain historical cache entries?'),
    })
    await pnyx.restart()
    await s.owner({
      args: [
        'task',
        'rename',
        'cache',
        '--title',
        'Cache work after restart',
      ],
    })
    await page.shows({
      what: 'the same choice after reconnect',
      check: () => document.querySelector('.waiting-decisions')?.textContent?.includes('Retain historical cache entries?') && !document.querySelector('.offline')
        && document.body.textContent?.includes('Cache work after restart'),
    })
    assert.equal(
      s.task({ key: 'cache' }).asks![0]!.closed,
      undefined,
    )
    assert.equal(
      await hydra.refused({
        args: [
          'task',
          'answer',
          'cache',
          ask.id,
          '--text',
          'Approved',
          '--reason',
          'recommended default',
        ],
      }),
      'OWNER_ONLY',
    )
    await page.click({ selector: '.waiting-decisions > .popover > button' })
    await page.click({ selector: '.waiting-decisions li button' })
    const answer = 'Retain existing history; only expire new entries after 30 days.'
    await s.owner({
      args: [
        'task',
        'answer',
        'cache',
        ask.id,
        '--text',
        answer,
      ],
    })
    await page.shows({
      what: 'only the answered choice disappears',
      check: () => !document.querySelector('.waiting-decisions'),
    })
    const decision = s.state().hydraMessages!.find(message => message.answers === ask.id)!
    assert.equal(
      decision.text,
      answer,
    )
    assert.ok(s.task({ key: 'cache' }).asks![0]!.answered)
    assert.notEqual(
      s.task({ key: 'cache' }).column,
      s.column({ role: 'done' }),
    )
    assert.notEqual(
      s.task({ key: 'cache' }).column,
      s.column({ role: 'needs_you' }),
    )
    assert.equal(
      s.task({ key: 'cache' }).status?.state === 'done',
      false,
    )
    assert.equal(
      s.task({ key: 'cache' }).copy,
      undefined,
    )
    await page.close()
  },
)
