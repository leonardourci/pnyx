import { HYDRA_CARD, hydraEvent } from '../src/core/hydra.ts'
import assert from 'node:assert/strict'
import { appendFileSync, closeSync, mkdtempSync, openSync, readFileSync, writeFileSync, writeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { decideMove, decidePush, decideReply, decideView, type Decision } from '../src/core/decide.ts'
import { decideUndo } from '../src/app/undo.ts'
import { emptyHydra, reduce, replay } from '../src/app/reducer.ts'
import { HydraError, COLUMNS } from '../src/core/model.ts'
import { type HydraEvent, type HydraState } from '../src/app/model.ts'
import { patchView, viewFor, VIEW_SIZE_LIMITS } from '../src/core/view.ts'
import { agentActivity, columnsFor, dropBefore, filterCards, findBoxCards, pageTitle, safeLink, shouldReload, shownActivity, slashMatches, slashPrefix, taskLabel, visibleParent } from '../web/src/hydra/view.ts'
import { withWriter } from '../src/app/writer.ts'
import { loadHydra } from '../src/app/store.ts'
import { latestMessage, readThread, recordEntries } from '../src/thread/read.ts'
import { observe } from '../src/integrations/hooks/observe.ts'
import { briefNotes, relativeTime } from '../web/src/hydra/brief.ts'

// Semantic search is on by default; these tests never start its worker or fetch models.
process.env.PNYX_SEMANTIC = 'off'

const meta = {
  at: '2026-10-13T10:00:00Z',
  actor: 'test',
}

const event = ({ d }: { d: Decision }): HydraEvent => {
  assert.ok('event' in d)

  return d.event
}

const push = ({
  state,
  key,
  fields,
}: {
  state: HydraState
  key: string
  fields: unknown
}) =>
  reduce({
    state,
    event: event({
      d: decidePush({
        state,
        newCardId: `c${state.seq + 1}`,
        key,
        input: fields,
        meta,
      }),
    }),
  })

test(
  'the task Hydra and its semantic matches exclude ad-hoc sessions',
  () => {
    let state = push({
      state: emptyHydra(),
      key: 'work',
      fields: {
        title: 'Shared work',
        attention: [
          {
            key: 'task-question',
            kind: 'question',
            blocking: true,
          },
        ],
      },
    })

    for (const key of [
      'interactive',
      'background',
    ]) {
      state = push({
        state,
        key,
        fields: {
          title: 'Shared run',
          agent: {
            provider: 'claude-code',
            sessionId: key,
          },
          ...(key === 'interactive' ? { terminal: { tty: '/dev/ttys123' } } : {}),
          attention: [
            {
              key: 'hook:question',
              kind: 'question',
              blocking: true,
            },
          ],
        },
      })
    }

    const visible = filterCards({
      state,
      workspace: '',
      tag: '',
      query: 'Shared',
    })
    assert.deepEqual(
      visible.map(c => c.key),
      ['work'],
    )
    assert.deepEqual(
      findBoxCards({
        state,
        workspace: '',
        tag: '',
        query: 'Shared',
        meaning: [
          state.keys.interactive!,
          state.keys.background!,
        ],
      }).map(c => c.key),
      ['work'],
    )
  },
)

test(
  'task labels retain legacy source status instead of claiming every tracked task is parked',
  () => {
    const state = push({
      state: emptyHydra(),
      key: 'fm:legacy',
      fields: {
        title: 'Legacy work',
        activity: 'working: step one',
        source: {
          adapter: 'firstmate',
          instanceId: '/fixture',
          objectId: 'legacy',
        },
      },
    })
    const card = state.cards.c1!
    assert.equal(
      taskLabel({ card }),
      'working: step one',
    )
    const moved = reduce({
      state,
      event: event({
        d: decideMove({
          state,
          ref: card.id,
          column: 'done',
          meta,
        }),
      }),
    })
    assert.equal(
      taskLabel({ card: moved.cards.c1! }),
      'working: step one',
    )
    assert.equal(
      taskLabel({
        card: {
          ...card,
          activity: undefined,
          sourceRefs: [],
        },
      }),
      'No status',
    )
    assert.equal(
      taskLabel({
        card: {
          ...card,
          status: {
            id: 'd1',
            at: meta.at,
            actor: 'test',
            state: 'needs_you',
            note: 'Review',
          },
        },
      }),
      'needs you: Review',
    )
  },
)

test(
  'tab titles follow the view, selected card and current needs-you count',
  () => {
    let state = push({
      state: emptyHydra(),
      key: 'a',
      fields: {
        title: 'Review <literal> changes',
        attention: [
          {
            kind: 'question',
            key: 'q',
            blocking: true,
          },
        ],
      },
    })
    state = push({
      state,
      key: 'b',
      fields: {
        title: 'Another decision',
        attention: [
          {
            kind: 'question',
            key: 'q',
            blocking: true,
          },
        ],
      },
    })
    state = push({
      state,
      key: 'c',
      fields: {
        title: 'Still working',
        activity: 'working',
      },
    })

    for (const ref of [
      'a',
      'b',
    ]) {
      state = reduce({
        state,
        event: event({
          d: decideMove({
            state,
            ref,
            column: 'needs_you',
            meta,
          }),
        }),
      })
    }

    assert.equal(
      pageTitle({
        cards: state.cards,
      }),
      '(2) Hydra · Pnyx',
    )
    assert.equal(
      pageTitle({
        cards: state.cards,
        selected: 'c1',
      }),
      '(2) Review <literal> changes · Pnyx',
    )
    state = push({
      state,
      key: 'a',
      fields: { title: 'Updated card title' },
    })
    state = reduce({
      state,
      event: event({
        d: decideMove({
          state,
          ref: 'b',
          column: 'done',
          meta,
        }),
      }),
    })
    assert.equal(
      pageTitle({
        cards: state.cards,
        selected: 'c1',
      }),
      '(1) Updated card title · Pnyx',
    )
    state = reduce({
      state,
      event: event({
        d: decideMove({
          state,
          ref: 'a',
          column: 'done',
          meta,
        }),
      }),
    })
    assert.equal(
      pageTitle({
        cards: state.cards,
        selected: 'c1',
      }),
      'Updated card title · Pnyx',
    )
  },
)

test(
  'preferences replay deterministically, guard revisions, and undo removes map overrides',
  () => {
    const initial = push({
      state: emptyHydra(),
      key: 'a',
      fields: { title: 'A' },
    })
    const edit = event({
      d: decideView({
        state: initial,
        patch: {
          columnWidths: { in_progress: 400 },
          cardTraceOverrides: { c1: { tools: true } },
        },
        meta: {
          ...meta,
          ifRevision: 0,
          id: 'view-1',
        },
      }),
    })
    const state = reduce({
      state: initial,
      event: edit,
    })
    assert.equal(
      initial.view,
      undefined,
    )
    assert.equal(
      state.viewRevision,
      1,
    )
    assert.equal(
      viewFor({ state }).columnWidths.in_progress,
      400,
    )
    assert.deepEqual(
      reduce({
        state: initial,
        event: edit,
      }),
      state,
    )
    assert.deepEqual(
      decideView({
        state,
        patch: {},
        meta: {
          ...meta,
          id: 'view-1',
          ifRevision: 0,
        },
      }),
      { skipped: 'duplicate' },
    )
    assert.throws(
      () => decideView({
        state,
        patch: { fontSize: 18 },
        meta: {
          ...meta,
          ifRevision: 0,
        },
      }),
      /changed/,
    )
    const undone = reduce({
      state,
      event: event({
        d: decideUndo({
          state,
          target: edit,
          meta: {
            ...meta,
            ifRevision: 1,
          },
        }),
      }),
    })
    assert.deepEqual(
      viewFor({ state: undone }),
      viewFor({ state: initial }),
    )
  },
)

test(
  'saved sizes load clamped to their limits, invalid patches are refused, and widths and card heights have no upper cap',
  () => {
    const state = push({
      state: emptyHydra(),
      key: 'a',
      fields: { title: 'A' },
    })
    const view = patchView({
      state,
      input: {
        hydraWidth: 1800,
        panelWidth: 2000,
        columnWidths: { needs_you: 2100 },
        cardHeights: { c1: 2400 },
        closedCardHeights: { c1: 1200 },
      },
    })
    assert.deepEqual(
      [
        view.hydraWidth,
        view.panelWidth,
        view.columnWidths.needs_you,
        view.cardHeights.c1,
        view.closedCardHeights.c1,
      ],
      [
        1800,
        2000,
        2100,
        2400,
        1200,
      ],
    )
    const loaded = viewFor({
      state: {
        ...state,
        view: {
          ...view,
          panelWidth: 1,
          columnWidths: { needs_you: 1 },
          cardHeights: { c1: 1 },
          closedCardHeights: { c1: 1 },
        },
      },
    })
    assert.deepEqual(
      [
        loaded.panelWidth,
        loaded.columnWidths.needs_you,
        loaded.cardHeights.c1,
        loaded.closedCardHeights.c1,
      ],
      [
        VIEW_SIZE_LIMITS.panelWidth.min,
        VIEW_SIZE_LIMITS.columnWidth.min,
        VIEW_SIZE_LIMITS.cardHeight.min,
        VIEW_SIZE_LIMITS.cardHeight.min,
      ],
    )

    for (const input of [
      { fontSize: 100 },
      { chatFontSize: 100 },
      { codeFontSize: 5 },
      { hydraWidth: 239 },
      { hydraWidth: Infinity },
      { closedCardHeights: { missing: 300 } },
      { closedCardHeights: { c1: VIEW_SIZE_LIMITS.cardHeight.min - 1 } },
      { theme: 'sepia' },
      { lastMessageOnCards: 'yes' },
      JSON.parse('{"columnWidths":{"__proto__":300}}'),
    ]) {
      assert.throws(
        () => patchView({
          state,
          input,
        }),
        HydraError,
        JSON.stringify(input),
      )
    }
  },
)

test(
  'filters hide excluded parents, links stay safe and slash queries work within prose',
  () => {
    let state = push({
      state: emptyHydra(),
      key: 'parent',
      fields: {
        title: 'Private parent',
        workspace: 'A',
      },
    })
    state = push({
      state,
      key: 'child',
      fields: {
        title: 'Searchable child',
        workspace: 'B',
        parent: 'parent',
        tags: ['ui'],
      },
    })
    const visible = filterCards({
      state,
      workspace: 'B',
      tag: 'ui',
      query: 'searchable',
    })
    assert.equal(
      visible.length,
      1,
    )
    assert.equal(
      visibleParent({
        card: visible[0]!,
        visible,
      }),
      undefined,
    )
    assert.equal(
      safeLink({
        link: {
          kind: 'url',
          url: 'javascript:alert(1)',
        },
      }),
      undefined,
    )
    assert.equal(
      slashPrefix({
        text: '/plan',
        cursor: 5,
      }),
      '/plan',
    )
    assert.equal(
      slashPrefix({
        text: 'open /path',
        cursor: 10,
      }),
      '/path',
    )
    assert.equal(
      slashPrefix({
        text: '/tmp/file',
        cursor: 9,
      }),
      null,
    )

    for (const typed of [
      '/d',
      '/D',
      '/dep',
    ]) {
      assert.equal(
        slashMatches({
          command: '/Deploy',
          prefix: slashPrefix({
            text: typed,
            cursor: typed.length,
          })!,
        }),
        true,
      )
    }

    assert.equal(
      slashMatches({
        command: '$Review',
        prefix: '/rev',
      }),
      true,
    )
    assert.equal(
      slashMatches({
        command: '/Deploy',
        prefix: '/r',
      }),
      false,
    )
  },
)

test(
  'the Find box shows every card its filter matches, then the strong meaning-only cards',
  () => {
    let state = emptyHydra()

    for (let i = 0; i < 35; i += 1) {
      state = push({
        state,
        key: `deploy-${i}`,
        fields: {
          title: `Deploy step ${i}`,
          workspace: 'A',
        },
      })
    }

    state = push({
      state,
      key: 'ops-rotation',
      fields: {
        title: 'Rotate keys',
        workspace: 'A',
        tags: ['infra'],
      },
    })
    state = push({
      state,
      key: 'cookie',
      fields: {
        title: 'Session cookie',
        workspace: 'B',
      },
    })
    const id = ({ key }: { key: string }) => Object.values(state.cards).find(c => c.key === key)!.id
    const ids = ({ cards }: { cards: { id: string }[] }) => cards.map(c => c.id)

    for (const query of [
      'dep',
      'nothing like it',
      '',
    ]) {
      assert.deepEqual(
        findBoxCards({
          state,
          workspace: '',
          tag: '',
          query,
          meaning: [],
        }),
        filterCards({
          state,
          workspace: '',
          tag: '',
          query,
        }),
      )
    }

    assert.equal(
      findBoxCards({
        state,
        workspace: '',
        tag: '',
        query: 'dep',
        meaning: [],
      }).length,
      35,
    )
    assert.deepEqual(
      ids({
        cards: findBoxCards({
          state,
          workspace: '',
          tag: '',
          query: 'infra',
          meaning: [],
        }),
      }),
      [id({ key: 'ops-rotation' })],
    )
    assert.deepEqual(
      ids({
        cards: findBoxCards({
          state,
          workspace: '',
          tag: '',
          query: 'ops-rot',
          meaning: [],
        }),
      }),
      [id({ key: 'ops-rotation' })],
    )

    const found = findBoxCards({
      state,
      workspace: '',
      tag: '',
      query: 'deploy',
      meaning: [
        id({ key: 'cookie' }),
        id({ key: 'deploy-0' }),
        'gone',
      ],
    })
    assert.deepEqual(
      ids({ cards: found }),
      [
        ...ids({
          cards: filterCards({
            state,
            workspace: '',
            tag: '',
            query: 'deploy',
          }),
        }),
        id({ key: 'cookie' }),
      ],
    )
    assert.equal(
      findBoxCards({
        state,
        workspace: 'A',
        tag: '',
        query: 'deploy',
        meaning: [id({ key: 'cookie' })],
      }).length,
      35,
    )
    assert.deepEqual(
      ids({
        cards: findBoxCards({
          state,
          workspace: '',
          tag: 'infra',
          query: 'deploy',
          meaning: [
            id({ key: 'cookie' }),
            id({ key: 'ops-rotation' }),
          ],
        }),
      }),
      [id({ key: 'ops-rotation' })],
    )
  },
)

test(
  'thread reader ignores partial records, separates traces and reports unavailable capabilities',
  () => {
    const home = mkdtempSync(join(
      tmpdir(),
      'pnyx-thread-',
    )); process.env.PNYX_HOME = home
    const path = join(
      home,
      'session.jsonl',
    )
    const records = Array.from(
      { length: 3 },
      (
        _,
        i,
      ) => JSON.stringify({
        type: 'assistant',
        message: { content: `message ${i}` },
      }),
    )
    writeFileSync(
      path,
      records.join('\n') + '\n{"partial":',
    )
    const state = push({
      state: emptyHydra(),
      key: 'a',
      fields: {
        agent: {
          provider: 'claude',
          sessionId: 'fixture',
          transcriptPath: path,
        },
      },
    })
    const page = readThread({
      hydraId: 'default',
      state,
      card: state.cards.c1!,
      homes: [],
    })
    assert.equal(
      page.entries.at(-1)?.text,
      'message 2',
    )
    assert.equal(
      page.route,
      false,
    ); assert.equal(
      page.watching,
      'unknown',
    )
    const entries = recordEntries({
      record: {
        type: 'assistant',
        message: {
          content: [
            {
              type: 'text',
              text: 'hello',
            },
            {
              type: 'thinking',
              thinking: 'thinking',
            },
            {
              type: 'tool_use',
              id: 'toolu_1',
              input: 'sk-abcdefghijklmnop123456789',
            },
          ],
        },
      },
      offset: 0,
    })
    assert.deepEqual(
      entries.map(e => e.kind),
      [
        'message',
        'thinking',
        'tool',
      ],
    ); assert.equal(
      entries[2]?.text,
      '[redacted]',
    )
    assert.equal(
      entries[2]?.call,
      'toolu_1',
    )
    assert.equal(
      recordEntries({
        record: {
          type: 'user',
          message: {
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'toolu_1',
                content: 'done',
              },
            ],
          },
        },
        offset: 1,
      })[0]?.call,
      'toolu_1',
    )
    // A Codex call carries its item id too; its output names only the call id.
    assert.deepEqual(
      [
        {
          type: 'function_call',
          id: 'fc_1',
          call_id: 'call_1',
          name: 'shell',
          arguments: '{}',
        },
        {
          type: 'function_call_output',
          call_id: 'call_1',
          output: 'done',
        },
      ].map((
        payload,
        offset,
      ) => recordEntries({
        record: {
          type: 'response_item',
          payload,
        },
        offset,
      })[0]?.call),
      [
        'call_1',
        'call_1',
      ],
    )
    assert.deepEqual(
      recordEntries({
        record: {
          type: 'user',
          isMeta: true,
          message: { content: 'injected' },
        },
        offset: 0,
      }),
      [],
    )
  },
)

