import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createPendingResource, CommandFailure } from '../web/src/hydra/pending-intents.ts'
import { pendingHydra, commandArguments } from '../web/src/hydra/pending-state.ts'
import { commandBytes, MAX_MESSAGE_BYTES } from '../src/server/protocol.ts'
import { emptyHydra } from '../src/core/reducer.ts'

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
  'preview survives receipt until its event is represented, without advancing revisions',
  () => {
    const resource = fixture()
    resource.enqueue({
      id: 'rename',
      targets: ['title'],
      patch: { title: 'New' },
      delivery: 'idempotent',
    })
    assert.equal(
      resource.snapshot().view.title,
      'New',
    )
    assert.equal(
      resource.snapshot().view.revision,
      1,
    )
    assert.equal(
      resource.snapshot().confirmed.title,
      'Original',
    )
    resource.sending({ id: 'rename' })
    resource.accept({ id: 'rename' })
    assert.equal(
      resource.snapshot().intents[0]?.stage,
      'accepted',
    )
    assert.equal(
      resource.snapshot().view.title,
      'New',
    )
    resource.confirm({
      state: {
        title: 'New',
        theme: 'dark',
        revision: 2,
        events: ['rename'],
      },
    })
    assert.equal(
      resource.snapshot().intents[0]?.stage,
      'confirmed',
    )
    assert.equal(
      resource.snapshot().view.theme,
      'dark',
    )
    assert.equal(
      resource.snapshot().view.revision,
      2,
    )
  },
)

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
  'unknown delivery retains identity and preview until resnapshot confirms it',
  () => {
    const resource = fixture()
    resource.enqueue({
      id: 'once',
      targets: ['title'],
      patch: { title: 'Maybe saved' },
      delivery: 'once',
    })
    resource.sending({ id: 'once' })
    resource.unknown({
      id: 'once',
      error: new CommandFailure({
        message: 'Connection lost',
        code: 'DISCONNECTED',
        outcome: 'unknown',
      }),
    })
    assert.equal(
      resource.snapshot().view.title,
      'Maybe saved',
    )
    assert.equal(
      resource.snapshot().intents[0]?.stage,
      'unknown',
    )
    assert.equal(
      resource.snapshot().intents[0]?.delivery,
      'once',
    )
    resource.confirm({
      state: {
        title: 'Maybe saved',
        theme: 'light',
        revision: 2,
        events: ['once'],
      },
    })
    assert.equal(
      resource.snapshot().intents[0]?.stage,
      'confirmed',
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
  'resource subscriptions retain pending state after their observer unmounts',
  () => {
    const resource = fixture()
    const observed: string[] = []
    const unsubscribe = resource.subscribe(() => observed.push(resource.snapshot().view.title))
    resource.enqueue({
      id: 'rename',
      targets: ['title'],
      patch: { title: 'Pending' },
      delivery: 'idempotent',
    })
    unsubscribe()
    resource.accept({ id: 'rename' })
    const other = fixture()
    assert.deepEqual(
      observed,
      ['Pending'],
    )
    assert.equal(
      resource.snapshot().view.title,
      'Pending',
    )
    assert.equal(
      other.snapshot().view.title,
      'Original',
    )
    assert.equal(
      resource.snapshot(),
      resource.snapshot(),
    )
  },
)

test(
  'an authoritative no-op receipt releases the preview without awaiting an event that will never exist',
  () => {
    const resource = fixture()
    resource.enqueue({
      id: 'same',
      targets: ['title'],
      patch: { title: 'Original' },
      delivery: 'idempotent',
    })
    resource.accept({
      id: 'same',
      complete: true,
    })
    assert.equal(
      resource.snapshot().intents[0]?.stage,
      'confirmed',
    )
  },
)

test(
  'invalidated previews cannot project their dependents during the same rebase',
  () => {
    const resource = createPendingResource<State, Partial<State>>({
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
        }) => {
          if (patch.title === 'Create' && state.theme === 'dark') {
            throw new Error('Target deleted')
          }

          return {
            ...state,
            ...patch,
          }
        },
        represented: () => false,
      },
    })
    resource.enqueue({
      id: 'create',
      targets: ['title'],
      patch: { title: 'Create' },
      delivery: 'once',
    })
    resource.enqueue({
      id: 'dependent',
      targets: ['title'],
      patch: { title: 'Dependent' },
      dependencies: ['create'],
      delivery: 'once',
    })
    resource.confirm({
      state: {
        title: 'Original',
        theme: 'dark',
        revision: 2,
        events: [],
      },
    })
    assert.equal(
      resource.snapshot().view.title,
      'Original',
    )
    assert.equal(
      resource.snapshot().view.theme,
      'dark',
    )
    assert.equal(
      resource.snapshot().intents[1]?.stage,
      'refused',
    )
  },
)

test(
  'Hydra resources share across consumers while separating Hydra and installation scopes',
  () => {
    const first = pendingHydra({
      scope: 'http://one/hydra/a/',
      confirmed: emptyHydra(),
    })
    first.enqueue({
      id: 'view',
      targets: ['view'],
      delivery: 'idempotent',
      patch: {
        name: 'view',
        args: [
          'set',
          '--json',
          '{"theme":"dark"}',
          '--event-id',
          'view',
        ],
      },
    })
    const same = pendingHydra({
      scope: 'http://one/hydra/a/',
      confirmed: emptyHydra(),
    })
    const otherHydra = pendingHydra({
      scope: 'http://one/hydra/b/',
      confirmed: emptyHydra(),
    })
    const otherInstallation = pendingHydra({
      scope: 'http://two/hydra/a/',
      confirmed: emptyHydra(),
    })
    assert.equal(
      same.snapshot().view.view?.theme,
      'dark',
    )
    assert.equal(
      otherHydra.snapshot().view.view,
      undefined,
    )
    assert.equal(
      otherInstallation.snapshot().view.view,
      undefined,
    )
    same.confirm({
      state: {
        ...emptyHydra(),
        eventIds: { view: 1 },
      },
    })
    assert.equal(
      first.snapshot().intents[0]?.stage,
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
