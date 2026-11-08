import assert from 'node:assert/strict'
import { test } from 'node:test'
import { cpSync, mkdtempSync, renameSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { commands } from '#app/cli.ts'
import { loadHydra } from '#app/store.ts'
import { withWriter } from '#app/writer.ts'
import { decidePush } from '#tasks/push.ts'
import { decideSession } from '#workers/sessions.ts'
import { decideReply } from '#workers/reply-rules.ts'
import { WORKER_COMMANDS, helperReads } from '#app/command-registry.ts'
import { HYDRA_CARD } from './identity.ts'
import { readThread } from './transcripts-read.ts'
import { hydraThreadView } from './thread-view.ts'

interface LookupOutput {
  anchor?: string
  messages: {
    id: string
    seq: number
    at: string
    text: string
  }[]
  older?: string
  newer?: string
}

test(
  'CLI revisits UI message references after inscribe, compaction and agent replacement',
  async t => {
    const home = mkdtempSync(join(
      tmpdir(),
      'pnyx-message-lookup-',
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
    await commands.task([
      'create',
      '--hydra',
      'fixture',
      '--key',
      'sample',
      '--title',
      'Sample change',
    ])
    const state = () => loadHydra({ hydraId: 'fixture' }).state
    const task = state().keys.sample!
    const attach = ({
      card,
      session,
      path,
    }: {
      card: string
      session: string
      path?: string
    }) => withWriter({
      hydraId: 'fixture',
      fn: ({ writer }) => {
        const previous = writer.state.cards[card]?.sessionIds?.[0]

        if (previous) {
          const detached = decideSession({
            state: writer.state,
            ref: previous,
            task: null,
            meta: {
              actor: 'web',
              at: '2026-01-02T00:00:00.000Z',
            },
          })

          if ('event' in detached) {
            writer.append({ event: detached.event })
          }
        }

        const decision = decidePush({
          state: writer.state,
          key: writer.state.cards[card]?.key ?? card,
          input: {
            title: card === HYDRA_CARD ? 'Hydra' : 'Sample change',
            agent: {
              host: 'pnyx',
              provider: 'claude-code',
              sessionId: session,
              transcriptPath: path,
            },
          },
          meta: {
            actor: 'web',
            at: '2026-01-02T00:00:00.000Z',
          },
        })
        assert.ok('event' in decision)
        writer.append({ event: decision.event })
        const attached = decideSession({
          state: writer.state,
          ref: `claude-code:${session}`,
          task: card === HYDRA_CARD ? null : card,
          meta: {
            actor: 'web',
            at: '2026-01-02T00:00:00.000Z',
          },
        })

        if ('event' in attached) {
          writer.append({ event: attached.event })
        } else {
          assert.equal(
            attached.skipped,
            'unchanged',
          )
        }
      },
    })
    const originalPath = join(
      home,
      'original.jsonl',
    )
    cpSync(
      join(
        import.meta.dirname,
        'fixtures/transcripts/lookup-session.jsonl',
      ),
      originalPath,
    )
    const references: {
      card: string
      id: string
      seq: number
      at: string
      text: string
      owner: {
        id: string
        text: string
      }
    }[] = []

    for (const card of [
      HYDRA_CARD,
      task,
    ]) {
      attach({
        card,
        session: card === HYDRA_CARD ? 'main-original' : 'worker-original',
        path: originalPath,
      })

      if (card === HYDRA_CARD) {
        await commands.hydra([
          'set',
          '--session',
          'claude-code:main-original',
          '--hydra',
          'fixture',
        ])
      }

      const shown = readThread({
        hydraId: 'fixture',
        state: state(),
        card: state().cards[card],
        homes: [],
      }).entries
        .find(entry => entry.role === 'assistant')!
      assert.ok(shown.reference)
      const invoke = async ({ args }: { args: string[] }) => (card === HYDRA_CARD
        ? commands.hydra([
          'message',
          ...args,
          '--hydra',
          'fixture',
        ])
        : commands.task([
          'messages',
          task,
          ...args,
          '--hydra',
          'fixture',
        ])) as unknown as Promise<LookupOutput>
      const page = await invoke({
        args: [
          '--id',
          shown.reference!,
          '--before',
          '1',
          '--after',
          '1',
        ],
      })
      assert.equal(
        page.anchor,
        shown.reference,
      )
      const message = page.messages.find(message => message.id === page.anchor)!
      assert.equal(
        message.text,
        shown.text,
      )

      for (const args of [
        [
          '--seq',
          String(message.seq),
        ],
        [
          '--at',
          message.at,
        ],
      ]) {
        const exact = await invoke({ args })
        assert.equal(
          exact.anchor,
          shown.reference,
        )
        assert.equal(
          exact.messages.length,
          1,
        )
      }

      const ranged = await invoke({
        args: [
          '--from',
          String(message.seq),
          '--to',
          String(message.seq),
        ],
      })
      assert.deepEqual(
        ranged.messages.map(message => message.id),
        [shown.reference],
      )

      const exact = await invoke({
        args: [
          '--id',
          shown.reference!,
        ],
      })
      assert.ok(exact.newer)
      const newer = await invoke({
        args: [
          '--cursor',
          exact.newer!,
        ],
      })
      assert.equal(
        newer.messages.at(-1)?.text,
        'The sample result is deterministic.',
      )

      let ownerReference: string
      let ownerText: string
      let ownerAt: string
      let expectedOwnerMessages: string[]

      if (card === HYDRA_CARD) {
        const sent = await commands.hydra([
          'send',
          '--text',
          'Keep the sample input.',
          '--details',
          'Preserve the sample format.',
          '--hydra',
          'fixture',
        ])
        ownerReference = String(sent.message)
        ownerText = 'Keep the sample input.\n\nPreserve the sample format.'
        ownerAt = state().hydraMessages!.find(message => message.id === ownerReference)!.at
        expectedOwnerMessages = [
          'The sample result is deterministic.',
          'Keep the sample input.\n\nPreserve the sample format.',
        ]
        const projected = hydraThreadView({
          state: state(),
          thinking: false,
          page: readThread({
            hydraId: 'fixture',
            state: state(),
            card: state().cards[card],
            homes: [],
          }),
        })
        assert.ok(projected.conversation.entries.some(entry => entry.reference === ownerReference))
      } else {
        withWriter({
          hydraId: 'fixture',
          fn: ({ writer }) => {
            const decision = decideReply({
              state: writer.state,
              ref: card,
              data: {
                reply: 'owner-followup',
                state: 'queued',
                route: 'pnyx',
                text: 'Keep the sample input.',
                context: 'Routing context stays out of the authored message.',
              },
              meta: {
                actor: 'web',
                at: '2026-01-01T00:00:02.500Z',
              },
            })
            assert.ok('event' in decision)
            writer.append({ event: decision.event })
          },
        })
        const thread = readThread({
          hydraId: 'fixture',
          state: state(),
          card: state().cards[card],
          homes: [],
        })
        const owner = thread.entries.find(entry => entry.replyId === 'owner-followup')!
        assert.ok(owner.reference)
        ownerReference = owner.reference!
        ownerText = 'Keep the sample input.'
        ownerAt = '2026-01-01T00:00:02.500Z'
        expectedOwnerMessages = [
          'Explain the result.',
          'Keep the sample input.',
          'The sample result is deterministic.',
        ]
        const nativeOwner = thread.entries.find(entry => entry.role === 'user')!
        assert.ok(nativeOwner.reference)
        const native = await invoke({
          args: [
            '--id',
            nativeOwner.reference!,
          ],
        })
        assert.equal(
          native.messages[0].text,
          'Describe the sample change.',
        )
      }

      const ownerPage = await invoke({
        args: [
          '--id',
          ownerReference,
          '--before',
          '1',
          '--after',
          '1',
        ],
      })
      assert.equal(
        ownerPage.anchor,
        ownerReference,
      )
      assert.deepEqual(
        ownerPage.messages.map(message => message.text),
        expectedOwnerMessages,
      )
      const owner = ownerPage.messages.find(message => message.id === ownerReference)!
      assert.equal(
        owner.text,
        ownerText,
      )
      assert.equal(
        owner.at,
        ownerAt,
      )
      const bySequence = await invoke({
        args: [
          '--seq',
          String(owner.seq),
        ],
      })
      assert.equal(
        bySequence.messages[0].id,
        ownerReference,
      )
      assert.equal(
        bySequence.messages[0].text,
        ownerText,
      )
      const byTime = await invoke({
        args: [
          '--at',
          ownerAt,
        ],
      })
      assert.equal(
        byTime.messages[0].id,
        ownerReference,
      )
      assert.equal(
        byTime.messages[0].text,
        ownerText,
      )

      references.push({
        card,
        ...message,
        owner: {
          id: owner.id,
          text: ownerText,
        },
      })
    }

    const inscribe = await commands.hydra([
      'inscribe',
      'start',
      '--hydra',
      'fixture',
    ])
    await commands.hydra([
      'inscribe',
      'finish',
      '--key',
      String(inscribe.milestone),
      '--through',
      String(inscribe.through),
      '--hydra',
      'fixture',
    ])
    withWriter({
      hydraId: 'fixture',
      fn: ({ writer }) => writer.append({
        event: {
          v: 1,
          seq: writer.state.seq + 1,
          id: 'sample-compaction',
          at: '2026-01-03T00:00:00.000Z',
          actor: 'pnyx',
          cardId: HYDRA_CARD,
          type: 'hydra.operation',
          data: {
            id: 'sample-compaction',
            kind: 'compaction',
            state: 'finished',
            through: writer.state.seq,
          },
        },
      }),
    })
    renameSync(
      originalPath,
      `${originalPath}.unavailable`,
    )

    for (const reference of references) {
      attach({
        card: reference.card,
        session: `replacement-${reference.card}`,
      })

      if (reference.card === HYDRA_CARD) {
        await commands.hydra([
          'set',
          '--session',
          `claude-code:replacement-${reference.card}`,
          '--hydra',
          'fixture',
        ])
      }

      const archived = reference.card === HYDRA_CARD
        ? await commands.hydra([
          'message',
          '--id',
          reference.id,
          '--before',
          '1',
          '--after',
          '1',
          '--hydra',
          'fixture',
        ])
        : await commands.task([
          'messages',
          task,
          '--id',
          reference.id,
          '--before',
          '1',
          '--after',
          '1',
          '--hydra',
          'fixture',
        ])
      assert.equal(
        archived.thread,
        reference.card === HYDRA_CARD ? 'hydra' : reference.card,
      )
      const archivedOwner = reference.card === HYDRA_CARD
        ? await commands.hydra([
          'message',
          '--id',
          reference.owner.id,
          '--hydra',
          'fixture',
        ])
        : await commands.task([
          'messages',
          task,
          '--id',
          reference.owner.id,
          '--hydra',
          'fixture',
        ])
      assert.equal(
        (archivedOwner as unknown as LookupOutput).messages[0].text,
        reference.owner.text,
      )
      assert.equal(
        archived.anchor,
        reference.id,
      )
      const messages = (archived as unknown as LookupOutput).messages
      assert.ok(messages.some(message => message.text === reference.text))
    }
  },
)

test(
  'worker and helper command policies allow message lookup',
  () => {
    assert.ok(WORKER_COMMANDS.includes('pnyx-axi hydra message'))
    assert.ok(WORKER_COMMANDS.includes('pnyx-axi task messages'))
    assert.ok(helperReads({ name: 'hydra' }).includes('message'))
    assert.ok(helperReads({ name: 'task' }).includes('messages'))
  },
)
