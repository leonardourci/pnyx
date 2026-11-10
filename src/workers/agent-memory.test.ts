import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { once } from 'node:events'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'
import { closeLogs, logsDir, openLogs, setLogMode } from '#app/diagnostics.ts'
import { logAgentMemory, treeMemory, watchAgent } from './agent-memory.ts'

const run = promisify(execFile)

const listing = async ({ args }: { args: string[] }) => (await run(
  'ps',
  args,
  { encoding: 'utf8' },
)).stdout

const lines = () => readdirSync(logsDir()).flatMap(name => readFileSync(
  join(
    logsDir(),
    name,
  ),
  'utf8',
).split('\n'))
  .filter(Boolean)
  .map(text => JSON.parse(text) as Record<string, unknown>)
  .filter(line => line.operation === 'agent.memory')

test(
  'an agent’s memory is its whole process tree’s, read from one listing',
  () => {
    const listing = [
      '    1     0  1000',
      '  200     1  4000',
      '  201   200  3000',
      '  202   201  2000',
      '  300     1  9000',
      'not a row',
    ].join('\n')
    assert.deepEqual(
      [
        ...treeMemory({
          listing,
          roots: [
            200,
            300,
            404,
          ],
        }),
      ],
      [
        [
          200,
          9000 * 1024,
        ],
        [
          300,
          9000 * 1024,
        ],
      ],
    )
  },
)

test(
  'every 30 seconds one line lists each agent the server runs with its ids and its tree’s memory, and Detailed reads one agent around its turn',
  async t => {
    openLogs()
    // An agent that started a tool of its own, as Claude Code or Codex would.
    const agent = spawn(
      process.execPath,
      [
        '-e',
        'require(\'node:child_process\').spawn(process.execPath, [\'-e\', \'setInterval(() => {}, 1000)\'], { stdio: \'ignore\' }); setInterval(() => {}, 1000)',
      ],
      {
        stdio: 'ignore',
        // Its own process group, as Pnyx starts agents, so stopping it stops its tool too.
        detached: true,
      },
    )

    const stop = () => {
      try {
        process.kill(
          -agent.pid!,
          'SIGKILL',
        )
      } catch { /* already gone */ }
    }

    t.after(() => {
      closeLogs()
      stop()
    })
    watchAgent({
      child: agent,
      ids: {
        hydraId: 'lab',
        taskId: 'first',
        sessionId: 'codex:thread',
      },
    })

    // Waits until the agent started its tool.
    for (let tries = 0; !(await listing({
      args: [
        '-A',
        '-o',
        'ppid=',
      ],
    })).split('\n').some(row => Number(row) === agent.pid); tries += 1) {
      assert.ok(
        tries < 100,
        'the agent started its tool',
      )
      await delay(50)
    }

    await logAgentMemory()
    await logAgentMemory({
      sessionId: 'codex:thread',
      name: 'turn.start',
    })
    setLogMode({ mode: 'detailed' })
    await logAgentMemory({
      sessionId: 'codex:thread',
      name: 'turn.end',
    })
    setLogMode({ mode: 'on' })
    const [
      sample,
      turn,
    ] = lines()
    assert.equal(
      lines().length,
      2,
      'On reads no agent around its turn',
    )
    const listed = sample?.agents as Record<string, unknown>[]
    assert.deepEqual(
      listed.map(agent => ({
        hydraId: agent.hydraId,
        taskId: agent.taskId,
        sessionId: agent.sessionId,
      })),
      [
        {
          hydraId: 'lab',
          taskId: 'first',
          sessionId: 'codex:thread',
        },
      ],
    )
    const own = await listing({
      args: [
        '-o',
        'rss=',
        '-p',
        String(agent.pid),
      ],
    })
    assert.ok(
      Number(listed[0]?.rss) > Number(own.trim()) * 1024,
      'the tree counts the tool the agent started',
    )
    assert.equal(
      typeof sample?.ms,
      'number',
    )
    assert.equal(
      turn?.name,
      'turn.end',
    )

    stop()
    await once(
      agent,
      'exit',
    )
    await logAgentMemory()
    assert.equal(
      lines().length,
      2,
      'an agent that exited is no longer listed',
    )
  },
)
