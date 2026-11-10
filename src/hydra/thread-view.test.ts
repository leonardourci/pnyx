import { createHydraThreadView, hydraThreadView } from './thread-view.ts'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { emptyHydra, reduce } from '#app/reducer.ts'
import { readThread, recordEntries, splitEntry, type ThreadPage } from './transcripts-read.ts'
import { HYDRA_CARD } from './identity.ts'
import { mergeThreadPages } from './thread-history.ts'
import { liveReplies } from '#workers/streaming.ts'
import { joinMessageParts } from './history.ts'

test(
  'a native page includes the beginning of a reply larger than its transport target',
  t => {
    const home = mkdtempSync(join(
      tmpdir(),
      'pnyx-whole-native-reply-',
    ))
    const previous = process.env.PNYX_HOME
    process.env.PNYX_HOME = home
    t.after(() => {
      if (previous === undefined) {
        delete process.env.PNYX_HOME
      } else {
        process.env.PNYX_HOME = previous
      }

      rmSync(
        home,
        {
          recursive: true,
          force: true,
        },
      )
    })
    const path = join(
      home,
      'native.jsonl',
    )
    const text = 'Keep the beginning and ending. '.repeat(2200).trimEnd()
    writeFileSync(
      path,
      `${JSON.stringify({
        type: 'assistant',
        timestamp: '2026-11-09T00:00:00Z',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'text',
              text,
            },
          ],
        },
      })}\n`,
    )
    const state = reduce({
      state: emptyHydra(),
      event: {
        v: 1,
        seq: 1,
        id: 'create',
        at: '2026-11-09T00:00:00Z',
        actor: 'web',
        cardId: HYDRA_CARD,
        type: 'task.created',
        data: {
          key: 'hydra',
          title: 'Hydra',
        },
      },
    })
    const card = state.cards[HYDRA_CARD]!
    card.agent = {
      provider: 'claude-code',
      sessionId: 'fixture',
      transcriptPath: path,
    }
    const page = readThread({
      hydraId: 'default',
      state,
      card,
      homes: [],
    })
    const messages = joinMessageParts({ entries: page.entries })
    assert.equal(
      messages.length,
      1,
    )
    assert.equal(
      messages[0]!.text,
      text,
      'the first page must include the whole latest reply',
    )
    assert.equal(
      page.older,
      undefined,
    )
  },
)

test(
  'transport chunks preserve redacted offsets when a word crosses their boundary',
  () => {
    const text = `${'a'.repeat(999)}Xsk-${'b'.repeat(40)}${' z'.repeat(1000)}`
    const parts = splitEntry({
      entry: {
        id: 'tool',
        kind: 'tool',
        role: 'Read',
        text,
      },
    })
    const archived = parts.flatMap(entry => splitEntry({ entry }))
    assert.equal(
      joinMessageParts({ entries: archived }).length,
      1,
    )
    assert.equal(
      joinMessageParts({ entries: archived })[0]?.text,
      text,
    )
    assert.equal(
      splitEntry({
        entry: {
          id: 'secret',
          kind: 'message',
          role: 'assistant',
          text: `sk-${'a'.repeat(40)}`,
        },
      })[0]?.text,
      '[redacted]',
    )
  },
)

// The saved and live Hydra pages of a recorded session, whose transcript holds tool calls.
function recordedPages({
  t,
  provider,
  transcript,
}: {
  t: TestContext
  provider: string
  transcript: string
}) {
  const home = mkdtempSync(join(
    tmpdir(),
    'pnyx-thread-view-',
  ))
  const previous = process.env.PNYX_HOME
  process.env.PNYX_HOME = home
  t.after(() => {
    if (previous === undefined) {
      delete process.env.PNYX_HOME
    } else {
      process.env.PNYX_HOME = previous
    }

    rmSync(
      home,
      {
        recursive: true,
        force: true,
      },
    )
  })
  const state = reduce({
    state: emptyHydra(),
    event: {
      v: 1,
      seq: 1,
      id: 'create',
      at: '2026-11-06T00:00:00Z',
      actor: 'web',
      cardId: HYDRA_CARD,
      type: 'task.created',
      data: {
        key: 'hydra',
        title: 'Hydra',
      },
    },
  })
  const card = state.cards[HYDRA_CARD]!
  card.agent = {
    provider,
    sessionId: 'fixture',
    transcriptPath: join(
      import.meta.dirname,
      'fixtures',
      'transcripts',
      transcript,
    ),
  }
  const saved = readThread({
    hydraId: 'default',
    state,
    card,
    homes: [],
  })
  const live = liveReplies()
  live.start({
    offset: 0,
    ownerStarted: true,
  })
  live.update({
    id: 'reply',
    text: 'A live answer',
    append: false,
  })

  return {
    saved: saved.entries.map(entry => entry.kind),
    live: live.page({ page: saved }).entries.map(entry => entry.kind),
  }
}

