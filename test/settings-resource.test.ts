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
    held.reject({
      error: new CommandFailure({
        message: 'No semantic',
        code: 'VALIDATION_ERROR',
      }),
    })
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

for (const outcome of [
  'refused',
  'unknown',
] as const) {
  test(
    `a canonical refresh reconciles ${outcome} without replaying the write`,
    async () => {
      const resource = createSettingsResource<string, string>({
        scope: `test:${outcome}`,
        project: ({ patch }) => patch,
        represented: ({
          state,
          patch,
        }) => state === patch,
        read: ({ receipt }) => String(receipt.value),
      })
      let writes = 0
      await assert.rejects(
        resource.write({
          command: async () => {
            writes++
            throw new CommandFailure({
              message: 'Save interrupted',
              code: 'TEST',
              outcome,
            })
          },
          name: 'settings',
          args: [],
          patch: 'new',
          targets: ['value'],
        }),
        /Save interrupted/,
      )
      await resource.refresh({
        command: async () => ({ value: 'old' }),
        name: 'settings',
        args: [],
      })
      assert.equal(
        resource.snapshot().error,
        'Save interrupted',
      )
      assert.equal(
        resource.snapshot().view,
        outcome === 'unknown' ? 'new' : 'old',
      )
      await resource.refresh({
        command: async () => ({ value: 'new' }),
        name: 'settings',
        args: [],
      })
      assert.equal(
        resource.snapshot().error,
        outcome === 'unknown' ? '' : 'Save interrupted',
      )
      assert.equal(
        resource.snapshot().intents[0]?.stage,
        outcome === 'unknown' ? 'confirmed' : 'refused',
      )
      assert.equal(
        writes,
        1,
      )
    },
  )
}

test(
  'a queued reversal is not confirmed by the value before its prerequisite save',
  async () => {
    const resource = createSettingsResource<string, string>({
      scope: 'test:reversal',
      project: ({ patch }) => patch,
      represented: ({
        state,
        patch,
      }) => state === patch,
      read: ({ receipt }) => String(receipt.value),
    })
    await resource.refresh({
      command: async () => ({ value: 'off' }),
      name: 'settings',
      args: [],
    })
    const held = deferred<Record<string, unknown>>()
    const first = resource.write({
      command: () => held.promise,
      name: 'settings',
      args: [],
      patch: 'on',
      targets: ['value'],
    })
    const second = resource.write({
      command: async () => {
        throw new CommandFailure({
          message: 'Reversal refused',
          code: 'TEST',
        })
      },
      name: 'settings',
      args: [],
      patch: 'off',
      targets: ['value'],
    })
    const refusal = assert.rejects(
      second,
      /Reversal refused/,
    )
    assert.equal(
      resource.snapshot().view,
      'off',
    )
    assert.equal(
      resource.snapshot().intents[1]?.stage,
      'pending',
    )
    held.resolve({ value: { value: 'on' } })
    await first
    await refusal
    assert.equal(
      resource.snapshot().view,
      'on',
    )
    assert.equal(
      resource.snapshot().intents[1]?.stage,
      'refused',
    )
  },
)

test(
  'independent saves retain the newest canonical project revision when receipts arrive backwards',
  async () => {
    type State = {
      revision: number
      values: Record<string, string>
    }
    const resource = createSettingsResource<State, Record<string, string>>({
      scope: 'test:revisions',
      project: ({
        state,
        patch,
      }) => ({
        revision: state?.revision ?? 0,
        values: {
          ...state?.values,
          ...patch,
        },
      }),
      represented: ({
        state,
        patch,
      }) => Object.entries(patch).every(([
        key,
        value,
      ]) => state.values[key] === value),
      read: ({ receipt }) => receipt.state as State,
      newer: ({
        current,
        next,
      }) => next.revision >= current.revision,
    })
    const older = deferred<Record<string, unknown>>()
    const newer = deferred<Record<string, unknown>>()
    const first = resource.write({
      command: () => older.promise,
      name: 'project',
      args: [],
      patch: { a: 'new' },
      targets: ['a'],
      serial: 'a',
    })
    const second = resource.write({
      command: () => newer.promise,
      name: 'project',
      args: [],
      patch: { b: 'new' },
      targets: ['b'],
      serial: 'b',
    })
    newer.resolve({
      value: {
        state: {
          revision: 2,
          values: {
            a: 'new',
            b: 'new',
          },
        },
      },
    })
    await second
    older.resolve({
      value: {
        state: {
          revision: 1,
          values: { a: 'new' },
        },
      },
    })
    await first
    assert.deepEqual(
      resource.snapshot().view,
      {
        revision: 2,
        values: {
          a: 'new',
          b: 'new',
        },
      },
    )
  },
)
