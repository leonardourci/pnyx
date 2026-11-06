import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { emptyHydra, reduce } from '#app/reducer.ts'
import { readThread } from './transcripts-read.ts'
import { HYDRA_CARD } from './identity.ts'
import { liveReplies } from '#workers/streaming.ts'

for (const provider of [
  'claude-code',
  'codex',
]) {
  test(
    `the ${provider} Hydra thread excludes tools in saved and live pages`,
    t => {
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
          provider === 'codex' ? 'codex-session.jsonl' : 'claude-session.jsonl',
        ),
      }
      const page = readThread({
        hydraId: 'default',
        state,
        card,
        homes: [],
      })
      assert.ok(page.entries.some(entry => entry.kind === 'message'))
      assert.equal(
        page.entries.some(entry => entry.kind === 'tool'),
        false,
      )
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
      assert.equal(
        live.page({ page }).entries.some(entry => entry.kind === 'tool'),
        false,
      )
    },
  )
}
