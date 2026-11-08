import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { readEvents } from '#app/event-log.ts'
import { loadHydra } from '#app/store.ts'
import { withWriter } from '#app/writer.ts'
import { hydraThreadView } from '#hydra/thread-view.ts'
import { readThread } from '#hydra/transcripts-read.ts'
import { harvestTranscripts } from './harvest.ts'

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
      message: { content: text },
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
