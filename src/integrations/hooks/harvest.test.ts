import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync, appendFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { test } from 'node:test'
import { readEvents } from '#app/event-log.ts'
import { loadHydra } from '#app/store.ts'
import { withWriter } from '#app/writer.ts'
import { joinMessageParts, loggedEntry } from '#hydra/history.ts'
import { hydraThreadView } from '#hydra/thread-view.ts'
import { readThread } from '#hydra/transcripts-read.ts'
import { harvestTranscripts, backfillConversations } from './harvest.ts'
import { recordEntries } from '#hydra/transcripts-read.ts'
import type { ChatEvent } from '#hydra/model.ts'
import { createIndexSync } from '#oracle/index-sync.ts'
import { setImmediate } from 'node:timers/promises'
import { updateIndex, openReader, searchPath } from '#oracle/index.ts'
import { redact } from '#oracle/text.ts'
import { until } from '#test-harness/harness.ts'
import { replayOwned } from '#app/reducer.ts'

test(
  'harvesting survives replacement and lost cursors, preserves repeated sends and hides legacy copies',
  t => {
    const home = mkdtempSync(join(
      tmpdir(),
      'pnyx-harvest-chat-',
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
    const transcript = join(
      home,
      'session.jsonl',
    )
    const text = 'A'.repeat(1100)
    const record = ({
      role,
      second,
      text,
    }: {
      role: string
      second: number
      text: string
    }) => `${JSON.stringify({
      type: role,
      timestamp: `2026-10-22T10:00:0${second}Z`,
      message: {
        content: text,
        stop_reason: role === 'assistant' ? 'end_turn' : undefined,
      },
    })}\n`
    writeFileSync(
      transcript,
      record({
        role: 'user',
        second: 1,
        text,
      })
    + record({
      role: 'user',
      second: 2,
      text,
    })
    + record({
      role: 'assistant',
      second: 3,
      text: 'Ready',
    }),
    )
    withWriter({
      hydraId: 'default',
      create: true,
      fn: ({ writer }) => {
        writer.append({
          event: {
            v: 1,
            seq: 1,
            id: 'create',
            at: '2026-10-22T10:00:00Z',
            actor: 'web',
            cardId: '$hydra',
            type: 'task.created',
            data: {
              key: '$hydra',
              title: 'Hydra',
            },
          },
        })
        writer.append({
          event: {
            v: 1,
            seq: writer.state.seq + 1,
            id: 'legacy-first',
            at: '2026-10-22T10:00:01Z',
            actor: 'session:claude-code:fixture',
            cardId: '$hydra',
            type: 'chat.message',
            data: {
              session: 'claude-code:fixture',
              nativeId: '0:m0.0',
              role: 'user',
              text: 'A'.repeat(1000),
            },
          },
        })
        writer.append({
          event: {
            v: 1,
            seq: writer.state.seq + 1,
            id: 'legacy-repeat',
            at: '2026-10-22T10:00:01Z',
            actor: 'session:claude-code:fixture',
            cardId: '$hydra',
            type: 'chat.message',
            data: {
              session: 'claude-code:fixture',
              nativeId: '0:m0.0',
              role: 'user',
              text: 'A'.repeat(1000),
            },
          },
        })
      },
    })
    const harvest = () => withWriter({
      hydraId: 'default',
      fn: ({ writer }) => harvestTranscripts({
        writer,
        cardIds: ['$hydra'],
        at: '2026-10-22T10:00:05Z',
        detached: {
          task: '$hydra',
          memberships: [],
          session: {
            id: 'claude-code:fixture',
            originCardId: '$hydra',
            taskId: '$hydra',
            attention: [],
            sourceRefs: [],
            agent: {
              provider: 'claude-code',
              sessionId: 'fixture',
              transcriptPath: transcript,
            },
          },
        },
      }),
    })
    const chats = () => readEvents({ hydraId: 'default' }).filter(event => event.type === 'chat.message')
    harvest()
    assert.equal(
      chats().length,
      6,
    )
    renameSync(
      transcript,
      `${transcript}.old`,
    )
    copyFileSync(
      `${transcript}.old`,
      transcript,
    )
    harvest()
    assert.equal(
      chats().length,
      6,
    )
    rmSync(join(
      home,
      'hydras/default/harvest.json',
    ))
    execFileSync(
      process.execPath,
      [
        '--conditions=source',
        join(
          import.meta.dirname,
          'fixtures',
          'reharvest.mjs',
        ),
        transcript,
      ],
      {
        cwd: process.cwd(),
        env: process.env,
      },
    )
    assert.equal(
      chats().length,
      6,
    )
    appendFileSync(
      transcript,
      record({
        role: 'user',
        second: 4,
        text,
      }),
    )
    harvest()
    assert.equal(
      chats().length,
      8,
    )
    assert.equal(
      chats().find(event => event.data.text === 'Ready')?.data.final,
      true,
    )
    const log = join(
      home,
      'hydras/default/events.jsonl',
    )
    const before = readFileSync(
      log,
      'utf8',
    )
    rmSync(transcript)
    const state = loadHydra({ hydraId: 'default' }).state
    const page = readThread({
      hydraId: 'default',
      state,
      card: state.cards.$hydra!,
      homes: [],
    })
    const view = hydraThreadView({
      state,
      page,
      thinking: false,
    })
    assert.deepEqual(
      view.conversation.entries.map(entry => entry.text),
      [
        text,
        text,
        'Ready',
        text,
      ],
    )
    assert.equal(
      new Set(view.conversation.entries.map(entry => entry.id)).size,
      4,
    )
    assert.equal(
      readFileSync(
        log,
        'utf8',
      ),
      before,
    )
  },
)

test(
  'legacy Hydra cursors backfill tools and internal boundaries once without rewriting the log',
  t => {
    const home = mkdtempSync(join(
      tmpdir(),
      'pnyx-chat-history-',
    ))
    const previous = process.env.PNYX_HOME
    process.env.PNYX_HOME = home
    t.after(() => {
      process.env.PNYX_HOME = previous

      if (previous === undefined) {
        delete process.env.PNYX_HOME
      }

      rmSync(
        home,
        {
          recursive: true,
          force: true,
        },
      )
    })
    const transcript = join(
      home,
      'session.jsonl',
    )
    copyFileSync(
      new URL(
        '../../hydra/fixtures/transcripts/reliability.jsonl',
        import.meta.url,
      ),
      transcript,
    )
    const longTool = `${'a'.repeat(999)}Xsk-${'b'.repeat(40)}${' z'.repeat(1000)}`
    appendFileSync(
      transcript,
      `${JSON.stringify({
        type: 'user',
        timestamp: '2026-10-22T10:00:07.000Z',
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'boundary-read',
              content: longTool,
            },
          ],
        },
      })}\n`,
    )
    appendFileSync(
      transcript,
      `${JSON.stringify({
        type: 'assistant',
        timestamp: '2026-10-22T10:00:08.000Z',
        message: {
          stop_reason: 'end_turn',
          content: longTool,
        },
      })}\n`,
    )
    const session = {
      id: 'claude-code:old',
      originCardId: '$hydra',
      taskId: null,
      attention: [],
      sourceRefs: [],
      agent: {
        provider: 'claude-code',
        sessionId: 'old',
        transcriptPath: transcript,
      },
    }
    withWriter({
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
        writer.state.sessions = { [session.id]: session }
        let offset = 0

        for (const line of readFileSync(
          transcript,
          'utf8',
        ).trimEnd()
          .split('\n')) {
          for (const entry of recordEntries({
            record: JSON.parse(line),
            offset,
            tools: false,
            thinking: false,
          })) {
            writer.append({
              event: {
                v: 1,
                seq: writer.state.seq + 1,
                id: `legacy:${entry.id}`,
                at: entry.at!,
                actor: 'harvest',
                cardId: '$hydra',
                type: 'chat.message',
                data: {
                  session: session.id,
                  nativeId: entry.id,
                  role: entry.role,
                  text: redact({ text: entry.text }),
                  final: entry.final,
                },
              },
            })
          }

          offset += Buffer.byteLength(line) + 1
        }
      },
    })
    const folder = join(
      home,
      'hydras/default',
    )
    const info = statSync(transcript)
    writeFileSync(
      join(
        folder,
        'harvest.json',
      ),
      JSON.stringify({
        [`$hydra\n${transcript}`]: {
          identity: `${info.dev}:${info.ino}`,
          pos: info.size,
        },
      }),
    )
    const log = join(
      folder,
      'events.jsonl',
    )
    const before = readFileSync(
      log,
      'utf8',
    )
    const harvest = () => withWriter({
      hydraId: 'default',
      fn: ({ writer }) => {
        writer.state.sessions = { [session.id]: session }

        return harvestTranscripts({
          writer,
          cardIds: ['$hydra'],
          at: '2026-10-22T11:00:00.000Z',
        })
      },
    })

    updateIndex({ hydraId: 'default' })

    let complete = false

    for (let batch = 0; batch < 100; batch++) {
      const result = withWriter({
        hydraId: 'default',
        fn: ({ writer }) => {
          writer.state.sessions = { [session.id]: session }

          return backfillConversations({
            writer,
            at: '2026-10-22T11:00:00.000Z',
          })
        },
      })

      if (!result.progressed) {
        complete = true
        break
      }
    }

    assert.equal(
      complete,
      true,
    )
    harvest()
    const events = readEvents({ hydraId: 'default' })
    updateIndex({ hydraId: 'default' })
    const correction = events.find((event): event is ChatEvent => event.type === 'chat.message'
      && event.data.replaces !== undefined && event.data.part === 1000)
    assert.ok(correction)
    const replaced = events.find(event => event.id === correction.data.replaces)
    assert.ok(replaced)
    const index = openReader({ path: searchPath({ hydraId: 'default' }) })

    try {
      assert.equal(
        index.prepare('SELECT count(*) AS count FROM docs WHERE source = ? AND pos = ?')
          .get(
            'events',
            replaced.seq,
          )!.count,
        0,
      )
      assert.ok(Number(index.prepare('SELECT count(*) AS count FROM docs WHERE source = ? AND pos = ?')
        .get(
          'events',
          correction.seq,
        )!.count) > 0)
    } finally {
      index.close()
    }

    assert.deepEqual(
      events.filter((event): event is ChatEvent => event.type === 'chat.message' && event.data.kind === 'tool' && event.data.call === 'check-release').map(event => event.data.call),
      [
        'check-release',
        'check-release',
      ],
    )
    assert.equal(
      events.filter(event => event.type === 'chat.message' && event.data.hidden).length,
      1,
    )
    assert.ok(readFileSync(
      log,
      'utf8',
    ).startsWith(before))
    harvest()
    assert.equal(
      readEvents({ hydraId: 'default' }).length,
      events.length,
    )
    const archivedBytes = readFileSync(
      log,
      'utf8',
    )
    const checked = JSON.parse(execFileSync(
      process.execPath,
      [
        '--conditions=source',
        fileURLToPath(new URL(
          '../../../scripts/verification/replay-chat.ts',
          import.meta.url,
        )),
        '--archive',
        home,
        '--claude-transcripts',
        home,
        '--codex-transcripts',
        home,
      ],
      {
        env: process.env,
        encoding: 'utf8',
      },
    ))
    assert.deepEqual(
      checked[0].counts,
      {
        missing: 0,
        duplicate: 0,
        order: 0,
        text: 0,
        tool: 0,
        progress: 0,
        hidden: 0,
        unexpected: 0,
      },
    )
    assert.equal(
      readFileSync(
        log,
        'utf8',
      ),
      archivedBytes,
    )
    rmSync(transcript)
    const state = replayOwned({
      state: loadHydra({ hydraId: 'default' }).state,
      events,
    })
    const page = readThread({
      hydraId: 'default',
      state,
      card: state.cards.$hydra!,
      homes: [],
    })
    const conversation = hydraThreadView({
      state,
      page,
      thinking: false,
    }).conversation
    assert.deepEqual(
      conversation.entries.map(entry => entry.text),
      [
        'Check the synthetic release.',
        'The release is ready.',
        longTool,
      ],
    )
    assert.deepEqual(
      conversation.folds[conversation.entries[2]!.id]!.notes.map(entry => entry.text),
      [
        'A helper result is ready.',
        longTool,
      ],
    )
    assert.ok(events.some(event => event.type === 'chat.message' && event.data.replaces))
    assert.deepEqual(
      conversation.folds[conversation.entries[1]!.id]!.notes.map(entry => entry.kind),
      [
        'message',
        'tool',
        'tool',
      ],
    )
  },
)

test(
  'legacy migration yields between bounded batches and resumes after stopping',
  async t => {
    const home = mkdtempSync(join(
      tmpdir(),
      'pnyx-backfill-batches-',
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
    const transcript = join(
      home,
      'native.jsonl',
    )
    const records: unknown[] = Array.from(
      { length: 70 },
      (
        _,
        index,
      ) => ({
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: `call:${index}`,
              name: 'Read',
              input: {},
            },
          ],
        },
      }),
    )
    records.push({
      type: 'assistant',
      message: {
        content: [
          {
            type: 'text',
            text: 'x'.repeat(40000),
          },
        ],
      },
    })
    writeFileSync(
      transcript,
      records.map(record => JSON.stringify(record)).join('\n') + '\n',
    )
    withWriter({
      hydraId: 'default',
      create: true,
      fn: ({ writer }) => {
        writer.append({
          event: {
            v: 1,
            seq: 1,
            id: 'create',
            at: '2026-10-22T10:00:00Z',
            actor: 'web',
            cardId: '$hydra',
            type: 'task.created',
            data: {
              key: '$hydra',
              title: 'Hydra',
            },
          },
        })
        writer.state.sessions = {
          fixture: {
            id: 'fixture',
            originCardId: '$hydra',
            taskId: null,
            attention: [],
            sourceRefs: [],
            agent: {
              provider: 'claude-code',
              sessionId: 'fixture',
              transcriptPath: transcript,
            },
          },
        }
      },
    })
    const folder = join(
      home,
      'hydras/default',
    )
    const info = statSync(transcript)
    writeFileSync(
      join(
        folder,
        'harvest.json',
      ),
      JSON.stringify({
        [`$hydra\n${transcript}`]: {
          identity: `${info.dev}:${info.ino}`,
          pos: info.size,
        },
      }),
    )
    let workers = 0

    const startWorker: Parameters<typeof createIndexSync>[0]['startWorker'] = ({ done }) => {
      workers++
      done({
        error: null,
        stdout: '',
      })
    }

    const first = createIndexSync({
      hydraId: 'default',
      startWorker,
    })
    t.after(() => first.stop())
    await first.ready()
    assert.equal(
      readEvents({ hydraId: 'default' }).filter(event => event.type === 'chat.message').length,
      0,
    )
    assert.equal(
      workers,
      1,
    )
    await setImmediate()
    const partial = readEvents({ hydraId: 'default' }).filter(event => event.type === 'chat.message')
    assert.ok(partial.length > 0 && partial.length < 70)
    first.stop()
    const sourcePrefix = records.slice(
      0,
      69,
    ).map(record => JSON.stringify(record))
      .join('\n') + '\n'
    const intervening = recordEntries({
      record: records[69],
      offset: Buffer.byteLength(sourcePrefix),
    })[0]!
    withWriter({
      hydraId: 'default',
      fn: ({ writer }) => writer.append({
        event: {
          v: 1,
          seq: writer.state.seq + 1,
          id: 'intervening',
          at: '2026-10-22T10:00:00Z',
          actor: 'harvest',
          cardId: '$hydra',
          type: 'chat.message',
          data: {
            session: 'fixture',
            nativeId: intervening.id,
            block: intervening.block,
            role: intervening.role,
            kind: 'tool',
            call: intervening.call,
            text: intervening.text,
          },
        },
      }),
    })
    const second = createIndexSync({
      hydraId: 'default',
      startWorker,
    })
    t.after(() => second.stop())
    await second.ready()
    await until({
      what: 'historical conversation migration to finish',
      check: () => JSON.parse(readFileSync(
        join(
          folder,
          'harvest.json',
        ),
        'utf8',
      ))[`$hydra\n${transcript}`].conversation === 1,
    })
    second.stop()
    const saved = readEvents({ hydraId: 'default' }).filter(event => event.type === 'chat.message')
    assert.equal(
      saved.filter(event => event.data.kind === 'tool').length,
      70,
    )
    assert.deepEqual(
      joinMessageParts({
        entries: saved.filter(event => event.data.kind === 'message')
          .map(event => loggedEntry({ event })),
      }).map(entry => entry.text),
      ['x'.repeat(40000)],
    )
    assert.equal(
      new Set(saved.map(event => event.id)).size,
      saved.length,
    )
    assert.equal(
      workers,
      2,
    )
    const cursor = JSON.parse(readFileSync(
      join(
        folder,
        'harvest.json',
      ),
      'utf8',
    ))[`$hydra\n${transcript}`]
    assert.equal(
      cursor.conversation,
      1,
    )
    assert.equal(
      cursor.backfill,
      undefined,
    )
  },
)