test(
  'the Claude Code Hydra thread keeps tools in saved and live pages',
  t => {
    assert.deepEqual(
      recordedPages({
        t,
        provider: 'claude-code',
        transcript: 'claude-session.jsonl',
      }),
      {
        saved: [
          'message',
          'message',
          'tool',
          'tool',
          'message',
          'message',
          'message',
          'message',
        ],
        live: [
          'message',
          'message',
          'tool',
          'tool',
          'message',
          'message',
          'message',
          'message',
          'message',
        ],
      },
    )
  },
)

test(
  'the Codex Hydra thread keeps tools in saved and live pages',
  t => {
    assert.deepEqual(
      recordedPages({
        t,
        provider: 'codex',
        transcript: 'codex-session.jsonl',
      }),
      {
        saved: [
          'message',
          'tool',
          'tool',
          'message',
        ],
        live: [
          'message',
          'tool',
          'tool',
          'message',
          'message',
        ],
      },
    )
  },
)

test(
  'the server returns serializable reconciled turns with folds timings and hidden instructions',
  () => {
    const state = reduce({
      state: emptyHydra(),
      event: {
        v: 1,
        seq: 1,
        id: 'create',
        at: '2026-11-06T00:00:00Z',
        actor: 'web',
        cardId: HYDRA_CARD,
        type: 'task.created',
        data: {
          key: 'hydra',
          title: 'Hydra',
        },
      },
    })
    state.cards[HYDRA_CARD]!.agent = {
      provider: 'codex',
      sessionId: 'fixture',
    }
    state.hydraMessages = [
      {
        id: 'owner',
        action: 'send',
        hydra: 'hydra',
        text: 'Please check',
        actor: 'web',
        at: '2026-11-06T00:00:01Z',
      },
    ]
    const page: ThreadPage = {
      card: HYDRA_CARD,
      route: true,
      watching: 'unknown',
      entries: [
        {
          id: 'instructions',
          kind: 'message',
          role: 'user',
          text: '# AGENTS.md instructions\n<INSTRUCTIONS>internal</INSTRUCTIONS>',
          at: '2026-11-06T00:00:00Z',
        },
        {
          id: 'native-owner',
          kind: 'message',
          role: 'user',
          text: 'Please check',
          at: '2026-11-06T00:00:01Z',
        },
        {
          id: 'note',
          kind: 'message',
          role: 'assistant',
          text: 'Checking now',
          at: '2026-11-06T00:00:02Z',
        },
        {
          id: 'reply',
          kind: 'message',
          role: 'assistant',
          text: 'It works',
          at: '2026-11-06T00:00:03Z',
        },
        {
          id: 'quiet',
          kind: 'message',
          role: 'assistant',
          text: 'NO_REPLY',
          at: '2026-11-06T00:00:04Z',
        },
      ],
    }
    const wire = JSON.parse(JSON.stringify(hydraThreadView({
      state,
      page,
      tools: true,
      thinking: true,
    }))) as ThreadPage
    assert.equal(
      wire.entries[0]!.hidden,
      true,
    )
    assert.equal(
      wire.entries[0]!.text,
      '',
    )
    assert.deepEqual(
      wire.conversation!.entries.map(entry => entry.id),
      [
        'native-owner',
        'reply',
      ],
    )
    assert.equal(
      wire.conversation!.timings.reply!.reply,
      'It works',
    )
    assert.equal(
      wire.conversation!.folds.reply!.notes[0]!.text,
      'Checking now',
    )
    const chunks = splitEntry({
      entry: {
        id: 'long',
        role: 'user',
        kind: 'message',
        text: 'x'.repeat(1100),
      },
    })
    assert.equal(
      chunks[1]!.continued,
      true,
    )
    assert.equal(
      chunks[1]!.role,
      'user',
    )
    const archived = splitEntry({
      entry: {
        id: 'tail',
        messageId: 'long',
        part: 1000,
        role: 'user',
        kind: 'message',
        text: 'tail',
      },
    })
    assert.equal(
      archived[0]!.continued,
      true,
    )
  },
)

