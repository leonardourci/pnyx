import { ORCHESTRATE_SKILL, INSCRIBE_SKILL } from '../../src/integrations/skills/names.ts'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { HYDRA_CARD } from '../../src/hydra/identity.ts'
import { taskMention } from '../../src/hydra/mentions.ts'
import type { ThreadPage } from '../../src/hydra/transcripts-read.ts'
import { openPage, until } from '../../src/test-harness/harness.ts'
import { pnyx, type Scenario } from '../../src/test-harness/pnyx.ts'

const finished = async ({
  s,
  turns,
}: {
  s: Scenario
  turns: number
}) => {
  const agent = await s.agent({ hydra: true })
  await until({
    what: `Hydra to finish turn ${turns}`,
    check: () => s.received({ cwd: agent.cwd }).length === turns
      && s.state().cards[HYDRA_CARD]?.sessionActivity === 'finished',
  })
}

const send = ({
  s,
  text,
  id,
}: {
  s: Scenario
  text: string
  id: string
}) => s.owner({
  args: [
    'hydra',
    'send',
    '--text',
    text,
    '--event-id',
    id,
  ],
})

test(
  'queued owner messages keep their selected model, deduplicate, and copy tagged replies to the right task',
  async () => {
    const s = await pnyx.scenario()
    await s.owner({
      args: [
        'task',
        'create',
        '--title',
        'Task quick',
        '--key',
        'quick',
      ],
    })
    const task = s.task({ key: 'quick' }).id
    const reply = `${taskMention({
      id: task,
      title: 'Task quick',
    })} Noted.`
    const page = await openPage({
      port: pnyx.port(),
      hydraId: s.hydraId,
    })
    const choose = ({ model }: { model: string }) => page.command({
      name: 'hydra-agent',
      args: [
        JSON.stringify({
          harness: 'claude',
          model,
        }),
      ],
    })
    const held = pnyx.claude.plan({
      text: 'First',
      reply,
      hold: true,
    })
    pnyx.claude.plan({
      text: 'Second',
      reply,
    })
    pnyx.claude.plan({
      text: 'Third',
      reply,
    })

    pnyx.claude.plan({
      text: '',
      reply,
    })
    pnyx.claude.plan({
      text: '',
      reply,
    })

    try {
      await choose({ model: 'sonnet' })
      await send({
        s,
        text: 'First',
        id: 'first',
      })
      const agent = await s.agent({ hydra: true })
      await until({
        what: 'the first held message',
        check: () => agent.received.length === 1,
      })
      await send({
        s,
        text: 'Second',
        id: 'second',
      })
      await send({
        s,
        text: 'Second',
        id: 'second',
      })
      await choose({ model: 'opus' })
      await send({
        s,
        text: 'Third',
        id: 'third',
      })
      await s.owner({
        args: [
          'hydra',
          'send',
          '--task',
          task,
          '--text',
          'A worker question',
          '--actor',
          `worker:${task}`,
        ],
      })
      await s.owner({
        args: [
          'hydra',
          'send',
          '--task',
          task,
          '--text',
          'Already on the task',
        ],
      })
      await choose({ model: 'haiku' })
      assert.equal(
        agent.received.length,
        1,
      )
      held.release()
      await finished({
        s,
        turns: 5,
      })
      const sessions = pnyx.claude.sessions.filter(session => session.env.PNYX_HYDRA === s.hydraId)
      assert.equal(
        sessions.find(session => session.received.some(text => text.endsWith('Second')))?.model,
        'sonnet',
      )
      assert.equal(
        sessions.find(session => session.received.some(text => text.endsWith('Third')))?.model,
        'opus',
      )
      assert.equal(
        s.received({ cwd: agent.cwd }).filter(text => text === 'Second').length,
        1,
      )
      const notes = ({ source }: { source: string }) => s.events().flatMap(event =>
        event.type === 'card.noted' && event.cardId === task && event.data.source === source ? [event.data.text] : [])
      assert.deepEqual(
        notes({ source: 'hydra' }),
        Array(5).fill('Noted.'),
      )
      assert.deepEqual(
        notes({ source: 'owner' }),
        [
          'First',
          'Second',
          'Third',
        ],
      )
      const received = s.received({ cwd: agent.cwd }).map(text => text.replace(
        /^<pnyx-digest[\s\S]*?<\/pnyx-digest>\n\n/,
        '',
      ))
      const reports = received.filter(text => text.includes('A worker question')).map(text => text.replace(
        / message="[^"]+"/,
        '',
      ))
      assert.equal(
        reports.length,
        1,
      )
      assert.ok(
        reports[0]!.startsWith(`<pnyx-wake>Why you are woken:\n- ${taskMention({
          id: task,
          title: s.task({ key: 'quick' }).title,
        })} report: from worker:${task}, in its envelope below\nA worker report arrived while you were busy.`),
        reports[0],
      )
      assert.ok(reports[0]!.includes(`<pnyx-report from="worker:${task}" task="${task}">\nA worker question\n</pnyx-report>`))
      assert.ok(!reports[0]!.includes('hydra check'))
      assert.ok(received.includes('Second'))
    } finally {
      held.release()
      page.close()
    }
  },
)

