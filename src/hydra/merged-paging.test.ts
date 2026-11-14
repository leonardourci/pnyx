import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { emptyHydra, reduce } from '#app/reducer.ts'
import { HYDRA_CARD } from './identity.ts'
import type { HydraMessage } from './model.ts'
import { mergeThreadPages } from './thread-history.ts'
import { hydraThreadView } from './thread-view.ts'
import { readThread } from './transcripts-read.ts'

const at = ({ minutes }: { minutes: number }) => new Date(Date.UTC(
  2026,
  10,
  1,
  9,
  0,
) + minutes * 60_000).toISOString()

test(
  'reaching the end of a transcript keeps what the owner already scrolled through',
  t => {
    const home = mkdtempSync(join(
      tmpdir(),
      'pnyx-review-386-',
    ))
    const previous = process.env.PNYX_HOME
    process.env.PNYX_HOME = home
    t.after(() => {
      process.env.PNYX_HOME = previous
    })
    // 80 transcript replies from 10:00 to 11:19: two pages of 60.
    const native = join(
      home,
      'native.jsonl',
    )
    writeFileSync(
      native,
      `${Array.from(
        { length: 80 },
        (
          _,
          i,
        ) => JSON.stringify({
          type: 'assistant',
          timestamp: at({ minutes: 60 + i }),
          message: {
            content: `Reply ${i}`,
            stop_reason: 'end_turn',
          },
        }),
      ).join('\n')}\n`,
    )
    // 75 owner messages from 09:00 to 11:28.
    const messages = Array.from(
      { length: 75 },
      (
        _,
        i,
      ): HydraMessage => ({
        id: `m${i}`,
        action: 'send',
        text: `owner message ${i}`,
        at: at({ minutes: i * 2 }),
        actor: 'web',
        hydra: 'hydra',
      }),
    )
    const state = reduce({
      state: emptyHydra(),
      event: {
        v: 1,
        seq: 1,
        id: 'create',
        at: at({ minutes: 0 }),
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
      provider: 'claude-code',
      sessionId: 'fixture',
      transcriptPath: native,
    }
    state.hydraMessages = messages
    const read = ({ before }: { before?: string } = {}) => readThread({
      hydraId: 'default',
      state,
      card: state.cards[HYDRA_CARD]!,
      homes: [],
      before,
    })
    const shown = ({ page }: { page: ReturnType<typeof read> }) => hydraThreadView({
      state,
      page,
      tools: true,
      thinking: false,
    })
      .conversation.entries.map(entry => entry.text).filter(text => /^(Reply|owner message) /.test(text))

    const first = read()
    assert.ok(shown({ page: first }).length <= 20)
    let page = first
    let reads = 0

    while (page.older && reads++ < 20) {
      const before = shown({ page })
      const older = read({ before: page.older })
      assert.ok(older.entries.length <= 20)
      page = mergeThreadPages({
        before: page,
        latest: older,
        olderPage: true,
      })
      assert.ok(before.every(text => shown({ page }).includes(text)))
    }

    assert.equal(
      page.older,
      undefined,
    )
    assert.equal(
      new Set(shown({ page })).size,
      155,
    )
  },
)

test(
  'a transcript with an older page bounds the first page across messages and transcript',
  t => {
    const home = mkdtempSync(join(
      tmpdir(),
      'pnyx-review-386-',
    ))
    const previous = process.env.PNYX_HOME
    process.env.PNYX_HOME = home
    t.after(() => {
      process.env.PNYX_HOME = previous
    })
    // 80 transcript replies, one every 3 hours: its newest page of 60 spans 7.5 days.
    const native = join(
      home,
      'native.jsonl',
    )
    writeFileSync(
      native,
      `${Array.from(
        { length: 80 },
        (
          _,
          i,
        ) => JSON.stringify({
          type: 'assistant',
          timestamp: at({ minutes: i * 180 }),
          message: {
            content: `Reply ${i}`,
            stop_reason: 'end_turn',
          },
        }),
      ).join('\n')}\n`,
    )
    // 1,000 owner messages over the last 7 days, the busy chat the re-measure saw.
    const messages = Array.from(
      { length: 1000 },
      (
        _,
        i,
      ): HydraMessage => ({
        id: `m${i}`,
        action: 'send',
        text: `owner message ${i}`,
        at: at({ minutes: 80 * 180 - 7 * 24 * 60 + i * 10 }),
        actor: 'web',
        hydra: 'hydra',
      }),
    )
    const state = reduce({
      state: emptyHydra(),
      event: {
        v: 1,
        seq: 1,
        id: 'create',
        at: at({ minutes: 0 }),
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
      provider: 'claude-code',
      sessionId: 'fixture',
      transcriptPath: native,
    }
    state.hydraMessages = messages
    const page = readThread({
      hydraId: 'default',
      state,
      card: state.cards[HYDRA_CARD]!,
      homes: [],
    })
    const entries = hydraThreadView({
      state,
      page,
      tools: true,
      thinking: false,
    }).conversation.entries
    assert.ok(
      entries.filter(entry => entry.text.startsWith('owner message')).length <= 20,
      'the first page should hold about 20 messages',
    )
  },
)
