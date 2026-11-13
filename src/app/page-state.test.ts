import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { HydraEvent, HydraState } from './model.ts'
import { emptyHydra, replayOwned } from './reducer.ts'
import { pageCard, pageState } from './page-state.ts'
import { HYDRA_CARD } from '#hydra/identity.ts'
import { summarize } from './cli-support.ts'
import { hydraConfig } from '#hydra/config.ts'
import { unmetPrerequisites } from '#tasks/dependencies.ts'

test(
  'page views exclude history and hidden cards, load explicit interests and retain durable state',
  () => {
    const state = emptyHydra()
    const create: HydraEvent = {
      v: 1,
      id: 'create',
      seq: 1,
      at: '2026-11-12T00:00:00Z',
      actor: 'owner',
      cardId: 'task',
      type: 'task.created',
      data: {
        key: 'task',
        title: 'Visible',
      },
    }
    replayOwned({
      state,
      events: [create],
    })
    const visible = state.cards.task!
    visible.steering = [
      {
        id: 'steer',
        order: 1,
        text: 'Private steering history',
        source: 'owner',
        at: create.at,
        actor: 'owner',
        attempts: [],
      },
    ]
    visible.externalSources = [
      {
        id: 'source',
        registration: 'registered',
        owner: {
          session: 'session',
          generation: 1,
        },
        command: {
          executable: 'fixture',
          digest: 'digest',
          argv: [],
          cwd: '/fixture',
        },
        timeoutMs: 1000,
        maxBytes: 1000,
        expiresAt: create.at,
        restart: 'never',
        maxRuns: 1,
        runs: 1,
        state: 'ended',
        results: [
          {
            sequence: 1,
            run: 'run',
            at: create.at,
            outcome: 'completed',
            stdout: 'Private capture',
            stderr: '',
            detail: '',
            terminal: true,
            message: 'Done',
          },
        ],
      },
    ]
    state.cards.hidden = {
      ...visible,
      id: 'hidden',
      key: 'hidden',
      hidden: true,
    }
    state.cards.automatic = {
      ...visible,
      id: 'automatic',
      key: 'automatic',
      automaticTask: true,
    }
    state.sessions = {
      'codex:visible': {
        id: 'codex:visible',
        agent: {
          provider: 'codex',
          sessionId: 'visible',
        },
        originCardId: 'task',
        taskId: 'task',
        attention: [],
        sourceRefs: [],
      },
      'codex:hidden': {
        id: 'codex:hidden',
        agent: {
          provider: 'codex',
          sessionId: 'hidden',
        },
        originCardId: 'hidden',
        taskId: 'hidden',
        attention: [],
        sourceRefs: [],
      },
    }
    state.keys.hidden = 'hidden'
    state.keys.automatic = 'automatic'
    const interest = {
      cards: [],
      hidden: false,
    }
    const snapshot = pageState({
      state,
      interest,
    })
    assert.deepEqual(
      Object.keys(snapshot.cards),
      ['task'],
    )
    assert.deepEqual(
      Object.keys(snapshot.sessions!),
      ['codex:visible'],
    )
    assert.deepEqual(
      snapshot.keys,
      {
        task: 'task',
        hidden: 'hidden',
      },
    )
    assert.deepEqual(
      Object.keys(snapshot.references!),
      ['hidden'],
    )
    assert.equal(
      'statusLog' in snapshot.references!.hidden!,
      false,
    )
    assert.equal(
      'eventIds' in snapshot,
      false,
    )
    assert.equal(
      'steering' in snapshot.cards.task!,
      false,
    )
    assert.equal(
      'externalSources' in snapshot.cards.task!,
      false,
    )
    assert.equal(
      state.cards.task,
      visible,
    )
    assert.equal(
      state.cards.task!.steering?.[0]?.text,
      'Private steering history',
    )
    assert.equal(
      state.eventIds.create,
      1,
    )
    assert.deepEqual(
      Object.keys(pageState({
        state,
        interest: {
          cards: ['hidden'],
          hidden: false,
        },
      }).cards),
      [
        'task',
        'hidden',
      ],
    )
    assert.deepEqual(
      Object.keys(pageState({
        state,
        interest: {
          cards: [],
          hidden: true,
        },
      }).cards),
      [
        'task',
        'hidden',
        'automatic',
      ],
    )
  },
)

test(
  'the page keeps Hydra\'s own session on its hidden hook card, so Hydra keeps its agent',
  () => {
    const state = emptyHydra()
    const base = {
      v: 1 as const,
      at: '2026-11-12T00:00:00Z',
      actor: 'owner',
    }
    replayOwned({
      state,
      events: [
        {
          ...base,
          id: 'hydra',
          seq: 1,
          cardId: HYDRA_CARD,
          type: 'task.created',
          data: {
            key: 'hydra',
            title: 'Hydra',
          },
        },
        {
          ...base,
          id: 'task',
          seq: 2,
          cardId: 'task',
          type: 'task.created',
          data: {
            key: 'task',
            title: 'Visible',
          },
        },
        {
          ...base,
          id: 'hook',
          seq: 3,
          cardId: 'hook',
          type: 'card.pushed',
          data: {
            key: 'hook',
            agent: {
              provider: 'claude',
              sessionId: 'hydra',
              host: 'pnyx',
            },
            activity: 'working',
          },
        },
      ],
    })
    state.cards.hook!.automaticTask = true
    replayOwned({
      state,
      events: [
        {
          ...base,
          id: 'configured',
          seq: 4,
          cardId: HYDRA_CARD,
          type: 'board.configured',
          data: {
            ...hydraConfig({ state }),
            hydra: {
              ...hydraConfig({ state }).hydra,
              session: 'claude:hydra',
            },
          },
        },
      ],
    })
    assert.equal(
      state.cards[HYDRA_CARD]!.agent?.host,
      'pnyx',
    )
    const interest = {
      cards: [],
      hidden: false,
    }
    const page = {
      ...pageState({
        state,
        interest,
      }),
      eventIds: {},
    }
    assert.ok(
      page.sessions?.['claude:hydra'],
      'Hydra\'s session stays on the page though its hook card is hidden',
    )
    assert.deepEqual(
      page.cards[HYDRA_CARD],
      pageCard({ card: state.cards[HYDRA_CARD]! }),
    )
  },
)

