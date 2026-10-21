import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import react from '@vitejs/plugin-react'
import { createServer } from 'vite'
import { DEFAULT_KEYBOARD } from '../src/core/keyboard.ts'
import { emptyHydra } from '../src/core/reducer.ts'
import { DEFAULT_VIEW } from '../src/core/view.ts'

test(
  'Hydra chat labels its replies Hydra and task conversations retain Agent',
  async () => {
    const css = Object.getOwnPropertyDescriptor(
      globalThis,
      'CSS',
    )
    const media = Object.getOwnPropertyDescriptor(
      globalThis,
      'matchMedia',
    )
    const document = Object.getOwnPropertyDescriptor(
      globalThis,
      'document',
    )
    Object.defineProperty(
      globalThis,
      'CSS',
      {
        configurable: true,
        value: { supports: () => false },
      },
    )
    Object.defineProperty(
      globalThis,
      'matchMedia',
      {
        configurable: true,
        value: () => ({ matches: false }),
      },
    )
    Object.defineProperty(
      globalThis,
      'document',
      {
        configurable: true,
        value: { querySelector: () => null },
      },
    )
    const server = await createServer({
      configFile: false,
      plugins: [react()],
      server: {
        middlewareMode: true,
        hmr: false,
      },
    })

    try {
      const { KeyboardProvider } = await server.ssrLoadModule('/web/src/keyboard/registry.tsx')
      const { Messages } = await server.ssrLoadModule('/web/src/hydra/messages.tsx')
      const { HydraChat } = await server.ssrLoadModule('/web/src/hydra/hydra-chat.tsx')
      const noop = () => {}
      const keyboard = {
        prefs: DEFAULT_KEYBOARD,
        onAction: () => false,
        leaveField: noop,
        hints: false,
        hintKey: () => false,
      }
      const entry = {
        id: 'answer',
        kind: 'message',
        role: 'assistant',
        text: 'Ready to work.',
      }
      const state = emptyHydra()
      state.hydraMessages = [
        {
          id: 'answer',
          actor: 'hydra',
          action: 'send',
          hydra: 'hydra',
          text: entry.text,
          at: '2026-10-20T10:00:00Z',
        },
      ]
      const chat = createElement(
        HydraChat,
        {
          state,
          command: async () => ({}),
          connected: false,
          notify: noop,
          view: DEFAULT_VIEW,
          save: async () => true,
          draft: '',
          setDraft: noop,
          comments: [],
          setComments: noop,
          liveThread: null,
          openTask: noop,
        },
      )
      const hydra = renderToStaticMarkup(createElement(
        KeyboardProvider,
        keyboard,
        chat,
      ))
      assert.match(
        hydra,
        /<article[^>]*aria-label="Hydra"/,
      )
      assert.doesNotMatch(
        hydra,
        /<article[^>]*aria-label="Agent"/,
      )
      const messages = createElement(
        Messages,
        {
          entries: [entry],
          comments: [],
          setComments: noop,
          quote: noop,
        },
      )
      const worker = renderToStaticMarkup(createElement(
        KeyboardProvider,
        keyboard,
        messages,
      ))
      assert.match(
        worker,
        /<article[^>]*aria-label="Agent"/,
      )
    } finally {
      await server.close()

      const descriptors = [
        [
          'CSS',
          css,
        ],
        [
          'matchMedia',
          media,
        ],
        [
          'document',
          document,
        ],
      ] as const

      for (const [
        key,
        descriptor,
      ] of descriptors) {
        if (descriptor) {
          Object.defineProperty(
            globalThis,
            key,
            descriptor,
          )
        } else {
          Reflect.deleteProperty(
            globalThis,
            key,
          )
        }
      }
    }
  },
)
