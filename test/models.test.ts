import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { claudeProvider, type QueryFn } from '../src/server/claude.ts'
import { codexProvider } from '../src/server/codex.ts'
import type { HostedSession } from '../src/server/provider.ts'
import { fakeCodex } from './codex-fixture.ts'
import { hydraSdk } from './hydra-host-fixture.ts'

const scratch = mkdtempSync(join(
  tmpdir(),
  'pnyx-test-',
))
after(() => rmSync(
  scratch,
  {
    recursive: true,
    force: true,
  },
))

async function turn({ session }: { session: HostedSession }) {
  const states: string[] = []

  for await (const event of session.run({
    input: (async function* () {
      yield 'Use the selected model'
    })(),
    permission: async () => ({
      behavior: 'deny',
      message: 'Test',
    }),
  })) {
    if (typeof event === 'string') {
      states.push(event)
    }
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
  'Claude discovers and runs models through the installed CLI',
  async () => {
    const root = mkdtempSync(join(
      scratch,
      'pnyx-installed-claude-',
    ))
    const sdk = hydraSdk()
    let catalogExecutable: string | undefined
    const query = (({
      options,
      prompt,
    }: Parameters<QueryFn>[0]) => {
      if (options?.persistSession === false) {
        catalogExecutable = options.pathToClaudeCodeExecutable

        return {
          supportedModels: async () => [
            {
              value: 'haiku',
              displayName: 'Haiku 5.5',
            },
          ],
          close: () => {},
        }
      }

      return sdk.query({
        options,
        prompt,
      })
    }) as unknown as QueryFn
    const provider = claudeProvider({
      query,
      readSettings: async () => ({}),
    })
    const env = {
      CLAUDE_CONFIG_DIR: join(
        root,
        'claude',
      ),
    }
    const models = await provider.models({
      cwd: root,
      env,
    })
    assert.equal(
      catalogExecutable,
      'claude',
    )
    const session = await provider.open({
      cwd: root,
      env,
      settings: { model: models[0]!.value },
      signal: new AbortController().signal,
    })

    try {
      await turn({ session })
      assert.deepEqual(
        [
          sdk.calls[0]?.options.pathToClaudeCodeExecutable,
          sdk.calls[0]?.options.model,
        ],
        [
          catalogExecutable,
          'haiku',
        ],
      )
    } finally {
      session.close()
    }
  },
)

test(
  'Claude lists SDK display names with settings defaults and closes its catalog, even a failed one',
  async () => {
    let closed = 0
    const query = (({ options }: Parameters<QueryFn>[0]) => {
      assert.equal(
        options?.persistSession,
        false,
      )

      return {
        supportedModels: async () => [
          {
            value: 'opus',
            displayName: 'Opus 5.5',
            resolvedModel: 'claude-opus-5-5',
            supportsEffort: true,
          },
          {
            value: 'future-model',
            displayName: 'Future Model',
          },
        ],
        close: () => {
          closed++
        },
      }
    }) as unknown as QueryFn
    const provider = claudeProvider({
      query,
      readSettings: async () => ({
        effortLevel: 'medium' as const,
        modelSettings: { 'claude-opus-5-5': { effortLevel: 'xhigh' as const } },
        permissions: { defaultMode: 'acceptEdits' as const },
      }),
    })
    const listed = await provider.models({
      cwd: tmpdir(),
      env: {},
    })
    assert.deepEqual(
      listed,
      [
        {
          value: 'opus',
          label: 'Opus 5.5',
          resolvedModel: 'claude-opus-5-5',
          defaultEffort: 'high',
        },
        {
          value: 'future-model',
          label: 'Future Model',
        },
      ],
    )
    assert.deepEqual(
      await provider.defaults({
        cwd: tmpdir(),
        env: {},
        models: listed,
      }),
      [
        {
          value: 'opus',
          label: 'Opus 5.5',
          resolvedModel: 'claude-opus-5-5',
          defaultEffort: 'xhigh',
          defaultMode: 'acceptEdits',
        },
        {
          value: 'future-model',
          label: 'Future Model',
          defaultMode: 'acceptEdits',
        },
      ],
    )
    assert.equal(
      (await claudeProvider({
        query,
        readSettings: async () => ({}),
      }).defaults({
        cwd: tmpdir(),
        env: {},
        models: listed,
      }))[0]!.defaultEffort,
      'high',
    )
    assert.equal(
      closed,
      1,
    )

    // A failed catalog is closed too, so reopening the picker can retry.
    await assert.rejects(
      claudeProvider({
        query: (() => ({
          supportedModels: async () => {
            throw new Error('Catalog unavailable')
          },
          close: () => {
            closed++
          },
        })) as unknown as QueryFn,
        readSettings: async () => ({}),
      }).models({
        cwd: tmpdir(),
        env: {},
      }),
      /unavailable/,
    )
    assert.equal(
      closed,
      2,
    )
  },
)

test(
  'Codex lists every page and starts the selected wire model',
  async () => {
    const root = mkdtempSync(join(
      scratch,
      'pnyx-models-',
    ))
    const fixture = fakeCodex({ root })
    const provider = codexProvider({ spawnCodex: fixture.spawnCodex })
    const listed = await provider.models({
      cwd: root,
      env: process.env,
    })
    const models = await provider.defaults({
      cwd: root,
      env: process.env,
      models: listed,
    })
    assert.deepEqual(
      models,
      [
        {
          value: 'gpt-catalog-one',
          label: 'Catalog One',
          isDefault: true,
          defaultEffort: 'low',
          defaultMode: 'bypassPermissions',
        },
        {
          value: 'gpt-catalog-two',
          label: 'Catalog Two',
          defaultEffort: 'medium',
          defaultMode: 'bypassPermissions',
        },
      ],
    )
    assert.deepEqual(
      fixture.messages().filter(m => m.method === 'model/list')
        .map(m => m.params),
      [
        {},
        { cursor: 'second-page' },
      ],
    )
    assert.equal(
      fixture.messages().some(m => m.method === 'thread/start'),
      false,
    )

    const session = await provider.open({
      cwd: root,
      env: process.env,
      signal: new AbortController().signal,
      settings: { model: models[1]!.value },
    })

    try {
      await turn({ session })
      assert.deepEqual(
        [
          'thread/start',
          'turn/start',
        ].map(method => fixture.messages().find(m => m.method === method)?.params?.model),
        [
          'gpt-catalog-two',
          'gpt-catalog-two',
        ],
      )
    } finally {
      session.close()
    }
  },
)
