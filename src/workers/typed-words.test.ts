import assert from 'node:assert/strict'
import { appendFileSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { commands } from '#app/cli.ts'
import { loadHydra } from '#app/store.ts'
import { withWriter } from '#app/writer.ts'
import { decidePush } from '#tasks/push.ts'
import { decideReply } from './reply-rules.ts'
import type { AgentRef } from './model.ts'
import { hydraCheck } from './workers.ts'

// Seconds after the test starts, so the events the commands record at the real time come first.
const started = Date.now()
const time = ({ seconds }: { seconds: number }) => new Date(started + seconds * 1000).toISOString()
const record = ({
  role,
  at,
  text,
}: {
  role: 'user' | 'assistant'
  at: number
  text: string
}) => `${JSON.stringify({
  type: role,
  timestamp: time({ seconds: at }),
  message: {
    role,
    content: text,
  },
})}\n`

test(
  'hydra check lists words typed into a worker session once an event follows them, and wakes on them, without echoes of Pnyx replies',
  async t => {
    const home = mkdtempSync(join(
      tmpdir(),
      'pnyx-typed-words-',
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
      'terminal',
      '--title',
      'Terminal work',
    ])
    const path = join(
      home,
      'terminal.jsonl',
    )

    // The transcript was last written when its last record was.
    const write = ({ records }: { records: Parameters<typeof record>[0][] }) => {
      appendFileSync(
        path,
        records.map(item => record(item)).join(''),
      )
      const written = new Date(time({ seconds: records.at(-1)!.at }))
      utimesSync(
        path,
        written,
        written,
      )
    }

    write({
      records: [
        {
          role: 'user',
          at: 5,
          text: 'Words from before the check.',
        },
      ],
    })
    const push = ({
      title,
      at,
      key = 'terminal',
      agent = {
        provider: 'claude-code',
        sessionId: 'terminal',
        transcriptPath: path,
      },
    }: {
      title: string
      at: number
      key?: string
      agent?: AgentRef
    }) => withWriter({
      hydraId: 'fixture',
      fn: ({ writer }) => {
        const decision = decidePush({
          state: writer.state,
          key,
          input: {
            title,
            agent,
          },
          meta: {
            actor: 'hooks',
            at: time({ seconds: at }),
          },
        })
        assert.ok('event' in decision)
        writer.append({ event: decision.event })
      },
    })
    push({
      title: 'Terminal work',
      at: 0,
    })
    withWriter({
      hydraId: 'fixture',
      fn: ({ writer }) => {
        const decision = decideReply({
          state: writer.state,
          ref: 'terminal',
          data: {
            reply: 'staging',
            state: 'queued',
            route: 'pnyx',
            text: 'Use the staging database.',
          },
          meta: {
            actor: 'web',
            at: time({ seconds: 10 }),
          },
        })
        assert.ok('event' in decision)
        writer.append({ event: decision.event })
      },
    })
    // A worker Pnyx runs has no terminal: its transcript's inputs are Pnyx's own.
    const hosted = join(
      home,
      'hosted.jsonl',
    )
    writeFileSync(
      hosted,
      record({
        role: 'user',
        at: 30,
        text: 'Input Pnyx gave its own worker.',
      }),
    )
    utimesSync(
      hosted,
      new Date(time({ seconds: 30 })),
      new Date(time({ seconds: 30 })),
    )
    await commands.task([
      'create',
      '--hydra',
      'fixture',
      '--key',
      'hosted',
      '--title',
      'Hosted work',
    ])
    push({
      key: 'hosted',
      title: 'Hosted work',
      at: 1,
      agent: {
        provider: 'claude-code',
        sessionId: 'hosted',
        transcriptPath: hosted,
        host: 'pnyx',
      },
    })
    const after = loadHydra({ hydraId: 'fixture' }).state.seq
    write({
      records: [
        {
          role: 'user',
          at: 20,
          text: 'Use the staging database.',
        },
        {
          role: 'user',
          at: 22,
          text: '<pnyx-worker task="terminal" hydra="fixture">\nScope and authority.\n</pnyx-worker>\n\nYou are the Pnyx worker for task terminal.',
        },
        {
          role: 'user',
          at: 25,
          text: 'Pnyx steering inbox has pending instruction IDs ["staging"]. Run the inbox read.',
        },
        {
          role: 'user',
          at: 30,
          text: 'Ship it after the tests pass.',
        },
        {
          role: 'assistant',
          at: 31,
          text: 'On it.',
        },
      ],
    })
    const check = async ({
      from,
      wait = 0,
    }: {
      from: number
      wait?: number
    }) => hydraCheck({
      args: [
        'check',
        '--after',
        String(from),
        '--wait',
        String(wait),
        '--hydra',
        'fixture',
      ],
    }) as Promise<{
      through: number
      conversations?: {
        task: string
        messages: {
          at?: string
          text: string
        }[]
      }[]
    }>
    type Checked = Awaited<ReturnType<typeof check>>
    const words = ({ result }: { result: Checked }) => result.conversations
      ?.flatMap(conversation => conversation.messages.map(message => message.text))

    assert.equal(
      words({ result: await check({ from: after }) }),
      undefined,
      'words with no event after them wait for one',
    )
    push({
      title: 'Terminal work, testing',
      at: 60,
    })
    const first = await check({ from: after })
    assert.deepEqual(
      words({ result: first }),
      ['Ship it after the tests pass.'],
    )
    assert.equal(
      words({ result: await check({ from: first.through }) }),
      undefined,
      'a check from the reported seq does not repeat them',
    )

    const waited = Date.now()
    const waiting = check({
      from: first.through,
      wait: 30,
    })
    setTimeout(
      () => {
        write({
          records: [
            {
              role: 'user',
              at: 120,
              text: 'Also update the changelog.',
            },
          ],
        })
        push({
          title: 'Terminal work, changelog',
          at: 180,
        })
      },
      500,
    )
    assert.deepEqual(
      words({ result: await waiting }),
      ['Also update the changelog.'],
    )
    assert.ok(
      Date.now() - waited < 15_000,
      'the typed words wake the waiting check',
    )

    // A page cut at the check limit keeps words written after its last change for the next page.
    const paged = (await waiting).through
    const limit = 20

    for (let reply = 0; reply <= limit; reply++) {
      withWriter({
        hydraId: 'fixture',
        fn: ({ writer }) => {
          const decision = decideReply({
            state: writer.state,
            ref: 'terminal',
            data: {
              reply: `later-${reply}`,
              state: 'queued',
              route: 'pnyx',
              text: `Later reply ${reply}.`,
            },
            meta: {
              actor: 'web',
              at: time({ seconds: 200 + reply }),
            },
          })
          assert.ok('event' in decision)
          writer.append({ event: decision.event })
        },
      })
    }

    write({
      records: [
        {
          role: 'user',
          at: 220.5,
          text: 'Words after the page.',
        },
      ],
    })
    push({
      title: 'Terminal work, paged',
      at: 230,
    })
    const cut = await check({ from: paged })
    assert.equal(
      words({ result: cut })?.includes('Words after the page.'),
      false,
    )
    assert.ok(words({ result: await check({ from: cut.through }) })?.includes('Words after the page.'))
  },
)