test(
  'owner chat starts a private Hydra that may not hold messages with check --wait, replies once, and resumes the same session after restart',
  async () => {
    const s = await pnyx.scenario()
    await send({
      s,
      text: 'Plan the release',
      id: 'first',
    })
    await finished({
      s,
      turns: 1,
    })
    const first = await s.agent({ hydra: true })
    // The Hydra Pnyx runs may not hold the owner's messages with check --wait; the owner may.
    const hydra = s.as({ agent: first })
    assert.equal(
      await hydra.refused({
        args: [
          'hydra',
          'check',
          '--wait',
          '1',
        ],
      }),
      'VALIDATION_ERROR',
    )
    await hydra.run({
      args: [
        'hydra',
        'check',
      ],
    })
    await s.owner({
      args: [
        'hydra',
        'check',
        '--wait',
        '1',
      ],
    })
    assert.equal(
      first.cwd,
      join(
        process.env.PNYX_HOME!,
        'hydras',
        s.hydraId,
        'agent',
      ),
    )
    assert.equal(
      first.env.PNYX_ACTOR,
      'hydra',
    )
    assert.equal(
      readFileSync(
        join(
          first.cwd,
          'CLAUDE.md',
        ),
        'utf8',
      ),
      '@AGENTS.md\n',
    )
    assert.match(
      readFileSync(
        join(
          first.cwd,
          'AGENTS.md',
        ),
        'utf8',
      ),
      /^# Hydra\n[\s\S]*## Load before/,
    )
    assert.match(
      readFileSync(
        join(
          first.cwd,
          `.claude/skills/${INSCRIBE_SKILL}/SKILL.md`,
        ),
        'utf8',
      ),
      new RegExp(String.raw`^---\nname: ${INSCRIBE_SKILL}`),
    )
    assert.equal(
      existsSync(join(
        first.cwd,
        `.agents/skills/${ORCHESTRATE_SKILL}`,
      )),
      true,
    )
    assert.match(
      first.received[0]!,
      new RegExp(`^<pnyx-digest hydra="${s.hydraId}"[\\s\\S]*</pnyx-digest>\\n\\nPlan the release$`),
    )
    await send({
      s,
      text: 'Plan the release',
      id: 'first',
    })
    const page = await openPage({
      port: pnyx.port(),
      hydraId: s.hydraId,
    })

    try {
      const receipt = await page.command({
        name: 'thread',
        args: [HYDRA_CARD],
      })
      const thread = receipt.thread as ThreadPage
      assert.deepEqual(
        thread.entries.filter(e => e.role === 'assistant').map(e => e.text),
        [pnyx.claude.reply],
      )
      assert.equal(
        s.events().filter(e => e.type === 'hydra.message' && e.id === 'first').length,
        1,
      )
    } finally {
      page.close()
    }

    await pnyx.restart()
    await send({
      s,
      text: 'Continue after restart',
      id: 'second',
    })
    await finished({
      s,
      turns: 2,
    })
    const resumed = await s.agent({ hydra: true })
    assert.notEqual(
      resumed,
      first,
    )
    assert.equal(
      resumed.id,
      first.id,
    )
    assert.equal(
      resumed.resumed,
      true,
    )
    assert.equal(
      s.state().config?.hydra.session,
      `claude-code:${first.id}`,
    )
    assert.equal(
      s.received({ cwd: first.cwd }).filter(text => text.endsWith('Plan the release')).length,
      1,
    )
  },
)

