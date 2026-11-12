import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { emptyHydra, replay } from './reducer.ts'
import { readStream } from '#test-harness/streams.ts'
import { createLatestFeed, LATEST_DELAY_MS } from './latest-feed.ts'

test(
  'only working transcripts retain background polls and folder watches',
  t => {
    const root = mkdtempSync(join(
      tmpdir(),
      'pnyx-latest-watches-',
    ))
    const active = join(
      root,
      'active',
    )
    const ended = join(
      root,
      'ended',
    )
    mkdirSync(active)
    mkdirSync(ended)
    const current = join(
      active,
      'native.jsonl',
    )
    const old = join(
      ended,
      'native.jsonl',
    )
    writeFileSync(
      current,
      '',
    )
    writeFileSync(
      old,
      '',
    )
    const state = replay({
      state: emptyHydra(),
      events: readStream({ name: 'lifecycle' }),
    })
    state.cards.c1!.agent = {
      provider: 'claude',
      sessionId: 'active',
      transcriptPath: current,
    }
    state.cards.c2!.agent = {
      provider: 'claude',
      sessionId: 'ended',
      transcriptPath: old,
    }
    state.cards.c1!.sessionActivity = 'working'
    state.cards.c2!.sessionActivity = 'finished'
    const feed = createLatestFeed({
      state: () => state,
      closed: () => false,
      clients: new Set(),
      send() {},
      threadSubscriptions: [],
      refreshThread() {},
      refreshLiveThread() {},
      agents: () => ({ action: () => null }),
      spend: { count() {} },
    })
    t.after(() => {
      clearTimeout(feed.latestTimer)

      for (const watcher of [
        ...feed.folders.values(),
        ...feed.transcripts.values(),
        ...feed.transcriptPolls.values(),
      ]) {
        watcher.close()
      }

      rmSync(
        root,
        {
          recursive: true,
          force: true,
        },
      )
    })
    t.mock.timers.enable({ apis: ['setTimeout'] })
    feed.touchLatest({
      ids: [
        'c1',
        'c2',
      ],
    })
    t.mock.timers.tick(LATEST_DELAY_MS)
    assert.deepEqual(
      [...feed.transcriptPolls.keys()],
      [current],
    )
    assert.deepEqual(
      [...feed.folders.keys()],
      [active],
    )
    state.cards.c1!.sessionActivity = 'finished'
    feed.touchLatest({ ids: ['c1'] })
    t.mock.timers.tick(LATEST_DELAY_MS)
    assert.equal(
      feed.transcriptPolls.size,
      0,
    )
    assert.equal(
      feed.transcripts.size,
      0,
    )
    assert.equal(
      feed.folders.size,
      0,
    )
  },
)