test(
  'Focus hides traces before paging, even from a tool-heavy tail larger than the first read window, and turning it off shows them',
  () => {
    const home = mkdtempSync(join(
      tmpdir(),
      'pnyx-focus-window-',
    )); process.env.PNYX_HOME = home
    const path = join(
        home,
        'session.jsonl',
      ), padding = 'x'.repeat(4000)
    const records = Array.from(
      { length: 90 },
      (
        _,
        i,
      ) => [
        {
          type: 'assistant',
          message: { content: `message ${i}` },
        },
        {
          type: 'assistant',
          message: {
            content: [
              {
                type: 'tool_use',
                input: `${padding} ${i}`,
              },
            ],
          },
        },
      ],
    ).flat()
    writeFileSync(
      path,
      records.map(r => JSON.stringify(r)).join('\n') + '\n',
    )
    const state = push({
      state: emptyHydra(),
      key: 'a',
      fields: {
        agent: {
          provider: 'claude',
          sessionId: 'fixture',
          transcriptPath: path,
        },
      },
    })
    const page = readThread({
      hydraId: 'default',
      state,
      card: state.cards.c1!,
      homes: [],
    })
    assert.deepEqual(
      page.entries.map(e => e.text),
      Array.from(
        { length: 60 },
        (
          _,
          i,
        ) => `message ${i + 30}`,
      ),
    )
    const older = readThread({
      hydraId: 'default',
      state,
      card: state.cards.c1!,
      homes: [],
      before: page.older,
    })
    assert.deepEqual(
      older.entries.map(e => e.text),
      Array.from(
        { length: 30 },
        (
          _,
          i,
        ) => `message ${i}`,
      ),
    )
    assert.equal(
      older.older,
      undefined,
    )
    const showTools = reduce({
      state,
      event: event({
        d: decideView({
          state,
          patch: { focusMode: false },
          meta,
        }),
      }),
    })
    assert.ok(readThread({
      hydraId: 'default',
      state: showTools,
      card: showTools.cards.c1!,
      homes: [],
    }).entries.some(e => e.kind === 'tool'))
  },
)

