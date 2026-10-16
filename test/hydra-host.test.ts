import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { commands } from '../src/cli/commands.ts'
import { HYDRA_CARD, hydraEvent } from '../src/core/hydra.ts'
import { loadHydra, withWriter } from '../src/store/hydra-store.ts'
import { startServer } from '../src/server/server.ts'
import { readThread } from '../src/thread/read.ts'
import { hydraSdk } from './hydra-host-fixture.ts'
import { fakeCodex } from './codex-fixture.ts'
import { configPath, writeConfig } from '../src/dispatch/config.ts'

async function until({ check }: { check(): boolean }) {
  for (let i = 0; i < 200; i++) {
    if (check()) {
      return
    }

    await new Promise(resolve => setTimeout(resolve, 10))
  }

  assert.fail('Hydra did not finish its turn')
}

test('Hydra starts in its own folder, replies, resumes after restart and deduplicates sends', async () => {
  const home = mkdtempSync(join(tmpdir(), 'pnyx-hydra-host-'))
  process.env.PNYX_HOME = home
  process.env.CLAUDE_CONFIG_DIR = join(home, 'claude')
  process.env.PNYX_SEMANTIC = 'off'
  commands.hydra(['create', 'existing', '--hydra', 'existing'])
  const sdk = hydraSdk()
  let server = await startServer({ hydraId: 'existing', query: sdk.query })
  const state = () => loadHydra({ hydraId: 'existing' }).state
  const send = ({ text, id }: { text: string; id: string }) => commands.hydra(['send', '--text', text, '--event-id', id, '--hydra', 'existing'])

  try {
    await send({ text: 'Hello Hydra', id: 'hello' })
    await until({ check: () => state().cards[HYDRA_CARD]?.sessionActivity === 'finished' })
    const agent = state().cards[HYDRA_CARD]!.agent!
    assert.equal(agent.host, 'pnyx')
    assert.equal(agent.cwd, join(home, 'hydras', 'existing', 'agent'))
    assert.match(readFileSync(join(agent.cwd!, '.agents/skills/pnyx-hydra/SKILL.md'), 'utf8'), /Hydra/)
    assert.match(JSON.stringify(sdk.calls[0]!.options.systemPrompt), /You are Hydra.*existing/)
    assert.ok(readThread({ hydraId: 'existing', state: state(), card: state().cards[HYDRA_CARD]!, homes: [] }).entries.some(e => e.role === 'assistant' && e.text.includes('Hello Hydra')))
    await send({ text: 'Hello Hydra', id: 'hello' })
    assert.equal(sdk.calls[0]!.messages.length, 1)
    await send({ text: 'Continue', id: 'next' })
    await until({ check: () => sdk.calls[0]?.messages.length === 2 && state().cards[HYDRA_CARD]?.sessionActivity === 'finished' })
    await server.close()
    server = await startServer({ hydraId: 'existing', query: sdk.query })
    await send({ text: 'After restart', id: 'restart' })
    await until({ check: () => sdk.calls.length === 2 && state().cards[HYDRA_CARD]?.sessionActivity === 'finished' })
    assert.equal(sdk.calls[1]!.options.resume, agent.sessionId)
    assert.equal(state().config?.hydra.session, `claude-code:${agent.sessionId}`)
  } finally {
    await server.close(); rmSync(home, { recursive: true, force: true })
  }
})

