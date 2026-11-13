import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Command } from '#web-app/connection.ts'
import { refreshLinks } from './link-refresh.ts'

test(
  'an open task and its review panel send one refresh while it runs, and a later open sends another',
  async () => {
    const sent: string[][] = []
    const held: (() => void)[] = []
    const release = () => held.splice(0).forEach(resolve => resolve())
    const command = (async ({ args }) => {
      sent.push(args)
      await new Promise<void>(resolve => {
        held.push(resolve)
      })

      return {}
    }) as Command
    const detail = refreshLinks({
      task: 'ship',
      command,
    })
    const review = refreshLinks({
      task: 'ship',
      command,
    })
    const other = refreshLinks({
      task: 'docs',
      command: (async ({ args }) => {
        sent.push(args)

        return {}
      }) as Command,
    })
    release()
    await Promise.all([
      detail,
      review,
      other,
    ])
    assert.deepEqual(
      sent,
      [
        [
          'refresh-links',
          'ship',
        ],
        [
          'refresh-links',
          'docs',
        ],
      ],
    )
    const reconnect = refreshLinks({
      task: 'ship',
      command,
    })
    release()
    await reconnect
    assert.equal(
      sent.length,
      3,
    )
  },
)