test(
  'long transcript messages and reply history page without losing text or duplicating entries',
  () => {
    const home = mkdtempSync(join(
      tmpdir(),
      'pnyx-thread-pages-',
    )); process.env.PNYX_HOME = home
    const path = join(
        home,
        'session.jsonl',
      ), longText = 'abcdefghij'.repeat(7000)
    writeFileSync(
      path,
      JSON.stringify({
        type: 'assistant',
        timestamp: '2026-10-12T10:00:00Z',
        message: { content: longText },
      }) + '\n',
    )
    const state = withWriter({
      hydraId: 'default',
      fn: ({ writer: w }) => {
        w.append({
          event: event({
            d: decidePush({
              state: w.state,
              newCardId: `c${w.state.seq + 1}`,
              key: 'a',
              input: {
                agent: {
                  provider: 'claude',
                  sessionId: 'fixture',
                  transcriptPath: path,
                },
              },
              meta,
            }),
          }),
        })

        for (let i = 0; i < 90; i++) {
          w.append({
            event: event({
              d: decideReply({
                state: w.state,
                ref: 'a',
                data: {
                  reply: `r${i}`,
                  state: 'queued',
                  route: 'fixture',
                  text: `reply ${i}`,
                },
                meta,
              }),
            }),
          })
        }

        return w.state
      },
    })
    let cursor: string | undefined
    const pages: ReturnType<typeof readThread>['entries'][] = []

    do {
      const page = readThread({
        hydraId: 'default',
        state,
        card: state.cards.c1!,
        homes: [],
        before: cursor,
      })
      assert.ok(page.entries.length <= 60)
      pages.unshift(page.entries); cursor = page.older
      assert.ok(
        pages.length < 10,
        'pagination terminates',
      )
    } while (cursor)

    const entries = pages.flat()
    assert.equal(
      new Set(entries.map(e => e.id)).size,
      entries.length,
    )
    assert.equal(
      entries.filter(e => e.role.startsWith('assistant')).map(e => e.text)
        .join(''),
      longText,
    )
    assert.equal(
      entries.filter(e => e.role === 'You').length,
      90,
    )
    const later = withWriter({
      hydraId: 'default',
      fn: ({ writer: w }) => {
        w.append({
          event: event({
            d: decideReply({
              state: w.state,
              ref: 'a',
              data: {
                reply: 'r90',
                state: 'queued',
                route: 'fixture',
                text: 'reply 90',
              },
              meta,
            }),
          }),
        })

        return w.state
      },
    })
    assert.equal(
      readThread({
        hydraId: 'default',
        state: later,
        card: later.cards.c1!,
        homes: [],
      }).entries.at(-1)?.text,
      'reply 90',
    )
  },
)

