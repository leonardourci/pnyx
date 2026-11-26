import { taskChildren } from '#app/task-runtime.ts'
import { processStart } from '#app/server-state.ts'
import { once } from 'node:events'
import { spawn, spawnSync } from 'node:child_process'
import { relative } from 'node:path'
import { beforeAll, expect, onTestFinished, test } from 'vitest'
import { startOthrys, until, type Othrys } from './setup/othrys.ts'

const COMPACTION_TEST_DEADLINE_MS = 10_000
let othrys: Othrys

beforeAll(async () => {
  process.env.OTHRYS_HOME = relative(
    process.cwd(),
    process.env.OTHRYS_HOME!,
  )
  othrys = await startOthrys({ compactionDelay: COMPACTION_TEST_DEADLINE_MS })
})

test(
  'a worker with a relative Othrys home writes reports from its own directory',
  async () => {
    const titan = await othrys.titan()
    onTestFinished(async () => {
      await titan.owner({
        args: [
          'titan',
          'remove',
          titan.id,
        ],
      })
    })
    const { worker } = await titan.startTask({ key: 'relative-home' })
    const report = spawnSync(
      process.execPath,
      [
        '-e',
        'require("node:fs").appendFileSync(process.env.OTHRYS_TASK_DIR + "/worker.log", "note: relative home report\\n")',
      ],
      {
        cwd: worker.cwd,
        env: worker.env,
        encoding: 'utf8',
      },
    )
    expect({
      status: report.status,
      stderr: report.stderr,
    }).toEqual({
      status: 0,
      stderr: '',
    })
    await until({
      what: 'the worker report reaches its task from the worker’s directory',
      check: async () => (await titan.task({ key: 'relative-home' })).latest === 'relative home report',
    })
  },
)

test(
  'a detached worker’s retained tools are recovered after restart and stopped on Titan removal',
  async () => {
    const titan = await othrys.titan({
      id: 'default',
      create: false,
    })
    await titan.startTask({ key: 'detached-tools' })
    const task = await titan.task({ key: 'detached-tools' })
    const leader = spawn(
      process.execPath,
      [
        '-e',
        `
    const { spawn } = require('node:child_process')
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
    child.unref()
    process.stdout.write(String(child.pid) + '\\n')
    process.stdin.once('data', () => process.exit(0))
  `,
      ],
      {
        detached: true,
        stdio: [
          'pipe',
          'pipe',
          'ignore',
        ],
      },
    )
    onTestFinished(() => {
      try {
        process.kill(
          -leader.pid!,
          'SIGKILL',
        )
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
          throw error
        }
      }
    })
    let output = ''
    leader.stdout.on(
      'data',
      chunk => {
        output += String(chunk)
      },
    )
    const tool = await until({
      what: 'the detached worker starts a background tool',
      check: () => output.includes('\n') && Number(output.trim()),
    })
    const children = taskChildren({
      titanId: titan.id,
      task: task.id,
    })
    children.spawned({ child: leader })
    children.associate({
      pid: leader.pid!,
      task: task.id,
    })
    await titan.owner({
      args: [
        'task',
        'detach',
        task.id,
      ],
    })
    const exited = once(
      leader,
      'exit',
    )
    leader.stdin.end('exit')
    await exited
    expect(processStart({ pid: tool })).not.toBeNull()
    await othrys.restart()
    expect(processStart({ pid: tool })).not.toBeNull()
    await until({
      what: 'only the target Titan is mounted before permanent removal',
      check: () => {
        const { scopes } = othrys.home()

        return Object.keys(scopes).length === 1 && Boolean(scopes[titan.id])
      },
    })
    await titan.owner({
      args: [
        'titan',
        'remove',
        titan.id,
      ],
    })
    await until({
      what: 'Titan removal stops the recovered background tool',
      check: () => processStart({ pid: tool }) === null,
    })
  },
)

