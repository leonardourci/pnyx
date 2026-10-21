import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { claudeProvider, type QueryFn } from '../src/server/claude.ts'
import { codexProvider } from '../src/server/codex.ts'
import { fakeCodex } from './codex-fixture.ts'
import { fakeDispatch } from './dispatch-fixture.ts'
import { commands } from '../src/cli/commands.ts'
import { createHost } from '../src/server/host.ts'
import { hydraEvent, HYDRA_CARD } from '../src/core/hydra.ts'
import { loadHydra, withWriter } from '../src/store/hydra-store.ts'
import { hydraSdk } from './hydra-host-fixture.ts'

test('Claude discovers and runs models through the installed CLI', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pnyx-installed-claude-'))
  const sdk = hydraSdk()
  let catalogExecutable: string | undefined
  const query = (({ options, prompt }: Parameters<QueryFn>[0]) => {
    if (options?.persistSession === false) {
      catalogExecutable = options.pathToClaudeCodeExecutable

      return {
        supportedModels: async () => [{ value: 'haiku', displayName: 'Haiku 5.5' }],
        close: () => {},
      }
    }

    return sdk.query({ options, prompt })
  }) as unknown as QueryFn
  const provider = claudeProvider({ query, readSettings: async () => ({}) })

  try {
    const env = { CLAUDE_CONFIG_DIR: join(root, 'claude') }
    const models = await provider.models({ cwd: root, env })
    assert.equal(catalogExecutable, 'claude')
    const session = await provider.open({
      cwd: root, env, settings: { model: models[0]!.value }, signal: new AbortController().signal,
    })

    try {
      async function* input() {
        yield 'Use the selected model'
      }

      const states: string[] = []

      for await (const event of session.run({ input: input(), permission: async () => ({ behavior: 'deny', message: 'Test' }) })) {
        if (typeof event === 'string') {
          states.push(event)
        }
      }

      assert.deepEqual(states, ['working', 'finished'])

      assert.equal(sdk.calls[0]?.options.pathToClaudeCodeExecutable, catalogExecutable)
      assert.equal(sdk.calls[0]?.options.model, 'haiku')
    } finally {
      session.close()
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('Claude lists SDK display names and closes its catalog without running a turn', async () => {
  let closed = false
  const query = (({ options }: Parameters<QueryFn>[0]) => {
    assert.equal(options?.persistSession, false)

    return {
      supportedModels: async () => [
        { value: 'opus', displayName: 'Opus 5.5', resolvedModel: 'claude-opus-5-5', supportsEffort: true },
        { value: 'future-model', displayName: 'Future Model' },
      ],
      close: () => {
        closed = true
      },
    }
  }) as unknown as QueryFn
  const readSettings = async () => ({ effortLevel: 'medium' as const, modelSettings: { 'claude-opus-5-5': { effortLevel: 'xhigh' as const } }, permissions: { defaultMode: 'acceptEdits' as const } })
  const provider = claudeProvider({ query, readSettings })
  const listed = await provider.models({ cwd: tmpdir(), env: {} })
  const models = await provider.defaults({ cwd: tmpdir(), env: {}, models: listed })

  assert.deepEqual(listed, [
    { value: 'opus', label: 'Opus 5.5', resolvedModel: 'claude-opus-5-5', defaultEffort: 'high' },
    { value: 'future-model', label: 'Future Model' },
  ])
  assert.deepEqual(models, [
    { value: 'opus', label: 'Opus 5.5', resolvedModel: 'claude-opus-5-5', defaultEffort: 'xhigh', defaultMode: 'acceptEdits' },
    { value: 'future-model', label: 'Future Model', defaultMode: 'acceptEdits' },
  ])
  assert.equal((await claudeProvider({ query, readSettings: async () => ({}) }).defaults({ cwd: tmpdir(), env: {}, models: listed }))[0]!.defaultEffort, 'high')
  assert.equal(closed, true)
})

test('Claude closes a failed catalog so reopening the picker can retry', async () => {
  let closed = false
  const query = (() => ({
    supportedModels: async () => {
      throw new Error('Catalog unavailable')
    },
    close: () => {
      closed = true
    },
  })) as unknown as QueryFn

  await assert.rejects(claudeProvider({ query, readSettings: async () => ({}) }).models({ cwd: tmpdir(), env: {} }), /unavailable/)
  assert.equal(closed, true)
})

test('Codex lists every page and starts the selected wire model', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pnyx-models-'))
  const fixture = fakeCodex({ root })
  const provider = codexProvider({ spawnCodex: fixture.spawnCodex })

  try {
    const listed = await provider.models({ cwd: root, env: process.env })
    const models = await provider.defaults({ cwd: root, env: process.env, models: listed })
    assert.deepEqual(models, [
      { value: 'gpt-catalog-one', label: 'Catalog One', isDefault: true, defaultEffort: 'low', defaultMode: 'bypassPermissions' },
      { value: 'gpt-catalog-two', label: 'Catalog Two', defaultEffort: 'medium', defaultMode: 'bypassPermissions' },
    ])
    assert.deepEqual(fixture.messages().filter(m => m.method === 'model/list')
      .map(m => m.params), [
      {}, { cursor: 'second-page' },
    ])
    assert.equal(fixture.messages().some(m => m.method === 'thread/start'), false)

    const session = await provider.open({
      cwd: root,
      env: process.env,
      signal: new AbortController().signal,
      settings: { model: models[1]!.value },
    })

    try {
      async function* input() {
        yield 'Use the selected model'
      }

      const states: string[] = []

      for await (const event of session.run({ input: input(), permission: async () => ({ behavior: 'deny', message: 'Test' }) })) {
        if (typeof event === 'string') {
          states.push(event)
        }
      }

      assert.deepEqual(states, ['working', 'finished'])

      assert.equal(fixture.messages().find(m => m.method === 'thread/start')?.params?.model, 'gpt-catalog-two')
      assert.equal(fixture.messages().find(m => m.method === 'turn/start')?.params?.model, 'gpt-catalog-two')
    } finally {
      session.close()
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('Hydra dispatch accepts a catalog model beyond its legacy shortlist from saved configuration', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pnyx-catalog-dispatch-'))
  const previousPath = process.env.PATH
  process.env.PNYX_HOME = root
  commands.hydra(['create', 'lab'])
  fakeDispatch({ root })
  const fixture = fakeCodex({ root })
  withWriter({
    hydraId: 'lab',
    fn: ({ writer }) => {
      const config = writer.state.config!
      const decision = hydraEvent({
        state: writer.state,
        meta: { actor: 'test', at: new Date().toISOString() },
        cardId: HYDRA_CARD,
        change: {
          type: 'board.configured',
          data: {
            ...config, hydra: { ...config.hydra, agent: { harness: 'codex', model: 'gpt-catalog-two' } },
          },
        },
      })
      assert.ok('event' in decision)
      writer.append({ event: decision.event })
    },
  })
  const host = createHost({ hydraId: 'lab', spawnCodex: fixture.spawnCodex, changed: () => {} })

  try {
    await host.hydra({ text: 'Use this catalog model', actor: 'test', id: 'catalog-model' })

    for (let attempt = 0; attempt < 200; attempt++) {
      if (loadHydra({ hydraId: 'lab' }).state.cards[HYDRA_CARD]?.sessionActivity === 'finished') {
        break
      }

      await new Promise(resolve => setTimeout(resolve, 10))
    }

    assert.equal(fixture.messages().find(m => m.method === 'thread/start')?.params?.model, 'gpt-catalog-two')
    assert.equal(fixture.messages().filter(m => m.method === 'model/list').length, 2)
  } finally {
    host.close()
    process.env.PATH = previousPath
    rmSync(root, { recursive: true, force: true })
  }
})

test('The model list is stored for every Hydra, answers before the harness and is rewritten when it changes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pnyx-stored-models-'))
  const previous = { PATH: process.env.PATH, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR }
  process.env.PNYX_HOME = root
  commands.hydra(['create', 'lab'])
  const { claude } = fakeDispatch({ root })
  process.env.CLAUDE_CONFIG_DIR = claude
  const file = join(root, 'harness-models.json')
  const stored = () => (JSON.parse(readFileSync(file, 'utf8')) as Record<string, { label: string }[]>)[`claude:${claude}`]?.map(m => m.label)
  let reads = 0
  let answer = async () => [{ value: 'opus', displayName: 'Opus 5.5' }]
  const query = (() => ({
    supportedModels: () => {
      reads++

      return answer()
    },
    close: () => {},
  })) as unknown as QueryFn
  const open = () => createHost({ hydraId: 'lab', query, changed: () => {} })

  const cold = open()

  try {
    assert.deepEqual((await cold.models({ harness: 'claude' })).map(m => m.label), ['Opus 5.5'])
    assert.deepEqual(stored(), ['Opus 5.5'])
  } finally {
    cold.close()
  }

  let release = () => {}
  answer = () => new Promise(resolve => {
    release = () => resolve([{ value: 'opus', displayName: 'Opus 6' }])
  })
  const warm = open()

  try {
    assert.deepEqual((await warm.models({ harness: 'claude' })).map(m => m.label), ['Opus 5.5'])
    assert.equal(reads, 2)
    release()

    for (let attempt = 0; attempt < 200 && stored()?.[0] !== 'Opus 6'; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 10))
    }

    assert.deepEqual(stored(), ['Opus 6'])
    assert.deepEqual((await warm.models({ harness: 'claude' })).map(m => m.label), ['Opus 6'])
    assert.equal(reads, 2)
  } finally {
    warm.close()
    process.env.PATH = previous.PATH
    process.env.CLAUDE_CONFIG_DIR = previous.CLAUDE_CONFIG_DIR
    rmSync(root, { recursive: true, force: true })
  }
})