test(
  'a tab reloads only when it reconnects to a server serving another build',
  () => {
    assert.equal(
      shouldReload({
        loaded: 'aaa111',
        server: 'bbb222',
      }),
      true,
    )
    assert.equal(
      shouldReload({
        loaded: 'aaa111',
        server: 'aaa111',
      }),
      false,
    )
    // The Vite dev page has no build; hot module replacement updates it instead.
    assert.equal(
      shouldReload({
        loaded: undefined,
        server: 'bbb222',
      }),
      false,
    )
    assert.equal(
      shouldReload({
        loaded: '',
        server: 'bbb222',
      }),
      false,
    )
    assert.equal(
      shouldReload({
        loaded: 'aaa111',
        server: '',
      }),
      false,
    )
  },
)

test(
  "a card's last message comes from the transcript tail, without tool calls, thinking, injected or torn text",
  () => {
    const fixture = ({ name }: { name: string }) => join(
      import.meta.dirname,
      'fixtures/transcripts',
      name,
    )
    const claude = latestMessage({ path: fixture({ name: 'claude-session.jsonl' }) }).message!
    assert.equal(
      claude.role,
      'assistant',
    )
    assert.equal(
      claude.at,
      '2026-10-11T09:02:00.000Z',
    )
    assert.match(
      claude.text,
      /^Paragraph 0 about the orders table backfill\. Rows are copied/,
    )
    assert.ok(claude.text.length <= 280 && claude.text.endsWith('…'))
    assert.deepEqual(
      latestMessage({ path: fixture({ name: 'codex-session.jsonl' }) }).message,
      {
        role: 'assistant',
        text: 'The export query scans every invoice without an index.',
        at: '2026-10-12T10:00:07.000Z',
      },
    )
    const dir = mkdtempSync(join(
        tmpdir(),
        'pnyx-latest-',
      )), path = join(
        dir,
        'codex.jsonl',
      )
    const line = ({ payload }: { payload: unknown }) => JSON.stringify({
      timestamp: '2026-10-12T10:01:00.000Z',
      type: 'response_item',
      payload,
    }) + '\n'
    writeFileSync(
      path,
      readFileSync(
        fixture({ name: 'codex-session.jsonl' }),
        'utf8',
      ) + line({
        payload: {
          type: 'message',
          role: 'user',
          content: [
            {
              type: 'input_text',
              text: '<environment_context>\n<cwd>/work</cwd>\n</environment_context>Now add the index.',
            },
          ],
        },
      }) + line({
        payload: {
          type: 'function_call_output',
          call_id: 'c2',
          output: 'x'.repeat(200_000),
        },
      }),
    )
    assert.deepEqual(
      latestMessage({ path }).message,
      {
        role: 'assistant',
        text: 'The export query scans every invoice without an index.',
        at: '2026-10-12T10:00:07.000Z',
      },
    )
    assert.equal(
      latestMessage({
        path: join(
          dir,
          'missing.jsonl',
        ),
      }).message,
      null,
    )
    writeFileSync(
      path,
      line({
        payload: {
          type: 'reasoning',
          summary: [],
        },
      }),
    )
    assert.equal(
      latestMessage({ path }).message,
      null,
    )
  },
)

