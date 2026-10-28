import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { configPath } from '#workers/dispatch-config.ts'
import { pnyx } from '#test-harness/pnyx.ts'

test(
  'rule init registers the command login folders, keeps unset defaults and preserves existing files',
  async () => {
    const savedClaude = process.env.CLAUDE_CONFIG_DIR
    const savedCodex = process.env.CODEX_HOME
    assert.ok(savedClaude)
    assert.ok(savedCodex)

    try {
      delete process.env.CLAUDE_CONFIG_DIR
      delete process.env.CODEX_HOME
      const defaults = await pnyx.scenario()
      await defaults.owner({
        args: [
          'rule',
          'init',
        ],
      })
      assert.deepEqual(
        JSON.parse(readFileSync(
          configPath({
            hydraId: defaults.hydraId,
            accounts: true,
          }),
          'utf8',
        )),
        {
          accounts: {
            'claude:personal': {
              provider: 'claude',
              folder: '~/.claude',
            },
            'codex:personal': {
              provider: 'codex',
              folder: '~/.codex',
            },
          },
        },
      )

      process.env.CLAUDE_CONFIG_DIR = ''
      process.env.CODEX_HOME = ''
      const empty = await pnyx.scenario()
      await empty.owner({
        args: [
          'rule',
          'init',
        ],
      })
      assert.deepEqual(
        JSON.parse(readFileSync(
          configPath({
            hydraId: empty.hydraId,
            accounts: true,
          }),
          'utf8',
        )),
        {
          accounts: {
            'claude:personal': {
              provider: 'claude',
              folder: '~/.claude',
            },
            'codex:personal': {
              provider: 'codex',
              folder: '~/.codex',
            },
          },
        },
      )

      delete process.env.CODEX_HOME
      const mixed = await pnyx.scenario()
      const claude = mixed.folder({ name: 'claude-login' })
      process.env.CLAUDE_CONFIG_DIR = claude
      await mixed.owner({
        args: [
          'rule',
          'init',
        ],
      })
      assert.deepEqual(
        JSON.parse(readFileSync(
          configPath({
            hydraId: mixed.hydraId,
            accounts: true,
          }),
          'utf8',
        )),
        {
          accounts: {
            'claude:personal': {
              provider: 'claude',
              folder: claude,
            },
            'codex:personal': {
              provider: 'codex',
              folder: '~/.codex',
            },
          },
        },
      )

      const both = await pnyx.scenario()
      const codex = both.folder({ name: 'codex-login' })
      process.env.CODEX_HOME = codex
      await both.owner({
        args: [
          'rule',
          'init',
        ],
      })
      const accountsPath = configPath({
        hydraId: both.hydraId,
        accounts: true,
      })
      const accounts = readFileSync(
        accountsPath,
        'utf8',
      )
      assert.deepEqual(
        JSON.parse(accounts),
        {
          accounts: {
            'claude:personal': {
              provider: 'claude',
              folder: claude,
            },
            'codex:personal': {
              provider: 'codex',
              folder: codex,
            },
          },
        },
      )
      const rulesPath = configPath({ hydraId: both.hydraId })
      const rules = readFileSync(
        rulesPath,
        'utf8',
      )
      process.env.CLAUDE_CONFIG_DIR = savedClaude
      process.env.CODEX_HOME = savedCodex
      await both.owner({
        args: [
          'rule',
          'init',
        ],
      })
      assert.equal(
        readFileSync(
          accountsPath,
          'utf8',
        ),
        accounts,
      )
      assert.equal(
        readFileSync(
          rulesPath,
          'utf8',
        ),
        rules,
      )
    } finally {
      process.env.CLAUDE_CONFIG_DIR = savedClaude
      process.env.CODEX_HOME = savedCodex
    }
  },
)
