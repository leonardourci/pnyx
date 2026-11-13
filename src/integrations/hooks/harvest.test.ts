import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync, appendFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { test } from 'node:test'
import { setTimeout } from 'node:timers/promises'
import { hydraDir } from '#app/home-migration.ts'
import { mountOwnedHydra } from '#app/server.ts'
import { storedHydra } from '#test-harness/database.ts'
import { HYDRA_CARD } from '#hydra/identity.ts'
import { readEvents } from '#app/event-log.ts'
import { loadHydra } from '#app/store.ts'
import { withWriter } from '#app/writer.ts'
import { hydraThreadView } from '#hydra/thread-view.ts'
import { readThread } from '#hydra/transcripts-read.ts'
import { harvestTranscripts, backfillConversations } from './harvest.ts'
import { recordEntries } from '#hydra/transcripts-read.ts'
import type { ChatEvent } from '#hydra/model.ts'
import { redact } from '#oracle/text.ts'
import { replayOwned } from '#app/reducer.ts'

const BACKFILL_WAIT_MS = 10_000
const BACKFILL_POLL_MS = 20

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
    const before = storedHydra({ hydraId: 'default' })
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
      tools: true,
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
      storedHydra({ hydraId: 'default' }),
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
    const before = readEvents({ hydraId: 'default' })
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
    const correction = events.find((event): event is ChatEvent => event.type === 'chat.message'
      && event.data.replaces !== undefined && event.data.part === 1000)
    assert.ok(correction)
    const replaced = events.find(event => event.id === correction.data.replaces)
    assert.ok(replaced)
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
    assert.deepEqual(
      events.slice(
        0,
        before.length,
      ),
      before,
    )
    harvest()
    assert.equal(
      readEvents({ hydraId: 'default' }).length,
      events.length,
    )
    const archived = storedHydra({ hydraId: 'default' })
    // replay-chat reads an archived home in the events.jsonl layout, so archive this Hydra in it.
    const archive = join(
      home,
      'archive',
    )
    const archivedHydra = join(
      archive,
      'hydras/default',
    )
    mkdirSync(
      archivedHydra,
      { recursive: true },
    )
    writeFileSync(
      join(
        archivedHydra,
        'events.jsonl',
      ),
      events.map(event => `${JSON.stringify(event)}\n`).join(''),
    )
    writeFileSync(
      join(
        archivedHydra,
        'snapshot.json',
      ),
      JSON.stringify({ state: loadHydra({ hydraId: 'default' }).state }),
    )
    copyFileSync(
      join(
        folder,
        'harvest.json',
      ),
      join(
        archivedHydra,
        'harvest.json',
      ),
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
        archive,
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
      storedHydra({ hydraId: 'default' }),
      archived,
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
      tools: true,
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
  'mounting a Hydra finishes the backfill of a legacy Hydra cursor',
  async t => {
    const home = mkdtempSync(join(
      tmpdir(),
      'pnyx-mount-backfill-',
    ))
    const previous = process.env.PNYX_HOME
    process.env.PNYX_HOME = home
    const resources: { mounted?: Awaited<ReturnType<typeof mountOwnedHydra>> } = {}
    t.after(async () => {
      await resources.mounted?.close()

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
    copyFileSync(
      new URL(
        '../../hydra/fixtures/transcripts/reliability.jsonl',
        import.meta.url,
      ),
      transcript,
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
            at: '2026-10-22T09:00:00.000Z',
            actor: 'web',
            cardId: HYDRA_CARD,
            type: 'task.created',
            data: {
              key: HYDRA_CARD,
              title: 'Hydra',
            },
          },
        })
        writer.state.sessions = {
          'claude-code:old': {
            id: 'claude-code:old',
            originCardId: HYDRA_CARD,
            taskId: null,
            attention: [],
            sourceRefs: [],
            agent: {
              provider: 'claude-code',
              sessionId: 'old',
              transcriptPath: transcript,
            },
          },
        }
      },
    })
    const dir = hydraDir({ hydraId: 'default' })
    mkdirSync(
      dir,
      { recursive: true },
    )
    const info = statSync(transcript)
    const cursors = join(
      dir,
      'harvest.json',
    )
    const cursorName = `${HYDRA_CARD}\n${transcript}`
    writeFileSync(
      cursors,
      JSON.stringify({
        [cursorName]: {
          identity: `${info.dev}:${info.ino}`,
          pos: info.size,
        },
      }),
    )
    resources.mounted = await mountOwnedHydra({
      hydraId: 'default',
      url: 'http://127.0.0.1/',
      homes: [],
      open: async () => 'http://127.0.0.1/',
      hydrasChanged() {},
    })
    const backfilled = () => JSON.parse(readFileSync(
      cursors,
      'utf8',
    ))[cursorName]?.conversation === 1
    const deadline = performance.now() + BACKFILL_WAIT_MS

    while (!backfilled() && performance.now() < deadline) {
      await setTimeout(BACKFILL_POLL_MS)
    }

    assert.equal(
      backfilled(),
      true,
    )
  },
)