test(
  "a card's last message is read again from only what its transcript gained",
  () => {
    const dir = mkdtempSync(join(
        tmpdir(),
        'pnyx-latest-',
      )), path = join(
        dir,
        'claude.jsonl',
      )
    const line = ({
      type,
      text,
      at,
    }: {
      type: string
      text: string
      at: string
    }) => JSON.stringify({
      type,
      timestamp: at,
      message: {
        content: [
          {
            type: 'text',
            text,
          },
        ],
      },
    }) + '\n'
    const tool = JSON.stringify({
      type: 'assistant',
      timestamp: '2026-10-12T10:02:00.000Z',
      message: {
        content: [
          {
            type: 'tool_use',
            name: 'Bash',
            input: {},
          },
        ],
      },
    }) + '\n'
    writeFileSync(
      path,
      line({
        type: 'assistant',
        text: 'First reply.',
        at: '2026-10-12T10:00:00.000Z',
      }),
    )
    const first = latestMessage({ path })
    assert.equal(
      first.message?.text,
      'First reply.',
    )
    // Appended tool calls and a torn line hold no message: the previous one stays, and the torn line is read once complete.
    const torn = line({
      type: 'user',
      text: 'Ship it.',
      at: '2026-10-12T10:03:00.000Z',
    })
    appendFileSync(
      path,
      tool + torn.slice(
        0,
        20,
      ),
    )
    const second = latestMessage({
      path,
      prev: first,
    })
    assert.equal(
      second.message?.text,
      'First reply.',
    )
    assert.equal(
      second.size,
      first.size + tool.length,
    )
    appendFileSync(
      path,
      torn.slice(20),
    )
    const fd = openSync(
      path,
      'r+',
    ); writeSync(
      fd,
      'x',
      0,
    ); closeSync(fd)
    const third = latestMessage({
      path,
      prev: second,
    })
    assert.equal(
      third.message?.text,
      'First reply.',
    )
    writeFileSync(
      path,
      line({
        type: 'assistant',
        text: 'Fresh.',
        at: '2026-10-12T11:00:00.000Z',
      }),
    )
    assert.equal(
      latestMessage({
        path,
        prev: third,
      }).message?.text,
      'Fresh.',
    )
  },
)