test(
  'progress stays on the task without a turn, then the next question carries every report to Hydra once',
  async () => {
    const s = await pnyx.scenario()
    const folder = s.folder({ name: 'parser' })
    await s.owner({
      args: [
        'task',
        'create',
        '--title',
        'Fix the parser',
        '--key',
        'fix',
        '--folder',
        folder,
      ],
    })
    await s.owner({
      args: [
        'task',
        'start',
        'fix',
      ],
    })
    const worker = s.as({ agent: await s.agent({ cwd: folder }) })
    // The worker's opening turn would otherwise touch the card between a report and its check.
    await until({
      what: 'the worker’s opening turn to finish',
      check: () => s.task({ key: 'fix' }).sessionActivity === 'finished',
    })
    const held = pnyx.claude.plan({
      text: 'Track the parser',
      hold: true,
    })
    const page = await openPage({
      port: pnyx.port(),
      hydraId: s.hydraId,
    })

    try {
      await send({
        s,
        text: 'Track the parser',
        id: 'track',
      })
      const agent = await s.agent({ hydra: true })
      await until({
        what: 'the held Hydra turn',
        check: () => agent.received.length === 1,
      })
      const reports = [
        'Reproduced the bug',
        'Wrote the failing test',
        'Fixed the parser',
      ]

      for (const text of reports) {
        await worker.run({
          args: [
            'hydra',
            'send',
            '--task',
            'fix',
            '--kind',
            'progress',
            '--text',
            text,
          ],
        })
        const event = s.events().findLast(e => e.type === 'hydra.message')!
        assert.equal(
          s.task({ key: 'fix' }).updatedSeq,
          event.seq,
        )
      }

      await page.shows({
        what: 'all progress saved on the page',
        check: ({ state }) => state.seq >= s.task({ key: 'fix' }).updatedSeq,
      })
      await page.command({
        name: 'card',
        args: [s.task({ key: 'fix' }).id],
      })
      assert.deepEqual(
        page.queues,
        [],
      )
      assert.equal(
        s.received({ cwd: agent.cwd }).length,
        1,
      )
      held.release()
      await finished({
        s,
        turns: 1,
      })
      await worker.run({
        args: [
          'task',
          'ask',
          'fix',
          '--question',
          'Which parser should own dates?',
        ],
      })
      await finished({
        s,
        turns: 2,
      })
      const batch = s.received({ cwd: agent.cwd })[1]!
      assert.match(
        batch,
        /^<pnyx-wake>Why you are woken:\n- \[@[^\]]+\]\(pnyx-task:[^)]+\) asked: ask-\d+: "Which parser should own dates\?"\n4 worker reports/,
      )
      const envelopes = batch.split('<pnyx-report').slice(1)
      assert.equal(
        envelopes.length,
        4,
      )
      assert.deepEqual(
        envelopes.slice(
          0,
          3,
        ).map(e => /\n(.+)\n<\/pnyx-report>/.exec(e)?.[1]),
        reports,
      )
      assert.ok(envelopes.slice(
        0,
        3,
      ).every(e => e.includes('kind="progress"')))
      assert.match(
        envelopes[3]!,
        /Which parser should own dates\?/,
      )
      await pnyx.restart()
      await send({
        s,
        text: 'Continue tracking',
        id: 'barrier',
      })
      await finished({
        s,
        turns: 3,
      })
      assert.equal(
        s.received({ cwd: agent.cwd }).filter(text => text.includes('<pnyx-report')).length,
        1,
      )
    } finally {
      held.release()
      page.close()
    }
  },
)

