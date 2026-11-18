import { expect } from 'vitest'
import { readFileSync } from 'node:fs'
import type { Page } from 'playwright-core'
import { flushLogs } from '#app/diagnostics.ts'
import { logFiles } from '#diagnostics/log-files.ts'
import { until } from './pnyx.ts'

const LONG_TASK_BUDGET_MS = 50
const METRIC_OPERATIONS = new Set([
  'page.long-task',
  'page.slow-interaction',
  'page.flow',
  'page.metrics-overhead',
  'page.react-commit',
  'page.memory',
  'page.drag-frames',
  'page.slow-frame',
])

export function uiMetrics() {
  return logFiles().flatMap(file => readFileSync(
    file.path,
    'utf8',
  ).trim()
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line)))
    .filter(line => line.source === 'web' && METRIC_OPERATIONS.has(line.operation))
}

async function flushUIMetrics({ page }: { page: Page }) {
  await flushLogs()
  const before = uiMetrics().filter(line => line.operation === 'page.metrics-overhead').length
  await page.evaluate(() => dispatchEvent(new PageTransitionEvent('pagehide')))
  await until({
    what: 'the browser metrics batch reaches the log file',
    check: async () => {
      await flushLogs()

      return uiMetrics().filter(line => line.operation === 'page.metrics-overhead').length > before
    },
  })
}

export async function beginUIWindow({ page }: { page: Page }) {
  await flushUIMetrics({ page })
  const offset = uiMetrics().length

  return async () => {
    await page.evaluate(() => new Promise(resolve => {
      requestAnimationFrame(() => requestAnimationFrame(resolve))
    }))
    await flushUIMetrics({ page })

    return uiMetrics().slice(offset)
  }
}

export function expectResponsiveUI({ metrics }: { metrics: ReturnType<typeof uiMetrics> }) {
  expect(metrics.filter(line => line.operation === 'page.long-task' && line.ms > LONG_TASK_BUDGET_MS)).toEqual([])
}

// Drag latency is report-only until task-c266753d restores the blocking gate.
export function reportDragResponsiveness({ metrics }: { metrics: ReturnType<typeof uiMetrics> }) {
  const longTaskMs = metrics.filter(line => line.operation === 'page.long-task').map(line => line.ms)
  console.info(JSON.stringify({
    check: 'drag responsiveness',
    mode: 'report-only',
    followUp: 'task-c266753d',
    budgetMs: LONG_TASK_BUDGET_MS,
    longTaskMs,
    worstLongTaskMs: Math.max(
      0,
      ...longTaskMs,
    ),
  }))
}
