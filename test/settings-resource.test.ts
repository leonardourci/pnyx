import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createSettingsResource } from '../web/src/hydra/settings-resource.ts'
import { CommandFailure } from '../web/src/hydra/pending-intents.ts'

const deferred = <Value>() => {
  let resolve!: ({ value }: { value: Value }) => void
  let reject!: ({ error }: { error: Error }) => void
  const promise = new Promise<Value>((
    yes,
    no,
  ) => {
    resolve = ({ value }) => yes(value); reject = ({ error }) => no(error)
  })

  return {
    promise,
    resolve,
    reject,
  }
}

test(
  'shared settings preview two queued writes and only remove the refused patch',
  async () => {
    const resource = createSettingsResource<Record<string, string>, Record<string, string>>({
      scope: 'test:settings',
      project: ({
        state,
        patch,
      }) => ({
        ...state,
        ...patch,
      }),
      represented: ({
        state,
        patch,
      }) => Object.entries(patch).every(([
        key,
        value,
      ]) => state[key] === value),
      read: ({ receipt }) => receipt.settings as Record<string, string>,
    })
    await resource.refresh({
      command: async () => ({
        settings: {
          semantic: 'off',
          rerank: 'off',
        },
      }),
      name: 'settings',
      args: [],
    })
    const held = deferred<Record<string, unknown>>()
    const first = resource.write({
      command: () => held.promise,
      name: 'settings',
      args: [
        'set',
        'semantic',
        'on',
      ],
      patch: { semantic: 'on' },
      targets: ['semantic'],
    })
    const refused = assert.rejects(
      first,
      /No semantic/,
    )
    const second = resource.write({
      command: async () => ({
        settings: {
          semantic: 'off',
          rerank: 'on',
          model: 'pushed',
        },
      }),
      name: 'settings',
      args: [
        'set',
        'rerank',
        'on',
      ],
      patch: { rerank: 'on' },
      targets: ['rerank'],
    })
    assert.equal(
      resource.snapshot().view?.semantic,
      'on',
    )
    assert.equal(
      resource.snapshot().view?.rerank,
      'on',
    )
    held.reject(new CommandFailure({
      message: 'No semantic',
      code: 'VALIDATION_ERROR',
    }))
    await refused
    await second
    assert.deepEqual(
      resource.snapshot().view,
      {
        semantic: 'off',
        rerank: 'on',
        model: 'pushed',
      },
    )
  },
)

test(
  'a late settings read cannot overwrite a newer canonical save',
  async () => {
    const resource = createSettingsResource<string, string>({
      scope: 'test:late',
      project: ({ patch }) => patch,
      represented: ({
        state,
        patch,
      }) => state === patch,
      read: ({ receipt }) => String(receipt.value),
    })
    const held = deferred<Record<string, unknown>>()
    const reading = resource.refresh({
      command: () => held.promise,
      name: 'settings',
      args: [],
    })
    await resource.write({
      command: async () => ({ value: 'new' }),
      name: 'settings',
      args: [],
      patch: 'new',
      targets: ['value'],
    })
    held.resolve({ value: { value: 'old' } })
    await reading
    assert.equal(
      resource.snapshot().view,
      'new',
    )
  },
)