test(
  'mid-turn owner chat steers Codex immediately while worker reports wait as one visible batch',
  async () => {
    const s = await pnyx.scenario()
    await s.owner({
      args: [
        'rule',
        'set',
        'hydra',
        '--harness',
        'codex',
      ],
    })
    const folder = s.folder({ name: 'worker' })
    await s.owner({
      args: [
        'task',
        'create',
        '--title',
        'Fix add',
        '--key',
        'fix',
        '--folder',
        folder,
      ],
    })
    await s.owner({
      args: [
        'task',
        'start',
        'fix',
      ],
    })
    const worker = s.as({ agent: await s.agent({ cwd: folder }) })
    const page = await openPage({
      port: pnyx.port(),
      hydraId: s.hydraId,
    })
    const held = pnyx.codex.plan({
      text: 'Take a long look',
      hold: true,
    })

    try {
      await send({
        s,
        text: 'Take a long look',
        id: 'long',
      })
      const agent = await s.agent({ hydra: true })
      await until({
        what: 'Codex to start the held turn',
        check: () => agent.received.length === 1 && s.state().cards[HYDRA_CARD]?.sessionActivity === 'working',
      })
      await send({
        s,
        text: 'Also check the docs',
        id: 'steer',
      })
      await until({
        what: 'the owner message inside the running turn',
        check: () => agent.received.includes('Also check the docs'),
      })

      for (const text of [
        'Report one',
        'Report two',
        'Report three',
      ]) {
        await worker.run({
          args: [
            'hydra',
            'send',
            '--task',
            'fix',
            '--text',
            text,
          ],
        })
      }

      await worker.run({
        args: [
          'task',
          'status',
          'fix',
          'blocked',
          '--note',
          'Reports sent',
        ],
      })
      await until({
        what: 'four queued worker updates',
        check: () => page.queues.at(-1)?.waiting.length === 4,
      })
      assert.equal(
        agent.requests?.filter(method => method === 'turn/start').length,
        1,
      )
      assert.equal(
        agent.requests?.filter(method => method === 'turn/steer').length,
        1,
      )
      assert.deepEqual(
        page.queues.at(-1)?.waiting.map(update => update.card),
        Array(4).fill(s.task({ key: 'fix' }).id),
      )
      held.release()
      await finished({
        s,
        turns: 3,
      })
      await until({
        what: 'Hydra to finish reading the batch',
        check: () => {
          const queue = page.queues.at(-1)

          return queue?.reading.length === 0 && queue.waiting.length === 0
        },
      })
      const batch = agent.received[2]!
      assert.match(
        batch,
        /^<pnyx-wake>Why you are woken:\n- \[@Fix add\]\(pnyx-task:[^)]+\) report: from worker:[^\n]+\n(- [^\n]+\n)*3 worker reports arrived while you were busy\./,
      )

      for (const text of [
        'Report one',
        'Report two',
        'Report three',
      ]) {
        assert.equal(
          batch.split(`\n${text}\n</pnyx-report>`).length,
          2,
        )
      }

      assert.match(
        batch,
        /hydra check --after \d+/,
      )
      assert.ok(page.queues.some(queue => queue.reading.length === 4 && queue.waiting.length === 0))
      assert.equal(
        agent.requests?.filter(method => method === 'turn/start').length,
        2,
      )
      await pnyx.restart()
      await send({
        s,
        text: 'Resume Codex',
        id: 'resume',
      })
      await finished({
        s,
        turns: 4,
      })
      const resumed = await s.agent({ hydra: true })
      assert.equal(
        resumed.resumed,
        true,
      )
      assert.equal(
        resumed.id,
        agent.id,
      )
    } finally {
      held.release()
      page.close()
    }
  },
)
