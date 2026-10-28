import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createPendingResource, CommandFailure } from './pending-intents.ts'
import { commandArguments } from '../app/pending-state.ts'
import { commandBytes, MAX_MESSAGE_BYTES } from '../../../src/app/server-protocol.ts'
import { HydraError } from '../../../src/core/model.ts'

test(
  'rebasing a preview preserves the validator reason, code and help',
  () => {
    const resource = createPendingResource({
      scope: 'validator',
      confirmed: { available: true },
      adapter: {
        project: ({ state }: {
          state: { available: boolean }
          patch: string
        }) => {
          if (!state.available) {
            throw new HydraError({
              message: 'Target moved',
              code: 'MOVED',
              help: ['Choose its new location'],
            })
          }

          return state
        },
        represented: () => false,
      },
    })
    resource.enqueue({
      id: 'edit',
      targets: ['target'],
      patch: 'edit',
      delivery: 'idempotent',
    })
    resource.confirm({ state: { available: false } })
    assert.equal(
      resource.snapshot().intents[0]?.stage,
      'refused',
    )
    assert.equal(
      resource.snapshot().intents[0]?.error?.message,
      'Target moved',
    )
    assert.equal(
      resource.snapshot().intents[0]?.error?.code,
      'MOVED',
    )
    assert.deepEqual(
      resource.snapshot().intents[0]?.error?.help,
      ['Choose its new location'],
    )
  },
)

interface State {
  title: string
  theme: string
  revision: number
  events: string[]
}

const fixture = () => createPendingResource<State, Partial<Pick<State, 'title' | 'theme'>>>({
  scope: 'installation/a',
  confirmed: {
    title: 'Original',
    theme: 'light',
    revision: 1,
    events: [],
  },
  adapter: {
    project: ({
      state,
      patch,
    }) => ({
      ...state,
      ...patch,
    }),
    represented: ({
      state,
      intent,
    }) => state.events.includes(intent.id),
  },
})

test(
  'refusal preserves a newer rapid write and unrelated pushed changes',
  () => {
    const resource = fixture()
    resource.enqueue({
      id: 'first',
      targets: ['title'],
      patch: { title: 'First' },
      delivery: 'idempotent',
    })
    resource.enqueue({
      id: 'second',
      targets: ['title'],
      patch: { title: 'Second' },
      delivery: 'idempotent',
    })
    resource.confirm({
      state: {
        title: 'Original',
        theme: 'dark',
        revision: 2,
        events: [],
      },
    })
    resource.refuse({
      id: 'first',
      error: new CommandFailure({
        message: 'Changed elsewhere',
        code: 'CONFLICT',
        help: ['Refresh title'],
      }),
    })
    assert.equal(
      resource.snapshot().view.title,
      'Second',
    )
    assert.equal(
      resource.snapshot().view.theme,
      'dark',
    )
    assert.equal(
      resource.snapshot().intents[0]?.error?.code,
      'CONFLICT',
    )
    assert.deepEqual(
      resource.snapshot().intents[0]?.error?.help,
      ['Refresh title'],
    )
  },
)

test(
  'refusal drops transitive dependents while retaining independent work',
  () => {
    const resource = fixture()
    resource.enqueue({
      id: 'create',
      targets: ['title'],
      patch: { title: 'Created' },
      delivery: 'once',
    })
    resource.enqueue({
      id: 'child',
      targets: ['title'],
      patch: { title: 'Child' },
      dependencies: ['create'],
      delivery: 'once',
    })
    resource.enqueue({
      id: 'grandchild',
      targets: ['title'],
      patch: { title: 'Grandchild' },
      dependencies: ['child'],
      delivery: 'once',
    })
    resource.enqueue({
      id: 'theme',
      targets: ['theme'],
      patch: { theme: 'dark' },
      delivery: 'idempotent',
    })
    resource.refuse({
      id: 'create',
      error: new CommandFailure({
        message: 'Creation refused',
        code: 'VALIDATION_ERROR',
      }),
    })
    assert.equal(
      resource.snapshot().view.title,
      'Original',
    )
    assert.equal(
      resource.snapshot().view.theme,
      'dark',
    )
    assert.deepEqual(
      resource.snapshot().intents.map(i => i.stage),
      [
        'refused',
        'refused',
        'refused',
        'pending',
      ],
    )
    assert.equal(
      resource.snapshot().intents[1]?.error?.code,
      'DEPENDENCY_REFUSED',
    )
  },
)

