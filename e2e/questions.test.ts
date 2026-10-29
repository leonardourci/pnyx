import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { openDecisions } from '#tasks/decisions.ts'
import { openPage, until } from '#test-harness/harness.ts'
import { pnyx } from '#test-harness/pnyx.ts'
import { cardQuestion } from '#tasks/questions.ts'
import { cardStatus, statusLabel } from '#tasks/card-status.ts'

test(
  'a worker’s permission request waits on its task in Needs you until Hydra or the owner decides it once, the worker gets that decision and its answers, a Codex worker’s turn permissions grant only what it asked, and a restart expires what was left waiting',
  async () => {
    const s = await pnyx.scenario()
    const folder = s.folder({ name: 'service' })
    const hydraAgent = await s.chat({ text: 'Clean up the service build.' })
    const hydra = s.as({ agent: hydraAgent })
    await hydra.run({
      args: [
        'task',
        'create',
        '--title',
        'Clean the build',
        '--key',
        'clean',
        '--folder',
        folder,
        '--reason',
        'the owner asked for it',
      ],
    })
    await hydra.run({
      args: [
        'task',
        'start',
        'clean',
        '--reason',
        'the owner asked for it',
      ],
    })
    const agent = await s.agent({ cwd: folder })
    await until({
      what: 'the worker to finish its opening turn',
      check: () => s.task({ key: 'clean' }).sessionActivity === 'finished',
    })
    const pending = () => until({
      what: 'a pending permission request',
      check: () => s.task({ key: 'clean' }).permissions?.find(r => r.status === 'pending'),
    })

    const heard = hydraAgent.received.length
    const bash = agent.useTool!({
      tool: 'Bash',
      input: {
        command: 'rm -rf build',
        description: 'Remove the build folder',
      },
    })
    const request = await pending()
    assert.deepEqual(
      [
        request.tool,
        request.input,
        s.task({ key: 'clean' }).column,
      ],
      [
        'Bash',
        {
          command: 'rm -rf build',
          description: 'Remove the build folder',
        },
        s.column({ role: 'needs_you' }),
      ],
    )
    assert.equal(
      cardQuestion({ card: s.task({ key: 'clean' }) })?.permission?.id,
      request.id,
    )
    await until({
      what: 'the request to wake Hydra',
      check: () => hydraAgent.received.slice(heard).some(text => text.startsWith('<pnyx-wake>')),
    })
    assert.match(
      await hydra.run({
        args: [
          'hydra',
          'check',
          '--after',
          '0',
        ],
      }),
      new RegExp(request.id),
    )
    assert.equal(
      await hydra.refused({
        args: [
          'task',
          'permission',
          'clean',
          request.id,
          'allow',
        ],
      }),
      'VALIDATION_ERROR',
    )
    await hydra.run({
      args: [
        'task',
        'permission',
        'clean',
        request.id,
        'allow',
        '--reason',
        'it only removes build output',
      ],
    })
    assert.deepEqual(
      await bash,
      { behavior: 'allow' },
    )
    assert.deepEqual(
      [
        await s.ownerRefusal({
          args: [
            'task',
            'permission',
            'clean',
            request.id,
            'deny',
          ],
        }),
        s.task({ key: 'clean' }).permissions?.find(r => r.id === request.id)?.status,
        s.task({ key: 'clean' }).column,
      ],
      [
        {
          code: 'PERMISSION_CLOSED',
          error: 'permission request is already allow',
        },
        'allow',
        s.column({ role: 'in_progress' }),
      ],
    )

    const question = {
      question: 'Which database should the cache use?',
      header: 'Cache',
      multiSelect: false,
      options: [
        {
          label: 'Postgres',
          description: 'The existing database',
        },
        {
          label: 'SQLite',
          description: 'A local file',
        },
      ],
    }
    const asked = agent.useTool!({
      tool: 'AskUserQuestion',
      input: { questions: [question] },
    })
    const ask = await pending()
    await s.owner({
      args: [
        'task',
        'permission',
        'clean',
        ask.id,
        'allow',
        '--answer',
        JSON.stringify({ answers: [{ pick: [2] }] }),
      ],
    })
    assert.deepEqual(
      await asked,
      {
        behavior: 'allow',
        updatedInput: {
          questions: [question],
          answers: { [question.question]: 'SQLite' },
        },
      },
    )

    const write = agent.useTool!({
      tool: 'Write',
      input: {
        file_path: '/etc/hosts',
        content: '',
      },
    })
    const left = await pending()
    await s.owner({
      args: [
        'task',
        'permission',
        'clean',
        left.id,
        'deny',
        '--reason',
        'outside the task',
      ],
    })
    assert.equal(
      (await write)?.behavior,
      'deny',
    )

    // A Codex worker asks for turn permissions: allowing grants only what it requested, for this turn,
    // and a denial grants nothing.
    const network = s.folder({ name: 'network' })
    await s.owner({
      args: [
        'task',
        'create',
        '--title',
        'Fetch the schema',
        '--key',
        'fetch',
        '--folder',
        network,
      ],
    })
    await s.owner({
      args: [
        'task',
        'start',
        'fetch',
        '--harness',
        'codex',
      ],
    })
    const codex = await s.agent({ cwd: network })

    for (const choice of [
      'allow',
      'deny',
    ]) {
      const asked = codex.ask!({
        method: 'item/permissions/requestApproval',
        params: {
          permissions: {
            network: { enabled: true },
            fileSystem: null,
          },
        },
      })
      const turn = await until({
        what: `the ${choice} turn permission request`,
        check: () => s.task({ key: 'fetch' }).permissions?.find(r => r.status === 'pending'),
      })
      assert.deepEqual(
        [
          turn.tool,
          turn.input.scope,
        ],
        [
          'Turn permissions',
          'turn',
        ],
      )
      await s.owner({
        args: [
          'task',
          'permission',
          'fetch',
          turn.id,
          choice,
        ],
      })
      assert.deepEqual(
        await asked,
        {
          permissions: choice === 'allow' ? { network: { enabled: true } } : {},
          scope: 'turn',
        },
      )
    }

    const later = agent.useTool!({
      tool: 'Bash',
      input: { command: 'make release' },
    })
    const waiting = await pending()
    await pnyx.restart()
    assert.deepEqual(
      [
        await later,
        s.task({ key: 'clean' }).permissions?.find(r => r.id === waiting.id)?.status,
      ],
      [
        {
          behavior: 'deny',
          message: 'This permission request expired.',
        },
        'expired',
      ],
    )
    assert.equal(
      await s.ownerRefused({
        args: [
          'task',
          'permission',
          'clean',
          waiting.id,
          'allow',
        ],
      }),
      'PERMISSION_CLOSED',
    )
    const worker = s.as({ agent })
    await worker.run({
      args: [
        'task',
        'status',
        'clean',
        'needs_you',
        '--note',
        'Retain historical cache entries?',
      ],
    })
    await worker.run({
      args: [
        'task',
        'ask',
        'clean',
        '--question',
        'Retain historical cache entries?',
      ],
    })
    const retention = s.task({ key: 'clean' }).asks!.at(-1)!
    await hydra.run({
      args: [
        'task',
        'escalate',
        'clean',
        retention.id,
        '--reason',
        'the owner sets retention',
      ],
    })
    let page = await openPage({
      port: pnyx.port(),
      hydraId: s.hydraId,
    })
    const taskId = s.task({ key: 'clean' }).id
    await page.shows({
      what: 'the question on the closed card',
      check: ({ state }) => cardQuestion({ card: state.cards[taskId]! })?.text
        === 'Retain historical cache entries?',
    })
    page.close()
    await pnyx.restart({
      whileStopped: async () => {
        await s.owner({
          args: [
            'task',
            'answer',
            'clean',
            retention.id,
            '--text',
            'Retain for 30 days.',
          ],
        })
      },
    })
    page = await openPage({
      port: pnyx.port(),
      hydraId: s.hydraId,
    })
    await page.shows({
      what: 'the saved answer with failed delivery after reconnecting',
      check: ({ state }) => cardQuestion({ card: state.cards[taskId]! })?.delivery?.state === 'failed',
    })
    assert.equal(
      cardQuestion({ card: s.task({ key: 'clean' }) })?.delivery?.decision?.answer,
      'Retain for 30 days.',
    )
    assert.equal(
      statusLabel({ status: cardStatus({ card: s.task({ key: 'clean' }) }) }),
      'Answer not sent',
    )
    await s.owner({
      args: [
        'task',
        'answer',
        'clean',
        retention.id,
        '--text',
        'Retain for 30 days.',
      ],
    })
    const answeredCard = await page.shows({
      what: 'the delivered answer on the page',
      check: ({ state }) => !!state.cards[taskId]?.asks
        ?.find(ask => ask.id === retention.id)?.answered && state.cards[taskId],
    })
    assert.equal(
      cardQuestion({ card: answeredCard! }),
      undefined,
    )
    assert.equal(
      s.task({ key: 'clean' }).status?.state,
      'needs_you',
    )
    page.close()
    await pnyx.restart()
    page = await openPage({
      port: pnyx.port(),
      hydraId: s.hydraId,
    })
    await page.shows({
      what: 'the answered question to stay absent after restart',
      check: ({ state }) => cardQuestion({ card: state.cards[taskId]! }) === undefined,
    })
    page.close()
  },
)

