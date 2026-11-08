import { skillReference } from '#hydra/transcripts-skill-reference.ts'
import type { Catalog } from '#hydra/transcripts-catalog.ts'
import { skillSource } from '#setup/skills.ts'
import { ORCHESTRATE_SKILL, INSCRIBE_SKILL } from '#setup/skill-names.ts'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { LATEST_DELAY_MS } from '#app/latest-feed.ts'
import { HYDRA_CARD } from '#hydra/identity.ts'
import { taskMention } from '#hydra/mentions.ts'
import type { ThreadPage } from '#hydra/transcripts-read.ts'
import { openPage, until } from '#test-harness/harness.ts'
import { pnyx, type Scenario } from '#test-harness/pnyx.ts'

const inscribePrompt = ({ text }: { text: string }) => text.includes(skillSource({ name: 'inscribe' }))
  && text.includes('pnyx-axi hydra history')
const summaryPrompt = ({ text }: { text: string }) => text.includes('pnyx-axi hydra history')
  && !inscribePrompt({ text })

function pendingSummary({
  s,
  harness = 'claude',
}: {
  s: Scenario
  harness?: 'claude' | 'codex'
}) {
  const sessions = harness === 'claude' ? pnyx.claude.sessions : pnyx.codex.sessions
  const latest = sessions.findLast(session => session.env.PNYX_HYDRA === s.hydraId)

  return latest && latest.id !== s.state().cards[HYDRA_CARD]?.agent?.sessionId
    && latest.received.some(text => summaryPrompt({ text })) ? latest : undefined
}

async function finishInscribe({
  s,
  agent,
}: {
  s: Scenario
  agent: Awaited<ReturnType<Scenario['agent']>>
}) {
  const worker = s.as({ agent })
  const pass = await worker.run({
    args: [
      'hydra',
      'inscribe',
      'start',
    ],
  })
  const milestone = pass.match(/^milestone: (.+)$/m)?.[1]
  assert.ok(milestone)
  const id = JSON.parse(milestone) as string
  const through = pass.match(/^through: (\d+)$/m)?.[1]
  assert.ok(id)
  assert.ok(through)
  await worker.run({
    args: [
      'hydra',
      'inscribe',
      'finish',
      '--key',
      id,
      '--through',
      through,
    ],
  })
}

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
    // A finished state can still be the previous turn's while the next prompt is already received, so wait for its turn to end too.
    check: () => s.received({ cwd: agent.cwd }).length === turns
      && s.answered({ cwd: agent.cwd }) === turns
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
  'an exhausted model hands inscribe to a fresh session on the same account before the first compaction',
  async () => {
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
    await send({
      s,
      text: 'Remember the release decision',
      id: 'release-decision',
    })
    await finished({
      s,
      turns: 1,
    })
    const previous = await s.agent({ hydra: true })
    assert.equal(
      s.state().hydraContext,
      undefined,
    )
    const quota = join(
      previous.env.CLAUDE_CONFIG_DIR!,
      'quota.json',
    )
    writeFileSync(
      quota,
      JSON.stringify({
        models: [
          {
            provider: 'claude',
            id: 'sonnet',
            effective: {
              status: 'known',
              effectivePercentRemaining: 0,
            },
          },
        ],
      }),
    )
    const handover = pnyx.claude.plan({
      match: inscribePrompt,
      reply: 'Memory saved.',
      hold: true,
    })

    try {
      await page.command({
        name: 'hydra-agent',
        args: [
          JSON.stringify({
            harness: 'claude',
            model: 'opus',
          }),
        ],
      })
      await send({
        s,
        text: 'Continue with the new model',
        id: 'new-model',
      })
      await page.command({
        name: 'hydra-agent-change',
        args: [
          'new-model',
          'inscribe',
        ],
      })
      const inscriber = await until({
        what: 'the replacement model to read the paged log',
        check: () => pnyx.claude.sessions.find(session => session.env.PNYX_HYDRA === s.hydraId
          && session.received.some(text => inscribePrompt({ text }))),
      })
      assert.equal(
        inscriber.model,
        'opus',
      )
      assert.equal(
        inscriber.env.CLAUDE_CONFIG_DIR,
        previous.env.CLAUDE_CONFIG_DIR,
      )
      assert.notEqual(
        inscriber.id,
        previous.id,
      )
      assert.ok(!inscriber.received[0]!.includes('Conversation context:'))
      assert.ok(!inscriber.received[0]!.includes('Remember the release decision'))
      const firstPage = await s.as({ agent: inscriber }).run({
        args: [
          'hydra',
          'history',
          '--since',
          'last-inscribe',
          '--budget',
          '1',
        ],
      })
      assert.match(
        firstPage,
        /Remember the release decision/,
      )
      const after = firstPage.match(/after: (.+)/)?.[1]
      assert.ok(after)
      const through = JSON.parse(after) as string
      const nextPage = await s.as({ agent: inscriber }).run({
        args: [
          'hydra',
          'history',
          '--since',
          'last-inscribe',
          '--after',
          through,
          '--budget',
          '15000',
        ],
      })
      assert.match(
        nextPage,
        /Continue with the new model/,
      )
      assert.doesNotMatch(
        nextPage,
        /Remember the release decision/,
      )
      await finishInscribe({
        s,
        agent: inscriber,
      })
      handover.release()
      await until({
        what: 'the held message to reach a fresh session after inscribe',
        check: () => pnyx.claude.sessions.find(session => session.env.PNYX_HYDRA === s.hydraId
          && session.received.some(text => text.includes('Continue with the new model'))),
      })
      assert.notEqual(
        s.state().cards[HYDRA_CARD]?.agent?.sessionId,
        inscriber.id,
      )
      assert.equal(
        s.state().hydraAgent?.model,
        'opus',
      )
    } finally {
      handover.release()
      unlinkSync(quota)
      page.close()
    }
  },
)