test(
  'event before receipt does not reapply an older preview over a newer daemon edit',
  () => {
    const resource = fixture()
    resource.enqueue({
      id: 'rename',
      targets: ['title'],
      patch: { title: 'First' },
      delivery: 'idempotent',
    })
    resource.confirm({
      state: {
        title: 'Later daemon title',
        theme: 'light',
        revision: 3,
        events: ['rename'],
      },
    })
    resource.accept({ id: 'rename' })
    assert.equal(
      resource.snapshot().view.title,
      'Later daemon title',
    )
    assert.equal(
      resource.snapshot().intents[0]?.stage,
      'confirmed',
    )
  },
)

test(
  'a stale refusal cannot invalidate children of a confirmed prerequisite',
  () => {
    const resource = fixture()
    resource.enqueue({
      id: 'parent',
      targets: ['title'],
      patch: { title: 'Parent' },
      delivery: 'idempotent',
    })
    resource.enqueue({
      id: 'child',
      targets: ['theme'],
      patch: { theme: 'dark' },
      dependencies: ['parent'],
      delivery: 'idempotent',
    })
    resource.confirm({
      state: {
        title: 'Parent',
        theme: 'light',
        revision: 2,
        events: ['parent'],
      },
    })
    resource.refuse({
      id: 'parent',
      error: new CommandFailure({
        message: 'Late failure',
        code: 'LATE_ERROR',
      }),
    })
    assert.equal(
      resource.snapshot().intents[0]?.stage,
      'confirmed',
    )
    assert.equal(
      resource.snapshot().intents[1]?.stage,
      'pending',
    )
    assert.equal(
      resource.snapshot().view.theme,
      'dark',
    )
  },
)

test(
  'frame validation includes the automatically appended idempotency key',
  () => {
    const id = 'request'
    const args = [
      'brief',
      'task',
      '--brief',
      '',
    ]
    args[3] = 'x'.repeat(MAX_MESSAGE_BYTES - commandBytes({
      id,
      name: 'task',
      args,
    }))
    assert.equal(
      commandBytes({
        id,
        name: 'task',
        args,
      }),
      MAX_MESSAGE_BYTES,
    )
    assert.throws(
      () => commandArguments({
        id,
        edit: {
          name: 'task',
          args,
        },
        persisted: true,
      }),
      (error: unknown) => error instanceof CommandFailure && error.code === 'MESSAGE_TOO_LARGE',
    )
  },
)

test(
  'retry preserves an idempotent intent identity and refuses unsafe replay',
  () => {
    const resource = fixture()
    resource.enqueue({
      id: 'safe',
      targets: ['title'],
      patch: { title: 'Retry' },
      delivery: 'idempotent',
    })
    resource.refuse({
      id: 'safe',
      error: new CommandFailure({
        message: 'Try later',
        code: 'LOCKED',
      }),
    })
    resource.retry({ id: 'safe' })
    assert.equal(
      resource.snapshot().intents[0]?.id,
      'safe',
    )
    assert.equal(
      resource.snapshot().intents[0]?.stage,
      'pending',
    )
    assert.equal(
      resource.snapshot().view.title,
      'Retry',
    )
    resource.enqueue({
      id: 'unsafe',
      targets: ['theme'],
      patch: { theme: 'dark' },
      delivery: 'once',
    })
    resource.unknown({
      id: 'unsafe',
      error: new CommandFailure({
        message: 'Uncertain',
        code: 'TIMEOUT',
        outcome: 'unknown',
      }),
    })
    assert.throws(
      () => resource.retry({ id: 'unsafe' }),
      (error: unknown) => error instanceof CommandFailure && error.code === 'UNSAFE_RETRY',
    )
  },
)
