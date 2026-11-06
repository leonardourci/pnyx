import { renameSync } from 'node:fs'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { HYDRA_CARD } from '#hydra/identity.ts'
import { canSkipCompaction } from '#hydra/history.ts'
import { countTokens } from '#workers/token-count.ts'
import { openPage, until } from '#test-harness/harness.ts'
import { pnyx } from '#test-harness/pnyx.ts'

test(
  'inscribe pages whole messages from a pinned snapshot and advances only a finished milestone',
  async () => {
    const s = await pnyx.scenario()
    const page = await openPage({
      port: pnyx.port(),
      hydraId: s.hydraId,
    })
    const ownerText = 'Release preference. '.repeat(100)
    const replyText = 'Résumé 😀: preserve the release decision. '.repeat(100)
    pnyx.claude.plan({
      text: ownerText,
      reply: replyText,
    })

    try {
      const empty = await page.command({
        name: 'hydra',
        args: ['history'],
      })
      assert.equal(
        empty.text,
        '',
      )
      assert.equal(
        empty.totalTokens,
        0,
      )
      await s.chat({ text: ownerText })
      const agent = await s.agent({ hydra: true })
      await until({
        what: 'the long reply to finish',
        check: () => s.answered({ cwd: agent.cwd }) === 1 && s.state().cards[HYDRA_CARD]?.sessionActivity === 'finished',
      })
      await s.owner({
        args: [
          'task',
          'create',
          '--title',
          'Release',
          '--brief',
          'Never skip the release smoke test.',
        ],
      })
      assert.equal(
        (await page.refusal({
          name: 'hydra',
          args: [
            'inscribe',
            'start',
            '--through',
            '-1',
          ],
        })).code,
        'VALIDATION_ERROR',
      )
      const pass = await page.command({
        name: 'hydra',
        args: [
          'inscribe',
          'start',
        ],
      })
      assert.equal(
        (await page.refusal({
          name: 'hydra',
          args: [
            'inscribe',
            'start',
            '--key',
            'another-pass',
          ],
        })).code,
        'CONFLICT',
      )
      const first = await page.command({
        name: 'hydra',
        args: [
          'history',
          '--since',
          'last-inscribe',
          '--through',
          String(pass.through),
          '--budget',
          '1',
        ],
      })
      assert.equal(
        first.text,
        `[owner] ${ownerText}`,
      )
      assert.equal(
        first.more,
        true,
      )
      assert.match(
        String(first.note),
        /More follows/,
      )
      assert.ok(Number(first.tokens) > 1)
      const incomplete = await page.refusal({
        name: 'hydra',
        args: [
          'inscribe',
          'finish',
          '--key',
          String(pass.milestone),
          '--through',
          String(first.through),
        ],
      })
      assert.equal(
        incomplete.code,
        'INSCRIBE_INCOMPLETE',
      )
      await s.owner({
        args: [
          'hydra',
          'send',
          '--text',
          'Arrived after the snapshot.',
        ],
      })
      const second = await page.command({
        name: 'hydra',
        args: [
          'history',
          '--since',
          'last-inscribe',
          '--after',
          String(first.after),
          '--budget',
          '1',
        ],
      })
      assert.equal(
        second.text,
        `[Hydra] ${replyText.trim()}`,
      )
      assert.equal(
        second.more,
        true,
      )
      const transcriptPath = s.state().cards[HYDRA_CARD]?.agent?.transcriptPath
      assert.ok(transcriptPath)
      renameSync(
        transcriptPath,
        `${transcriptPath}.held`,
      )

      try {
        const archived = await page.command({
          name: 'hydra',
          args: [
            'history',
            '--since',
            'last-inscribe',
            '--after',
            String(first.after),
            '--budget',
            '1',
          ],
        })
        assert.equal(
          archived.text,
          second.text,
        )
        assert.equal(
          archived.totalTokens,
          second.totalTokens,
        )
      } finally {
        renameSync(
          `${transcriptPath}.held`,
          transcriptPath,
        )
      }

      const third = await page.command({
        name: 'hydra',
        args: [
          'history',
          '--since',
          'last-inscribe',
          '--after',
          String(second.after),
          '--budget',
          '1',
        ],
      })
      assert.match(
        String(third.text),
        /Never skip the release smoke test\.$/,
      )
      assert.equal(
        third.more,
        false,
      )
      assert.equal(
        third.through,
        pass.through,
      )
      assert.doesNotMatch(
        String(third.text),
        /Arrived after/,
      )
      assert.equal(
        first.totalTokens,
        countTokens({ text: `${first.text}\n\n${second.text}\n\n${third.text}` }),
      )
      await page.command({
        name: 'hydra',
        args: [
          'inscribe',
          'fail',
          '--key',
          String(pass.milestone),
          '--error',
          'Memory save failed',
        ],
      })
      assert.equal(
        (await page.refusal({
          name: 'hydra',
          args: [
            'inscribe',
            'finish',
            '--key',
            String(pass.milestone),
            '--through',
            String(pass.through),
          ],
        })).code,
        'VALIDATION_ERROR',
      )
      const failedBoundary = await page.command({
        name: 'hydra',
        args: [
          'history',
          '--since',
          'last-inscribe',
          '--budget',
          '1',
        ],
      })
      assert.equal(
        failedBoundary.text,
        `[owner] ${ownerText}`,
      )
      const retry = await page.command({
        name: 'hydra',
        args: [
          'inscribe',
          'start',
        ],
      })
      const replay = await page.command({
        name: 'hydra',
        args: [
          'history',
          '--since',
          'last-inscribe',
          '--through',
          String(retry.through),
        ],
      })
      assert.match(
        String(replay.text),
        /Arrived after the snapshot/,
      )
      await page.command({
        name: 'hydra',
        args: [
          'inscribe',
          'finish',
          '--key',
          String(retry.milestone),
          '--through',
          String(retry.through),
        ],
      })
      const done = await page.command({
        name: 'hydra',
        args: [
          'history',
          '--since',
          'last-inscribe',
        ],
      })
      assert.doesNotMatch(
        String(done.text),
        /Release preference|release smoke test|Arrived after/,
      )
      const explicit = await page.command({
        name: 'hydra',
        args: [
          'history',
          '--since',
          String(retry.milestone),
        ],
      })
      assert.equal(
        explicit.text,
        done.text,
      )
      const oldPage = await page.command({
        name: 'hydra',
        args: [
          'history',
          '--since',
          'last-inscribe',
          '--after',
          String(first.after),
          '--budget',
          '1',
        ],
      })
      assert.equal(
        oldPage.text,
        second.text,
      )
      assert.equal(
        (await page.refusal({
          name: 'hydra',
          args: [
            'history',
            '--since',
            String(pass.milestone),
          ],
        })).code,
        'VALIDATION_ERROR',
      )
      assert.equal(
        (await page.refusal({
          name: 'hydra',
          args: [
            'history',
            '--after',
            'bad-cursor',
          ],
        })).code,
        'VALIDATION_ERROR',
      )
      assert.equal(
        (await page.refusal({
          name: 'hydra',
          args: [
            'history',
            '--budget',
            '0',
          ],
        })).code,
        'VALIDATION_ERROR',
      )
      assert.equal(
        s.state().hydraMemory?.['inscribe-cursor'],
        undefined,
      )
      assert.equal(
        s.state().hydraMessages?.filter(message => message.kind === 'divider' && message.text === 'Inscribed').length,
        1,
      )
      const unfinished = await page.command({
        name: 'hydra',
        args: [
          'inscribe',
          'start',
        ],
      })
      await pnyx.restart()
      assert.equal(
        s.state().historyMilestones?.find(item => item.id === unfinished.milestone)?.state,
        'failed',
      )
      assert.equal(
        s.state().historyMilestones?.find(item => item.id === retry.milestone)?.state,
        'finished',
      )
      assert.equal(
        s.state().historyMilestones?.find(item => item.id === pass.milestone)?.state,
        'failed',
      )
    } finally {
      page.close()
    }
  },
)

