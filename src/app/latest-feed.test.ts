import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { emptyHydra, replay } from './reducer.ts'
import { readStream } from '#test-harness/streams.ts'
import { createLatestFeed, LATEST_DELAY_MS } from './latest-feed.ts'

test(
  'working and unknown transcripts stay watched, finished sessions release and resume their watches',
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
    const unknown = join(
      root,
      'unknown',
    )
    mkdirSync(active)
    mkdirSync(ended)
    mkdirSync(unknown)
    const current = join(
      active,
      'native.jsonl',
    )
    const old = join(
      ended,
      'native.jsonl',
    )
    const unobserved = join(
      unknown,
      'native.jsonl',
    )
    writeFileSync(
      unobserved,
      '',
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
    state.cards.unknown = {
      ...state.cards.c2!,
      id: 'unknown',
      key: 'unknown',
      agent: {
        provider: 'claude',
        sessionId: 'unobserved',
        transcriptPath: unobserved,
      },
      activity: undefined,
      sessionActivity: undefined,
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
        'unknown',
      ],
    })
    t.mock.timers.tick(LATEST_DELAY_MS)
    assert.deepEqual(
      [...feed.transcriptPolls.keys()],
      [
        current,
        unobserved,
      ],
    )
    assert.deepEqual(
      [...feed.folders.keys()],
      [
        active,
        unknown,
      ],
    )
    state.cards.c1!.sessionActivity = 'finished'
    feed.touchLatest({ ids: ['c1'] })
    t.mock.timers.tick(LATEST_DELAY_MS)
    assert.deepEqual(
      [...feed.transcriptPolls.keys()],
      [unobserved],
    )
    assert.deepEqual(
      [...feed.folders.keys()],
      [unknown],
    )
    state.cards.unknown!.sessionActivity = 'finished'
    feed.touchLatest({ ids: ['unknown'] })
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
    state.cards.c1!.sessionActivity = 'working'
    feed.touchLatest({ ids: ['c1'] })
    t.mock.timers.tick(LATEST_DELAY_MS)
    assert.deepEqual(
      [...feed.transcriptPolls.keys()],
      [current],
    )
    assert.deepEqual(
      [...feed.folders.keys()],
      [active],
    )
  },
)