test(
  'a moved silent compaction keeps its deadline and delivers its held input once through another move',
  async () => {
    const source = await othrys.titan()
    const target = await othrys.titan()
    const final = await othrys.titan()
    const { worker } = await source.startTask({ key: 'silent-compaction' })
    const task = await source.task({ key: 'silent-compaction' })
    othrys.claude.plan({
      titan: source.id,
      text: '/compact',
      compacting: true,
    })
    await source.owner({
      args: [
        'reply',
        task.id,
        '--text',
        '/compact',
      ],
    })
    await until({
      what: 'the same session completes its first compaction',
      check: async () => (await source.owner({
        args: [
          'task',
          'show',
          task.id,
          '--full',
        ],
      })).task.compaction?.operations.some((operation: { state: string }) => operation.state === 'done'),
    })
    const held = othrys.claude.plan({
      titan: source.id,
      text: '/compact',
      compacting: true,
      hold: true,
    })
    onTestFinished(() => held.release())
    await source.owner({
      args: [
        'reply',
        task.id,
        '--text',
        '/compact',
      ],
    })
    await until({
      what: 'the original worker starts compaction',
      check: async () => (await source.owner({
        args: [
          'task',
          'show',
          task.id,
          '--full',
        ],
      })).task.compaction?.operations.some((operation: { state: string }) => operation.state === 'running'),
    })
    const text = '/review Resume exactly once after the compaction deadline'
    const output = 'Completed in the final destination after compaction'
    othrys.claude.plan({
      titan: source.id,
      match: ({ text: prompt }) => prompt.includes(text),
      reply: output,
    })
    await source.owner({
      args: [
        'reply',
        task.id,
        '--text',
        text,
      ],
    })
    await until({
      what: 'the message is held by compaction',
      check: async () => (await source.owner({
        args: [
          'task',
          'show',
          task.id,
          '--full',
        ],
      })).task.compaction?.inputs.length === 1,
    })
    await source.owner({
      args: [
        'task',
        'move',
        task.id,
        '--to-titan',
        target.id,
      ],
    })
    await source.owner({
      args: [
        'titan',
        'remove',
        source.id,
      ],
    })
    await target.owner({
      args: [
        'task',
        'move',
        task.id,
        '--to-titan',
        final.id,
      ],
    })
    await target.owner({
      args: [
        'titan',
        'remove',
        target.id,
      ],
    })
    await until({
      what: 'the final destination fails the silent compaction',
      check: async () => (await final.owner({
        args: [
          'task',
          'show',
          task.id,
          '--full',
        ],
      })).task.compaction?.operations.some((operation: {
        state: string
        error?: string
      }) => operation.state === 'failed' && operation.error?.includes('stopped reporting')),
    })
    expect((await final.owner({
      args: [
        'task',
        'show',
        task.id,
        '--full',
      ],
    })).task.agent.sessionId).toBe(worker.id)
    held.release()
    await until({
      what: 'the original worker receives its held input',
      check: () => worker.received.some(message => message.includes(text)),
    })
    await until({
      what: 'the final destination settles the held delivery',
      check: async () => (await final.owner({
        args: [
          'task',
          'show',
          task.id,
          '--full',
        ],
      })).task.compaction?.inputs.length === 0,
    })
    await until({
      what: 'the final destination reads the running worker output',
      check: async () => (await final.owner({
        args: [
          'task',
          'chat',
          task.id,
        ],
      })).thread.entries.some((entry: { text?: string }) => entry.text === output),
    })
    const cancellation = new AbortController()
    onTestFinished(() => cancellation.abort())
    const question = worker.useTool!({
      tool: 'AskUserQuestion',
      input: {
        questions: [
          {
            question: 'Should I finish in the destination?',
            header: 'Destination',
            options: [
              {
                label: 'Continue',
                description: 'Finish here',
              },
              {
                label: 'Stop',
                description: 'Pause here',
              },
            ],
            multiSelect: false,
          },
        ],
      },
      signal: cancellation.signal,
    })
    const request = await until({
      what: 'the final destination receives the running worker question',
      check: async () => (await final.owner({
        args: [
          'task',
          'show',
          task.id,
          '--full',
        ],
      })).task.permissions?.find((request: {
        status: string
        questions?: { question: string }[]
      }) => request.status === 'pending' && request.questions?.some(question => question.question === 'Should I finish in the destination?')),
    })
    await final.owner({
      args: [
        'task',
        'permission',
        task.id,
        request.id,
        'deny',
        '--reason',
        'The destination received the question',
      ],
    })
    expect(await question).toMatchObject({ behavior: 'deny' })
    await until({
      what: 'neither source Titan retains the moved task or questions',
      check: () => !othrys.home().scopes[source.id] && !othrys.home().scopes[target.id],
    })
    expect((await final.owner({
      args: [
        'task',
        'show',
        task.id,
        '--full',
      ],
    })).task.agent.sessionId).toBe(worker.id)
    expect(worker.received.filter(message => message.includes(text))).toHaveLength(1)
    expect(worker.closed).toBe(false)
    await final.owner({
      args: [
        'titan',
        'remove',
        final.id,
      ],
    })
  },
)