async function pendingSwitch({
  characters,
  effort = false,
}: {
  characters: number
  effort?: boolean
}) {
  const s = await pnyx.scenario()
  const page = await openPage({
    port: pnyx.port(),
    hydraId: s.hydraId,
  })
  await page.command({
    name: 'hydra-agent',
    args: [
      JSON.stringify({
        harness: 'claude',
        model: 'sonnet',
      }),
    ],
  })
  const firstText = 'x'.repeat(30000)
  pnyx.claude.plan({
    text: firstText,
    reply: '',
  })
  await s.chat({ text: firstText })
  const firstAgent = await s.agent({ hydra: true })
  await until({
    what: 'the first empty reply to finish',
    check: () => s.answered({ cwd: firstAgent.cwd }) === 1 && s.state().cards[HYDRA_CARD]?.sessionActivity === 'finished',
  })
  const text = 'x'.repeat(characters - 30010)
  pnyx.claude.plan({
    text,
    reply: '',
  })
  await s.chat({ text })
  const agent = await s.agent({ hydra: true })
  await until({
    what: 'the empty reply to finish',
    check: () => s.answered({ cwd: agent.cwd }) === 2 && s.state().cards[HYDRA_CARD]?.sessionActivity === 'finished',
  })
  await page.command({
    name: 'hydra-agent',
    args: [
      JSON.stringify({
        harness: 'claude',
        model: effort ? 'sonnet' : 'opus',
        effort: effort ? 'low' : undefined,
      }),
    ],
  })
  await s.owner({
    args: [
      'hydra',
      'send',
      '--text',
      'a',
      '--event-id',
      'switch',
    ],
  })
  await until({
    what: 'the pending model switch',
    check: () => s.state().hydraAgentChange?.state === 'requested',
  })

  return {
    s,
    page,
  }
}

