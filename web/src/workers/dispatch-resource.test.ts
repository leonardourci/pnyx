import assert from 'node:assert/strict'
import { test } from 'node:test'
import { dispatchDocument } from './dispatch-resource.ts'
import type { DispatchDocument } from '#workers/dispatch-check.ts'

test(
  'a saved dispatch draft stays visible until a confirming document arrives',
  async t => {
    const documentDescriptor = Object.getOwnPropertyDescriptor(
      globalThis,
      'document',
    )
    const locationDescriptor = Object.getOwnPropertyDescriptor(
      globalThis,
      'location',
    )
    Object.defineProperty(
      globalThis,
      'document',
      {
        configurable: true,
        value: { querySelector: () => ({ content: 'dispatch-resource-test' }) },
      },
    )
    Object.defineProperty(
      globalThis,
      'location',
      {
        configurable: true,
        value: new URL('http://pnyx.test/'),
      },
    )
    t.after(() => {
      if (documentDescriptor) {
        Object.defineProperty(
          globalThis,
          'document',
          documentDescriptor,
        )
      } else {
        Reflect.deleteProperty(
          globalThis,
          'document',
        )
      }

      if (locationDescriptor) {
        Object.defineProperty(
          globalThis,
          'location',
          locationDescriptor,
        )
      } else {
        Reflect.deleteProperty(
          globalThis,
          'location',
        )
      }
    })
    const before: DispatchDocument = {
      default: [
        {
          harness: 'claude',
          model: 'sonnet',
        },
      ],
      rules: {},
      accounts: {},
      workers: {},
      projects: {},
    }
    const after: DispatchDocument = {
      ...before,
      default: [
        {
          harness: 'codex',
          model: 'gpt-6-luna',
        },
      ],
    }
    const resource = dispatchDocument()
    resource.receive({
      state: {
        document: before,
        revision: 0,
      },
    })
    await resource.write({
      command: async () => ({
        applied: true,
        revision: 1,
      }),
      name: 'rule',
      args: ['apply'],
      patch: { default: after.default },
      targets: ['/default'],
    })
    assert.deepEqual(
      resource.snapshot().view?.document.default,
      [
        {
          harness: 'codex',
          model: 'gpt-6-luna',
        },
      ],
    )
    let rejectRead!: ({ error }: { error: Error }) => void
    const read = new Promise<Record<string, unknown>>((
      _,
      reject,
    ) => {
      rejectRead = ({ error }) => reject(error)
    })
    const refreshing = resource.refresh({
      command: async () => read,
      name: 'rule',
      args: ['show'],
    })
    assert.deepEqual(
      resource.snapshot().view?.document.default,
      [
        {
          harness: 'codex',
          model: 'gpt-6-luna',
        },
      ],
    )
    rejectRead({ error: new Error('Follow-up read failed') })
    await refreshing
    assert.deepEqual(
      resource.snapshot().view?.document.default,
      [
        {
          harness: 'codex',
          model: 'gpt-6-luna',
        },
      ],
    )
    assert.equal(
      resource.snapshot().error,
      'Follow-up read failed',
    )
    await resource.refresh({
      command: async () => ({
        document: after,
        revision: 1,
      }),
      name: 'rule',
      args: ['show'],
    })
    assert.deepEqual(
      resource.snapshot().view?.document,
      after,
    )
    assert.equal(
      resource.snapshot().error,
      '',
    )
    assert.ok(resource.snapshot().intents.every(intent => intent.stage === 'confirmed'))
  },
)
