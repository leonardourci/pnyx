import assert from 'node:assert/strict'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { test } from 'node:test'
import { claudeProvider, type QueryFn } from '#workers/claude.ts'
import { codexProvider } from '#workers/codex.ts'
import { claudeNative } from '#workers/fixtures/claude-native.ts'
import { nativeGroup } from '#agent-host/groups.ts'
import { until } from '#test-harness/harness.ts'

const entry = join(
  import.meta.dirname,
  '../src/workers/fixtures/owned-process.ts',
)

test(
  'the Claude process hook records a private group and drains stderr pressure',
  async t => {
    const native = claudeNative()
    let ready = false, pid: number | undefined

    const query: QueryFn = ({
      prompt,
      options,
    }) => {
      assert.ok(options?.spawnClaudeCodeProcess)
      const child = options.spawnClaudeCodeProcess({
        command: process.execPath,
        args: [
          entry,
          'claude',
        ],
        cwd: tmpdir(),
        env: {},
        signal: new AbortController().signal,
      })
      child.stdout.on(
        'data',
        chunk => {
          if (String(chunk).includes('ready')) {
            ready = true
          }
        },
      )

      return native.query({
        prompt,
        options,
      })
    }

    const session = await claudeProvider({ query }).open({
      cwd: tmpdir(),
      settings: {},
      env: {},
      signal: new AbortController().signal,
      ownProcess({ pid: child }) {
        pid = child
        nativeGroup({ pid: child })
      },
    })
    const reading = (async () => {
      for await (const event of session.run({
        input: (async function* () {})(),
        permission: async () => ({
          behavior: 'deny',
          message: 'unused',
        }),
      })) {
        assert.ok(event)
      }
    })()
    t.after(async () => {
      session.close()

      if (pid) {
        process.kill(
          -pid,
          'SIGKILL',
        )
      }

      await reading
    })
    await until({
      what: 'Claude stderr drain',
      check: () => ready,
    })
    assert.ok(pid)
  },
)

test(
  'the Codex provider records its spawned app-server private group',
  async t => {
    let child: ChildProcessWithoutNullStreams | undefined, pid: number | undefined
    const provider = codexProvider({
      spawnCodex({
        cwd,
        env,
        detached,
      }) {
        child = spawn(
          process.execPath,
          [
            entry,
            'codex',
          ],
          {
            cwd,
            env,
            detached,
            stdio: 'pipe',
          },
        )

        return child
      },
    })
    t.after(() => child?.kill('SIGKILL'))
    const session = await provider.open({
      cwd: tmpdir(),
      settings: {},
      env: {},
      signal: new AbortController().signal,
      ownProcess({ pid: child }) {
        pid = nativeGroup({ pid: child }).id
      },
    })
    t.after(() => session.close())
    assert.equal(
      pid,
      child!.pid,
    )
    assert.equal(
      session.id,
      'owned-native-thread',
    )
  },
)