test('Hydra hosts Codex and resumes its thread after restart', async () => {
  const home = mkdtempSync(join(tmpdir(), 'pnyx-hydra-codex-'))
  process.env.PNYX_HOME = home
  process.env.PNYX_SEMANTIC = 'off'
  commands.hydra(['create', 'lab'])
  writeConfig({ path: configPath({ hydraId: 'lab' }), value: { default: [{ harness: 'codex', model: 'gpt-6-luna' }] } })
  const codex = fakeCodex({ root: home })
  let server = await startServer({ hydraId: 'lab', spawnCodex: codex.spawnCodex })
  const state = () => loadHydra({ hydraId: 'lab' }).state

  try {
    await commands.hydra(['send', '--hydra', 'lab', '--text', 'Hello Codex'])
    await until({ check: () => state().cards[HYDRA_CARD]?.sessionActivity === 'finished' })
    const session = state().config!.hydra.session
    assert.ok(codex.messages().some(m => m.method === 'thread/start'))
    await server.close()
    server = await startServer({ hydraId: 'lab', spawnCodex: codex.spawnCodex })
    await commands.hydra(['send', '--hydra', 'lab', '--text', 'Continue Codex'])
    await until({ check: () => codex.messages().some(m => m.method === 'thread/resume') && state().cards[HYDRA_CARD]?.sessionActivity === 'finished' })
    assert.equal(state().config!.hydra.session, session)
    assert.ok(codex.messages().some(m => m.method === 'thread/resume'))
    assert.match(String(codex.messages().find(m => m.method === 'thread/start')?.params?.developerInstructions), /You are Hydra/)
    await commands.hydra(['send', '--hydra', 'lab', '--text', 'ALLOW'])
    await until({ check: () => state().cards[HYDRA_CARD]?.permissions?.some(p => p.status === 'pending') ?? false })
    const request = state().cards[HYDRA_CARD]!.permissions!.find(p => p.status === 'pending')!
    await commands.task(['permission', HYDRA_CARD, request.id, 'allow', '--hydra', 'lab'])
    await until({ check: () => state().cards[HYDRA_CARD]?.sessionActivity === 'finished' })
    assert.equal(state().cards[HYDRA_CARD]!.permissions!.find(p => p.id === request.id)?.status, 'allow')
  } finally {
    await server.close(); rmSync(home, { recursive: true, force: true })
  }
})

test('Hydra exposes provider failures and Firstmate Hydras never start a hosted agent', async () => {
  const home = mkdtempSync(join(tmpdir(), 'pnyx-hydra-error-'))
  process.env.PNYX_HOME = home
  process.env.CLAUDE_CONFIG_DIR = join(home, 'claude')
  process.env.PNYX_SEMANTIC = 'off'
  commands.hydra(['create', 'lab'])
  const sdk = hydraSdk(); sdk.control.fail = true
  const server = await startServer({ hydraId: 'lab', query: sdk.query })
  const state = () => loadHydra({ hydraId: 'lab' }).state

  try {
    await commands.hydra(['send', '--hydra', 'lab', '--text', 'Hello'])
    await until({ check: () => state().cards[HYDRA_CARD]?.attention.some(a => a.kind === 'interrupted') ?? false })
    assert.match(state().cards[HYDRA_CARD]!.attention[0]!.text ?? '', /Harness login is missing/)
    sdk.control.fail = false
    const session = state().cards[HYDRA_CARD]!.agent!.sessionId
    await commands.hydra(['send', '--hydra', 'lab', '--text', 'Retry after sign-in'])
    await until({ check: () => sdk.calls[1]?.messages.length === 1 && state().cards[HYDRA_CARD]?.sessionActivity === 'finished' })
    assert.equal(sdk.calls[1]!.options.resume, undefined)
    assert.equal(sdk.calls[1]!.options.sessionId, session)
    assert.ok(!state().cards[HYDRA_CARD]!.attention.some(a => a.kind === 'interrupted'))
    commands.hydra(['set', '--hydra', 'lab', '--firstmate', join(home, 'firstmate')])
    await commands.hydra(['send', '--hydra', 'lab', '--text', 'Firstmate message'])
    assert.equal(sdk.calls.length, 2)
    assert.equal(state().hydraMessages?.at(-1)?.text, 'Firstmate message')
  } finally {
    await server.close(); rmSync(home, { recursive: true, force: true })
  }
})

test('messages queue during a running Hydra turn without blocking delivery', async () => {
  const home = mkdtempSync(join(tmpdir(), 'pnyx-hydra-queue-'))
  process.env.PNYX_HOME = home
  process.env.CLAUDE_CONFIG_DIR = join(home, 'claude')
  process.env.PNYX_SEMANTIC = 'off'
  commands.hydra(['create', 'lab'])
  const sdk = hydraSdk(); sdk.control.hold = true
  const server = await startServer({ hydraId: 'lab', query: sdk.query })

  try {
    await commands.hydra(['send', '--hydra', 'lab', '--text', 'First'])
    await until({ check: () => sdk.calls[0]?.messages.length === 1 })
    await commands.hydra(['send', '--hydra', 'lab', '--text', 'Second', '--event-id', 'second'])
    await commands.hydra(['send', '--hydra', 'lab', '--text', 'Second', '--event-id', 'second'])
    assert.deepEqual(sdk.calls[0]?.messages, ['First'])
    sdk.release()
    await until({ check: () => sdk.calls[0]?.messages.length === 2 })
    assert.deepEqual(sdk.calls[0]?.messages, ['First', 'Second'])
  } finally {
    sdk.release(); await server.close(); rmSync(home, { recursive: true, force: true })
  }
})

