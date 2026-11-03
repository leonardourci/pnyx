import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DEFAULT_SETTINGS } from '#settings/settings.ts'
import { CommandFailure } from '#web-shared/pending-intents.ts'
import { saveSharedSettings, sharedSettings } from './shared-settings.ts'

test(
  'a combined view save previews shared settings, reads its nested receipt and rolls back a refusal',
  async () => {
    const globals = Object.fromEntries([
      'document',
      'location',
    ].map(key => [
      key,
      Object.getOwnPropertyDescriptor(
        globalThis,
        key,
      ),
    ]))
    Object.defineProperty(
      globalThis,
      'document',
      {
        configurable: true,
        value: { querySelector: () => ({ content: 'width-test' }) },
      },
    )
    Object.defineProperty(
      globalThis,
      'location',
      {
        configurable: true,
        value: { origin: 'http://width-test' },
      },
    )

    try {
      const resource = sharedSettings()
      resource.receive({
        state: {
          settings: structuredClone(DEFAULT_SETTINGS),
          revision: 0,
        },
      })
      const patch = { defaultHydraWidth: 650 }
      let confirm!: () => void
      const gate = new Promise<void>(resolve => {
        confirm = resolve
      })
      let writes = 0
      const saving = saveSharedSettings({
        patch,
        view: {
          patch: {
            ...patch,
            hydraWidth: 650,
          },
          revision: 3,
        },
        command: async ({
          name,
          args,
        }) => {
          writes++
          assert.equal(
            name,
            'view',
          )
          assert.equal(
            args[args.indexOf('--if-revision') + 1],
            '3',
          )
          assert.deepEqual(
            JSON.parse(args[args.indexOf('--json') + 1]!),
            {
              ...patch,
              hydraWidth: 650,
            },
          )
          await gate

          return {
            revision: 4,
            settings: {
              settings: {
                ...DEFAULT_SETTINGS,
                ...patch,
              },
              revision: 1,
            },
          }
        },
      })
      assert.equal(
        resource.snapshot().view?.settings.defaultHydraWidth,
        650,
      )
      confirm()
      await saving
      assert.equal(
        writes,
        1,
      )
      assert.equal(
        resource.snapshot().confirmed?.settings.defaultHydraWidth,
        650,
      )
      assert.equal(
        resource.snapshot().confirmed?.revision,
        1,
      )
      await assert.rejects(
        saveSharedSettings({
          patch: { defaultHydraWidth: 690 },
          view: {
            patch: {
              defaultHydraWidth: 690,
              hydraWidth: 690,
            },
            revision: 4,
          },
          command: async () => {
            throw new CommandFailure({
              message: 'Reload and retry',
              code: 'REVISION_CONFLICT',
            })
          },
        }),
        /Reload and retry/,
      )
      assert.equal(
        resource.snapshot().view?.settings.defaultHydraWidth,
        650,
      )
      assert.equal(
        resource.snapshot().error,
        'Reload and retry',
      )
      await saveSharedSettings({
        patch: { theme: 'dark' },
        command: async ({ name }) => {
          assert.equal(
            name,
            'settings',
          )

          return {
            settings: {
              ...DEFAULT_SETTINGS,
              ...patch,
              theme: 'dark',
            },
            revision: 2,
          }
        },
      })
      assert.equal(
        resource.snapshot().confirmed?.settings.theme,
        'dark',
      )
    } finally {
      for (const key of [
        'document',
        'location',
      ]) {
        const descriptor = globals[key]

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
