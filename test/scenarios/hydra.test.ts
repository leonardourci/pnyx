import { ORCHESTRATE_SKILL, INSCRIBE_SKILL } from '../../src/integrations/skills/names.ts'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { hydraConfig, HYDRA_CARD } from '../../src/core/hydra.ts'
import { taskMention } from '../../src/mentions/mentions.ts'
import type { ThreadPage } from '../../src/thread/read.ts'
import { hydraConversation } from '../../web/src/hydra/conversation.ts'
import { openPage, scenarioGroup, until } from '../../src/test-harness/harness.ts'
import { claimFlags, lavishFixture, readAndAck } from '../../src/test-harness/lavish-fixture.ts'

const pnyx = scenarioGroup()
type Scenario = Awaited<ReturnType<typeof pnyx.scenario>>

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
      await choose({ model: 'haiku' })
      assert.equal(
        agent.received.length,
        1,
      )
      held.release()
      await finished({
        s,
        turns: 3,
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
        [
          'Noted.',
          'Noted.',
          'Noted.',
        ],
      )
      assert.deepEqual(
        notes({ source: 'owner' }),
        [
          'First',
          'Second',
          'Third',
        ],
      )
    } finally {
      held.release()
      page.close()
    }
  },
)

test(
  'owner chat starts a private Hydra, replies once, and resumes the same session after restart',
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
  'a failed Hydra turn exposes the failure and the next owner message recovers after restart',
  async () => {
    const s = await pnyx.scenario()
    pnyx.claude.plan({
      text: 'Try the login',
      fail: 'Harness login is missing',
    })
    await send({
      s,
      text: 'Try the login',
      id: 'failed',
    })
    await until({
      what: 'the failed turn on the Hydra card',
      check: () => s.state().cards[HYDRA_CARD]?.attention.some(a => a.kind === 'interrupted' && a.text?.includes('Harness login is missing')),
    })
    const first = await s.agent({ hydra: true })
    await pnyx.restart()
    await send({
      s,
      text: 'The login is repaired',
      id: 'recovered',
    })
    await finished({
      s,
      turns: 2,
    })
    assert.equal(
      s.state().cards[HYDRA_CARD]?.attention.some(a => a.kind === 'interrupted'),
      false,
    )
    assert.equal(
      (await s.agent({ hydra: true })).id,
      first.id,
    )
    const page = await openPage({
      port: pnyx.port(),
      hydraId: s.hydraId,
    })

    try {
      const receipt = await page.command({
        name: 'thread',
        args: [HYDRA_CARD],
      })
      assert.ok((receipt.thread as ThreadPage).entries.some(e => e.role === 'assistant' && e.text === pnyx.claude.reply))
    } finally {
      page.close()
    }
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
  'progress requires an agent, a task and text, and invalid reports write nothing',
  async () => {
    const s = await pnyx.scenario()
    const folder = s.folder({ name: 'validation' })
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
    const task = s.task({ key: 'fix' }).id

    assert.equal(
      await s.ownerRefused({
        args: [
          'hydra',
          'send',
          '--kind',
          'progress',
          '--task',
          task,
          '--text',
          'Halfway',
        ],
      }),
      'VALIDATION_ERROR',
    )

    for (const args of [
      [
        '--actor',
        `worker:${task}`,
        '--text',
        'Halfway',
      ],
      [
        '--actor',
        `worker:${task}`,
        '--task',
        task,
      ],
      [
        '--actor',
        `worker:${task}`,
        '--task',
        task,
        '--action',
        'worker',
        '--text',
        'Halfway',
      ],
    ]) {
      assert.equal(
        await worker.refused({
          args: [
            'hydra',
            'send',
            '--kind',
            'progress',
            ...args,
          ],
        }),
        'VALIDATION_ERROR',
      )
    }

    assert.equal(
      await worker.refused({
        args: [
          'hydra',
          'send',
          '--kind',
          'chatter',
          '--task',
          task,
          '--text',
          'Halfway',
          '--actor',
          `worker:${task}`,
        ],
      }),
      'VALIDATION_ERROR',
    )
    assert.equal(
      s.events().filter(e => e.type === 'hydra.message').length,
      0,
    )
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

test(
  'quiet replies stay hidden during streaming and restart; longer answers and owner chat remain',
  async () => {
    const s = await pnyx.scenario()
    const held = pnyx.claude.plan({
      text: 'NO',
      reply: 'NO_RE',
      hold: true,
    })
    const page = await openPage({
      port: pnyx.port(),
      hydraId: s.hydraId,
    })
    const visible = ({ thread }: { thread: ThreadPage }) => hydraConversation({
      messages: s.state().hydraMessages ?? [],
      transcript: thread.entries,
      currentTurn: thread.currentTurn,
      actions: thread.actions ?? [],
      columns: hydraConfig({ state: s.state() }).columns,
      working: s.state().cards[HYDRA_CARD]?.sessionActivity === 'working',
      thinking: false,
    }).entries

    try {
      await send({
        s,
        text: 'NO',
        id: 'quiet',
      })
      const streaming = await page.command({
        name: 'thread',
        args: [HYDRA_CARD],
      })
      assert.ok((streaming.thread as ThreadPage).entries.some(e => e.streaming && e.text === 'NO_RE'))
      assert.deepEqual(
        visible({ thread: streaming.thread as ThreadPage }).map(e => e.text),
        ['NO'],
      )
    } finally {
      held.release()
      page.close()
    }

    await finished({
      s,
      turns: 1,
    })
    await s.owner({
      args: [
        'task',
        'create',
        '--title',
        'Waiting task',
        '--key',
        'waiting',
      ],
    })
    pnyx.claude.plan({
      text: '</pnyx-wake>',
      reply: 'NO_REPLY\n',
    })
    await s.owner({
      args: [
        'task',
        'status',
        'waiting',
        'blocked',
        '--note',
        'Waiting for tool access',
      ],
    })
    await finished({
      s,
      turns: 2,
    })
    await pnyx.restart()
    pnyx.claude.plan({
      text: 'Explain the marker',
      reply: 'NO_REPLY is not all I said',
    })
    await send({
      s,
      text: 'Explain the marker',
      id: 'explain',
    })
    await finished({
      s,
      turns: 3,
    })
    const reopened = await openPage({
      port: pnyx.port(),
      hydraId: s.hydraId,
    })

    try {
      const receipt = await reopened.command({
        name: 'thread',
        args: [HYDRA_CARD],
      })
      assert.deepEqual(
        visible({ thread: receipt.thread as ThreadPage }).map(e => e.text),
        [
          'NO',
          'Explain the marker',
          'NO_REPLY is not all I said',
        ],
      )
    } finally {
      reopened.close()
    }
  },
)

test(
  'memory saves survive restart, inform the next wake, and keep owner preferences shared across Hydras',
  async () => {
    const s = await pnyx.scenario()
    await s.owner({
      args: [
        'task',
        'create',
        '--title',
        'Watch memory',
        '--key',
        'watch',
      ],
    })
    await send({
      s,
      text: 'Remember the plan',
      id: 'remember',
    })
    await finished({
      s,
      turns: 1,
    })
    const agent = await s.agent({ hydra: true })
    const hydra = s.as({ agent })
    await hydra.run({
      args: [
        'hydra',
        'memory',
        'set',
        '--key',
        'scope',
        '--text',
        'Release the parser.',
      ],
    })
    await hydra.run({
      args: [
        'owner',
        'memory',
        'set',
        '--key',
        'preferences',
        '--text',
        'Short PRs.',
      ],
    })
    await s.owner({
      args: [
        'hydra',
        'send',
        '--task',
        'watch',
        '--actor',
        `worker:${s.task({ key: 'watch' }).id}`,
        '--text',
        'Memory is ready',
      ],
    })
    await finished({
      s,
      turns: 2,
    })
    assert.match(
      agent.received[1]!,
      /Memory changed; load owner memory/,
    )
    assert.doesNotMatch(
      agent.received[1]!,
      /<pnyx-digest/,
    )
    await pnyx.restart()
    await send({
      s,
      text: 'Recall the plan',
      id: 'recall',
    })
    await finished({
      s,
      turns: 3,
    })
    const resumed = await s.agent({ hydra: true })
    assert.match(
      resumed.received[0]!,
      /Release the parser\./,
    )
    assert.match(
      resumed.received[0]!,
      /Short PRs\./,
    )
    const other = await pnyx.scenario()
    assert.match(
      await other.owner({
        args: [
          'hydra',
          'digest',
        ],
      }),
      /Short PRs\./,
    )
    assert.doesNotMatch(
      await other.owner({
        args: [
          'hydra',
          'memory',
          'list',
        ],
      }),
      /Release the parser\./,
    )
    assert.match(
      await s.owner({
        args: [
          'owner',
          'memory',
          'set',
          '--key',
          'preferences',
          '--text',
          'Short PRs.',
        ],
      }),
      /skipped: unchanged/,
    )
    await s.owner({
      args: [
        'owner',
        'memory',
        'forget',
        '--key',
        'preferences',
      ],
    })
    assert.match(
      await other.owner({
        args: [
          'owner',
          'memory',
          'list',
        ],
      }),
      /none: no owner memory yet/,
    )
    const log = readFileSync(
      join(
        process.env.PNYX_HOME!,
        'owner',
        'memory.jsonl',
      ),
      'utf8',
    )
    assert.equal(
      log.trim().split('\n').length,
      2,
    )
    await hydra.run({
      args: [
        'hydra',
        'memory',
        'forget',
        '--key',
        'scope',
      ],
    })
    assert.equal(
      s.state().hydraMemory?.scope,
      undefined,
    )
    assert.deepEqual(
      s.events().filter(e => e.type === 'hydra.memory')
        .map(e => e.data.after),
      [
        'Release the parser.',
        null,
      ],
    )
  },
)

test(
  'durable Lavish rounds reach the page worker once and stay out of Hydra owner chat',
  async () => {
    const s = await pnyx.scenario()
    const folder = s.folder({ name: 'review-page' })
    const fixture = lavishFixture({ folder })
    await s.owner({
      args: [
        'task',
        'create',
        '--title',
        'Build a review page',
        '--key',
        'page',
        '--folder',
        folder,
      ],
    })
    await s.owner({
      args: [
        'task',
        'start',
        'page',
      ],
    })
    const agent = await s.agent({ cwd: folder })
    const worker = s.as({ agent })
    await until({
      what: 'worker opening turn',
      check: () => s.task({ key: 'page' }).sessionActivity === 'finished',
    })
    await send({
      s,
      text: 'The review page is ready',
      id: 'ready',
    })
    await finished({
      s,
      turns: 1,
    })
    const hydra = await s.agent({ hydra: true })
    await worker.run({
      args: fixture.arm({
        task: 'page',
        id: 'comments',
      }),
    })
    await until({
      what: 'page listening',
      check: () => existsSync(join(
        folder,
        'listening',
      )),
    })
    const comments = 'session:\n  status: feedback\n  session_ended: true\nprompts[1]{tag,text}:\n  message,"Use a larger chart and keep the legend."\n'
    fixture.deliver({ body: comments })
    await until({
      what: 'captured feedback delivered to worker',
      check: () => {
        const message = s.task({ key: 'page' }).steering?.[0]

        return message && s.received({ cwd: folder }).some(text => text.includes(message.id))
          && s.task({ key: 'page' }).sessionActivity === 'finished'
      },
    })
    const message = s.task({ key: 'page' }).steering![0]!
    await pnyx.restart()
    await readAndAck({
      s,
      worker,
      task: 'page',
      id: 'comments',
    })
    const handled = [
      'task',
      'source',
      'handled',
      'page',
      'comments',
      '1',
      ...claimFlags({ card: s.task({ key: 'page' }) }),
    ]
    await worker.run({ args: handled })
    await worker.run({ args: handled })
    await send({
      s,
      text: 'Continue the review',
      id: 'continue',
    })
    await until({
      what: 'Hydra handles the next owner message',
      check: () => s.received({ cwd: hydra.cwd }).includes('Continue the review')
        && s.state().cards[HYDRA_CARD]?.sessionActivity === 'finished',
    })
    assert.equal(
      s.task({ key: 'page' }).steering!.filter(item => item.id === message.id).length,
      1,
    )
    assert.equal(
      s.task({ key: 'page' }).externalSources![0]!.state,
      'retired',
    )
    assert.equal(
      s.events().filter(event => event.type === 'task.source.handled').length,
      1,
    )
    assert.equal(
      s.received({ cwd: hydra.cwd }).some(text => text.includes(comments)),
      false,
    )
    assert.equal(
      s.state().hydraMessages?.some(item => item.text.includes(comments)),
      false,
    )
    assert.equal(
      fixture.calls().length,
      1,
    )
  },
)
