import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { HydraEvent } from './model.ts'
import { emptyHydra, replayOwned } from './reducer.ts'
import { applyPageUpdate, pageCard, pageEvent, pageState } from './page-state.ts'
import { pageInterest, parsePage } from './page-cli.ts'
import { HYDRA_CARD } from '#hydra/identity.ts'
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
        interest: pageInterest({
          state,
          values: parsePage({
            args: [
              '--card',
              'hidden',
            ],
          }).values,
        }).interest,
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

    const browser = {
      ...snapshot,
      eventIds: {},
    }
    const hidden = browser.cards.hidden
    const queued: HydraEvent = {
      ...create,
      id: 'queued',
      seq: 2,
      type: 'task.steering.queued',
      data: {
        message: {
          ...visible.steering![0]!,
          id: 'new-steer',
          text: 'Newest instruction',
        },
      },
    }
    replayOwned({
      state,
      events: [queued],
    })
    const update = pageEvent({
      state,
      event: queued,
      interest,
    })
    assert.equal(
      update.event,
      undefined,
    )
    assert.equal(
      JSON.stringify(update).includes('Private'),
      false,
    )
    assert.equal(
      JSON.stringify(update).includes('Newest instruction'),
      false,
    )
    applyPageUpdate({
      state: browser,
      update,
    })
    assert.equal(
      browser.seq,
      2,
    )
    assert.equal(
      browser.cards.task!.revision,
      state.cards.task!.revision,
    )
    assert.deepEqual(
      browser.eventIds,
      {},
    )
    assert.equal(
      browser.cards.hidden,
      hidden,
    )
    const hide: HydraEvent = {
      ...create,
      id: 'hide',
      seq: 3,
      type: 'task.visibility',
      data: {
        before: false,
        after: true,
      },
    }
    replayOwned({
      state,
      events: [hide],
    })
    applyPageUpdate({
      state: browser,
      update: pageEvent({
        state,
        event: hide,
        interest,
      }),
    })
    assert.equal(
      browser.cards.task,
      undefined,
    )
    assert.equal(
      browser.references?.task?.title,
      'Visible',
    )
    assert.equal(
      browser.keys.task,
      'task',
    )
    assert.equal(
      browser.sessions?.['codex:visible'],
      undefined,
    )
    const show: HydraEvent = {
      ...hide,
      id: 'show',
      seq: 4,
      data: {
        before: true,
        after: false,
      },
    }
    replayOwned({
      state,
      events: [show],
    })
    applyPageUpdate({
      state: browser,
      update: pageEvent({
        state,
        event: show,
        interest,
      }),
    })
    const shownAgain = Object.values(browser.cards).find(card => card.id === 'task')
    assert.ok(shownAgain)
    assert.equal(
      shownAgain.title,
      'Visible',
    )
    assert.equal(
      browser.keys.task,
      'task',
    )
    assert.equal(
      shownAgain.steering,
      undefined,
    )
    assert.ok(browser.sessions?.['codex:visible'])
    const compact: HydraEvent = {
      ...create,
      cardId: 'hidden',
      type: 'session.compaction',
      data: {
        kind: 'held',
        input: {
          id: 'held',
          text: 'Private compact input',
          actor: 'owner',
          route: 'steering',
          at: create.at,
        },
      },
    }
    assert.equal(
      pageEvent({
        state,
        event: compact,
        interest,
      }).event,
      undefined,
    )
    assert.equal(
      pageEvent({
        state,
        event: compact,
        interest: {
          cards: ['hidden'],
          hidden: false,
        },
      }).event?.type,
      'session.compaction',
    )
    assert.equal(
      pageEvent({
        state,
        event: {
          ...compact,
          cardId: '$hydra',
        },
        interest,
      }).event?.type,
      'session.compaction',
    )
    const beforeSession = structuredClone(state)
    const origin: HydraEvent = {
      ...create,
      id: 'origin',
      seq: 5,
      cardId: 'origin',
      type: 'card.pushed',
      data: {
        key: 'origin',
        agent: {
          provider: 'codex',
          sessionId: 'session',
        },
        activity: 'working',
      },
    }
    const attached: HydraEvent = {
      ...create,
      id: 'attached',
      seq: 6,
      type: 'task.session',
      data: {
        session: 'codex:session',
        before: 'origin',
        after: 'task',
      },
    }
    replayOwned({
      state,
      events: [
        origin,
        attached,
      ],
    })
    assert.equal(
      pageState({
        state,
        interest,
      }).sessions?.['codex:session']?.taskId,
      'task',
    )
    const active = {
      ...pageState({
        state,
        interest,
      }),
      eventIds: {},
    }
    assert.equal(
      active.cards.task!.activity,
      'working',
    )
    const ended: HydraEvent = {
      ...origin,
      id: 'ended',
      seq: 7,
      data: {
        key: 'origin',
        agent: {
          provider: 'codex',
          sessionId: 'session',
        },
        activity: 'ended',
      },
    }
    replayOwned({
      state,
      events: [ended],
    })
    const hiddenUpdate = pageEvent({
      state,
      event: ended,
      interest,
    })
    assert.equal(
      hiddenUpdate.event,
      undefined,
    )
    applyPageUpdate({
      state: active,
      update: hiddenUpdate,
    })
    assert.equal(
      active.cards.task!.activity,
      'ended',
    )
    assert.equal(
      active.sessions?.['codex:session']?.activity,
      'ended',
    )
    const outcome: HydraEvent = {
      ...origin,
      id: 'outcome',
      seq: 8,
      type: 'card.outcome',
      data: {
        before: null,
        after: {
          state: 'done',
          source: 'hooks',
          note: 'Session ended',
        },
        card: {
          title: 'Origin',
          workspace: '',
          tags: [],
          links: [],
        },
      },
    }
    replayOwned({
      state,
      events: [outcome],
    })
    applyPageUpdate({
      state: active,
      update: pageEvent({
        state,
        event: outcome,
        interest,
      }),
    })
    assert.equal(
      active.cards.task!.outcome?.note,
      'Session ended',
    )
    assert.equal(
      active.sessions?.['codex:session']?.outcome?.note,
      'Session ended',
    )
    const detached: HydraEvent = {
      ...attached,
      id: 'detached',
      seq: 9,
      cardId: 'hidden',
      data: {
        session: 'codex:session',
        before: 'task',
        after: 'hidden',
      },
    }
    replayOwned({
      state,
      events: [detached],
    })
    applyPageUpdate({
      state: active,
      update: pageEvent({
        state,
        event: detached,
        interest,
      }),
    })
    assert.equal(
      active.cards.task!.agent,
      undefined,
    )
    assert.equal(
      active.cards.hidden,
      undefined,
    )
    assert.equal(
      active.sessions?.['codex:session'],
      undefined,
    )
    const resumed = {
      ...pageState({
        state: beforeSession,
        interest,
      }),
      eventIds: {},
    }
    applyPageUpdate({
      state: resumed,
      update: pageEvent({
        state,
        event: origin,
        interest,
      }),
    })
    applyPageUpdate({
      state: resumed,
      update: pageEvent({
        state,
        event: attached,
        interest,
      }),
    })
    applyPageUpdate({
      state: resumed,
      update: pageEvent({
        state,
        event: ended,
        interest,
      }),
    })
    applyPageUpdate({
      state: resumed,
      update: pageEvent({
        state,
        event: outcome,
        interest,
      }),
    })
    applyPageUpdate({
      state: resumed,
      update: pageEvent({
        state,
        event: detached,
        interest,
      }),
    })
    assert.deepEqual(
      pageState({
        state: resumed,
        interest,
      }),
      pageState({
        state,
        interest,
      }),
    )
    assert.deepEqual(
      pageInterest({
        state,
        values: parsePage({
          args: [
            '--card',
            'missing',
            '--card',
            'hidden',
          ],
        }).values,
      }),
      {
        interest: {
          cards: ['hidden'],
          hidden: false,
        },
        unavailable: ['missing'],
      },
    )
    const detachedSession = {
      ...state.sessions!['codex:hidden']!,
      taskId: null,
    }
    const movedVisible = pageEvent({
      state: {
        ...state,
        sessions: { [detachedSession.id]: detachedSession },
      },
      interest,
      event: {
        ...create,
        type: 'task.moved-in',
        data: {
          card: state.cards.task!,
          sessions: [detachedSession],
          from: 'other',
          column: 'queued',
        },
      },
    })
    assert.ok(movedVisible.event?.type === 'task.moved-in')
    assert.deepEqual(
      movedVisible.event.data.sessions,
      [],
    )
    const leaving = emptyHydra()
    const leavingCreate: HydraEvent = {
      ...create,
      data: {
        key: 'task',
        title: 'Old hidden body',
        brief: 'Do not send this old brief',
      },
    }
    replayOwned({
      state: leaving,
      events: [leavingCreate],
    })
    const leavingHide: HydraEvent = {
      ...hide,
      seq: 2,
    }
    replayOwned({
      state: leaving,
      events: [leavingHide],
    })
    const moved: HydraEvent = {
      ...create,
      id: 'moved-away',
      seq: 3,
      type: 'task.moved-out',
      data: {
        card: structuredClone(leaving.cards.task!),
        sessions: [],
        to: 'other-hydra',
      },
    }
    replayOwned({
      state: leaving,
      events: [moved],
    })
    const resumedLeaving = emptyHydra()
    const skippedCreate = pageEvent({
      state: leaving,
      event: leavingCreate,
      interest,
    })
    assert.equal(
      skippedCreate.event,
      undefined,
    )
    assert.deepEqual(
      skippedCreate.cards,
      { task: null },
    )
    applyPageUpdate({
      state: resumedLeaving,
      update: skippedCreate,
    })
    applyPageUpdate({
      state: resumedLeaving,
      update: pageEvent({
        state: leaving,
        event: leavingHide,
        interest,
      }),
    })
    applyPageUpdate({
      state: resumedLeaving,
      update: pageEvent({
        state: leaving,
        event: moved,
        interest,
      }),
    })
    assert.equal(
      resumedLeaving.cards.task,
      undefined,
    )
    assert.deepEqual(
      resumedLeaving.movedOut,
      leaving.movedOut,
    )
    const back: HydraEvent = {
      ...create,
      id: 'moved-back',
      seq: 4,
      type: 'task.moved-in',
      data: {
        card: structuredClone(moved.data.card),
        sessions: [],
        from: 'other-hydra',
        column: 'queued',
      },
    }
    replayOwned({
      state: leaving,
      events: [back],
    })
    applyPageUpdate({
      state: resumedLeaving,
      update: pageEvent({
        state: leaving,
        event: back,
        interest,
      }),
    })
    assert.deepEqual(
      resumedLeaving.movedOut ?? {},
      leaving.movedOut ?? {},
      'a hidden card that moves back clears its moved-out record on the page too',
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
    const moved: HydraEvent = {
      ...base,
      id: 'moved',
      seq: 5,
      cardId: 'task',
      type: 'card.moved',
      data: {
        before: 'queued',
        after: 'parked',
      },
    }
    const idle: HydraEvent = {
      ...base,
      id: 'idle',
      seq: 6,
      cardId: 'hook',
      type: 'card.pushed',
      data: {
        key: 'hook',
        agent: {
          provider: 'claude',
          sessionId: 'hydra',
          host: 'pnyx',
        },
        activity: 'idle',
      },
    }

    for (const event of [
      moved,
      idle,
    ]) {
      replayOwned({
        state,
        events: [event],
      })
      applyPageUpdate({
        state: page,
        update: pageEvent({
          state,
          event,
          interest,
        }),
      })
      assert.deepEqual(
        page.cards[HYDRA_CARD],
        pageCard({ card: state.cards[HYDRA_CARD]! }),
        event.id,
      )
    }

    assert.equal(
      page.cards[HYDRA_CARD]!.activity,
      'idle',
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