test(
  'Neither allows 14,999 tokens, refuses exactly 15,000, and rechecks after new messages',
  async () => {
    assert.equal(
      canSkipCompaction({ tokens: 14999 }),
      true,
    )
    assert.equal(
      canSkipCompaction({ tokens: 15000 }),
      false,
    )
    const below = await pendingSwitch({ characters: 59977 })

    try {
      const count = await below.page.command({
        name: 'hydra',
        args: [
          'history',
          '--count',
        ],
      })
      assert.equal(
        count.totalTokens,
        14999,
      )
      await below.page.command({
        name: 'hydra-agent-change',
        args: [
          'switch',
          'neither',
        ],
      })
      await until({
        what: 'a fresh agent without compaction',
        check: () => below.s.state().hydraAgent?.model === 'opus' && !below.s.state().hydraAgentChange,
      })
      assert.equal(
        below.s.state().historyMilestones?.length ?? 0,
        0,
      )
      await until({
        what: 'the fresh context to include a history command',
        check: () => pnyx.claude.sessions.find(session => session.env.PNYX_HYDRA === below.s.hydraId && session.model === 'opus' && session.received.some(text => text.includes('pnyx-axi hydra history'))),
      })
    } finally {
      below.page.close()
    }

    const exact = await pendingSwitch({ characters: 59981 })

    try {
      assert.equal(
        (await exact.page.command({
          name: 'hydra',
          args: [
            'history',
            '--count',
          ],
        })).totalTokens,
        15000,
      )
      assert.equal(
        (await exact.page.refusal({
          name: 'hydra-agent-change',
          args: [
            'switch',
            'neither',
          ],
        })).code,
        'VALIDATION_ERROR',
      )
      assert.equal(
        exact.s.state().hydraAgentChange?.state,
        'requested',
      )
    } finally {
      exact.page.close()
    }

    const stale = await pendingSwitch({ characters: 59977 })

    try {
      assert.equal(
        (await stale.page.command({
          name: 'hydra',
          args: [
            'history',
            '--count',
          ],
        })).totalTokens,
        14999,
      )
      await stale.s.owner({
        args: [
          'hydra',
          'send',
          '--text',
          'b',
        ],
      })
      assert.equal(
        (await stale.page.command({
          name: 'hydra',
          args: [
            'history',
            '--count',
          ],
        })).totalTokens,
        15002,
      )
      const refused = await stale.page.refusal({
        name: 'hydra-agent-change',
        args: [
          'switch',
          'neither',
        ],
      })
      assert.equal(
        refused.code,
        'VALIDATION_ERROR',
      )
      assert.match(
        refused.error,
        /less than 15,000/,
      )
    } finally {
      stale.page.close()
    }

    const effort = await pendingSwitch({
      characters: 59981,
      effort: true,
    })

    try {
      const agent = await effort.s.agent({ hydra: true })
      const previous = agent.id
      await effort.page.command({
        name: 'hydra-agent-change',
        args: [
          'switch',
          'neither',
        ],
      })
      await until({
        what: 'an effort change to keep its existing context above the switch limit',
        check: () => effort.s.state().cards[HYDRA_CARD]?.settings?.effort === 'low' && !effort.s.state().hydraAgentChange,
      })
      assert.equal(
        effort.s.state().cards[HYDRA_CARD]?.agent?.sessionId,
        previous,
      )
      await until({
        what: 'the effort-only continuation to finish',
        check: () => effort.s.answered({ cwd: agent.cwd }) === 3,
      })
      const latest = pnyx.claude.sessions.findLast(session =>
        session.env.PNYX_HYDRA === effort.s.hydraId)!
      assert.doesNotMatch(
        latest.received.at(-1)!,
        /pnyx-axi hydra history/,
      )
    } finally {
      effort.page.close()
    }
  },
)
