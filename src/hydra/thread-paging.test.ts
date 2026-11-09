import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { test } from 'node:test'
import { withWriter } from '#app/writer.ts'
import { readThread } from './transcripts-read.ts'
import { mergeThreadPages } from './thread-history.ts'

test(
  'paging retains late timestamped native and harvested records exactly once',
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
    let state = withWriter({
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
                session: 'claude-code:old',
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

    const archived = pageAll()
    assert.equal(
      archived.length,
      80,
    )
    assert.equal(
      new Set(archived.map(entry => entry.text)).size,
      80,
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
    state = withWriter({
      hydraId: 'default',
      fn: ({ writer }) => {
        writer.append({
          event: {
            v: 1,
            seq: writer.state.seq + 1,
            id: 'late-reply',
            at: '2026-10-22T11:00:00.000Z',
            actor: 'harvest',
            cardId: '$hydra',
            type: 'chat.message',
            data: {
              session: 'claude-code:older',
              nativeId: '100:m0',
              role: 'assistant',
              text: 'Finished',
            },
          },
        })
        writer.append({
          event: {
            v: 1,
            seq: writer.state.seq + 1,
            id: 'late-tool',
            at: '2026-10-22T11:00:00.000Z',
            actor: 'harvest',
            cardId: '$hydra',
            type: 'chat.message',
            data: {
              session: 'claude-code:older',
              nativeId: '0:t0',
              kind: 'tool',
              role: 'Read',
              text: 'release.txt',
            },
          },
        })

        return writer.state
      },
    })
    assert.deepEqual(
      pageAll().slice(-2)
        .map(entry => entry.reference),
      [
        'claude-code:older:0:t0',
        'claude-code:older:100:m0',
      ],
    )
  },
)
