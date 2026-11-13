import assert from 'node:assert/strict'
import { appendFileSync, existsSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { HYDRA_CARD } from '#hydra/identity.ts'
import { logLines, openPage, until } from '#test-harness/harness.ts'
import { pnyx } from '#test-harness/pnyx.ts'

const DAY_MS = 24 * 60 * 60 * 1000

const logsDir = () => join(
  process.env.PNYX_HOME!,
  'logs',
)

// Fixed when the flows load, so a flow that runs across UTC midnight still names the same files.
const loaded = Date.now()

const dayFile = ({ daysAgo }: { daysAgo: number }) => join(
  logsDir(),
  `${new Date(loaded - daysAgo * DAY_MS).toISOString()
    .slice(
      0,
      10,
    )}.jsonl`,
)

test(
  'each action leaves one timestamped line with its duration and memory; Off keeps only warnings and errors, Detailed adds live lines, and page lines arrive marked as the page’s',
  async t => {
    const s = await pnyx.scenario()
    const page = await openPage({
      port: pnyx.port(),
      hydraId: s.hydraId,
    })
    t.after(async () => {
      page.close()
      await s.owner({
        args: [
          'settings',
          'set',
          '--json',
          '{"logs":"on"}',
        ],
      })
    })
    const mine = ({ operation }: { operation: string }) => logLines()
      .filter(line => line.operation === operation && line.hydraId === s.hydraId)

    const seqBefore = s.state().seq
    await page.command({
      name: 'task',
      args: [
        'create',
        '--title',
        'Logged ✓ in 日本語',
        '--key',
        'logged',
      ],
    })
    const pageCommand = mine({ operation: 'command.page' }).find(line => line.name === 'task create')
    assert.ok(
      pageCommand,
      'a page command writes its line before its receipt',
    )
    assert.equal(
      pageCommand.source,
      'server',
    )
    assert.equal(
      pageCommand.status,
      'ok',
    )
    assert.equal(
      typeof pageCommand.ms,
      'number',
    )
    assert.equal(
      typeof pageCommand.rss,
      'number',
    )
    assert.ok(Number.isFinite(Date.parse(String(pageCommand.at))))
    assert.equal(
      mine({ operation: 'socket.send' }).length,
      0,
      'On writes no line for the live updates the page got',
    )
    const mounted = mine({ operation: 'hydra.open' })[0]
    assert.equal(
      typeof mounted?.ms,
      'number',
      'loading the Hydra has its line',
    )
    await page.refusal({
      name: 'task',
      args: [
        'show',
        'no-such-task',
      ],
    })
    const refusedCommand = mine({ operation: 'command.page' }).find(line => line.name === 'task show')
    assert.equal(
      refusedCommand?.status,
      'error',
    )
    assert.equal(
      typeof refusedCommand?.code,
      'string',
    )
    const created = mine({ operation: 'events.write' }).find(line => line.name === 'task.created')
    assert.ok(
      created,
      'the event-log write has its line',
    )
    assert.equal(
      typeof created.eventSeq,
      'number',
    )
    const appended = mine({ operation: 'events.write' })
      .filter(line => Number(line.eventSeq) > seqBefore)
      .reduce(
        (
          sum,
          line,
        ) => sum + Number(line.count),
        0,
      )
    assert.equal(
      appended,
      s.events().filter(event => event.seq > seqBefore).length,
      'event-log lines count the events they write',
    )

    await s.owner({
      args: [
        'task',
        'show',
        'logged',
      ],
    })
    const cli = await until({
      what: 'the CLI command line',
      check: () => mine({ operation: 'command.cli' }).find(line => line.name === 'task show'),
    })
    assert.equal(
      cli.exitCode,
      0,
    )
    assert.equal(
      typeof cli.ms,
      'number',
    )
    assert.equal(
      cli.actor,
      'cli',
      'a command from the owner’s terminal is the CLI’s',
    )

    page.log({
      lines: [
        {
          operation: 'page.slow-frame',
          ageMs: 0,
          tab: 'tab-one',
          hydraId: s.hydraId,
          ms: 120,
          blockingMs: 70,
          script: 'WebSocket.onmessage',
        },
        {
          operation: 'page.long-task',
          // Queued an hour ago on the page's clock, while its socket was down.
          ageMs: 60 * 60 * 1000,
          hydraId: s.hydraId,
          ms: 80,
        },
        { operation: 'not a page line' },
      ],
    })
    const frame = await until({
      what: 'the page line',
      check: () => mine({ operation: 'page.slow-frame' })[0],
    })
    assert.deepEqual(
      [
        frame.source,
        frame.tab,
        frame.ms,
        frame.blockingMs,
        frame.script,
        frame.pid,
        frame.rss,
      ],
      [
        'web',
        'tab-one',
        120,
        70,
        'WebSocket.onmessage',
        undefined,
        undefined,
      ],
    )
    const refusedLines = () => logLines().filter(line => line.operation === 'page.lines-refused')
    await until({
      what: 'the refused page line counted as a warning',
      check: () => refusedLines().some(line => line.level === 'warn' && line.count === 1),
    })
    const queued = mine({ operation: 'page.long-task' })[0]
    assert.ok(
      Math.abs(Date.parse(String(queued?.at)) - (Date.now() - 60 * 60 * 1000)) < 60_000,
      'a line that waited an hour on the page is placed an hour back',
    )
    page.log({
      lines: Array.from(
        { length: 101 },
        () => ({
          operation: 'page.long-task',
          hydraId: s.hydraId,
          ms: 51,
        }),
      ),
    })
    await until({
      what: 'the lines past one message’s limit counted as refused',
      check: () => refusedLines().filter(line => line.count === 1).length === 2,
    })
    assert.equal(
      mine({ operation: 'page.long-task' }).filter(line => line.ms === 51).length,
      100,
    )

    await s.owner({
      args: [
        'settings',
        'set',
        '--json',
        '{"logs":"off"}',
      ],
    })
    await until({
      what: 'logging off on the page',
      check: () => page.settings()?.logs === 'off',
    })
    const quietBefore = mine({ operation: 'command.page' }).length
    await page.command({
      name: 'task',
      args: [
        'create',
        '--title',
        'Quiet',
        '--key',
        'quiet',
      ],
    })
    assert.equal(
      mine({ operation: 'command.page' }).length,
      quietBefore,
      'Off writes no line for an action',
    )
    const warningsBefore = refusedLines().length
    page.log({
      lines: [
        {
          operation: 'page.slow-frame',
          hydraId: s.hydraId,
          ms: 99,
        },
        {
          operation: 'page.error',
          level: 'error',
          hydraId: s.hydraId,
          error: {
            name: 'TypeError',
            message: 'synthetic page failure',
            stack: 'TypeError: synthetic page failure\n    at page',
          },
        },
        { operation: 'still not a page line' },
      ],
    })
    await until({
      what: 'a warning written while logging is off',
      check: () => refusedLines().length > warningsBefore,
    })
    assert.equal(
      mine({ operation: 'page.slow-frame' }).filter(line => line.ms === 99).length,
      0,
      'Off drops a page’s action lines',
    )
    const pageError = mine({ operation: 'page.error' })[0]
    assert.deepEqual(
      [
        pageError?.level,
        pageError?.source,
        pageError?.error?.name,
        pageError?.error?.message,
        pageError?.error?.stack,
      ],
      [
        'error',
        'web',
        'TypeError',
        'synthetic page failure',
        'TypeError: synthetic page failure\n    at page',
      ],
    )

    await s.owner({
      args: [
        'settings',
        'set',
        '--json',
        '{"logs":"detailed"}',
      ],
    })
    await until({
      what: 'detailed logging on the page',
      check: () => page.settings()?.logs === 'detailed',
    })
    await page.command({
      name: 'task',
      args: [
        'create',
        '--title',
        'Detailed',
        '--key',
        'detailed',
      ],
    })
    const live = await until({
      what: 'a detailed line for each live update the page gets',
      check: () => mine({ operation: 'socket.send' }).find(line => line.name === 'receipt'),
    })
    assert.ok(Number(live.bytes) > 0)
    assert.equal(
      typeof live.backlog,
      'number',
    )
    assert.deepEqual(
      [
        live.detailed,
        live.pid,
        live.rss,
      ],
      [
        undefined,
        undefined,
        undefined,
      ],
      'a detailed line leaves out what the lines around it say',
    )
    assert.ok(
      mine({ operation: 'command.page' }).length > quietBefore,
      'Detailed keeps the action lines',
    )

    await s.chat({ text: 'Say hello' })
    const opened = await until({
      what: 'the line for Hydra’s session opening',
      check: () => mine({ operation: 'session.open' })[0],
    })
    assert.equal(
      typeof opened.ms,
      'number',
    )
    const turn = await until({
      what: 'the line for Hydra’s turn ending',
      check: () => mine({ operation: 'turn.end' })[0],
    })
    assert.equal(
      turn.status,
      'completed',
    )
    assert.equal(
      typeof turn.ms,
      'number',
    )
    // The chat open on the page, so the next turn's text reaches it as live thread pages.
    await page.command({
      name: 'thread',
      args: [HYDRA_CARD],
    })
    await s.chat({ text: 'Say hello again' })
    await until({
      what: 'the second turn ending',
      check: () => mine({ operation: 'turn.end' }).length === 2,
    })
    await s.project({ name: 'logged' })
    const reading = new Date().toISOString()
    await s.owner({
      args: [
        'project',
        'memory',
        '--project',
        'logged',
      ],
    })
    const seen = new Set(logLines().filter(line => line.hydraId === s.hydraId)
      .map(line => line.operation))
    assert.deepEqual(
      [
        'command.cli',
        'command.page',
        'events.write',
        'history.read',
        'hydra.open',
        'message.taken',
        'session.open',
        'socket.send',
        'thread.page',
        'turn.end',
        'turn.start',
      ].filter(operation => !seen.has(operation)),
      [],
      'commands, a chat turn and its live thread on an open page write each of their actions’ lines',
    )
    assert.ok(
      logLines().some(line => line.operation === 'exec' && String(line.at) >= reading
        && /^git [a-z-]+$/.test(String(line.name))),
      'reading a project runs git, logged by its subcommand',
    )
  },
)

test(
  'the server keeps the configured days and size cap, deleting the oldest days first, and logs clean deletes every file now',
  async t => {
    const s = await pnyx.scenario()
    t.after(() => s.owner({
      args: [
        'settings',
        'set',
        '--json',
        '{"logDays":7,"logMaxMB":500}',
      ],
    }))
    // Starts from an empty folder, so today's file holds only this flow's few lines.
    await s.owner({
      args: [
        'logs',
        'clean',
      ],
    })
    await s.owner({
      args: [
        'task',
        'create',
        '--title',
        'Today',
        '--key',
        'today',
      ],
    })
    const today = dayFile({ daysAgo: 0 })
    // Today's file survived when the line written before the cleanups is still in it.
    const todayKept = () => logLines().some(line => line.operation === 'command.cli' && line.name === 'task create')
    writeFileSync(
      dayFile({ daysAgo: 30 }),
      '{"v":1}\n',
    )
    writeFileSync(
      dayFile({ daysAgo: 2 }),
      '{"v":1}\n',
    )
    writeFileSync(
      dayFile({ daysAgo: 1 }),
      `${'x'.repeat(1536 * 1024)}\n`,
    )

    await s.owner({
      args: [
        'settings',
        'set',
        '--json',
        '{"logDays":2}',
      ],
    })
    await until({
      what: 'days past the kept ones deleted',
      check: () => !existsSync(dayFile({ daysAgo: 30 })) && !existsSync(dayFile({ daysAgo: 2 })),
    })
    assert.ok(
      existsSync(dayFile({ daysAgo: 1 })),
      'yesterday is within two days',
    )
    assert.ok(
      todayKept(),
      'today is within two days',
    )

    await s.owner({
      args: [
        'settings',
        'set',
        '--json',
        '{"logMaxMB":1}',
      ],
    })
    await until({
      what: 'the oldest day deleted to fit the size cap',
      check: () => !existsSync(dayFile({ daysAgo: 1 })),
    })
    assert.ok(
      todayKept(),
      'today fits in the cap, so it stays',
    )

    for (const refused of [
      '{"logDays":0}',
      '{"logMaxMB":0}',
      '{"logs":"loud"}',
    ]) {
      assert.equal(
        await s.ownerRefused({
          args: [
            'settings',
            'set',
            '--json',
            refused,
          ],
        }),
        'VALIDATION_ERROR',
        refused,
      )
    }

    // Today's own file past the cap stays, and takes only warnings and errors until the day ends.
    const page = await openPage({
      port: pnyx.port(),
      hydraId: s.hydraId,
    })
    t.after(() => page.close())
    appendFileSync(
      today,
      `${'x'.repeat(1536 * 1024)}\n`,
    )
    await s.owner({
      args: [
        'settings',
        'set',
        '--json',
        '{"logDays":1}',
      ],
    })
    await until({
      what: 'the warning that today passed the cap',
      check: () => logLines().some(line => line.level === 'warn' && line.operation === 'logs.full'),
    })
    assert.ok(
      todayKept(),
      'today stays past the cap',
    )
    const actionLines = () => logLines().filter(line => line.operation === 'command.cli').length
    const actionsBefore = actionLines()
    await s.owner({
      args: [
        'task',
        'show',
        'today',
      ],
    })
    assert.equal(
      actionLines(),
      actionsBefore,
      'past the cap today takes no action line',
    )
    page.log({ lines: [{ operation: 'past the cap' }] })
    await until({
      what: 'a warning still written past the cap',
      check: () => logLines().some(line => line.level === 'warn' && line.operation === 'page.lines-refused'),
    })

    const shown = await s.owner({ args: ['logs'] })
    assert.match(
      shown,
      /logDays: 1\nlogMaxMB: 1\n/,
    )
    assert.match(
      shown,
      new RegExp(`files\\[1\\]\\{day,size\\}:\\n {2}${today.slice(
        -16,
        -6,
      )},`),
    )
    const cleaned = await s.owner({
      args: [
        'logs',
        'clean',
      ],
    })
    assert.match(
      cleaned,
      /deleted: 1 file\n/,
    )
    assert.equal(
      todayKept(),
      false,
      'logs clean deleted the lines written before it',
    )
    await s.owner({
      args: [
        'task',
        'show',
        'today',
      ],
    })
    assert.deepEqual(
      readdirSync(logsDir()),
      [today.slice(-16)],
      'the next line starts a new file',
    )

    writeFileSync(
      dayFile({ daysAgo: 30 }),
      '{"v":1}\n',
    )
    await pnyx.restart()
    await until({
      what: 'a starting server deleting days past the kept ones',
      check: () => !existsSync(dayFile({ daysAgo: 30 })),
    })
    const lifecycle = logLines().filter(line => line.operation === 'server.stop' || line.operation === 'server.start')
    assert.deepEqual(
      lifecycle.map(line => [
        line.operation,
        typeof line.ms,
        typeof line.pid,
      ]),
      [
        [
          'server.stop',
          'number',
          'undefined',
        ],
        [
          'server.start',
          'number',
          'number',
        ],
      ],
      'the restart has its stop and start lines, and the start names the process the lines after it come from',
    )
  },
)

test(
  'debug performance reads the logs into counts and durations per action, memory over time and the slowest actions, bounded and filtered',
  async () => {
    const s = await pnyx.scenario()
    const page = await openPage({
      port: pnyx.port(),
      hydraId: s.hydraId,
    })

    try {
      // Another Hydra's command, which --hydra keeps out of this Hydra's report.
      const other = await pnyx.scenario()
      const otherPage = await openPage({
        port: pnyx.port(),
        hydraId: other.hydraId,
      })
      await otherPage.command({
        name: 'task',
        args: [
          'create',
          '--title',
          'Elsewhere',
          '--key',
          'elsewhere',
        ],
      })
      otherPage.close()

      for (const key of [
        'first',
        'second',
        'third',
      ]) {
        await page.command({
          name: 'task',
          args: [
            'create',
            '--title',
            key,
            '--key',
            key,
          ],
        })
      }

      const sample = await until({
        what: 'a process line',
        check: () => logLines().find(line => line.operation === 'process'),
      })

      for (const field of [
        'cpuPercent',
        'loopUtilization',
        'loopDelayP99Ms',
        'heapUsed',
        'heapTotal',
        'external',
        'gcCount',
        'gcMs',
        'rss',
      ]) {
        assert.equal(
          typeof sample[field],
          'number',
          field,
        )
      }

      const report = await s.owner({
        args: [
          'debug',
          'performance',
          '--operation',
          'command.page',
          '--limit',
          '2',
        ],
      })
      assert.match(
        report,
        /operations\[1\]\{operation,count,typicalMs,worstMs,totalMs,errors,warnings\}:\n {2}command\.page task create,3,/,
      )
      assert.match(
        report,
        /memory\[\d+\]\{at,rssMB,heapMB,cpuPercent,loopDelayP99Ms\}:/,
      )
      assert.match(
        report,
        /slowest\[2\]\{at,operation,ms,source,hydraId,taskId\}:/,
      )

      const empty = await s.owner({
        args: [
          'debug',
          'performance',
          '--since',
          new Date(Date.now() + DAY_MS).toISOString(),
          '--until',
          new Date(Date.now() + 2 * DAY_MS).toISOString(),
        ],
      })
      assert.match(
        empty,
        /operations: "none: no log lines in this window"/,
      )

      for (const refused of [
        [
          'debug',
          'timeline',
          '--operation',
          'command',
        ],
        [
          'debug',
          'performance',
          '--since',
          new Date(Date.now() + DAY_MS).toISOString(),
          '--until',
          new Date().toISOString(),
        ],
        [
          'debug',
          'performance',
          '--limit',
          '0',
        ],
        [
          'debug',
          'performance',
          '--task',
          'first',
        ],
        [
          'logs',
          'rotate',
        ],
      ]) {
        assert.equal(
          await s.ownerRefused({ args: refused }),
          'VALIDATION_ERROR',
          refused.join(' '),
        )
      }
    } finally {
      page.close()
    }
  },
)
