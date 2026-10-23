import assert from 'node:assert/strict'
import { test } from 'node:test'
import { openPage, scenarioGroup, until } from './harness.ts'

const pnyx = scenarioGroup()

test(
  'a Codex worker’s reply shows in its task chat, and each owner message reaches it once, through a restart that resumes the same thread',
  async () => {
    const s = await pnyx.scenario()
    const folder = s.folder({ name: 'docs' })
    await s.owner({
      args: [
        'task',
        'create',
        '--title',
        'Write the changelog',
        '--key',
        'notes',
        '--folder',
        folder,
      ],
    })
    await s.owner({
      args: [
        'task',
        'start',
        'notes',
        '--harness',
        'codex',
      ],
    })
    const first = await s.agent({ cwd: folder })
    const card = s.task({ key: 'notes' })
    const finished = ({ turns }: { turns: number }) => until({
      what: `turn ${turns} to finish`,
      check: () => s.received({ cwd: folder }).length === turns && s.task({ key: 'notes' }).sessionActivity === 'finished',
    })
    await finished({ turns: 1 })
    assert.match(
      s.received({ cwd: folder })[0]!,
      /You are the Pnyx worker for task \S+ "Write the changelog"/,
    )

    const page = await openPage({
      port: pnyx.port(),
      hydraId: s.hydraId,
    })
    const thread = await page.command({
      name: 'thread',
      args: [card.id],
    }) as {
      thread: {
        entries: {
          role?: string
          text?: string
        }[]
      }
    }
    assert.deepEqual(
      thread.thread.entries.filter(e => e.role === 'assistant').map(e => e.text),
      [pnyx.codex.reply],
    )
    page.close()

    await s.owner({
      args: [
        'reply',
        card.id,
        '--text',
        'Add the release date.',
      ],
    })
    await finished({ turns: 2 })

    await pnyx.restart()
    await s.owner({
      args: [
        'reply',
        card.id,
        '--text',
        'Ship it.',
      ],
    })
    await finished({ turns: 3 })
    assert.deepEqual(
      s.received({ cwd: folder }).slice(1),
      [
        'Add the release date.',
        'Ship it.',
      ],
    )
    const resumed = await s.agent({ cwd: folder })
    assert.notEqual(
      resumed,
      first,
    )
    const opened = ({ requests }: { requests?: string[] }) => requests!.filter(m => m.startsWith('thread/') || m === 'turn/start')
    assert.deepEqual(
      [
        opened(first),
        opened(resumed),
        resumed.id,
      ],
      [
        [
          'thread/start',
          'turn/start',
          'turn/start',
        ],
        [
          'thread/resume',
          'turn/start',
        ],
        first.id,
      ],
    )
    assert.deepEqual(
      [
        card.agent?.sessionId,
        s.task({ key: 'notes' }).agent?.sessionId,
      ],
      [
        first.id,
        first.id,
      ],
    )
  },
)
