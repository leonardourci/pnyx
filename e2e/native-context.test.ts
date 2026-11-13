import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import { tmpdir } from 'node:os'
import { claudeProvider } from '#workers/claude.ts'
import { codexProvider } from '#workers/codex.ts'
import { claudeNative } from '#workers/fixtures/claude-native.ts'
import { replayCodex } from '#test-harness/fake-agents.ts'
import { inbox } from '#hydra/update-queue.ts'
import { emptyHydra } from '#app/reducer.ts'
import { createDigestContext } from '#hydra/digest-context.ts'
import { hydraDigest } from '#hydra/digest.ts'
import { conversationContext } from '#hydra/agent-switch.ts'
import { until } from '#test-harness/harness.ts'

async function claudeProfile({
  t,
  toolScope,
}: {
  t: TestContext
  toolScope?: 'routine'
}) {
  const native = claudeNative()
  const session = await claudeProvider({ query: native.query }).open({
    cwd: tmpdir(),
    settings: {},
    env: {},
    signal: new AbortController().signal,
    toolScope,
  })
  const input = inbox()

  const read = async () => {
    const messages = async function* () {
      for await (const item of input) {
        yield {
          id: item.id!,
          text: item.text,
          images: [],
        }
      }
    }

    for await (const event of session.run({
      input: messages(),
      permission: async () => ({
        behavior: 'deny',
        message: 'Only Pnyx commands',
      }),
    })) {
      if (event === 'finished') {
        break
      }
    }
  }

  const done = read()
  t.after(async () => {
    input.end(); session.close(); await done
  })
  input.push({
    id: 'routine',
    text: 'Read the granted task',
  })
  await until({
    what: 'routine native query',
    check: () => native.incoming.length === 1,
  })

  return native.options()
}

test(
  'routine Claude sessions expose the command tool and no skill or MCP catalog',
  async t => {
    const profile = await claudeProfile({
      t,
      toolScope: 'routine',
    })
    assert.deepEqual(
      profile?.tools,
      ['Bash'],
    )
    assert.deepEqual(
      profile?.skills,
      [],
    )
    assert.equal(
      profile?.strictMcpConfig,
      true,
    )
    assert.deepEqual(
      profile?.mcpServers,
      {},
    )
    assert.deepEqual(
      profile?.settingSources,
      [
        'user',
        'project',
        'local',
      ],
    )
    const regular = await claudeProfile({ t })
    assert.deepEqual(
      regular?.tools,
      {
        type: 'preset',
        preset: 'claude_code',
      },
    )
    assert.equal(
      regular?.skills,
      undefined,
    )
    assert.equal(
      regular?.strictMcpConfig,
      true,
    )
    assert.deepEqual(
      regular?.mcpServers,
      {},
    )
  },
)

test(
  'routine Codex sessions restrict skills and web search while all sessions exclude ungranted servers',
  async t => {
    const native = replayCodex({ hydra: () => 'lab' })
    const session = await codexProvider({ spawnCodex: native.spawnCodex }).open({
      cwd: tmpdir(),
      env: { CODEX_HOME: tmpdir() },
      settings: {},
      signal: new AbortController().signal,
      toolScope: 'routine',
    })
    t.after(() => session.close())
    const config = native.sessions[0]!.config
    assert.equal(
      config?.['mcp_servers."unrelated.server".enabled'],
      false,
    )
    assert.deepEqual(
      config?.['skills.config'],
      [
        {
          path: '/synthetic/skills/unrelated/SKILL.md',
          enabled: false,
        },
      ],
    )
    assert.equal(
      config?.['features.apps'],
      false,
    )
    assert.equal(
      config?.['features.plugins'],
      false,
    )
    assert.equal(
      config?.web_search,
      'disabled',
    )
    const state = emptyHydra()
    const context = createDigestContext({
      render: async ({
        previousDigest,
        compacted,
      }) => {
        const digest = hydraDigest({
          hydraId: 'lab',
          state,
          checkpointed: true,
          previousDigest,
          owner: {
            preferences: {
              text: 'Synthetic Codex owner policy',
              at: '2026-01-01T00:00:00Z',
            },
          },
        })

        return compacted ? digest + '\n' + conversationContext({
          hydraId: 'lab',
          state,
        }) : digest
      },
    })
    const regular = await codexProvider({ spawnCodex: native.spawnCodex }).open({
      context,
      cwd: tmpdir(),
      env: { CODEX_HOME: tmpdir() },
      settings: {},
      signal: new AbortController().signal,
    })
    t.after(() => regular.close())
    const normal = native.sessions[1]!.config
    assert.equal(
      normal?.['mcp_servers."unrelated.server".enabled'],
      false,
    )
    assert.equal(
      normal?.['skills.config'],
      undefined,
    )
    assert.equal(
      normal?.['features.apps'],
      false,
    )
    assert.equal(
      normal?.['features.plugins'],
      false,
    )
    assert.equal(
      normal?.web_search,
      undefined,
    )
    const input = inbox()
    let completed = 0

    const consume = async () => {
      const messages = async function* () {
        for await (const item of input) {
          yield {
            id: item.id!,
            text: item.text,
            images: [],
          }
        }
      }

      for await (const event of regular.run({
        input: messages(),
        permission: async () => ({
          behavior: 'deny',
          message: 'No tools needed',
        }),
      })) {
        if (typeof event === 'object' && event.type === 'turn-ended') {
          completed++
        }
      }
    }

    const done = consume()
    t.after(async () => {
      input.end(); regular.close(); await done
    })
    input.push({
      id: 'before-compact',
      text: 'Before compact',
    })
    await until({
      what: 'first context turn',
      check: () => completed === 1,
    })
    const thread = native.sessions[1]!
    assert.match(
      thread.received[0]!,
      /Synthetic Codex owner policy/,
    )
    thread.notify!({
      method: 'item/completed',
      params: {
        threadId: thread.id,
        turnId: 'native-compact',
        item: {
          type: 'contextCompaction',
          id: 'compact',
        },
      },
    })
    input.push({
      id: 'after-compact',
      text: 'After compact',
    })
    await until({
      what: 'context after native compaction',
      check: () => completed === 2,
    })
    assert.match(
      thread.received[1]!,
      /Synthetic Codex owner policy/,
    )
    assert.match(
      thread.received[1]!,
      /pnyx-axi hydra history/,
    )
  },
)
