import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { commands } from '#app/cli.ts'
import { withWriter } from '#app/writer.ts'
import { HYDRA_CARD } from './identity.ts'
import { hydraEvent } from './hydra.ts'

const scratch = mkdtempSync(join(
  tmpdir(),
  'pnyx-inscribe-sweep-',
))
after(() => rmSync(
  scratch,
  {
    recursive: true,
    force: true,
  },
))

const ownerSays = ({ text }: { text: string }) => withWriter({
  hydraId: 'lab',
  fn: ({ writer }) => {
    const decision = hydraEvent({
      state: writer.state,
      meta: {
        at: new Date().toISOString(),
        actor: 'web',
      },
      cardId: HYDRA_CARD,
      change: {
        type: 'hydra.message',
        data: {
          action: 'send',
          hydra: 'lab',
          text,
        },
      },
    })
    assert.ok('event' in decision)
    writer.append({ event: decision.event })
  },
})

const sweep = async () => await commands.hydra([
  'messages',
  '--inscribe',
  '--hydra',
  'lab',
]) as {
  messages: { text: string }[] | string
  through: number
}

test(
  'the first inscribe sweep reads the whole history, task briefs included, and later sweeps start at the saved cursor',
  async () => {
    process.env.PNYX_HOME = join(
      scratch,
      'home',
    )
    await commands.hydra([
      'create',
      'lab',
    ])
    ownerSays({ text: 'Never merge without the migration smoke test.' })
    await commands.task([
      'create',
      '--hydra',
      'lab',
      '--title',
      'One-off change',
      '--brief',
      'Always run the deployment smoke test for this project.',
      '--folder',
      scratch,
    ])

    const first = await sweep()
    assert.deepEqual(
      Array.isArray(first.messages) && first.messages.map(message => message.text),
      [
        'Never merge without the migration smoke test.',
        'Always run the deployment smoke test for this project.',
      ],
    )

    await commands.hydra([
      'memory',
      'set',
      '--hydra',
      'lab',
      '--key',
      'inscribe-cursor',
      '--text',
      String(first.through),
      '--reason',
      'inscribe pass saved',
    ])
    ownerSays({ text: 'Keep PRs small.' })
    const next = await sweep()
    assert.deepEqual(
      Array.isArray(next.messages) && next.messages.map(message => message.text),
      ['Keep PRs small.'],
    )
  },
)