test('changing Hydra harness preserves the earlier conversation', async () => {
  const home = mkdtempSync(join(tmpdir(), 'pnyx-hydra-switch-'))
  process.env.PNYX_HOME = home
  process.env.CLAUDE_CONFIG_DIR = join(home, 'claude')
  process.env.PNYX_SEMANTIC = 'off'
  commands.hydra(['create', 'lab'])
  const sdk = hydraSdk(), codex = fakeCodex({ root: home })
  const server = await startServer({ hydraId: 'lab', query: sdk.query, spawnCodex: codex.spawnCodex })
  const state = () => loadHydra({ hydraId: 'lab' }).state

  try {
    await commands.hydra(['send', '--hydra', 'lab', '--text', 'Earlier message'])
    await until({ check: () => state().cards[HYDRA_CARD]?.sessionActivity === 'finished' })
    withWriter({
      hydraId: 'lab',
      fn: ({ writer }) => {
        const config = writer.state.config!
        const decision = hydraEvent({ state: writer.state, meta: { at: new Date().toISOString(), actor: 'test' }, cardId: HYDRA_CARD, change: { type: 'board.configured', data: { ...config, hydra: { ...config.hydra, agent: { harness: 'codex' } } } } })
        assert.ok('event' in decision); writer.append({ event: decision.event })
      },
    })
    await commands.hydra(['send', '--hydra', 'lab', '--text', 'Later message'])
    await until({ check: () => state().cards[HYDRA_CARD]?.agent?.provider === 'codex' && state().cards[HYDRA_CARD]?.sessionActivity === 'finished' })
    const thread = readThread({ hydraId: 'lab', state: state(), card: state().cards[HYDRA_CARD]!, homes: [] })
    assert.ok(thread.entries.some(e => e.role === 'assistant' && e.text === 'Hydra: Earlier message'))
    assert.ok(thread.entries.some(e => e.role === 'assistant' && e.text === 'Codex: Later message'))
  } finally {
    await server.close(); rmSync(home, { recursive: true, force: true })
  }
})

test('queued Hydra messages retain the settings selected when sent', async () => {
  const home = mkdtempSync(join(tmpdir(), 'pnyx-hydra-settings-'))
  process.env.PNYX_HOME = home
  process.env.CLAUDE_CONFIG_DIR = join(home, 'claude')
  process.env.PNYX_SEMANTIC = 'off'
  commands.hydra(['create', 'lab'])
  const sdk = hydraSdk(); sdk.control.hold = true
  const server = await startServer({ hydraId: 'lab', query: sdk.query })
  const choose = ({ model }: { model: string }) => withWriter({
    hydraId: 'lab',
    fn: ({ writer }) => {
      const config = writer.state.config!
      const decision = hydraEvent({ state: writer.state, meta: { at: new Date().toISOString(), actor: 'test' }, cardId: HYDRA_CARD, change: { type: 'board.configured', data: { ...config, hydra: { ...config.hydra, agent: { harness: 'claude', model } } } } })
      assert.ok('event' in decision); writer.append({ event: decision.event })
    },
  })

  try {
    choose({ model: 'sonnet' })
    await commands.hydra(['send', '--hydra', 'lab', '--text', 'First'])
    await until({ check: () => sdk.calls[0]?.messages.length === 1 })
    await commands.hydra(['send', '--hydra', 'lab', '--text', 'Second'])
    choose({ model: 'opus' })
    await commands.hydra(['send', '--hydra', 'lab', '--text', 'Third'])
    choose({ model: 'haiku' })
    sdk.release()
    await until({ check: () => sdk.calls.some(c => c.messages.includes('Third')) })
    assert.equal(sdk.calls.find(c => c.messages.includes('Second'))?.options.model, 'sonnet')
    assert.equal(sdk.calls.find(c => c.messages.includes('Third'))?.options.model, 'opus')
  } finally {
    sdk.release(); await server.close(); rmSync(home, { recursive: true, force: true })
  }
})
