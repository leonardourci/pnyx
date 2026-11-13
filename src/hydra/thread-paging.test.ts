import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { test } from 'node:test'
import { commands } from '#app/cli.ts'
import { loadHydra } from '#app/store.ts'
import { withWriter } from '#app/writer.ts'
import { decidePush } from '#tasks/push.ts'
import { HYDRA_CARD } from './identity.ts'
import { messageReference } from './message-reference.ts'
import { readThread } from './transcripts-read.ts'
import { mergeThreadPages } from './thread-history.ts'

test(
  'paging reads only the native transcript, ignoring copies an older Pnyx stored in the log',
  t => {
    const home = mkdtempSync(join(
      tmpdir(),
      'pnyx-thread-paging-',
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
    const native = join(
      home,
      'native.jsonl',
    )
    const rows = Array.from(
      { length: 80 },
      (
        _,
        index,
      ) => ({
        type: 'assistant',
        timestamp: new Date(Date.UTC(
          2026,
          9,
          22,
          10,
          0,
          (index + 20) % 80,
        )).toISOString(),
        message: {
          content: `Reply ${index}`,
          stop_reason: 'end_turn',
        },
      }),
    )
    writeFileSync(
      native,
      `${rows.map(row => JSON.stringify(row)).join('\n')}\n`,
    )
    const state = withWriter({
      hydraId: 'default',
      create: true,
      fn: ({ writer }) => {
        writer.append({
          event: {
            v: 1,
            seq: 1,
            id: 'create',
            at: '2026-10-22T09:00:00.000Z',
            actor: 'web',
            cardId: '$hydra',
            type: 'task.created',
            data: {
              key: '$hydra',
              title: 'Hydra',
            },
          },
        })

        for (const [
          index,
          row,
        ] of rows.entries()) {
          writer.append({
            event: {
              v: 1,
              seq: writer.state.seq + 1,
              id: `record:${index}`,
              at: row.timestamp,
              actor: 'harvest',
              cardId: '$hydra',
              type: 'chat.message',
              data: {
                session: 'claude-code:older',
                nativeId: `record:${index}`,
                role: 'assistant',
                text: row.message.content,
              },
            },
          })
        }

        return writer.state
      },
    })
    const card = state.cards.$hydra!

    const pageAll = () => {
      const card = state.cards.$hydra!
      let page = readThread({
        hydraId: 'default',
        state,
        card,
        homes: [],
      })
      let remaining = 10

      while (page.older && remaining-- > 0) {
        page = mergeThreadPages({
          before: page,
          latest: readThread({
            hydraId: 'default',
            state,
            card,
            homes: [],
            before: page.older,
          }),
          olderPage: true,
        })
      }

      assert.equal(
        page.older,
        undefined,
      )

      return page.entries
    }

    card.agent = {
      provider: 'claude-code',
      sessionId: 'old',
      transcriptPath: join(
        home,
        'missing.jsonl',
      ),
    }
    const missing = readThread({
      hydraId: 'default',
      state,
      card,
      homes: [],
    })
    assert.equal(
      missing.unavailable,
      'The recorded transcript is unavailable.',
    )
    assert.deepEqual(
      missing.entries,
      [],
    )
    assert.equal(
      missing.older,
      undefined,
    )
    card.agent = {
      provider: 'claude-code',
      sessionId: 'old',
      transcriptPath: native,
    }
    const recorded = pageAll()
    assert.equal(
      recorded.length,
      80,
    )
    assert.equal(
      new Set(recorded.map(entry => entry.text)).size,
      80,
    )
    assert.equal(
      recorded[0]?.text,
      'Reply 60',
    )
    assert.equal(
      recorded.at(-1)?.text,
      'Reply 59',
    )
  },
)

test(
  'Hydra\'s chat pages back through every session it was configured with, skipping a transcript that is gone',
  async t => {
    const home = mkdtempSync(join(
      tmpdir(),
      'pnyx-thread-sessions-',
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
    await commands.hydra([
      'create',
      'fixture',
    ])
    const sessions = [
      'first',
      'gone',
      'second',
      'current',
    ]

    for (const [
      index,
      session,
    ] of sessions.entries()) {
      const path = join(
        home,
        `${session}.jsonl`,
      )

      if (session !== 'gone') {
        writeFileSync(
          path,
          `${Array.from(
            { length: 50 },
            (
              _,
              reply,
            ) => JSON.stringify({
              type: 'assistant',
              timestamp: new Date(Date.UTC(
                2026,
                9,
                22,
                10 + index,
                reply,
              )).toISOString(),
              message: {
                content: `${session} ${reply}`,
                stop_reason: 'end_turn',
              },
            }),
          ).join('\n')}\n`,
        )
      }

      // Hooks first see each Hydra session on a hidden card of its own.
      withWriter({
        hydraId: 'fixture',
        fn: ({ writer }) => {
          const decision = decidePush({
            state: writer.state,
            key: `hook-${session}`,
            input: {
              title: 'Hydra',
              agent: {
                host: 'pnyx',
                provider: 'claude-code',
                sessionId: session,
                transcriptPath: path,
              },
            },
            meta: {
              actor: 'web',
              at: '2026-10-22T09:00:00.000Z',
            },
          })
          assert.ok('event' in decision)
          writer.append({ event: decision.event })
        },
      })
      await commands.hydra([
        'set',
        '--session',
        `claude-code:${session}`,
        '--hydra',
        'fixture',
      ])
    }

    const state = loadHydra({ hydraId: 'fixture' }).state
    const card = state.cards[HYDRA_CARD]!
    const read = ({ before }: { before?: string }) => readThread({
      hydraId: 'fixture',
      state,
      card,
      homes: [],
      before,
    })
    let page = read({})
    const cursors = new Set<string>()
    const pageLimit = 10

    while (page.older && cursors.size < pageLimit) {
      assert.ok(!cursors.has(page.older))
      cursors.add(page.older)
      page = mergeThreadPages({
        before: page,
        latest: read({ before: page.older }),
        olderPage: true,
      })
    }

    const texts = page.entries.map(entry => entry.text)
    assert.deepEqual(
      {
        older: page.older,
        unavailable: page.unavailable,
        count: texts.length,
        distinct: new Set(texts).size,
        first: texts[0],
        lastOfFirst: texts[49],
        firstOfSecond: texts[50],
        firstOfCurrent: texts[100],
        last: texts.at(-1),
      },
      {
        older: undefined,
        unavailable: undefined,
        count: 150,
        distinct: 150,
        first: 'first 0',
        lastOfFirst: 'first 49',
        firstOfSecond: 'second 0',
        firstOfCurrent: 'current 0',
        last: 'current 49',
      },
    )
    const earlier = page.entries.find(entry => entry.text === 'first 0')!
    assert.equal(
      earlier.reference,
      messageReference({
        session: 'claude-code:first',
        id: '0:m0',
      }),
    )
  },
)
