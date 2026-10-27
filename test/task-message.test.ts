import assert from 'node:assert/strict'
import { cpSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { commands } from '../src/cli/commands.ts'
import { sendTaskMessage } from '../src/cli/task-message.ts'
import { decidePush, decideReply } from '../src/core/decide.ts'
import { loadHydra, withWriter } from '../src/store/hydra-store.ts'
import { readThread, type ThreadEntry } from '../src/thread/read.ts'
import { paseoHistory } from '../src/integrations/paseo/history.ts'
import { taskReceipt, withTaskReceipts } from '../src/thread/task.ts'

function fixture() {
  const home = realpathSync(mkdtempSync(join(
    tmpdir(),
    'pnyx-task-message-',
  )))
  process.env.PNYX_HOME = home
  commands.hydra([
    'create',
    'default',
  ])
  commands.task([
    'create',
    '--key',
    'work',
    '--title',
    'Keep task context',
    '--brief',
    'Read the migration plan',
  ])
  cpSync(
    join(
      import.meta.dirname,
      'fixtures/firstmate-home',
    ),
    join(
      home,
      'firstmate',
    ),
    { recursive: true },
  )
  const state = () => loadHydra({ hydraId: 'default' }).state
  const card = () => state().cards[state().keys.work!]!
  const send = ({
    id = 'message-1',
    text = 'Check the rollback path',
  }: {
    id?: string
    text?: string
  } = {}) => sendTaskMessage({
    hydraId: 'default',
    request: {
      card: card().id,
      id,
      text,
      homes: [
        join(
          home,
          'firstmate',
        ),
      ],
      actor: 'web',
    },
  })
  const thread = () => readThread({
    hydraId: 'default',
    state: state(),
    card: card(),
    homes: [],
  })
  const agent = ({ firstmate = false }: { firstmate?: boolean } = {}) => withWriter({
    hydraId: 'default',
    fn: ({ writer }) => {
      const decision = decidePush({
        state: writer.state,
        key: 'work',
        input: {
          agent: {
            provider: 'claude-code',
            sessionId: 'fixture',
          },
          ...(firstmate ? {
            source: {
              adapter: 'firstmate',
              instanceId: join(
                home,
                'firstmate',
              ),
              objectId: 'work',
            },
          } : {}),
        },
        meta: {
          at: new Date().toISOString(),
          actor: 'hydra',
        },
      })
      assert.ok('event' in decision); writer.append({ event: decision.event })
    },
  })

  return {
    home,
    state,
    card,
    send,
    thread,
    agent,
    close: () => rmSync(
      home,
      {
        recursive: true,
        force: true,
      },
    ),
  }
}

test(
  'old snapshots rebuild the original prompt after the working brief changed',
  () => {
    const f = fixture()

    try {
      commands.task([
        'brief',
        'work',
        '--brief',
        'The revised plan',
      ])
      const path = join(
        f.home,
        'hydras',
        'default',
        'snapshot.json',
      )
      const snapshot = JSON.parse(readFileSync(
        path,
        'utf8',
      ))
      snapshot.rules = 11
      delete snapshot.state.cards[f.card().id].initialPrompt
      writeFileSync(
        path,
        JSON.stringify(snapshot),
      )
      assert.equal(
        f.card().initialPrompt,
        'Read the migration plan',
      )
      assert.equal(
        f.card().brief,
        'The revised plan',
      )
    } finally {
      f.close()
    }
  },
)

test(
  'repeated text cannot replace a different native message with a failed receipt',
  () => {
    const base = {
      card: 'task',
      route: true,
      watching: 'unknown' as const,
    }
    const native = {
      id: 'older',
      replyId: 'older-reply',
      kind: 'message' as const,
      role: 'user',
      text: 'Yes',
    }
    const failed = {
      id: 'newer',
      replyId: 'newer-reply',
      kind: 'message' as const,
      role: 'You',
      text: 'Yes',
      receipt: 'failed' as const,
    }
    const result = withTaskReceipts({
      native: {
        ...base,
        entries: [native],
      },
      saved: {
        ...base,
        entries: [failed],
      },
    })
    assert.deepEqual(
      result.entries,
      [
        native,
        failed,
      ],
    )
    assert.deepEqual(
      withTaskReceipts({
        native: {
          ...base,
          entries: [
            {
              ...native,
              replyId: undefined,
            },
          ],
        },
        saved: {
          ...base,
          entries: [failed],
        },
      }).entries.map(e => e.id),
      [
        'older',
        'newer',
      ],
    )
  },
)

test(
  'saved task history remains pageable after the native timeline has no older page',
  async () => {
    const f = fixture()

    try {
      withWriter({
        hydraId: 'default',
        fn: ({ writer }) => {
          for (let i = 0; i < 135; i++) {
            const decision = decideReply({
              state: writer.state,
              ref: 'work',
              data: {
                reply: `reply-${i}`,
                route: 'hydra',
                state: 'queued',
                taskMessage: true,
                text: `Context ${i}`,
              },
              meta: {
                at: new Date(1700000000000 + i).toISOString(),
                actor: 'web',
              },
            })
            assert.ok('event' in decision); writer.append({ event: decision.event })
          }
        },
      })
      let reads = 0
      const conversation = {
        read: async () => {
          reads++

          return {
            card: f.card().id,
            route: true,
            watching: 'unknown' as const,
            entries: [
              {
                id: 'native',
                kind: 'message' as const,
                role: 'assistant',
                text: 'Native reply',
              },
            ],
          }
        },
      }
      const entries: ThreadEntry[] = []
      let before: string | undefined

      do {
        const page = await paseoHistory({
          card: f.card().id,
          conversation,
          readSaved: ({ before }) => readThread({
            hydraId: 'default',
            state: f.state(),
            card: f.card(),
            homes: [],
            before,
          }),
          before,
        })
        entries.push(...page.entries)
        before = page.older
      } while (before)

      assert.equal(
        reads,
        1,
      )
      assert.equal(
        entries.filter(e => e.text.startsWith('Context ')).length,
        135,
      )
      assert.equal(
        new Set(entries.map(e => e.id)).size,
        136,
      )
    } finally {
      f.close()
    }
  },
)

test(
  'native and saved pagination advance independently and reapply current receipt states',
  async () => {
    const f = fixture()

    try {
      await f.send()
      const saved = f.thread()
      const first = saved.entries[0]!
      let nativeReads = 0
      const nativeBefore = `p${Buffer.from(JSON.stringify({
        epoch: 'fixture',
        seq: 2,
      })).toString('base64url')}`
      const conversation = {
        read: async ({ before }: { before?: string }) => {
          nativeReads++

          return {
            ...saved,
            entries: [
              {
                ...first,
                receipt: undefined,
                delivery: undefined,
                role: 'user',
              },
            ],
            older: before ? undefined : nativeBefore,
          }
        },
      }
      const page = await paseoHistory({
        card: f.card().id,
        conversation,
        readSaved: () => saved,
      })
      assert.ok(page.older)
      const earlier = await paseoHistory({
        card: f.card().id,
        conversation,
        readSaved: () => {
          throw new Error('Saved source must stay exhausted')
        },
        before: page.older,
      })
      assert.equal(
        nativeReads,
        2,
      )
      assert.equal(
        earlier.older,
        undefined,
      )
      const current = taskReceipt({
        card: f.card(),
        reply: earlier.entries.at(-1)!.replyId!,
      })
      assert.equal(
        current?.receipt,
        'queued',
      )
      assert.equal(
        current?.delivery?.hydra.state,
        'queued',
      )
    } finally {
      f.close()
    }
  },
)