test(
  'deleting a populated column is atomic, replayable, undoable and guarded',
  () => {
    const events: HydraEvent[] = []
    let state = emptyHydra()

    const apply = ({ d }: { d: Decision }) => {
      const e = event({ d }); events.push(e); state = reduce({
        state,
        event: e,
      })

      return e
    }

    apply({
      d: decidePush({
        state,
        newCardId: `c${state.seq + 1}`,
        key: 'question',
        input: {
          attention: [
            {
              kind: 'question',
              key: 'q',
              blocking: true,
            },
          ],
        },
        meta,
      }),
    })
    apply({
      d: decidePush({
        state,
        newCardId: `c${state.seq + 1}`,
        key: 'worker',
        input: {},
        meta,
      }),
    })
    apply({
      d: decideView({
        state,
        patch: {
          customColumns: [
            {
              id: 'custom:later',
              title: 'Later',
            },
          ],
          columnWidths: { 'custom:later': 400 },
        },
        meta,
      }),
    })
    assert.equal(
      columnsFor({ state }).at(-1)?.title,
      'Later',
    )
    assert.throws(
      () => decideMove({
        state,
        ref: 'question',
        column: 'custom:missing',
        meta,
      }),
      /unknown/,
    )
    apply({
      d: decideMove({
        state,
        ref: 'question',
        column: 'custom:later',
        meta,
      }),
    })
    apply({
      d: decideMove({
        state,
        ref: 'worker',
        column: 'custom:later',
        meta,
      }),
    })
    const before = structuredClone(state)
    const deletion = apply({
      d: decideView({
        state,
        patch: { customColumns: [] },
        meta: {
          ...meta,
          id: 'delete',
          ifRevision: 1,
        },
      }),
    })
    assert.equal(
      state.cards.c1!.column,
      'parked',
    )
    assert.equal(
      state.cards.c2!.column,
      'parked',
    )
    assert.equal(
      viewFor({ state }).columnWidths['custom:later'],
      undefined,
    )
    assert.deepEqual(
      decideView({
        state,
        patch: { customColumns: [] },
        meta: {
          ...meta,
          id: 'delete',
          ifRevision: 1,
        },
      }),
      { skipped: 'duplicate' },
    )
    const later = reduce({
      state,
      event: event({
        d: decideMove({
          state,
          ref: 'worker',
          column: 'done',
          meta,
        }),
      }),
    })
    assert.throws(
      () => decideUndo({
        state: later,
        target: deletion,
        meta,
      }),
      /moved since/,
    )
    apply({
      d: decideUndo({
        state,
        target: deletion,
        meta: {
          ...meta,
          ifRevision: 2,
        },
      }),
    })
    assert.deepEqual(
      viewFor({ state }),
      viewFor({ state: before }),
    )
    assert.equal(
      state.cards.c1!.column,
      'custom:later',
    )
    assert.equal(
      state.cards.c2!.column,
      'custom:later',
    )
    assert.deepEqual(
      state.cards.c1!.attention,
      before.cards.c1!.attention,
    )
    assert.deepEqual(
      replay({
        state: emptyHydra(),
        events,
      }),
      state,
    )

    for (const id of COLUMNS) {
      assert.throws(
        () => patchView({
          state,
          input: {
            customColumns: [
              {
                id,
                title: 'Replacement',
              },
            ],
          },
        }),
        /invalid/,
      )
    }
  },
)

