import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import type { HydraEvent } from '#app/model.ts'
import type { Card } from '#tasks/model.ts'

// Node strips types from .ts but cannot read JSX, so the card's .tsx files are transpiled as they load.
registerHooks({
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
            target: ts.ScriptTarget.ESNext,
          },
        },
      ).outputText,
    }
  },
})
// The streaming caret checks CSS support when its module loads.
Object.assign(
  globalThis,
  { CSS: { supports: () => false } },
)

const { createElement } = await import('react')
const { renderToStaticMarkup } = await import('react-dom/server')
const { HydraCard } = await import('./card.tsx')
const { KeyboardProvider } = await import('#web-preferences/keyboard-registry.tsx')
const { DEFAULT_VIEW } = await import('#preferences/view.ts')
const {
  emptyHydra,
  replay,
} = await import('#app/reducer.ts')

const AT = '2026-10-13T10:00:00Z'

const reportedCard = (): Card => {
  const state = replay({
    state: emptyHydra(),
    events: [
      {
        v: 1,
        seq: 1,
        id: 'evt_1',
        at: AT,
        actor: 'cli',
        cardId: 'c1',
        type: 'card.pushed',
        data: {
          key: 'claude:host-a:c1',
          title: 'Ship the login page',
          source: {
            adapter: 'claude',
            objectId: 'c1',
            instanceId: 'host-a',
            generation: 1,
            observedAt: AT,
          },
        },
      } as HydraEvent,
    ],
  })

  return {
    ...state.cards.c1!,
    intent: 'Let people sign in',
    brief: 'Build the form',
    report: {
      id: 'evt_2',
      at: AT,
    },
  } as Card
}

const noop = () => undefined

test(
  'an open card on Context mounts none of Activity: no updates, report or brief',
  () => {
    const updates = createElement(
      'div',
      { className: 'activity-updates' },
    )
    const card = createElement(
      HydraCard,
      {
        card: reportedCard(),
        lookup: {} as never,
        notify: noop,
        selected: true,
        view: DEFAULT_VIEW,
        save: async () => true,
        open: async () => true,
        onEdit: noop,
        recoverSelection: noop,
        tabIndex: 0,
        command: async () => ({}),
        connected: true,
        answer: noop,
        children: updates,
      },
    )
    const html = renderToStaticMarkup(createElement(
      KeyboardProvider,
      {
        prefs: DEFAULT_VIEW.keyboard,
        onAction: () => false,
        leaveField: noop,
        hints: false,
        hintKey: () => false,
        children: card,
      },
    ))

    assert.match(
      html,
      /Let people sign in/,
      'Context shows the Intent',
    )
    assert.doesNotMatch(
      html,
      /activity-updates|task-report|Build the form/,
      'the hidden Activity tab mounts nothing',
    )
  },
)
