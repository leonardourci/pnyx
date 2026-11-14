import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { emptyHydra, reduce } from '#app/reducer.ts'
import { HYDRA_CARD } from './identity.ts'
import type { HydraMessage } from './model.ts'

const MESSAGE_PAGE = 20
import { mergeThreadPages } from './thread-history.ts'
import { hydraThreadView } from './thread-view.ts'
import { readThread } from './transcripts-read.ts'

const COUNT = 75

const messages = Array.from(
  { length: COUNT },
  (
    _,
    index,
  ): HydraMessage => ({
    id: `m${index}`,
    action: 'send',
    text: `owner message ${index}`,
    at: new Date(Date.UTC(
      2026,
      10,
      1,
    ) + index * 60_000).toISOString(),
    actor: 'web',
    hydra: 'hydra',
  }),
)

test(
  'a conversation without a transcript opens on its newest messages and reads earlier ones page by page',
  t => {
    const previous = process.env.PNYX_HOME
    process.env.PNYX_HOME = mkdtempSync(join(
      tmpdir(),
      'pnyx-message-window-',
    ))
    t.after(() => {
      process.env.PNYX_HOME = previous
    })
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
    state.cards[HYDRA_CARD]!.agent = {
      provider: 'claude-code',
      sessionId: 'fixture',
    }
    state.hydraMessages = messages
    const read = ({ before }: { before?: string } = {}) => readThread({
      hydraId: 'default',
      state,
      card: state.cards[HYDRA_CARD]!,
      homes: [],
      before,
    })
    const texts = ({ page }: { page: ReturnType<typeof read> }) => hydraThreadView({
      state,
      page,
      tools: true,
      thinking: false,
    }).conversation.entries.filter(entry => entry.text.startsWith('owner message'))
      .map(entry => entry.text)

    let page = read()

    assert.deepEqual(
      texts({ page }),
      messages.slice(-MESSAGE_PAGE).map(message => message.text),
      'the first read carries only the newest page',
    )
    assert.ok(page.older)

    let reads = 0

    while (page.older) {
      page = mergeThreadPages({
        before: page,
        latest: read({ before: page.older }),
        olderPage: true,
      })
      reads++
    }

    assert.equal(
      reads,
      Math.ceil(COUNT / MESSAGE_PAGE) - 1,
    )
    assert.deepEqual(
      texts({ page }),
      messages.map(message => message.text),
      'every earlier message is read, and the page then holds no limit',
    )
  },
)

test(
  'a page read again keeps how far back the loaded messages reach',
  t => {
    const previous = process.env.PNYX_HOME
    process.env.PNYX_HOME = mkdtempSync(join(
      tmpdir(),
      'pnyx-message-window-',
    ))
    t.after(() => {
      process.env.PNYX_HOME = previous
    })
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
    state.cards[HYDRA_CARD]!.agent = {
      provider: 'claude-code',
      sessionId: 'fixture',
    }
    state.hydraMessages = messages
    const read = ({ before }: { before?: string } = {}) => readThread({
      hydraId: 'default',
      state,
      card: state.cards[HYDRA_CARD]!,
      homes: [],
      before,
    })
    const first = read()
    const loaded = mergeThreadPages({
      before: first,
      latest: read({ before: first.older }),
      olderPage: true,
    })
    const refreshed = mergeThreadPages({
      before: loaded,
      latest: read(),
    })

    assert.equal(
      refreshed.older,
      loaded.older,
    )
  },
)
