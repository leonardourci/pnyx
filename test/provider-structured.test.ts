import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { outcomeSchema } from '../src/helper/runner.ts'
import { claudeProvider } from '../src/server/claude.ts'
import { codexProvider } from '../src/server/codex.ts'
import { fakeCodex } from '../src/test-harness/codex-fixture.ts'
import { hydraSdk } from '../src/test-harness/hydra-host-fixture.ts'

test(
  'Claude delivers its structured result even when the assistant also emits prose',
  async () => {
    const root = mkdtempSync(join(
      tmpdir(),
      'pnyx-structured-claude-',
    ))
    const sdk = hydraSdk()
    const expected = {
      outcomes: [
        {
          task: 'work',
          audience: 'owner',
          summary: 'A decision is needed.',
        },
      ],
    }
    sdk.control.reply = 'Here is the result:\n```json\n{}\n```'
    sdk.control.structured = expected
    const schema = outcomeSchema({ tasks: ['work'] })
    const session = await claudeProvider({ query: sdk.query }).open({
      cwd: root,
      settings: {},
      env: { CLAUDE_CONFIG_DIR: root },
      signal: new AbortController().signal,
      outputSchema: schema,
    })

    try {
      const events = []

      async function* input() {
        yield 'Classify the granted task'
      }

      for await (const event of session.run({
        input: input(),
        permission: async () => ({
          behavior: 'deny',
          message: 'Fixture',
        }),
      })) {
        events.push(event)
      }

      assert.deepEqual(
        sdk.calls[0]!.options.outputFormat,
        {
          type: 'json_schema',
          schema,
        },
      )
      assert.deepEqual(
        events.find(event => typeof event === 'object' && event.type === 'structured'),
        {
          type: 'structured',
          value: expected,
        },
      )
      assert.equal(
        events.at(-1),
        'finished',
      )
    } finally {
      session.close()
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
  'Codex receives the granted-task output schema on its actual turn request',
  async () => {
    const root = mkdtempSync(join(
      tmpdir(),
      'pnyx-structured-codex-',
    ))
    const fixture = fakeCodex({ root })
    const schema = outcomeSchema({ tasks: ['work'] })
    const session = await codexProvider({ spawnCodex: fixture.spawnCodex }).open({
      cwd: root,
      settings: {},
      env: {},
      signal: new AbortController().signal,
      outputSchema: schema,
    })

    try {
      async function* input() {
        yield 'Classify the granted task'
      }

      for await (const event of session.run({
        input: input(),
        permission: async () => ({
          behavior: 'deny',
          message: 'Fixture',
        }),
      })) {
        assert.ok(event)
      }

      assert.deepEqual(
        fixture.messages().find(message => message.method === 'turn/start')?.params?.outputSchema,
        schema,
      )
    } finally {
      session.close()
      await Promise.all(fixture.children.map(child => child.exitCode === null ? once(
        child,
        'exit',
      ) : Promise.resolve()))
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