test(
  'the notes header keeps the newest distinct notes and skips text already in the chat',
  () => {
    const note = {
      at: '2026-10-13T10:00:00Z',
      source: 'firstmate',
      text: 'resolved: Keep the composer visible.',
    }
    const newer = {
      ...note,
      at: '2026-10-13T11:00:00Z',
    }
    assert.deepEqual(
      briefNotes({
        notes: [
          note,
          newer,
          {
            ...note,
            text: 'Already in the chat.',
          },
        ],
        conversation: ['Already in the chat.'],
      }),
      [newer],
    )
    assert.deepEqual(
      briefNotes({
        notes: [note],
        conversation: ['Keep the composer visible.'],
      }),
      [],
    )
    assert.equal(
      relativeTime({
        at: note.at,
        now: Date.parse('2026-10-13T10:02:00Z'),
      }),
      '2m ago',
    )
    assert.equal(
      relativeTime({
        at: undefined,
        now: 0,
      }),
      'Time not recorded',
    )
  },
)

test(
  'the turn indicator follows the joined session until the turn ends, unobserved activity stays unknown and an ended worker stays stopped',
  () => {
    const firstmate = {
      activity: 'working: task status',
      source: {
        adapter: 'firstmate',
        objectId: 'task',
      },
    }
    let state = push({
      state: emptyHydra(),
      key: 'task',
      fields: {
        title: 'Joined task',
        ...firstmate,
      },
    })
    assert.equal(
      agentActivity({ card: state.cards.c1! }),
      undefined,
    )

    for (const [
      hook,
      expected,
    ] of [
        [
          'PreToolUse',
          'working',
        ],
        [
          'Stop',
          'finished',
        ],
      ] as const) {
      const [observed] = observe({
        envelope: {
          v: 1,
          id: hook,
          at: meta.at,
          harness: 'claude',
          event: hook,
          payload: {
            session_id: 'fixture',
            tool_name: 'Read',
          },
        },
      })
      assert.ok(observed)
      state = push({
        state,
        key: 'task',
        fields: observed.card,
      })
      assert.equal(
        agentActivity({ card: state.cards.c1! }),
        expected,
      )
      state = push({
        state,
        key: 'task',
        fields: firstmate,
      })
      assert.equal(
        state.cards.c1!.activity,
        'working: task status',
      )
      assert.equal(
        agentActivity({ card: state.cards.c1! }),
        expected,
      )
    }

    const [ended] = observe({
      envelope: {
        v: 1,
        id: 'end',
        at: meta.at,
        harness: 'claude',
        event: 'SessionEnd',
        payload: { session_id: 'fixture' },
      },
    })
    assert.ok(ended)
    state = push({
      state,
      key: 'task',
      fields: ended.card,
    })
    assert.equal(
      shownActivity({ card: state.cards.c1! }),
      'ended',
    )
    state = push({
      state,
      key: 'task',
      fields: {
        ...firstmate,
        activity: 'working: new step',
      },
    })
    assert.equal(
      shownActivity({ card: state.cards.c1! }),
      'working: new step',
    )
    assert.equal(
      agentActivity({ card: state.cards.c1! }),
      'stopped',
      'a source status line never revives an ended worker',
    )
  },
)

