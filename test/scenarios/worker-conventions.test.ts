import assert from 'node:assert/strict'
import { test } from 'node:test'
import { scenarioGroup, until } from './harness.ts'

const pnyx = scenarioGroup({ incorporateSteering: true })

function followsProject({ prompt }: { prompt: string }): void {
  assert.match(
    prompt,
    /Before changing anything/,
  )

  for (const path of [
    'AGENTS.md',
    'CLAUDE.md',
    'CONTRIBUTING.md',
    '.agents/skills',
    '.claude/skills',
    'skills/',
  ]) {
    assert.ok(
      prompt.includes(path),
      `opening prompt names ${path}`,
    )
  }

  assert.match(
    prompt,
    /Follow them over generic habits/,
  )
  assert.match(
    prompt,
    /use the project's skills for the jobs they cover/,
  )
}

for (const harness of ['codex']) {
  test(
    `${harness} workers receive repository conventions with a custom opening prompt and on task handoff`,
    async () => {
      const s = await pnyx.scenario()
      const folder = s.folder({ name: harness })
      await s.owner({
        args: [
          'task',
          'create',
          '--key',
          'first',
          '--title',
          'First assignment',
          '--brief',
          'Fix the parser.',
          '--folder',
          folder,
        ],
      })
      await s.owner({
        args: [
          'task',
          'start',
          'first',
          '--harness',
          harness,
          '--prompt',
          'Start with the failing input.',
        ],
      })
      const agent = await s.agent({ cwd: folder })
      await until({
        what: 'the opening turn to finish',
        check: () => s.task({ key: 'first' }).sessionActivity === 'finished',
      })
      const opening = s.received({ cwd: folder })[0]!
      followsProject({ prompt: opening })
      assert.ok(opening.includes('Fix the parser.'))
      assert.ok(opening.endsWith('Start with the failing input.'))

      await s.owner({
        args: [
          'task',
          'create',
          '--key',
          'next',
          '--title',
          'Next assignment',
          '--brief',
          'Document the parser.',
          '--folder',
          folder,
        ],
      })
      await s.owner({
        args: [
          'task',
          'attach',
          'next',
          '--session',
          s.task({ key: 'first' }).sessionIds![0]!,
        ],
      })
      const handoff = await until({
        what: 'the next assignment to reach the worker',
        check: () => s.received({ cwd: folder }).find(prompt => prompt.includes('Document the parser.')),
      })
      followsProject({ prompt: handoff })
      assert.ok(handoff.startsWith(`<pnyx-worker task="${s.task({ key: 'next' }).id}"`))
      assert.equal(
        s.task({ key: 'next' }).agent?.sessionId,
        agent.id,
      )
    },
  )
}