test(
  'completed background replies survive quiet endings while narration stays hidden',
  () => {
    const state = reduce({
      state: emptyHydra(),
      event: {
        v: 1,
        seq: 1,
        id: 'create',
        at: '2026-10-22T10:00:00Z',
        actor: 'web',
        cardId: HYDRA_CARD,
        type: 'task.created',
        data: {
          key: 'hydra',
          title: 'Hydra',
        },
      },
    })
    const card = state.cards[HYDRA_CARD]!
    card.agent = {
      provider: 'claude-code',
      sessionId: 'fixture',
      host: 'pnyx',
    }
    card.activity = 'working'
    const records = [
      {
        type: 'assistant',
        timestamp: '2026-10-22T10:00:03Z',
        isSidechain: true,
        message: {
          stop_reason: 'end_turn',
          content: 'A subagent internal result',
        },
      },
      {
        type: 'user',
        timestamp: '2026-10-22T10:00:00Z',
        message: { content: 'Please review' },
      },
      {
        type: 'assistant',
        timestamp: '2026-10-22T10:00:01Z',
        message: {
          stop_reason: 'end_turn',
          content: 'Review started',
        },
      },
      {
        type: 'user',
        timestamp: '2026-10-22T10:00:02Z',
        message: { content: '<pnyx-wake>Check pending work</pnyx-wake>' },
      },
      {
        type: 'assistant',
        timestamp: '2026-10-22T10:00:03Z',
        message: {
          stop_reason: 'tool_use',
          content: 'Checking the synthetic task',
        },
      },
      {
        type: 'assistant',
        timestamp: '2026-10-22T10:00:04Z',
        message: {
          stop_reason: 'end_turn',
          content: 'The first result is ready',
        },
      },
      {
        type: 'response_item',
        timestamp: '2026-10-22T10:00:05Z',
        payload: {
          type: 'message',
          role: 'assistant',
          phase: 'commentary',
          content: 'Reading the next task',
        },
      },
      {
        type: 'response_item',
        timestamp: '2026-10-22T10:00:06Z',
        payload: {
          type: 'message',
          role: 'assistant',
          phase: 'final_answer',
          content: 'The second result is ready',
        },
      },
      {
        type: 'assistant',
        timestamp: '2026-10-22T10:00:07Z',
        message: {
          stop_reason: 'end_turn',
          content: 'NO_REPLY',
        },
      },
    ]
    state.hydraMessages = [
      {
        id: 'explicit-update',
        hydra: 'hydra',
        actor: 'hydra',
        action: 'send',
        text: 'An explicit update',
        at: '2026-10-22T10:00:07Z',
      },
    ]
    const page: ThreadPage = {
      card: HYDRA_CARD,
      route: true,
      watching: 'unknown',
      entries: records.flatMap((
        record,
        index,
      ) => recordEntries({
        record,
        offset: index * 100,
        boundaries: true,
        tools: false,
        thinking: false,
      })),
    }
    assert.deepEqual(
      hydraThreadView({
        state,
        page,
        tools: true,
        thinking: false,
      }).conversation.entries.map(entry => entry.text),
      [
        'Please review',
        'Review started',
        'The first result is ready',
        'The second result is ready',
        'An explicit update',
      ],
    )
    const archived = {
      ...page,
      entries: page.entries.filter(entry => !entry.hidden),
    }
    assert.deepEqual(
      hydraThreadView({
        state,
        page: archived,
        tools: true,
        thinking: false,
      }).conversation.entries.map(entry => entry.text),
      [
        'Please review',
        'Review started',
        'The first result is ready',
        'The second result is ready',
        'An explicit update',
      ],
    )
    card.activity = 'finished'
    assert.deepEqual(
      hydraThreadView({
        state,
        page,
        tools: true,
        thinking: false,
      }).conversation.entries.map(entry => entry.text),
      [
        'Please review',
        'Review started',
        'The first result is ready',
        'The second result is ready',
        'An explicit update',
      ],
    )
  },
)

