import assert from 'node:assert/strict'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { hostObserver } from '../src/test-harness/host-observer.ts'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { claudeProvider, type QueryFn } from '../src/server/claude.ts'
import { codexProvider } from '../src/server/codex.ts'
import type { HostedSession } from '../src/server/provider.ts'
import { fakeCodex } from '../src/test-harness/codex-fixture.ts'
import { fakeDispatch } from '../src/test-harness/dispatch-fixture.ts'
import { commands } from '../src/cli/commands.ts'
import { createHost } from '../src/server/host.ts'
import { hydraEvent, HYDRA_CARD } from '../src/core/hydra.ts'
import { loadHydra, withWriter } from '../src/store/hydra-store.ts'
import { hydraSdk } from '../src/test-harness/hydra-host-fixture.ts'

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

test(
  'Hydra dispatch accepts a catalog model beyond its legacy shortlist from saved configuration',
  { timeout: 30_000 },
  async context => {
    const root = mkdtempSync(join(
      scratch,
      'pnyx-catalog-dispatch-',
    ))
    process.env.PNYX_HOME = root
    commands.hydra([
      'create',
      'lab',
    ])
    fakeDispatch({ root })
    const fixture = fakeCodex({ root })
    withWriter({
      hydraId: 'lab',
      fn: ({ writer }) => {
        const config = writer.state.config!
        const decision = hydraEvent({
          state: writer.state,
          meta: {
            actor: 'test',
            at: new Date().toISOString(),
          },
          cardId: HYDRA_CARD,
          change: {
            type: 'board.configured',
            data: {
              ...config,
              hydra: {
                ...config.hydra,
                agent: {
                  harness: 'codex',
                  model: 'gpt-catalog-two',
                },
              },
            },
          },
        })
        assert.ok('event' in decision)
        writer.append({ event: decision.event })
      },
    })
    let finish = () => {}
    const finished = new Promise<void>(resolve => {
      finish = resolve
    })
    const host = createHost({
      hydraId: 'lab',
      spawnCodex: fixture.spawnCodex,
      changed: () => {
        if (loadHydra({ hydraId: 'lab' }).state.cards[HYDRA_CARD]?.sessionActivity === 'finished') {
          finish()
        }
      },
    })
    context.after(() => host.close())

    await host.hydra({
      text: 'Use this catalog model',
      actor: 'test',
      id: 'catalog-model',
    })

    await finished

    assert.equal(
      fixture.messages().find(m => m.method === 'thread/start')?.params?.model,
      'gpt-catalog-two',
    )
    assert.equal(
      fixture.messages().filter(m => m.method === 'model/list').length,
      2,
    )
  },
)

test(
  'The model list is stored for every Hydra, answers before the harness and is rewritten only when it changes',
  async t => {
    const root = mkdtempSync(join(
      scratch,
      'pnyx-stored-models-',
    ))
    process.env.PNYX_HOME = root
    commands.hydra([
      'create',
      'lab',
    ])
    const { claude } = fakeDispatch({ root })
    process.env.CLAUDE_CONFIG_DIR = claude
    writeFileSync(
      join(
        claude,
        'settings.json',
      ),
      JSON.stringify({ permissions: { defaultMode: 'acceptEdits' } }),
    )
    const entry = () => (JSON.parse(readFileSync(
      join(
        root,
        'harness-models.json',
      ),
      'utf8',
    )) as Record<string, Record<string, string>[]>)[`claude:${claude}`]
    const stored = () => entry()?.map(m => m.label)
    const labels = async ({ host }: { host: ReturnType<typeof createHost> }) => (await host.models({ harness: 'claude' })).map(m => m.label)
    let reads = 0
    let lookupsClosed = 0
    const observer = hostObserver({
      describe: () => ({
        reads,
        lookupsClosed,
        stored: stored(),
      }),
    })
    const rename = fs.renameSync
    t.mock.method(
      fs,
      'renameSync',
      // eslint-disable-next-line pnyx/object-params -- Node owns fs.renameSync's signature.
      (...args: Parameters<typeof fs.renameSync>) => {
        const result = rename(...args)

        if (String(args[1]) === join(
          root,
          'harness-models.json',
        )) {
          observer.notify()
        }

        return result
      },
    )
    syncBuiltinESMExports()
    t.after(() => {
      t.mock.restoreAll()
      syncBuiltinESMExports()
    })

    let answer = async (): Promise<{
      value: string
      displayName: string
    }[]> => {
      throw new Error('Catalog unavailable')
    }

    const query = (() => ({
      supportedModels: () => {
        reads++

        return answer()
      },
      close: () => {
        lookupsClosed++
        observer.notify()
      },
    })) as unknown as QueryFn
    const open = () => createHost({
      hydraId: 'lab',
      query,
      changed: () => {},
    })

    const cold = open()

    try {
      await assert.rejects(
        cold.models({ harness: 'claude' }),
        /unavailable/,
      )
      answer = async () => [
        {
          value: 'opus',
          displayName: 'Opus 5.5',
        },
      ]
      assert.deepEqual(
        (await cold.models({ harness: 'claude' })).map(m => [
          m.label,
          m.defaultMode,
        ]),
        [
          [
            'Opus 5.5',
            'acceptEdits',
          ],
        ],
      )
      assert.deepEqual(
        entry(),
        [
          {
            value: 'opus',
            label: 'Opus 5.5',
          },
        ],
      )
    } finally {
      cold.close()
    }

    // A new host answers from the stored list at once and refreshes it in the background.
    let release = () => {}
    answer = () => new Promise(resolve => {
      release = () => resolve([
        {
          value: 'opus',
          displayName: 'Opus 6',
        },
      ])
    })
    const warm = open()

    try {
      assert.deepEqual(
        await labels({ host: warm }),
        ['Opus 5.5'],
      )
      assert.equal(
        reads,
        3,
      )
      release()

      await observer.until({ check: () => stored()?.[0] === 'Opus 6' })

      assert.deepEqual(
        stored(),
        ['Opus 6'],
      )
      assert.deepEqual(
        await labels({ host: warm }),
        ['Opus 6'],
      )
      assert.equal(
        reads,
        3,
      )
    } finally {
      warm.close()
    }

    // An unavailable harness keeps the stored list.
    answer = async () => {
      throw new Error('Catalog unavailable')
    }

    const offline = open()

    try {
      assert.deepEqual(
        await labels({ host: offline }),
        ['Opus 6'],
      )
      await observer.until({ check: () => lookupsClosed === 4 })
      assert.equal(
        reads,
        4,
      )
      assert.deepEqual(
        await labels({ host: offline }),
        ['Opus 6'],
      )
      assert.deepEqual(
        stored(),
        ['Opus 6'],
      )
    } finally {
      offline.close()
    }
  },
)