test(
  'a shown task whose finished prerequisite was hidden stays ready on the page',
  () => {
    const state = emptyHydra()
    const base = {
      v: 1 as const,
      at: '2026-11-12T00:00:00Z',
      actor: 'owner',
    }
    replayOwned({
      state,
      events: [
        {
          ...base,
          id: 'first',
          seq: 1,
          cardId: 'first',
          type: 'task.created',
          data: {
            key: 'first',
            title: 'First step',
          },
        },
        {
          ...base,
          id: 'next',
          seq: 2,
          cardId: 'next',
          type: 'task.created',
          data: {
            key: 'next',
            title: 'Next step',
          },
        },
      ],
    })
    state.cards.first!.status = {
      id: 'done',
      at: base.at,
      actor: 'worker',
      state: 'done',
      note: 'Finished',
    }
    state.cards.first!.hidden = true
    state.cards.first!.expired = true
    state.cards.next!.prerequisites = ['first']
    const page = pageState({
      state,
      interest: {
        cards: [],
        hidden: false,
      },
    })
    assert.equal(
      page.cards.first,
      undefined,
    )
    assert.deepEqual(
      unmetPrerequisites({
        state,
        card: state.cards.next!,
      }),
      [],
    )
    assert.deepEqual(
      unmetPrerequisites({
        state: {
          ...page,
          eventIds: {},
        },
        card: page.cards.next!,
      }),
      [],
    )
    assert.equal(
      page.keys.first,
      'first',
    )
  },
)

test(
  'the page holds the owner’s latest Hydra message instead of the message history, and follows new ones',
  () => {
    const message = ({
      seq,
      actor,
      text,
      task,
      action = 'send',
    }: {
      seq: number
      actor: string
      text: string
      task?: string
      action?: 'send' | 'worker'
    }): HydraEvent => ({
      v: 1,
      id: `message-${seq}`,
      seq,
      at: '2026-11-12T00:00:00Z',
      actor,
      cardId: '$hydra',
      type: 'hydra.message',
      data: {
        action,
        text,
        hydra: 'default',
        task,
      },
    })
    const interest = {
      cards: [],
      hidden: false,
    }
    const state = emptyHydra()
    replayOwned({
      state,
      events: [
        message({
          seq: 1,
          actor: 'web',
          text: 'An earlier question',
        }),
        message({
          seq: 2,
          actor: 'web',
          text: 'Explain the choice',
          task: 'task',
        }),
        message({
          seq: 3,
          actor: 'hydra',
          text: 'Hydra prose',
        }),
        message({
          seq: 4,
          actor: 'cli',
          text: 'Start the worker',
          task: 'other',
          action: 'worker',
        }),
      ],
    })
    const page: HydraState = {
      ...structuredClone(pageState({
        state,
        interest,
      })),
      eventIds: {},
    }
    assert.equal(
      'hydraMessages' in page,
      false,
    )
    assert.deepEqual(
      page.hydraOwnerMessage,
      {
        id: 'message-2',
        task: 'task',
        text: 'Explain the choice',
      },
    )

    const prose = message({
      seq: 5,
      actor: 'hydra',
      text: 'More Hydra prose',
    })
    replayOwned({
      state,
      events: [prose],
    })
    const afterProse = pageState({
      state,
      interest,
    })
    assert.equal(
      'hydraMessages' in afterProse,
      false,
    )
    assert.equal(
      afterProse.hydraOwnerMessage?.id,
      'message-2',
    )

    const owner = message({
      seq: 6,
      actor: 'cli',
      text: 'How is everything else going?',
    })
    replayOwned({
      state,
      events: [owner],
    })
    assert.deepEqual(
      pageState({
        state,
        interest,
      }).hydraOwnerMessage,
      {
        id: 'message-6',
        task: undefined,
        text: 'How is everything else going?',
      },
    )

    // A conversation copy an older Pnyx logged is listed without its text.
    const copy: HydraEvent = {
      v: 1,
      id: 'copy-7',
      seq: 7,
      at: '2026-11-12T00:00:00Z',
      actor: 'harvest',
      cardId: HYDRA_CARD,
      type: 'chat.message',
      data: {
        session: 'claude-code:older',
        nativeId: 'record:7',
        role: 'assistant',
        text: 'A copied reply',
      },
    }
    assert.equal(
      summarize({ event: copy }),
      'Conversation copy from an older Pnyx',
    )
  },
)
