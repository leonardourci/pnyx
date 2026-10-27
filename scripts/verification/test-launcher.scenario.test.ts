import assert from 'node:assert/strict'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { until } from '../../src/test-harness/harness.ts'
import { discoverTests } from './discover.ts'
import { test } from 'node:test'

test(
  'the test launcher discards hostile agent, model, port and browser settings',
  () => {
    const result = spawnSync(
      process.execPath,
      [
        'scripts/verification/test.ts',
        'scripts/verification/fixtures/launcher-probe.ts',
      ],
      {
        env: {
          ...process.env,
          PATH: '/unavailable/outer-bin',
          PNYX_ACTOR: 'worker:live',
          PNYX_HYDRA: 'live',
          PNYX_TASK: 'live',
          PORT: '4747',
          PNYX_SEMANTIC: 'off',
          PNYX_SEMANTIC_STUB_FAIL: '1',
          NODE_OPTIONS: '--trace-warnings',
          CHROME_DEVTOOLS_AXI_PORT: '4747',
          CHROME_DEVTOOLS_AXI_AUTO_CONNECT: '1',
          GIT_CONFIG_GLOBAL: '/unavailable/outer-gitconfig',
        },
        encoding: 'utf8',
      },
    )
    assert.equal(
      result.status,
      0,
      `${result.stdout}\n${result.stderr}`,
    )
  },
)

test(
  'test files respect heavy and serial budgets and own separate runtime directories',
  async () => {
    const root = mkdtempSync(join(
      tmpdir(),
      'budget-',
    ))
    const events = join(
      root,
      'events.jsonl',
    )
    const heavyGate = join(
      root,
      'heavy.release',
    )
    const fixture = new URL(
      './fixtures/launcher-budget.ts',
      import.meta.url,
    ).href
    const probes = [
      {
        name: 'one',
        lane: 'heavy',
      },
      {
        name: 'two',
        lane: 'heavy',
      },
      {
        name: 'three',
        lane: 'heavy',
      },
      {
        name: 'test/scenarios/one',
        lane: 'serial',
      },
      {
        name: 'test/scenarios/two',
        lane: 'serial',
      },
      {
        name: 'one.scenario',
        lane: 'serial',
      },
      {
        name: 'one.e2e',
        lane: 'serial',
      },
      {
        name: 'one-browser',
        lane: 'serial',
      },
      {
        name: 'two-browser',
        lane: 'serial',
      },
    ].map(({
      name,
      lane,
    }) => {
      const path = join(
        root,
        `${name}.test.ts`,
      )
      const gate = lane === 'heavy' ? heavyGate : join(
        root,
        `${name}.release`,
      )
      mkdirSync(
        dirname(path),
        { recursive: true },
      )
      writeFileSync(
        path,
        `import { test } from 'node:test';
import { budgetProbe } from ${JSON.stringify(fixture)};
test('budget probe', () => budgetProbe(${JSON.stringify({
  events,
  gate,
  lane,
})}));
`,
      )

      return {
        path,
        gate,
        lane,
      }
    })

    const read = () => {
      if (!existsSync(events)) {
        return []
      }

      return readFileSync(
        events,
        'utf8',
      ).trim()
        .split('\n')
        .filter(Boolean)
        .map(line => JSON.parse(line) as {
          phase: string
          pid: number
          gate: string
          lane: string
          directories: Record<string, string>
        })
    }

    const child = spawn(
      process.execPath,
      [
        'scripts/verification/test.ts',
        ...probes.map(probe => probe.path),
      ],
      {
        stdio: [
          'ignore',
          'pipe',
          'pipe',
        ],
      },
    )
    let output = ''
    child.stdout.on(
      'data',
      text => {
        output += text
      },
    )
    child.stderr.on(
      'data',
      text => {
        output += text
      },
    )
    let closed = false
    const finished = new Promise<number | null>((
      resolve,
      reject,
    ) => {
      child.once(
        'error',
        reject,
      )
      child.once(
        'close',
        code => {
          closed = true
          resolve(code)
        },
      )
    })

    try {
      try {
        await until({
          what: 'two heavy files to reach their release gate',
          check: () => {
            assert.equal(
              closed,
              false,
              output,
            )

            return read().filter(event => event.phase === 'start' && event.lane === 'heavy').length >= 2
          },
        })
      } finally {
        writeFileSync(
          heavyGate,
          'release',
        )
      }

      const serialProbes = probes.filter(probe => probe.lane === 'serial').length

      for (let index = 0; index < serialProbes; index++) {
        const started = await until({
          what: `serial probe ${index + 1} to reach its release gate`,
          check: () => {
            assert.equal(
              closed,
              false,
              output,
            )

            return read().filter(event => event.phase === 'start' && event.lane === 'serial')[index]
          },
        })
        writeFileSync(
          started.gate,
          'release',
        )
      }

      assert.equal(
        await finished,
        0,
        output,
      )
      const active = {
        heavy: 0,
        serial: 0,
      }
      const maximum = {
        heavy: 0,
        serial: 0,
      }
      const directories = new Map<string, Set<string>>()

      for (const event of read()) {
        const lane = event.lane as keyof typeof active

        if (event.phase === 'start') {
          active[lane]++
          maximum[lane] = Math.max(
            maximum[lane],
            active[lane],
          )
          assert.ok(
            !active.heavy || !active.serial,
            'heavy and serial lanes never overlap',
          )

          for (const [
            key,
            path,
          ] of Object.entries(event.directories)) {
            const seen = directories.get(key) || new Set<string>()
            seen.add(path)
            directories.set(
              key,
              seen,
            )
          }
        } else {
          active[lane]--
        }
      }

      assert.deepEqual(
        maximum,
        {
          heavy: 2,
          serial: 1,
        },
      )
      assert.deepEqual(
        active,
        {
          heavy: 0,
          serial: 0,
        },
      )

      for (const key of [
        'HOME',
        'PNYX_HOME',
        'CLAUDE_CONFIG_DIR',
        'CODEX_HOME',
        'TMPDIR',
      ]) {
        assert.equal(
          directories.get(key)?.size,
          probes.length,
          `each file has its own ${key}`,
        )
      }
    } finally {
      for (const probe of probes) {
        writeFileSync(
          probe.gate,
          'release',
        )
      }

      await finished
      rmSync(
        root,
        {
          recursive: true,
          force: true,
        },
      )
    }
  },
)

test(
  'discovery finds every test file in the repository',
  () => {
    const files = execFileSync(
      'git',
      [
        'ls-files',
        '--cached',
        '--others',
        '--exclude-standard',
        '--',
        '*.test.ts',
      ],
      { encoding: 'utf8' },
    ).trim()
      .split('\n')
      .sort()

    assert.deepEqual(
      discoverTests(),
      files,
    )
  },
)
