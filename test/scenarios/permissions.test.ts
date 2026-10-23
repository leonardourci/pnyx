import assert from 'node:assert/strict'
import { test } from 'node:test'
import { scenarioGroup, until } from './harness.ts'

const pnyx = scenarioGroup()

test(
  'a worker’s permission request waits on its task in Needs you until Hydra or the owner decides it once, the worker gets that decision and its answers, and a restart expires what was left waiting',
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
  },
)