test(
  'a dropped card goes above the card it lands on, or below it on its lower half',
  () => {
    let state = emptyHydra()

    for (const key of [
      'a',
      'b',
    ]) {
      state = push({
        state,
        key,
        fields: {},
      })
    }

    const cards = filterCards({
      state,
      workspace: '',
      tag: '',
    })
    assert.equal(
      dropBefore({
        cards,
        over: 'c1',
        below: false,
      }),
      'c1',
    )
    assert.equal(
      dropBefore({
        cards,
        over: 'c1',
        below: true,
      }),
      'c2',
    )
    assert.equal(
      dropBefore({
        cards,
        over: 'c2',
        below: true,
      }),
      undefined,
      'below the last card is the end',
    )
    assert.equal(
      dropBefore({
        cards,
        below: false,
      }),
      undefined,
      'empty column space is the end',
    )
  },
)

test(
  'Hydra actions between adjacent transcript pages remain in the older page',
  () => {
    const previous = process.env.PNYX_HOME
    const home = mkdtempSync(join(
      tmpdir(),
      'pnyx-action-pages-',
    ))
    process.env.PNYX_HOME = home

    try {
      const transcript = join(
        home,
        'hydra.jsonl',
      )
      const start = Date.UTC(
        2026,
        9,
        22,
        10,
      )
      const records = Array.from(
        { length: 121 },
        (
          _,
          index,
        ) => ({
          type: index === 0 ? 'user' : 'assistant',
          timestamp: new Date(start + index * 1000).toISOString(),
          message: {
            content: [
              {
                type: 'text',
                text: `Message ${index}`,
              },
            ],
          },
        }),
      )
      writeFileSync(
        transcript,
        records.map(record => JSON.stringify(record)).join('\n') + '\n',
      )
      withWriter({
        hydraId: 'default',
        fn: ({ writer }) => {
          const create = hydraEvent({
            state: writer.state,
            cardId: 'task',
            meta: {
              actor: 'web',
              at: new Date(start).toISOString(),
            },
            change: {
              type: 'task.created',
              data: {
                key: 'task',
                title: 'Paged task',
              },
            },
          })
          assert.ok('event' in create)
          writer.append({ event: create.event })
          const change = hydraEvent({
            state: writer.state,
            cardId: 'task',
            meta: {
              actor: 'hydra',
              at: new Date(start + 60_500).toISOString(),
              reason: 'Keep this action in history',
            },
            change: {
              type: 'task.brief',
              data: {
                before: '',
                after: 'A revised brief',
              },
            },
          })
          assert.ok('event' in change)
          writer.append({ event: change.event })
        },
      })
      const { state } = loadHydra({ hydraId: 'default' })
      const card = {
        ...state.cards.task!,
        id: HYDRA_CARD,
        agent: {
          provider: 'claude',
          sessionId: 'fixture',
          transcriptPath: transcript,
        },
      }
      const latest = readThread({
        hydraId: 'default',
        state,
        card,
        homes: [],
      })
      assert.ok(latest.older)
      const older = readThread({
        hydraId: 'default',
        state,
        card,
        homes: [],
        before: latest.older,
      })
      const changed = older.actions?.find(action => action.type === 'task.brief')
      assert.equal(
        changed?.reason,
        'Keep this action in history',
      )
      assert.ok(changed!.at > older.entries.at(-1)!.at!)
      assert.ok(changed!.at < latest.entries[0]!.at!)
    } finally {
      process.env.PNYX_HOME = previous
    }
  },
)