test(
  'terminal, continuation and unknown provider text all remain available',
  () => {
    const reply = ({ record }: { record: unknown }) => hydraThreadView({
      state: emptyHydra(),
      tools: true,
      thinking: false,
      page: {
        card: HYDRA_CARD,
        route: true,
        watching: 'unknown',
        entries: [
          ...recordEntries({
            record: {
              type: 'user',
              timestamp: '2026-10-22T10:00:00Z',
              message: { content: 'Please check' },
            },
            offset: 0,
          }),
          ...recordEntries({
            record,
            offset: 100,
          }),
        ],
      },
    }).conversation.entries.map(entry => entry.text)
    const claude = ({ stop }: { stop?: string }) => reply({
      record: {
        type: 'assistant',
        timestamp: '2026-10-22T10:00:01Z',
        message: {
          stop_reason: stop,
          content: 'A response',
        },
      },
    })
    const codex = ({ phase }: { phase?: string }) => reply({
      record: {
        type: 'response_item',
        timestamp: '2026-10-22T10:00:01Z',
        payload: {
          type: 'message',
          role: 'assistant',
          phase,
          content: [
            {
              type: 'output_text',
              text: 'A response',
            },
          ],
        },
      },
    })
    assert.deepEqual(
      claude({ stop: 'max_tokens' }),
      [
        'Please check',
        'A response',
      ],
    )
    assert.deepEqual(
      claude({ stop: 'refusal' }),
      [
        'Please check',
        'A response',
      ],
    )
    assert.deepEqual(
      claude({ stop: 'stop_sequence' }),
      [
        'Please check',
        'A response',
      ],
    )
    assert.deepEqual(
      claude({ stop: 'model_context_window_exceeded' }),
      [
        'Please check',
        'A response',
      ],
    )
    assert.deepEqual(
      claude({ stop: 'future_terminal_reason' }),
      [
        'Please check',
        'A response',
      ],
    )
    assert.deepEqual(
      claude({}),
      [
        'Please check',
        'A response',
      ],
    )
    assert.deepEqual(
      claude({ stop: 'tool_use' }),
      [
        'Please check',
        'A response',
      ],
    )
    assert.deepEqual(
      claude({ stop: 'pause_turn' }),
      [
        'Please check',
        'A response',
      ],
    )
    assert.deepEqual(
      codex({ phase: 'final_answer' }),
      [
        'Please check',
        'A response',
      ],
    )
    assert.deepEqual(
      codex({ phase: 'partial_answer' }),
      [
        'Please check',
        'A response',
      ],
    )
    assert.deepEqual(
      codex({ phase: 'future_phase' }),
      [
        'Please check',
        'A response',
      ],
    )
    assert.deepEqual(
      codex({}),
      [
        'Please check',
        'A response',
      ],
    )
    assert.deepEqual(
      codex({ phase: 'commentary' }),
      [
        'Please check',
        'A response',
      ],
    )
  },
)

test(
  'live growth preserves the projected conversation through chunks, quiet replies and handoff',
  () => {
    const state = emptyHydra()
    const base: ThreadPage = {
      card: HYDRA_CARD,
      session: 'fixture',
      route: true,
      watching: 'unknown',
      entries: [
        {
          id: 'owner',
          kind: 'message',
          role: 'user',
          text: 'Explain it',
          at: '2026-11-06T00:00:01Z',
        },
        {
          id: 'old',
          kind: 'message',
          role: 'assistant',
          text: 'Earlier answer',
          final: true,
          at: '2026-11-06T00:00:02Z',
        },
      ],
    }
    const project = createHydraThreadView({
      state,
      page: base,
      tools: true,
      thinking: true,
    })
    const live = liveReplies()
    live.start({
      offset: 0,
      ownerStarted: true,
    })

    const check = () => {
      const page = live.page({ page: base })
      assert.deepEqual(
        project({ page }),
        hydraThreadView({
          state,
          page: mergeThreadPages({
            before: base,
            latest: page,
          }),
          tools: true,
          thinking: true,
        }),
      )
    }

    live.update({
      id: 'answer',
      text: 'N',
      append: true,
    })
    check()
    live.update({
      id: 'answer',
      text: 'ormal answer. ',
      append: true,
    })
    check()
    live.update({
      id: 'answer',
      text: 'More detail. '.repeat(200),
      append: true,
    })
    check()
    live.update({
      id: 'answer',
      text: 'The ending.',
      append: true,
    })
    check()
    live.update({
      id: 'second',
      text: 'A separate reply.',
      append: false,
    })
    check()
    live.finish()
    check()
  },
)
