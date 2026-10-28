import { HYDRA_CARD, hydraEvent } from '../../../src/core/hydra.ts'
import assert from 'node:assert/strict'
import { appendFileSync, closeSync, mkdtempSync, openSync, readFileSync, writeFileSync, writeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { decideUndo } from '../../../src/app/undo.ts'
import type { Decision, HydraEvent, HydraState } from '../../../src/app/model.ts'
import { decideView } from '../../../src/preferences/decisions.ts'
import { decideMove, decidePush, decideReply } from '../../../src/core/decide.ts'
import { emptyHydra, reduce, replay } from '../../../src/app/reducer.ts'
import { COLUMNS } from '../../../src/core/model.ts'
import { patchView, viewFor } from '../../../src/preferences/view.ts'
import { columnsFor } from '../hydra/view.ts'
import { loadHydra } from '../../../src/app/store.ts'
import { withWriter } from '../../../src/app/writer.ts'
import { latestMessage, readThread, recordEntries } from '../../../src/thread/read.ts'

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
  "a card's last message comes from the transcript tail, without tool calls, thinking, injected or torn text",
  () => {
    const fixture = ({ name }: { name: string }) => join(
      import.meta.dirname,
      '../../../test/fixtures/transcripts',
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
