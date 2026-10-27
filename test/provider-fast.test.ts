import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { claudeProvider } from '../src/server/claude.ts'
import { codexProvider } from '../src/server/codex.ts'
import type { HostedSession } from '../src/server/provider.ts'
import { hydraSdk } from '../src/test-harness/hydra-host-fixture.ts'
import { fakeCodex } from '../src/test-harness/codex-fixture.ts'

async function turn({ session }: { session: HostedSession }) {
  async function* input() {
    yield 'Check speed'
  }

  const states = []

  for await (const activity of session.run({
    input: input(),
    permission: async () => ({
      behavior: 'deny',
      message: 'Test',
    }),
  })) {
    states.push(activity)
  }

  assert.deepEqual(
    states,
    [
      'working',
      'finished',
    ],
  )
}

test(
  'Claude Fast uses the harness default unless explicitly enabled or disabled',
  async () => {
    const root = mkdtempSync(join(
      tmpdir(),
      'pnyx-claude-fast-',
    ))
    const sdk = hydraSdk(), provider = claudeProvider({ query: sdk.query })

    try {
      for (const fast of [
        undefined,
        'true',
        'false',
      ]) {
        const session = await provider.open({
          cwd: root,
          settings: fast === undefined ? {} : { fast },
          env: {
            CLAUDE_CONFIG_DIR: join(
              root,
              'claude',
            ),
          },
          signal: new AbortController().signal,
        })

        try {
          await turn({ session })
          assert.deepEqual(
            sdk.calls.at(-1)?.options.settings,
            fast === undefined ? undefined : { fastMode: fast === 'true' },
          )
        } finally {
          session.close()
        }
      }
    } finally {
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
  'Codex Fast inherits by default and switches service tier between turns',
  async () => {
    const root = mkdtempSync(join(
      tmpdir(),
      'pnyx-codex-fast-',
    ))
    const fixture = fakeCodex({ root })
    const provider = codexProvider({ spawnCodex: fixture.spawnCodex })
    const session = await provider.open({
      cwd: root,
      settings: {},
      env: process.env,
      signal: new AbortController().signal,
    })

    try {
      await turn({ session })
      assert.equal(
        fixture.messages().find(m => m.method === 'thread/start')?.params?.serviceTier,
        undefined,
      )
      assert.equal(
        fixture.messages().filter(m => m.method === 'turn/start')
          .at(-1)?.params?.serviceTier,
        undefined,
      )
      await session.set({
        setting: 'fast',
        value: 'true',
      })
      await turn({ session })
      assert.equal(
        fixture.messages().filter(m => m.method === 'turn/start')
          .at(-1)?.params?.serviceTier,
        'fast',
      )
      await session.set({
        setting: 'fast',
        value: 'false',
      })
      await turn({ session })
      assert.equal(
        fixture.messages().filter(m => m.method === 'turn/start')
          .at(-1)?.params?.serviceTier,
        'default',
      )
    } finally {
      session.close(); rmSync(
        root,
        {
          recursive: true,
          force: true,
        },
      )
    }
  },
)