test(
  'owner messages queue once, agent switches compact the stored conversation, and effort and Fast apply on the next turn',
  async () => {
    const s = await pnyx.scenario()
    await s.owner({
      args: [
        'task',
        'create',
        '--title',
        'Release notes',
        '--key',
        'notes',
      ],
    })
    const task = s.task({ key: 'notes' }).id
    const reply = `${taskMention({
      id: task,
      title: 'Release notes',
    })} Noted.`
    const page = await openPage({
      port: pnyx.port(),
      hydraId: s.hydraId,
    })
    const choose = ({
      model,
      effort = 'high',
      fast = false,
    }: {
      model: string
      effort?: string
      fast?: boolean
    }) => page.command({
      name: 'hydra-agent',
      args: [
        JSON.stringify({
          harness: 'claude',
          model,
          effort,
          fast,
        }),
      ],
    })
    const first = pnyx.claude.plan({
      text: 'Before the switch',
      reply,
      hold: true,
    })
    pnyx.claude.plan({
      text: 'Queued once',
      reply,
    })

    try {
      await choose({ model: 'sonnet' })
      await send({
        s,
        text: 'Before the switch',
        id: 'before',
      })
      const agent = await s.agent({ hydra: true })
      await until({
        what: 'the first message to reach Hydra',
        check: () => agent.received.length === 1,
      })
      await send({
        s,
        text: 'Queued once',
        id: 'queued',
      })
      await send({
        s,
        text: 'Queued once',
        id: 'queued',
      })
      first.release()
      await finished({
        s,
        turns: 2,
      })
      assert.equal(
        s.received({ cwd: agent.cwd }).filter(text => text === 'Queued once').length,
        1,
      )
      assert.deepEqual(
        s.events().flatMap(event => event.type === 'card.noted' && event.cardId === task && event.data.source === 'hydra' ? [event.data.text] : []),
        [
          'Noted.',
          'Noted.',
        ],
      )

      assert.deepEqual(
        s.events().flatMap(event =>
          event.type === 'card.noted' && event.cardId === task && event.data.source === 'owner' ? [event.data.text] : []),
        [
          'Before the switch',
          'Queued once',
        ],
      )

      await choose({ model: 'opus' })
      assert.equal(
        s.state().hydraAgentChange,
        undefined,
      )
      await send({
        s,
        text: 'After the switch',
        id: 'after',
      })
      await until({
        what: 'the held message to offer a switch choice',
        check: () => s.state().hydraAgentChange?.state === 'requested',
      })
      assert.equal(
        s.received({ cwd: agent.cwd }).length,
        2,
      )
      assert.equal(
        (await page.refusal({
          name: 'hydra-agent-change',
          args: [
            'stale-choice',
            'neither',
          ],
        })).code,
        'VALIDATION_ERROR',
      )
      pnyx.claude.plan({
        match: summaryPrompt,
        reply: 'The release notes were acknowledged.',
      })
      await page.command({
        name: 'hydra-agent-change',
        args: [
          'after',
          'compact',
        ],
      })
      await until({
        what: 'the new agent to receive the held message',
        check: () => s.received({ cwd: agent.cwd }).some(text => text.includes('back after a stop') && text.includes('After the switch')),
      })
      await finished({
        s,
        turns: 4,
      })
      const sessions = pnyx.claude.sessions.filter(session => session.env.PNYX_HYDRA === s.hydraId)
      const next = sessions.find(session => session.model === 'opus')
      assert.ok(next)
      assert.notEqual(
        next.id,
        agent.id,
      )
      assert.ok(next.received[0]!.includes('The release notes were acknowledged.'))
      assert.ok(!next.received[0]!.includes('Before the switch'))
      assert.ok(!next.received[0]!.includes('Queued once'))
      assert.deepEqual(
        s.events().flatMap(event => event.type === 'hydra.operation' ? [event.data.state] : []),
        [
          'started',
          'finished',
        ],
      )
      assert.ok(s.state().hydraMessages?.some(message => message.kind === 'divider' && message.text === 'Switched to opus'))
      assert.ok(s.state().hydraMessages?.some(message => message.kind === 'divider' && message.text === 'Compacted'))
      const compactedHistory = await page.command({
        name: 'hydra',
        args: [
          'history',
          '--since',
          'last-compaction',
        ],
      })
      const firstInscription = await page.command({
        name: 'hydra',
        args: [
          'history',
          '--since',
          'last-inscribe',
        ],
      })
      assert.equal(
        firstInscription.boundary,
        compactedHistory.boundary,
      )
      assert.doesNotMatch(
        String(firstInscription.text),
        /Before the switch/,
      )

      await choose({
        model: 'opus',
        effort: 'low',
      })
      await send({
        s,
        text: 'Continue at low effort',
        id: 'effort',
      })
      await until({
        what: 'an effort change choice',
        check: () => s.state().hydraAgentChange?.kind === 'effort',
      })
      await page.command({
        name: 'hydra-agent-change',
        args: [
          'effort',
          'neither',
        ],
      })
      await finished({
        s,
        turns: 5,
      })
      assert.equal(
        s.state().hydraAgentChange,
        undefined,
      )
      assert.equal(
        s.events().filter(event => event.type === 'hydra.operation').length,
        2,
      )
      assert.equal(
        s.state().cards[HYDRA_CARD]?.settings?.effort,
        'low',
      )

      const fastTurn = pnyx.claude.plan({
        text: 'Before Fast',
        hold: true,
      })

      try {
        await send({
          s,
          text: 'Before Fast',
          id: 'before-fast',
        })
        await until({
          what: 'the turn before Fast',
          check: () => s.received({ cwd: agent.cwd }).some(text => text.endsWith('Before Fast')),
        })
        await choose({
          model: 'opus',
          effort: 'low',
          fast: true,
        })
        assert.equal(
          s.state().hydraAgentChange,
          undefined,
        )
        assert.equal(
          s.state().cards[HYDRA_CARD]?.settings?.fast,
          'false',
        )
        await send({
          s,
          text: 'With Fast',
          id: 'with-fast',
        })
        fastTurn.release()
        await finished({
          s,
          turns: 7,
        })
        assert.equal(
          s.state().cards[HYDRA_CARD]?.settings?.fast,
          'true',
        )
        assert.equal(
          s.state().hydraAgentChange,
          undefined,
        )
      } finally {
        fastTurn.release()
      }

      await choose({
        model: 'sonnet',
        effort: 'low',
      })
      await send({
        s,
        text: 'Switch back',
        id: 'back',
      })
      await until({
        what: 'another switch choice',
        check: () => s.state().hydraAgentChange?.id === 'back',
      })
      pnyx.claude.plan({
        match: inscribePrompt,
        reply: 'No memory saved.',
      })
      await page.command({
        name: 'hydra-agent-change',
        args: [
          'back',
          'inscribe',
        ],
      })
      await until({
        what: 'an incomplete inscribe to leave the message held',
        check: () => s.state().hydraAgentChange?.state === 'failed' && !s.state().hydraOperation,
      })
      assert.match(
        s.state().hydraAgentChange!.error!,
        /Inscribe did not finish saving memory/,
      )
      await finished({
        s,
        turns: 9,
      })
      assert.ok(!s.received({ cwd: agent.cwd }).some(text => text.includes('Switch back')))
      const inscription = pnyx.claude.plan({
        match: inscribePrompt,
        reply: 'Memory saved.',
        hold: true,
      })
      const summary = pnyx.claude.plan({
        match: summaryPrompt,
        reply: 'Fast was enabled after the release discussion.',
        hold: true,
      })

      try {
        await page.command({
          name: 'hydra-agent-change',
          args: [
            'back',
            'inscribe',
          ],
        })
        await until({
          what: 'inscribe on the previous model',
          check: () => s.received({ cwd: agent.cwd }).some(text => inscribePrompt({ text })),
        })
        const inscribing = pnyx.claude.sessions.findLast(session =>
          session.env.PNYX_HYDRA === s.hydraId)!
        assert.equal(
          inscribing.model,
          'opus',
        )
        assert.equal(
          inscribing.env.CLAUDE_CONFIG_DIR,
          agent.env.CLAUDE_CONFIG_DIR,
        )
        await s.as({ agent: inscribing }).run({
          args: [
            'hydra',
            'memory',
            'set',
            '--key',
            'scope',
            '--text',
            'Release decisions saved before switching.',
            '--reason',
            'Inscribe',
          ],
        })
        await finishInscribe({
          s,
          agent: inscribing,
        })
        inscription.release()
        await until({
          what: 'the summary after inscribe',
          check: () => pendingSummary({ s }),
        })
        assert.equal(
          s.state().hydraMemory?.scope?.text,
          'Release decisions saved before switching.',
        )
        const compactPrompt = s.received({ cwd: agent.cwd }).at(-1)!
        assert.ok(compactPrompt.includes('The release notes were acknowledged.'))
        assert.ok(compactPrompt.includes('pnyx-axi hydra history'))
        assert.ok(!compactPrompt.includes('Before Fast'))
        assert.ok(compactPrompt.includes('Release decisions saved before switching.'))
        assert.ok(!compactPrompt.includes('Before the switch'))
        const summarizer = pnyx.claude.sessions.findLast(session =>
          session.env.PNYX_HYDRA === s.hydraId)!
        const historyCommand = compactPrompt.match(/`(pnyx-axi hydra history[^`]+)`/)?.[1]
        assert.ok(historyCommand)
        const useTool = summarizer.useTool
        assert.ok(useTool)
        assert.equal(
          (await useTool({
            tool: 'Bash',
            input: { command: historyCommand },
          }))?.behavior,
          'allow',
        )
        assert.equal(
          (await useTool({
            tool: 'Bash',
            input: { command: `${historyCommand} && touch unexpected` },
          }))?.behavior,
          'deny',
        )
        const historyArgs = historyCommand.replace(
          ` --hydra ${s.hydraId}`,
          '',
        ).split(' ')
          .slice(1)
        const recordedHistory = await s.as({ agent: summarizer }).run({ args: historyArgs })
        assert.match(
          recordedHistory,
          /Before Fast/,
        )
        assert.doesNotMatch(
          recordedHistory,
          /Before the switch/,
        )

        await send({
          s,
          text: 'Queued during the switch',
          id: 'during',
        })
        summary.release()
        await finished({
          s,
          turns: 12,
        })
        assert.equal(
          s.state().hydraMessages?.filter(message => message.kind === 'divider' && message.text === 'Inscribed and compacted').length,
          1,
        )
        assert.equal(
          s.state().hydraMessages?.filter(message => message.kind === 'divider' && message.text === 'Inscribed').length,
          0,
        )
        const resumed = s.received({ cwd: agent.cwd }).at(-1)!
        assert.ok(resumed.includes('Switch back'))
        assert.ok(resumed.includes('Release decisions saved before switching.'))
        assert.ok(resumed.includes('Queued during the switch'))
        assert.ok(resumed.indexOf('Switch back') < resumed.indexOf('Queued during the switch'))
      } finally {
        inscription.release()
        summary.release()
      }

      const previousAgent = s.state().cards[HYDRA_CARD]!.agent!
      const quota = join(
        previousAgent.loginFolder!,
        'quota.json',
      )
      writeFileSync(
        quota,
        JSON.stringify({
          provider: {
            quotaSemantics: {
              effectiveAvailability: [
                {
                  scope: 'all_models',
                  status: 'known',
                  effectivePercentRemaining: 0,
                },
              ],
            },
          },
        }),
      )

      try {
        await page.command({
          name: 'hydra-agent',
          args: [
            JSON.stringify({
              harness: 'codex',
              model: 'gpt-6.1-sol',
            }),
          ],
        })
        await send({
          s,
          text: 'Continue on Codex',
          id: 'codex',
        })
        await until({
          what: 'the provider change choice',
          check: () => s.state().hydraAgentChange?.next.harness === 'codex',
        })
        page.close()
        await pnyx.restart()
        let recovered = await openPage({
          port: pnyx.port(),
          hydraId: s.hydraId,
        })

        try {
          assert.equal(
            s.state().hydraAgentChange?.id,
            'codex',
          )
          const handover = pnyx.codex.plan({
            match: inscribePrompt,
            reply: 'Memory saved.',
            hold: true,
          })
          await recovered.command({
            name: 'hydra-agent-change',
            args: [
              'codex',
              'inscribe',
            ],
          })
          await until({
            what: 'the new agent to inscribe for the agent with no usage left',
            check: () => pnyx.codex.sessions.some(session => session.env.PNYX_HYDRA === s.hydraId
              && session.received.some(text => inscribePrompt({ text }))),
          })
          const inscriber = pnyx.codex.sessions.find(session => session.env.PNYX_HYDRA === s.hydraId
            && session.received.some(text => inscribePrompt({ text })))!
          assert.ok(!inscriber.received[0]!.includes('Conversation context:'))
          const inscribeSession = s.state().cards[HYDRA_CARD]!.agent!.sessionId
          await finishInscribe({
            s,
            agent: inscriber,
          })
          handover.release()
          await until({
            what: 'Codex to receive the resumed queue',
            check: () => pnyx.codex.sessions.some(session => session.env.PNYX_HYDRA === s.hydraId && session.received.some(text => text.includes('Continue on Codex') && text.includes('back after a stop'))),
          })
          assert.ok(pnyx.codex.sessions.some(session => session.env.PNYX_HYDRA === s.hydraId
            && session.received.some(text => summaryPrompt({ text }))))
          assert.notEqual(
            s.state().cards[HYDRA_CARD]?.agent?.sessionId,
            inscribeSession,
          )
          assert.equal(
            s.state().hydraAgent?.harness,
            'codex',
          )
          assert.notEqual(
            s.state().cards[HYDRA_CARD]?.agent?.sessionId,
            previousAgent.sessionId,
          )
          const alternate = s.folder({ name: 'alternate-codex' })
          await s.owner({
            args: [
              'account',
              'set',
              'codex:alternate',
              '--provider',
              'codex',
              '--folder',
              alternate,
            ],
          })
          const beforeAccount = s.state().cards[HYDRA_CARD]!.agent!.sessionId
          await recovered.command({
            name: 'hydra-agent',
            args: [
              JSON.stringify({
                harness: 'codex',
                account: 'codex:alternate',
                model: 'gpt-6.1-sol',
              }),
            ],
          })
          await send({
            s,
            text: 'Use the alternate account',
            id: 'account',
          })
          await until({
            what: 'an account switch choice',
            check: () => s.state().hydraAgentChange?.next.account === 'codex:alternate',
          })
          const compacting = pnyx.codex.plan({
            match: summaryPrompt,
            hold: true,
          })

          try {
            await recovered.command({
              name: 'hydra-agent-change',
              args: [
                'account',
                'compact',
              ],
            })
            await until({
              what: 'the account switch compaction to start',
              check: () => pendingSummary({
                s,
                harness: 'codex',
              }),
            })
            await recovered.command({
              name: 'hydra',
              args: ['stop'],
            })
            await until({
              what: 'the cancelled compaction failure',
              check: () => s.state().hydraAgentChange?.state === 'failed' && !s.state().hydraOperation,
            })
            assert.ok(s.state().hydraMessages?.some(message => message.kind === 'divider' && message.text === 'Compaction failed'))
          } finally {
            compacting.release()
          }

          await until({
            what: 'the failure notice to reach the previous agent',
            check: () => pnyx.codex.sessions.some(session => session.env.PNYX_HYDRA === s.hydraId && session.received.some(text => text.includes('Compaction failed:'))),
          })
          await until({
            what: 'the failure notice turn to finish',
            check: () => s.state().cards[HYDRA_CARD]?.sessionActivity === 'finished' && pnyx.codex.sessions.at(-1)?.answered === 1,
          })
          assert.ok(!pnyx.codex.sessions.some(session => session.env.PNYX_HYDRA === s.hydraId && session.received.some(text => text.includes('Use the alternate account'))))
          const interrupted = pnyx.codex.plan({
            match: summaryPrompt,
            hold: true,
          })

          try {
            await recovered.command({
              name: 'hydra-agent-change',
              args: [
                'account',
                'compact',
              ],
            })
            await until({
              what: 'the retry summary before restart',
              check: () => pendingSummary({
                s,
                harness: 'codex',
              }),
            })
            recovered.close()
            await pnyx.restart()
            recovered = await openPage({
              port: pnyx.port(),
              hydraId: s.hydraId,
            })
            await until({
              what: 'the running switch to recover as a failed choice',
              check: () => s.state().hydraAgentChange?.state === 'failed' && !s.state().hydraOperation,
            })
            await until({
              what: 'the restart failure notice to finish',
              check: () => s.state().cards[HYDRA_CARD]?.sessionActivity === 'finished' && pnyx.codex.sessions.at(-1)?.answered === 1,
            })
            assert.ok(!pnyx.codex.sessions.some(session => session.env.PNYX_HYDRA === s.hydraId && session.received.some(text => text.includes('Use the alternate account'))))
          } finally {
            interrupted.release()
          }

          await recovered.command({
            name: 'hydra-agent-change',
            args: [
              'account',
              'compact',
            ],
          })
          await until({
            what: 'the alternate account to receive its queued message',
            check: () => pnyx.codex.sessions.some(session => session.env.CODEX_HOME === alternate && session.received.some(text => text.includes('Use the alternate account'))),
          })
          assert.notEqual(
            s.state().cards[HYDRA_CARD]?.agent?.sessionId,
            beforeAccount,
          )
          assert.equal(
            s.state().cards[HYDRA_CARD]?.agent?.loginFolder,
            alternate,
          )
        } finally {
          recovered.close()
        }
      } finally {
        unlinkSync(quota)
      }
    } finally {
      first.release()
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
      assert.ok(page.queues.length > 0)
      const queuedWork = page.queues.flatMap(queue => [
        ...queue.waiting,
        ...queue.reading,
      ])
      assert.deepEqual(
        queuedWork,
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
    await page.command({
      name: 'hydra-agent',
      args: [JSON.stringify({ harness: 'codex' })],
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
      await until({
        what: 'the page’s queue to show Hydra working',
        check: () => page.queues.at(-1)?.chat?.working,
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
  'a Hydra with no projects offers built-ins before a session and delivers the selected shipped skill',
  async () => {
    const s = await pnyx.scenario()
    const page = await openPage({
      port: pnyx.port(),
      hydraId: s.hydraId,
    })
    const result = await page.command({
      name: 'catalog',
      args: [HYDRA_CARD],
    })
    assert.ok('catalog' in result)
    const catalog = result.catalog as Catalog
    // The page names Hydra's skills with the receipt's provider, so the server always says which harness receives them.
    assert.equal(
      catalog.provider,
      'claude',
    )
    assert.deepEqual(
      catalog.suggestions.filter(item => item.source === 'Built-in').map(item => [
        item.command,
        item.source,
      ]),
      [
        [
          '/inscribe',
          'Built-in',
        ],
        [
          '/pnyx-set-up',
          'Built-in',
        ],
        [
          '/upgrade',
          'Built-in',
        ],
        [
          '/restart',
          'Built-in',
        ],
        [
          '/add-project',
          'Built-in',
        ],
      ],
    )
    assert.equal(
      s.state().projects,
      undefined,
    )
    const selected = catalog.suggestions.find(item => item.command === '/inscribe')
    assert.ok(selected)
    await s.owner({
      args: [
        'hydra',
        'send',
        '--text',
        skillReference({ item: selected }),
      ],
    })
    const agent = await s.agent({ hydra: true })
    await until({
      what: 'the selected built-in skill to reach Hydra',
      check: () => s.received({ cwd: agent.cwd }).some(text => text.includes(
        `Read and follow the skill "inscribe" at ${JSON.stringify(skillSource({ name: 'inscribe' }))}.`,
      )),
    })
    assert.equal(
      existsSync(join(
        agent.cwd,
        '.agents/skills/inscribe/SKILL.md',
      )),
      true,
    )
    await page.command({
      name: 'hydra-agent',
      args: [JSON.stringify({ harness: 'codex' })],
    })
    const switched = await page.command({
      name: 'catalog',
      args: [HYDRA_CARD],
    })
    assert.ok('catalog' in switched)
    const switchedCatalog = switched.catalog as Catalog
    assert.equal(
      switchedCatalog.provider,
      'codex',
    )
    assert.deepEqual(
      switchedCatalog.suggestions.filter(item => item.source === 'Built-in').map(item => item.command),
      [
        '$inscribe',
        '$pnyx-set-up',
        '/upgrade',
        '/restart',
        '/add-project',
      ],
    )
  },
)

test(
  'the page creates a Hydra once per attempt, renames and reorders the list, and refuses an unknown action or attempt',
  async t => {
    const s = await pnyx.scenario()
    const page = await openPage({
      port: pnyx.port(),
      hydraId: s.hydraId,
    })
    t.after(() => page.close())
    type Listed = {
      hydras: {
        id: string
        name: string
      }[]
    }
    const create = {
      name: 'hydras',
      args: [
        'create',
        'Atlas',
        'atlas-attempt',
      ],
    }
    const first = await page.command(create) as Listed & { creation: { hydraId: string } }
    const atlas = first.creation.hydraId
    const retried = await page.command(create)
    const boreas = (await page.command({
      name: 'hydras',
      args: [
        'create',
        'Boreas',
      ],
    }) as Listed & { url: string }).url.split('/').at(-2)!
    await page.command({
      name: 'hydras',
      args: [
        'edit',
        atlas,
        'Atlas Prime',
      ],
    })
    await page.command({
      name: 'hydras',
      args: [
        'move',
        boreas,
        '1',
      ],
    })
    const moved = await page.command({
      name: 'hydras',
      args: [
        'move',
        atlas,
        '2',
      ],
    }) as Listed
    assert.deepEqual(
      [
        first.creation,
        retried.creation,
        moved.hydras.filter(h => h.id === atlas || h.id === boreas).map(h => [
          h.id,
          h.name,
        ]),
      ],
      [
        {
          attempt: 'atlas-attempt',
          hydraId: atlas,
          status: 'saved',
          mount: 'pending',
        },
        {
          attempt: 'atlas-attempt',
          hydraId: atlas,
          status: 'saved',
          mount: 'pending',
        },
        [
          [
            boreas,
            'Boreas',
          ],
          [
            atlas,
            'Atlas Prime',
          ],
        ],
      ],
    )

    const refusals = [
      await page.refusal({
        name: 'hydras',
        args: ['delete'],
      }),
      await page.refusal({
        name: 'hydras',
        args: [
          'create',
          'Cronus',
          'not an attempt',
        ],
      }),
    ]
    assert.deepEqual(
      refusals.map(refusal => [
        refusal.code,
        refusal.error,
      ]),
      [
        [
          'VALIDATION_ERROR',
          'Hydras expects nothing, open <id>, create <name> [<attempt> <icon>], edit <id> <name> [<icon>] or move <id> <position>',
        ],
        [
          'VALIDATION_ERROR',
          'Invalid Hydra creation attempt',
        ],
      ],
    )
  },
)

test(
  'the Hydra thread keeps what it loaded when an older page arrives, skips unrelated card events, and pushes a newer version when its conversation changes',
  async t => {
    const s = await pnyx.scenario()
    // Long enough to split into more parts than one page holds.
    const plan = 'Every step of the release plan. '.repeat(2100).trimEnd()
    pnyx.claude.plan({
      text: 'Write the whole plan',
      reply: plan,
    })
    await send({
      s,
      text: 'Write the whole plan',
      id: 'plan',
    })
    await finished({
      s,
      turns: 1,
    })
    // A restart drops the streamed copy of the reply, so every page reads the saved transcript.
    await pnyx.restart()
    const page = await openPage({
      port: pnyx.port(),
      hydraId: s.hydraId,
    })
    t.after(() => page.close())

    const latest = (await page.command({
      name: 'thread',
      args: [HYDRA_CARD],
    })).thread as ThreadPage
    const older = (await page.command({
      name: 'thread',
      args: [
        HYDRA_CARD,
        latest.older!,
      ],
    })).thread as ThreadPage
    const conversation = ({ page }: { page: ThreadPage }) => page.conversation!.entries
      .map(entry => ({
        role: entry.role,
        text: entry.text,
      }))
    assert.deepEqual(
      conversation({ page: older }),
      [
        {
          role: 'user',
          text: 'Write the whole plan',
        },
        {
          role: 'assistant',
          text: plan,
        },
      ],
    )

    const renewed = (await page.command({
      name: 'thread',
      args: [HYDRA_CARD],
    })).thread as ThreadPage
    assert.deepEqual(
      conversation({ page: renewed }),
      conversation({ page: older }),
    )
    assert.equal(
      renewed.conversation!.stream,
      older.conversation!.stream,
    )

    const newer = () => page.threads.filter(thread => thread.conversation!.version!
      > older.conversation!.version!)

    // A card Hydra's conversation does not show leaves the thread as it was.
    await s.owner({
      args: [
        'task',
        'create',
        '--title',
        'Ship the plan',
      ],
    })
    await delay(3 * LATEST_DELAY_MS)
    assert.deepEqual(
      newer(),
      [],
    )

    pnyx.claude.plan({
      text: 'Ship it',
      reply: 'Shipping now.',
    })
    await send({
      s,
      text: 'Ship it',
      id: 'ship',
    })
    const pushed = await until({
      what: 'a newer Hydra thread with the new message',
      check: () => newer().find(thread => thread.conversation!.entries
        .some(entry => entry.text === 'Ship it')),
    })
    assert.equal(
      pushed.conversation!.stream,
      older.conversation!.stream,
    )
    assert.deepEqual(
      conversation({ page: pushed }).slice(
        0,
        2,
      ),
      conversation({ page: older }),
    )
    await finished({
      s,
      turns: 2,
    })
    page.close()
    await pnyx.restart()
    const reconnected = await openPage({
      port: pnyx.port(),
      hydraId: s.hydraId,
    })
    t.after(() => reconnected.close())
    const restored = (await reconnected.command({
      name: 'thread',
      args: [
        HYDRA_CARD,
        '--retain',
        JSON.stringify({
          session: older.session,
          oldest: older.entries[0]!.id,
        }),
      ],
    })).thread as ThreadPage
    assert.deepEqual(
      conversation({ page: restored }).slice(
        0,
        2,
      ),
      conversation({ page: older }),
    )
    assert.ok(restored.conversation!.entries.some(entry => entry.text === 'Ship it'))
    assert.notEqual(
      restored.conversation!.stream,
      older.conversation!.stream,
    )
    const refusal = await reconnected.refusal({
      name: 'thread',
      args: [
        HYDRA_CARD,
        '--retain',
        '{}',
      ],
    })
    assert.equal(
      refusal.code,
      'VALIDATION_ERROR',
    )
  },
)
