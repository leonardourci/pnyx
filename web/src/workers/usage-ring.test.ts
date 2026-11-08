import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import * as nodeModule from 'node:module'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { Card } from '#tasks/model.ts'
import { usageFor } from '#workers/usage.ts'

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

const card: Card = {
  id: 'usage',
  key: 'usage',
  title: 'Synthetic usage',
  workspace: '',
  tags: [],
  attention: [],
  links: [],
  sourceRefs: [],
  column: 'queued',
  revision: 1,
  createdSeq: 1,
  updatedSeq: 1,
  updatedAt: '2026-11-08T00:00:00Z',
}

test(
  'the ring leaves unknown usage empty and shows known percentages with accessible descriptions',
  { skip: !hooks },
  async () => {
    // Node needs the transpilation hook installed before it can import TSX.
    const { UsageRing } = await import('./usage-ring.tsx')
    const cases = [
      {
        reading: undefined,
        text: '',
        dash: undefined,
        label: 'Context unavailable',
        fill: false,
        tone: 'normal',
      },
      {
        reading: { used: 42000 },
        text: '',
        dash: undefined,
        label: 'Context 42,000 tokens used; capacity unavailable',
        fill: false,
        tone: 'normal',
      },
      {
        reading: {
          used: 0,
          window: 100000,
        },
        text: '0%',
        dash: '0 100',
        label: 'Context window 0% used',
        fill: true,
        tone: 'normal',
      },
      {
        reading: {
          used: 42000,
          window: 100000,
        },
        text: '42%',
        dash: '42 100',
        label: 'Context window 42% used',
        fill: true,
        tone: 'normal',
      },
      {
        reading: {
          used: 75000,
          window: 100000,
        },
        text: '75%',
        dash: '75 100',
        label: 'Context window 75% used',
        fill: true,
        tone: 'warning',
      },
      {
        reading: {
          used: 95000,
          window: 100000,
        },
        text: '95%',
        dash: '95 100',
        label: 'Context window 95% used',
        fill: true,
        tone: 'critical',
      },
      {
        reading: {
          used: 100000,
          window: 100000,
        },
        text: '100%',
        dash: '100 100',
        label: 'Context window 100% used',
        fill: true,
        tone: 'critical',
      },
    ]

    for (const expected of cases) {
      const html = renderToStaticMarkup(createElement(
        UsageRing,
        {
          card: {
            ...card,
            usage: usageFor({ live: expected.reading }),
          },
          connected: false,
          command: async () => ({}),
        },
      ))
      const visible = html.replace(
        /<[^>]*>/g,
        '',
      )
      assert.equal(
        visible,
        expected.text,
      )
      assert.equal(
        html.match(/stroke-dasharray="([^"]+)"/)?.[1],
        expected.dash,
      )
      assert.ok(html.includes(`aria-label="${expected.label}"`))
      assert.equal(
        html.includes('class="usage-fill"'),
        expected.fill,
      )
      assert.ok(html.includes(`data-tone="${expected.tone}"`))
    }
  },
)