test(
  'a report choice survives completion, origin hiding and restart, only the owner answers it, and the answer is recorded',
  async () => {
    const s = await pnyx.scenario()
    const folder = s.folder({ name: 'research' })
    await s.owner({
      args: [
        'task',
        'create',
        '--key',
        'report',
        '--title',
        'Cache investigation',
        '--kind',
        'investigation',
        '--folder',
        folder,
      ],
    })
    await s.owner({
      args: [
        'task',
        'start',
        'report',
      ],
    })
    const worker = s.as({ agent: await s.agent({ cwd: folder }) })
    const file = join(
      folder,
      'report.md',
    )
    writeFileSync(
      file,
      'The cache is slow. The owner must choose whether to retain historical entries.',
    )
    await worker.run({
      args: [
        'task',
        'report',
        'report',
        '--file',
        file,
      ],
    })
    const report = s.task({ key: 'report' }).report!
    assert.match(
      await s.owner({
        args: [
          'task',
          'report',
          'report',
        ],
      }),
      /The cache is slow/,
      'the stored report reads back',
    )
    assert.equal(
      await worker.refused({
        args: [
          'task',
          'ask',
          'report',
          '--from-report',
          'report',
          '--question',
          'Worker cannot link a Hydra question',
        ],
      }),
      'VALIDATION_ERROR',
    )
    assert.equal(
      await worker.refused({
        args: [
          'task',
          'status',
          'report',
          'done',
        ],
      }),
      'NOT_LANDED',
    )
    assert.equal(
      await s.ownerRefused({
        args: [
          'task',
          'hide',
          'report',
        ],
      }),
      'REPORT_REVIEW_REQUIRED',
    )
    const doneColumn = s.column({ role: 'done' })
    assert.ok(doneColumn)
    assert.equal(
      await s.ownerRefused({
        args: [
          'move',
          'report',
          doneColumn,
        ],
      }),
      'REPORT_REVIEW_REQUIRED',
    )
    assert.equal(
      await s.ownerRefused({
        args: [
          'outcome',
          'report',
          'done',
        ],
      }),
      'REPORT_REVIEW_REQUIRED',
    )
    assert.equal(
      await s.ownerRefused({
        args: [
          'task',
          'build',
          'report',
        ],
      }),
      'REPORT_REVIEW_REQUIRED',
    )
    await s.owner({
      args: [
        'task',
        'create',
        '--key',
        'cache',
        '--title',
        'Fix cache retention',
      ],
    })
    const hydra = s.as({ agent: await s.chat({ text: 'Review the cache report and ask about retention.' }) })
    await hydra.run({
      args: [
        'task',
        'ask',
        'cache',
        '--from-report',
        'report',
        '--question',
        'Retain historical cache entries?',
        '--choice',
        'Retain',
        '--choice',
        'Remove',
      ],
    })
    const ask = s.task({ key: 'cache' }).asks![0]!
    const call = `${s.task({ key: 'cache' }).id}/${ask.id}`
    assert.deepEqual(
      ask.origin,
      {
        task: s.task({ key: 'report' }).id,
        report: report.id,
      },
    )
    assert.equal(
      await worker.refused({
        args: [
          'task',
          'report-review',
          'report',
          '--report',
          report.id,
          '--none',
        ],
      }),
      'VALIDATION_ERROR',
    )
    assert.equal(
      await worker.refused({
        args: [
          'task',
          'report-review',
          'report',
          '--report',
          report.id,
          '--call',
          `${s.task({ key: 'cache' }).id}/missing`,
        ],
      }),
      'VALIDATION_ERROR',
    )
    await worker.run({
      args: [
        'task',
        'report-review',
        'report',
        '--report',
        report.id,
        '--call',
        call,
      ],
    })
    const count = s.events().filter(event => event.type === 'task.report-reviewed').length
    await worker.run({
      args: [
        'task',
        'report-review',
        'report',
        '--report',
        report.id,
        '--call',
        call,
      ],
    })
    assert.equal(
      s.events().filter(event => event.type === 'task.report-reviewed').length,
      count,
    )
    await worker.run({
      args: [
        'task',
        'status',
        'report',
        'done',
      ],
    })
    await s.owner({
      args: [
        'task',
        'hide',
        'report',
      ],
    })
    assert.equal(
      await s.ownerRefused({
        args: [
          'task',
          'hide',
          'cache',
        ],
      }),
      'OWNER_DECISION_PENDING',
    )
    assert.equal(
      s.task({ key: 'cache' }).column,
      s.column({ role: 'needs_you' }),
    )
    assert.equal(
      openDecisions({ state: s.state() }).filter(item => item.id === ask.id).length,
      1,
    )
    await pnyx.restart()
    await s.owner({
      args: [
        'task',
        'rename',
        'cache',
        '--title',
        'Cache work after restart',
      ],
    })
    // The restarted server still offers the owner the retained report choice.
    const page = await openPage({
      port: pnyx.port(),
      hydraId: s.hydraId,
    })
    await page.shows({
      what: 'the same choice after restart',
      check: ({ state }) => openDecisions({ state }).some(item => item.id === ask.id)
        && state.cards[s.task({ key: 'cache' }).id]?.title === 'Cache work after restart',
    })
    assert.equal(
      s.task({ key: 'cache' }).asks![0]!.closed,
      undefined,
    )
    assert.equal(
      await hydra.refused({
        args: [
          'task',
          'answer',
          'cache',
          ask.id,
          '--text',
          'Approved',
          '--reason',
          'recommended default',
        ],
      }),
      'OWNER_ONLY',
    )
    const answer = 'Retain existing history; only expire new entries after 30 days.'
    await s.owner({
      args: [
        'task',
        'answer',
        'cache',
        ask.id,
        '--text',
        answer,
      ],
    })
    await page.shows({
      what: 'the answered choice to leave the open decisions',
      check: ({ state }) => !openDecisions({ state }).some(item => item.id === ask.id),
    })
    page.close()
    const decision = s.state().hydraMessages!.find(message => message.answers === ask.id)!
    assert.equal(
      decision.text,
      answer,
    )
    assert.ok(s.task({ key: 'cache' }).asks![0]!.answered)
    assert.notEqual(
      s.task({ key: 'cache' }).column,
      s.column({ role: 'done' }),
    )
    assert.notEqual(
      s.task({ key: 'cache' }).column,
      s.column({ role: 'needs_you' }),
    )
    assert.equal(
      s.task({ key: 'cache' }).status?.state === 'done',
      false,
    )
    assert.equal(
      s.task({ key: 'cache' }).copy,
      undefined,
    )
  },
)
