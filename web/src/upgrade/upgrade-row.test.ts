import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import * as nodeModule from 'node:module'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const hooks = typeof nodeModule.registerHooks === 'function'
nodeModule.registerHooks?.({
  // eslint-disable-next-line pnyx/object-params -- Node owns the load hook's signature.
  load(
    url,
    context,
    next,
  ) {
    if (!url.endsWith('.tsx')) {
      return next(
        url,
        context,
      )
    }

    return {
      format: 'module',
      shortCircuit: true,
      source: ts.transpileModule(
        readFileSync(
          fileURLToPath(url),
          'utf8',
        ),
        {
          compilerOptions: {
            jsx: ts.JsxEmit.ReactJSX,
            module: ts.ModuleKind.ESNext,
          },
        },
      ).outputText,
    }
  },
})

test(
  'failed restart reports its reason without claiming a rollback or offering an agent',
  { skip: !hooks },
  async () => {
    const { createElement } = await import('react')
    const { renderToStaticMarkup } = await import('react-dom/server')
    const { UpgradeRow } = await import('./upgrade-row.tsx')
    const html = renderToStaticMarkup(createElement(
      UpgradeRow,
      {
        operation: {
          id: 'restart',
          state: 'failed',
          failed: 'restart',
          error: 'The application identity is not verifiable',
          folder: '',
          queuedAt: '2026-11-02T00:00:00Z',
          endedAt: '2026-11-02T00:00:01Z',
          steps: [
            {
              step: 'restart',
              state: 'failed',
              seconds: 0,
            },
          ],
        },
        askHydra: () => {},
        stop: async () => {},
        restartNow: async () => {},
      },
    ))
    assert.match(
      html,
      /Restart failed/,
    )
    assert.match(
      html,
      /identity is not verifiable/,
    )
    assert.doesNotMatch(
      html,
      /previous version|Ask Hydra/,
    )
  },
)

test(
  'failed upgrade restart reports that the upgraded code remains',
  { skip: !hooks },
  async () => {
    const { createElement } = await import('react')
    const { renderToStaticMarkup } = await import('react-dom/server')
    const { UpgradeRow } = await import('./upgrade-row.tsx')
    const html = renderToStaticMarkup(createElement(
      UpgradeRow,
      {
        operation: {
          id: 'upgrade',
          state: 'failed',
          failed: 'restart',
          error: 'The application did not restart',
          folder: '',
          queuedAt: '2026-11-02T00:00:00Z',
          endedAt: '2026-11-02T00:00:01Z',
          steps: [
            {
              step: 'build',
              state: 'done',
              seconds: 0,
            },
            {
              step: 'restart',
              state: 'failed',
              seconds: 0,
            },
          ],
        },
        askHydra: () => {},
        stop: async () => {},
        restartNow: async () => {},
      },
    ))
    assert.match(
      html,
      /Upgrade finished, but restart failed/,
    )
    assert.match(
      html,
      /upgraded code remains on disk/,
    )
    assert.doesNotMatch(
      html,
      /previous version/,
    )
  },
)

test(
  'a built upgrade waiting for agents between turns says so and offers Restart now',
  { skip: !hooks },
  async () => {
    const { createElement } = await import('react')
    const { renderToStaticMarkup } = await import('react-dom/server')
    const { UpgradeRow } = await import('./upgrade-row.tsx')
    const html = renderToStaticMarkup(createElement(
      UpgradeRow,
      {
        operation: {
          id: 'upgrade',
          state: 'waiting',
          folder: '',
          queuedAt: '2026-11-02T00:00:00Z',
          restartBy: '2026-11-02T00:15:00Z',
          steps: [
            {
              step: 'build',
              state: 'done',
              seconds: 0,
            },
          ],
        },
        askHydra: () => {},
        stop: async () => {},
        restartNow: async () => {},
      },
    ))
    assert.match(
      html,
      /restarting once no agent is mid-turn/,
    )
    assert.match(
      html,
      /Restart now/,
    )
  },
)
