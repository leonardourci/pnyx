import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import * as nodeModule from 'node:module'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import type { HydraEvent } from '#app/model.ts'
import type { Card } from '#tasks/model.ts'

// Node strips types from .ts but cannot read JSX, so the card's .tsx files are transpiled as they load;
// the card's modules are imported below, after the hook. registerHooks exists from Node 22.15.
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

const AT = '2026-10-13T10:00:00Z'

const load = async () => ({
  ...await import('react'),
  ...await import('react-dom/server'),
  ...await import('./card.tsx'),
  ...await import('#web-preferences/keyboard-registry.tsx'),
  ...await import('#preferences/view.ts'),
  ...await import('#app/reducer.ts'),
})

const reportedCard = ({
  emptyHydra,
  replay,
}: Pick<Awaited<ReturnType<typeof load>>, 'emptyHydra' | 'replay'>): Card => {
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
  { skip: !hooks && 'needs module.registerHooks (Node 22.15)' },
  async () => {
    const {
      createElement,
      renderToStaticMarkup,
      HydraCard,
      KeyboardProvider,
      DEFAULT_VIEW,
      emptyHydra,
      replay,
    } = await load()
    const updates = createElement(
      'div',
      { className: 'activity-updates' },
    )
    const card = createElement(
      HydraCard,
      {
        card: reportedCard({
          emptyHydra,
          replay,
        }),
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
      /activity-updates|Build the form/,
      'the hidden Activity tab mounts nothing',
    )
  },
)
