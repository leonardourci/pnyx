import assert from 'node:assert/strict'
import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, test } from 'node:test'
import { commands } from '../src/cli/commands.ts'
import { followUpReplies } from '../src/cli/reply-retry.ts'
import { decidePush, decideReply, decideSession } from '../src/core/decide.ts'
import type { ReplyState } from '../src/core/model.ts'
import { loadHydra, withWriter } from '../src/store/hydra-store.ts'

let root = ''
let transcript = ''
const SENT = Date.parse('2026-10-22T10:00:00Z')
const MINUTE = 60_000

beforeEach(async () => {
  root = realpathSync(mkdtempSync(join(
    tmpdir(),
    'pnyx-reply-retry-',
  )))
  process.env.PNYX_HOME = join(
    root,
    'pnyx',
  )
  process.env.PNYX_SEMANTIC = 'off'
  const folder = join(
    root,
    'work',
  )
  mkdirSync(folder)
  transcript = join(
    root,
    'session.jsonl',
  )
  writeFileSync(
    transcript,
    '',
  )
  await commands.hydra([
    'create',
    'lab',
  ])
  await commands.task([
    'create',
    '--title',
    'Ship',
    '--key',
    'ship',
    '--hydra',
    'lab',
  ])
  withWriter({
    hydraId: 'lab',
    fn: ({ writer }) => {
      const meta = {
        at: new Date(SENT - MINUTE).toISOString(),
        actor: 'test',
      }
      const pushed = decidePush({
        state: writer.state,
        newCardId: `c${writer.state.seq + 1}`,
        key: 'terminal-session',
        input: {
          agent: {
            provider: 'claude-code',
            sessionId: 'terminal-session',
            cwd: folder,
            transcriptPath: transcript,
          },
          terminal: { tty: '/dev/ttys123' },
          activity: 'finished',
          source: {
            adapter: 'hooks',
            instanceId: 'claude',
            objectId: 'terminal-session',
            observedAt: meta.at,
          },
        },
        meta,
      })
      assert.ok('event' in pushed)
      writer.append({ event: pushed.event })
      const attached = decideSession({
        state: writer.state,
        ref: 'claude-code:terminal-session',
        task: writer.state.keys.ship!,
        meta,
      })
      assert.ok('event' in attached)
      writer.append({ event: attached.event })
    },
  })
})

afterEach(() => {
  rmSync(
    root,
    {
      recursive: true,
      force: true,
    },
  )
})

const task = () => {
  const state = loadHydra({ hydraId: 'lab' }).state

  return state.cards[state.keys.ship!]!
}

const receipt = ({
  reply,
  state,
  text,
  at,
}: {
  reply: string
  state: ReplyState
  text?: string
  at: number
}) => withWriter({
  hydraId: 'lab',
  fn: ({ writer }) => {
    const data = {
      reply,
      state,
      route: 'terminal:tmux',
    }

    if (text) {
      Object.assign(
        data,
        { text },
      )
    }

    const decision = decideReply({
      state: writer.state,
      ref: task().id,
      data,
      meta: {
        at: new Date(at).toISOString(),
        actor: 'test',
      },
    })
    assert.ok('event' in decision)
    writer.append({ event: decision.event })
  },
})

// A resend that the route again cannot confirm, recorded as the reply command records it.
const unknownResend = ({ at }: { at: number }) => {
  const resent: string[] = []

  return {
    resent,
    resend: async ({
      retry,
    }: {
      card: string
      text: string
      retry: string
    }): Promise<ReplyState> => {
      resent.push(retry)
      receipt({
        reply: retry,
        state: 'queued',
        text: 'Rebase onto main',
        at,
      })
      receipt({
        reply: retry,
        state: 'delivery_unknown',
        at,
      })

      return 'delivery_unknown'
    },
  }
}

test(
  'an unconfirmed reply missing from the transcript is resent twice, then reported to Hydra without marking the card',
  async () => {
    receipt({
      reply: 'r1',
      state: 'queued',
      text: 'Rebase onto main',
      at: SENT,
    })
    receipt({
      reply: 'r1',
      state: 'delivery_unknown',
      at: SENT,
    })
    const reported: string[] = []

    const unconfirmed = ({
      reply,
      text,
    }: {
      card: string
      reply: string
      text: string
    }) => {
      reported.push(`${reply}: ${text}`)
    }

    const early = unknownResend({ at: SENT })
    await followUpReplies({
      hydraId: 'lab',
      resend: early.resend,
      unconfirmed,
      now: SENT + MINUTE / 2,
    })
    assert.deepEqual(
      early.resent,
      [],
      'a fresh send gets its grace period',
    )

    const first = unknownResend({ at: SENT + 2 * MINUTE })
    await followUpReplies({
      hydraId: 'lab',
      resend: first.resend,
      unconfirmed,
      now: SENT + 2 * MINUTE,
    })
    const second = unknownResend({ at: SENT + 4 * MINUTE })
    await followUpReplies({
      hydraId: 'lab',
      resend: second.resend,
      unconfirmed,
      now: SENT + 4 * MINUTE,
    })
    assert.deepEqual(
      [
        ...first.resent,
        ...second.resent,
      ],
      [
        'r1~retry1',
        'r1~retry2',
      ],
    )
    assert.deepEqual(
      reported,
      [],
    )

    const last = unknownResend({ at: SENT + 6 * MINUTE })
    await followUpReplies({
      hydraId: 'lab',
      resend: last.resend,
      unconfirmed,
      now: SENT + 6 * MINUTE,
    })
    assert.deepEqual(
      last.resent,
      [],
    )
    assert.deepEqual(
      reported,
      ['r1: Rebase onto main'],
    )
    assert.deepEqual(
      task().attention,
      [],
      'the card stays unmarked',
    )

    // Past the follow-up window nothing is resent or reported again.
    const late = unknownResend({ at: SENT + 40 * MINUTE })
    await followUpReplies({
      hydraId: 'lab',
      resend: late.resend,
      unconfirmed,
      now: SENT + 40 * MINUTE,
    })
    assert.deepEqual(
      [
        late.resent.length,
        reported.length,
      ],
      [
        0,
        1,
      ],
    )
  },
)

test(
  'an unconfirmed reply found in the transcript is recorded delivered and never resent',
  async () => {
    receipt({
      reply: 'r1',
      state: 'queued',
      text: 'Rebase   onto\nmain',
      at: SENT,
    })
    receipt({
      reply: 'r1',
      state: 'delivery_unknown',
      at: SENT,
    })
    appendFileSync(
      transcript,
      `${JSON.stringify({
        type: 'user',
        timestamp: new Date(SENT + 5000).toISOString(),
        message: {
          role: 'user',
          content: 'Rebase onto main',
        },
      })}\n`,
    )
    const fake = unknownResend({ at: SENT })
    await followUpReplies({
      hydraId: 'lab',
      resend: fake.resend,
      unconfirmed: () => assert.fail('a delivered reply is not reported'),
      now: SENT + 2 * MINUTE,
    })
    assert.deepEqual(
      fake.resent,
      [],
    )
    assert.equal(
      task().replies?.find(reply => reply.id === 'r1')?.state,
      'delivered',
    )
  },
)
