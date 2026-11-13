import assert from 'node:assert/strict'
import { test } from 'node:test'
import { runFixture } from '#test-harness/child-fixture.ts'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { openPage } from '#test-harness/harness.ts'
import { pnyx } from '#test-harness/pnyx.ts'

test(
  'tool grants resume the same Claude and Codex conversations only after the running turn finishes',
  async t => {
    const stdout = await runFixture({
      t,
      name: 'tool-grants',
    })
    assert.match(
      stdout,
      /Tool grants and revocations resume Claude and Codex at safe turn boundaries/,
    )
    assert.match(
      stdout,
      /Hydra applies grants to its own card in the same conversation, including after restart/,
    )
  },
)

test(
  'a Hydra agent change to a login without one of Hydra\'s grants is refused before it switches',
  async () => {
    const s = await pnyx.scenario()
    await s.chat({ text: 'Begin' })
    const folder = s.state().cards.$hydra?.agent?.loginFolder
    assert.ok(folder)
    const login = join(
      folder,
      '.claude.json',
    )
    const existed = existsSync(login)
    const saved = existed ? JSON.parse(readFileSync(
      login,
      'utf8',
    )) : {}
    mkdirSync(
      folder,
      { recursive: true },
    )
    writeFileSync(
      login,
      JSON.stringify({
        ...saved,
        mcpServers: {
          ...saved.mcpServers,
          'claude-only': { command: 'claude-only-server' },
        },
      }),
    )
    const page = await openPage({
      port: pnyx.port(),
      hydraId: s.hydraId,
    })

    try {
      await s.owner({
        args: [
          'task',
          'tools',
          '$hydra',
          '--grant',
          'mcp:claude-only',
        ],
      })
      const refused = await page.refusal({
        name: 'hydra-agent',
        args: ['{"harness":"codex"}'],
      })
      assert.equal(
        refused.code,
        'TOOL_UNAVAILABLE',
      )
      assert.match(
        refused.error,
        /mcp:claude-only/,
      )
      assert.notEqual(
        s.state().config?.hydra?.agent?.harness,
        'codex',
        'the refused change is not saved',
      )
      await s.owner({
        args: [
          'task',
          'tools',
          '$hydra',
          '--revoke',
          'mcp:claude-only',
        ],
      })
      await page.command({
        name: 'hydra-agent',
        args: ['{"harness":"codex"}'],
      })
    } finally {
      page.close()

      if (existed) {
        writeFileSync(
          login,
          JSON.stringify(saved),
        )
      } else {
        rmSync(login)
      }
    }
  },
)
