// Setting changes typed into a hook session's terminal, with only tmux faked at the terminal boundary.
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { spoolWrite } from '#app/spool.ts'
import { loadHydra } from '#app/store.ts'
import { HydraError } from '#store/errors.ts'
import { until } from '#test-harness/harness.ts'
import { sendReply } from './reply.ts'

const HYDRA = 'default'
const SESSION = '11111111-2222-4333-8444-555555555555'
const HOOK_FIXTURES = join(
  import.meta.dirname,
  '..',
  'integrations',
  'hooks',
  'fixtures',
)

const hookPayload = ({ name }: { name: string }) => JSON.parse(readFileSync(
  join(
    HOOK_FIXTURES,
    `${name}.json`,
  ),
  'utf8',
))

const hook = ({
  id,
  event,
  name,
}: {
  id: string
  event: string
  name: string
}) => spoolWrite({
  hydraId: HYDRA,
  entry: {
    v: 1,
    id,
    at: new Date().toISOString(),
    harness: 'claude',
    event,
    payload: hookPayload({ name }),
    terminal: {
      tty: '/dev/ttys001',
      pid: '4242',
      program: 'tmux',
      tmux: '/tmp/fake-tmux',
      tmuxPane: '%1',
    },
  },
})

const setting = ({ text }: { text: string }) => sendReply({
  hydraId: HYDRA,
  request: {
    card: `claude:${SESSION}`,
    text,
    control: true,
    confirm: true,
    homes: [],
  },
})

test(
  'a setting change waits on the session’s open request only until Hydra answers it',
  async t => {
    const dir = realpathSync(mkdtempSync(join(
      tmpdir(),
      'pnyx-reply-',
    )))
    const saved = {
      PATH: process.env.PATH,
      PNYX_HOME: process.env.PNYX_HOME,
    }
    process.env.PNYX_HOME = join(
      dir,
      'pnyx',
    )
    process.env.PATH = `${join(
      import.meta.dirname,
      'fixtures',
      'terminal',
    )}:${saved.PATH}`
    process.env.FAKE_TERMINAL_DIR = dir
    t.after(() => {
      process.env.PATH = saved.PATH
      process.env.PNYX_HOME = saved.PNYX_HOME
      delete process.env.FAKE_TERMINAL_DIR
      rmSync(
        dir,
        {
          recursive: true,
          force: true,
        },
      )
    })
    const hold = join(
      dir,
      'hold',
    )
    const sent = () => readFileSync(
      join(
        dir,
        'sent',
      ),
      'utf8',
    ).trim()
      .split('\n')
    hook({
      id: 'start',
      event: 'SessionStart',
      name: 'claude-session-start',
    })

    // The session opens a permission request between the command's Enter and the confirmation's.
    writeFileSync(
      hold,
      '',
    )
    const model = setting({ text: '/model sonnet' })
    await until({
      what: 'the command’s Enter',
      check: () => existsSync(join(
        dir,
        'sent',
      )) && sent().includes('key Enter'),
    })
    hook({
      id: 'permission',
      event: 'PermissionRequest',
      name: 'claude-permission-request',
    })
    rmSync(hold)
    assert.equal(
      (await model).state,
      'delivery_unknown',
    )
    assert.deepEqual(
      sent(),
      [
        'paste /model sonnet',
        'key Enter',
      ],
    )

    await assert.rejects(
      setting({ text: '/effort high' }),
      (error: HydraError) => error.code === 'SESSION_WAITING',
    )

    const { state } = loadHydra({ hydraId: HYDRA })
    const request = state.cards[state.keys[`claude:${SESSION}`]!]!.attention[0]!
    const answer = await sendReply({
      hydraId: HYDRA,
      request: {
        card: `claude:${SESSION}`,
        text: '',
        actor: 'hydra',
        homes: [],
        answer: {
          request: request.key,
          value: { choice: 'allow' },
        },
      },
    })
    assert.equal(
      answer.state,
      'delivered',
    )

    assert.equal(
      (await setting({ text: '/effort high' })).state,
      'delivered',
    )
    assert.deepEqual(
      sent(),
      [
        'paste /model sonnet',
        'key Enter',
        'key 1',
        'paste /effort high',
        'key Enter',
        'key Enter',
      ],
    )
  },
)
