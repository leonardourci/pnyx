import { readFileSync } from 'node:fs'
import { expect, inject, test } from 'vitest'
import { flushLogs } from '#app/diagnostics.ts'
import { scanEvents } from '#app/event-log.ts'
import { logFiles } from '#diagnostics/log-files.ts'
import { openHydra } from '../setup/browser.ts'
import { startPnyx, until } from '../setup/pnyx.ts'

declare module 'vitest' {
  export interface ProvidedContext {
    uiProfile: boolean
  }
}

function metrics() {
  return logFiles().flatMap(file => readFileSync(
    file.path,
    'utf8',
  ).trim()
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line)))
    .filter(line => line.source === 'web' && [
      'page.long-task',
      'page.slow-interaction',
      'page.flow',
      'page.metrics-overhead',
      'page.react-commit',
      'page.memory',
    ].includes(line.operation))
}

test(
  'a slow real interaction writes named bounded metrics to files without appending Hydra events, and Logs Off stops them',
  async () => {
    const pnyx = await startPnyx({ zeroCache: true })
    const hydra = await pnyx.hydra()
    const page = await openHydra({
      port: pnyx.port(),
      hydraId: hydra.id,
    })
    await page.getByRole(
      'button',
      {
        name: 'Settings',
        exact: true,
      },
    ).waitFor()
    const before = [...scanEvents({ hydraId: hydra.id })].map(event => event.id)
    await page.evaluate(() => {
      const button = document.querySelector('button[aria-label="Settings"]')!
      button.setAttribute(
        'data-ui-action',
        'settings.open_panel',
      )
      button.addEventListener(
        'click',
        () => {
          const started = performance.now()

          while (performance.now() - started < 150) {
            // Browser observers require real main-thread work.
          }
        },
        { once: true },
      )
    })
    await page.getByRole(
      'button',
      {
        name: 'Settings',
        exact: true,
      },
    ).click()
    await until({
      what: 'browser interaction metrics written through the log socket',
      check: async () => {
        await flushLogs()

        return metrics().some(line => line.operation === 'page.slow-interaction')
        && metrics().some(line => line.operation === 'page.long-task')
      },
    })
    const recorded = metrics()
    expect(recorded.some(line => line.operation === 'page.react-commit')).toBe(inject('uiProfile'))
    expect(recorded).toEqual(expect.arrayContaining([
      expect.objectContaining({
        operation: 'page.slow-interaction',
        surface: expect.any(String),
        action: 'settings.open_panel',
        ms: expect.any(Number),
        processingMs: expect.any(Number),
      }),
      expect.objectContaining({
        operation: 'page.long-task',
        count: expect.any(Number),
      }),
      expect.objectContaining({
        operation: 'page.metrics-overhead',
        ms: expect.any(Number),
        totalMs: expect.any(Number),
      }),
    ]))
    expect([...scanEvents({ hydraId: hydra.id })].map(event => event.id)).toEqual(before)
    await hydra.owner({
      args: [
        'settings',
        'set',
        '--json',
        '{"logs":"off"}',
      ],
    })
    await until({
      what: 'Logs Off reaches the page',
      check: () => page.getByRole(
        'radiogroup',
        { name: 'Logging' },
      )
        .getByRole(
          'radio',
          {
            name: 'Off',
            exact: true,
          },
        )
        .getAttribute('aria-checked')
        .then(value => value === 'true'),
    })
    const onBatch = recorded.find(line => line.operation === 'page.metrics-overhead')
    expect(onBatch.totalMs).toBeGreaterThan(onBatch.ms)
    await flushLogs()
    const disabledCount = metrics().length
    await page.close()
    await flushLogs()
    expect(metrics()).toHaveLength(disabledCount)
  },
)
