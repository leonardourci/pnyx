import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { PaseoClient } from '@getpaseo/client'
import { HYDRA_CARD } from '../src/core/hydra.ts'
import { ingestSpool } from '../src/integrations/hooks/ingest.ts'
import { commands } from '../src/cli/commands.ts'
import { integrations } from '../src/cli/integrations.ts'
import { HYDRA_SKILL, setupHydra, startHydra, startTask } from '../src/cli/start.ts'
import { loadBoard, spoolWrite } from '../src/store/board-store.ts'

const at = '2026-10-15T00:00:00Z'
const meta = { at, actor: 'test' }
const ROOT = join(import.meta.dirname, '..')

function lab() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pnyx-start-')))
  process.env.PNYX_HOME = join(root, 'pnyx')
  const folder = join(root, 'work')
  mkdirSync(folder)
  const run = ({ args }: { args: string[] }) => commands[args[0] as keyof typeof commands]([...args.slice(1), '--board', 'lab'])
  run({ args: ['board', 'create', 'lab'] })

  return { root, folder, run, state: () => loadBoard({ board: 'lab' }).state }
}

async function written({ path }: { path: string }): Promise<string> {
  for (let i = 0; i < 100 && !existsSync(path); i++) {
    await new Promise(resolve => setTimeout(resolve, 20))
  }

  return readFileSync(path, 'utf8')
}

// The installed hook as a session started with the given environment would run it.
function hook({ env, session, event }: {
  env: Record<string, string>
  session: string
  event: string
}) {
  const payload = JSON.stringify({ session_id: session, hook_event_name: event, cwd: env.PNYX_FOLDER, prompt: 'go' })
  const ran = spawnSync('/bin/sh', [join(ROOT, 'setup', 'hooks', 'pnyx-hook.sh'), 'claude', event], { input: payload, env: { PATH: process.env.PATH, ...env } })
  assert.equal(ran.status, 0)
}

const environment = ({ text }: { text: string }): Record<string, string> => JSON.parse(text)

const captureEnvironment = ({ path }: { path: string }) => {
  const script = `const fs = require('node:fs'); const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith('PNYX_'))); fs.writeFileSync(${JSON.stringify(path + '.tmp')}, JSON.stringify(env)); fs.renameSync(${JSON.stringify(path + '.tmp')}, ${JSON.stringify(path)});`

  return `node -e '${script.replaceAll("'", "'\\''")}'`
}

test('task start --via command runs the board command once and its session joins the task', async () => {
  const { root, folder, run, state } = lab()
  const out = join(root, 'env.txt')
  run({ args: ['board', 'set', '--command', captureEnvironment({ path: out })] })
  run({ args: ['task', 'create', '--title', 'Write the docs', '--folder', folder] })
  const task = Object.values(state().cards).find(c => c.title === 'Write the docs')!.id

  await run({ args: ['task', 'brief', task, '--brief', 'Draft it'] })
  const started = await startTask({ board: 'lab', task, via: 'command', meta: { ...meta, id: 's1' } })
  assert.equal(started.via, 'command')
  assert.equal(state().cards[task]?.launch?.via, 'command')
  assert.equal(state().cards[task]?.launch?.pid, started.pid)
  assert.equal(state().cards[task]?.launch?.folder, folder)
  const env = environment({ text: await written({ path: out }) })
  assert.equal(env.PNYX_TASK, task)
  assert.equal(env.PNYX_BOARD, 'lab')
  assert.equal(env.PNYX_HOME, process.env.PNYX_HOME)
  assert.equal(env.PNYX_ROLE, 'worker')
  assert.match(env.PNYX_PROMPT!, /^Draft it\n\nYou are the Pnyx worker/)
  assert.equal(env.PNYX_FOLDER, folder)
  assert.equal(state().cards[task]!.notes?.at(-1)?.source, 'pnyx:start')

  writeFileSync(out, '')
  assert.equal((await startTask({ board: 'lab', task, via: 'command', meta: { ...meta, id: 's1' } })).event, 'none: duplicate')
  await new Promise(resolve => setTimeout(resolve, 200))
  assert.equal(readFileSync(out, 'utf8'), '')

  hook({ env, session: 'cmd-1', event: 'SessionStart' })
  ingestSpool({ board: 'lab' })
  assert.deepEqual(state().cards[task]!.sessionIds, ['claude-code:cmd-1'])
  assert.equal(state().sessions?.['claude-code:cmd-1']?.launch?.via, 'command')
  assert.equal(state().sessions?.['claude-code:cmd-1']?.launch?.pid, started.pid)
  hook({ env, session: 'cmd-2', event: 'SessionStart' })
  ingestSpool({ board: 'lab' })
  assert.deepEqual(state().cards[task]!.sessionIds, ['claude-code:cmd-1'])

  run({ args: ['board', 'set', '--command', ''] })
  await assert.rejects(startTask({ board: 'lab', task, via: 'command', meta }), /no start command/)
})

test('hydra start --via command makes its first session the board Hydra, never a worker', async () => {
  const { root, folder, run, state } = lab()
  const out = join(root, 'env.txt')
  run({ args: ['board', 'set', '--command', captureEnvironment({ path: out })] })
  run({ args: ['task', 'create', '--title', 'Same folder', '--folder', folder] })

  await startHydra({ board: 'lab', via: 'command', folder, meta: { ...meta, id: 'h1' } })
  const env = environment({ text: await written({ path: out }) })
  assert.equal(env.PNYX_TASK, HYDRA_CARD)
  assert.equal(env.PNYX_ROLE, 'hydra')
  assert.match(env.PNYX_PROMPT!, /pnyx-hydra/)

  hook({ env, session: 'hydra-1', event: 'SessionStart' })
  ingestSpool({ board: 'lab' })
  assert.equal(state().board?.hydra.session, 'claude-code:hydra-1')
  assert.deepEqual(Object.values(state().cards).find(c => c.title === 'Same folder')!.sessionIds, [])
})

test('hydra start --via paseo records the Paseo agent as the board Hydra', async () => {
  const { folder, state } = lab()
  const created: Record<string, unknown>[] = []
  const client = {
    providers: { listModels: async () => ({ models: [{ id: 'default', isDefault: true }] }) },
    agents: {
      create: async (options: Record<string, unknown>) => {
        created.push(options)

        return { id: 'hydra-agent' }
      },
    },
    close: async () => undefined,
  }
  const connect = async () => client as unknown as PaseoClient
  const url = 'ws://127.0.0.1:16767/ws'

  const out = await startHydra({ board: 'lab', via: 'paseo', folder, url, meta: { ...meta, id: 'p1' }, connect })
  assert.deepEqual(out.hydra, { session: 'claude-code:hydra-agent', paseo: 'hydra-agent', folder })
  assert.deepEqual(created[0]!.env, { PNYX_HOME: process.env.PNYX_HOME, PNYX_BOARD: 'lab' })
  assert.equal(created[0]!.cwd, folder)
  assert.equal(state().board?.hydra.session, 'claude-code:hydra-agent')
  assert.equal((await startHydra({ board: 'lab', via: 'paseo', folder, url, meta: { ...meta, id: 'p1' }, connect })).event, 'none: duplicate')
  await assert.rejects(startHydra({ board: 'lab', via: 'paseo', folder, url, meta: { ...meta, id: 'p2' }, connect }), /already has a Hydra session/)
  assert.equal(created.length, 1)
})

test('setup hydra gives a Firstmate home the skill and a note, and task start asks it for workers', async () => {
  const { root, run, state } = lab()
  cpSync(join(ROOT, 'test', 'fixtures', 'firstmate-home'), join(root, 'home'), { recursive: true })
  const home = join(root, 'home')
  spawnSync('git', ['init', '-q', home])

  const out = setupHydra({ board: 'lab', home, meta })
  assert.equal(readFileSync(out.skill as string, 'utf8'), readFileSync(HYDRA_SKILL, 'utf8'))
  assert.equal(out.excluded, 'yes')
  assert.match(readFileSync(join(home, '.git', 'info', 'exclude'), 'utf8'), /^\/\.agents\/skills\/pnyx-hydra\/$/m)
  assert.equal(spawnSync('git', ['-C', home, 'status', '--porcelain', '.agents']).stdout.toString(), '')
  assert.equal(out.note, 'delivered')
  assert.deepEqual(state().board?.hydra, { id: 'firstmate:home', kind: 'firstmate', name: 'Hydra', home })
  setupHydra({ board: 'lab', home, meta })
  assert.equal(readFileSync(join(home, '.git', 'info', 'exclude'), 'utf8').match(/pnyx-hydra/g)?.length, 1)
  assert.equal(JSON.parse(readFileSync(join(home, 'inbox.json'), 'utf8')).length, 1)
  cpSync(join(ROOT, 'test', 'fixtures', 'firstmate-home'), join(root, 'other'), { recursive: true })
  setupHydra({ board: 'lab', home: join(root, 'other'), meta })
  assert.equal(state().board?.hydra.home, join(root, 'other'))
  setupHydra({ board: 'lab', home, meta })
  assert.equal(state().board?.hydra.home, home)

  run({ args: ['task', 'create', '--title', 'Fix login'] })
  const task = Object.values(state().cards).find(c => c.title === 'Fix login')!.id
  const asked = await startTask({ board: 'lab', task, prompt: 'Only the API', meta: { ...meta, id: 'w1' } })
  assert.equal(asked.sent, 'delivered')
  assert.equal(state().hydraMessages?.at(-1)?.action, 'worker')
  const notes = JSON.parse(readFileSync(join(home, 'inbox.json'), 'utf8')) as { request_id: string; body: string }[]
  assert.equal(notes.at(-1)!.request_id, 'pnyx:lab:w1')
  assert.match(notes.at(-1)!.body, new RegExp(`worker on task ${task} "Fix login"[\\s\\S]*Request: Only the API`))
})

test('board homes lists Firstmate homes beside each other and creates one board per home', () => {
  const { root, run } = lab()
  const base = join(root, 'homes')

  for (const name of ['fm-alpha', 'fm-beta', 'not-a-home']) {
    mkdirSync(join(base, name, 'bin'), { recursive: true })
  }

  for (const name of ['fm-alpha', 'fm-beta']) {
    mkdirSync(join(base, name, 'state'))
    mkdirSync(join(base, name, 'config'))
    writeFileSync(join(base, name, 'bin', 'fm-send.sh'), '')
  }

  const before = run({ args: ['board', 'homes', '--base', base] }) as { homes: { home: string; board: string }[] }
  assert.deepEqual(before.homes.map(h => [h.home.split('/').at(-1), h.board]), [['fm-alpha', 'none'], ['fm-beta', 'none']])
  commands.board(['create', '--firstmate', join(base, 'fm-alpha')])
  const after = run({ args: ['board', 'homes', '--base', base] }) as { homes: { board: string }[] }
  assert.deepEqual(after.homes.map(h => h.board), ['fm-alpha', 'none'])
  assert.equal(loadBoard({ board: 'fm-alpha' }).state.board?.hydra.kind, 'firstmate')
})

test('integrations show what is ready and how to set up the rest', async () => {
  lab()
  const out = await integrations({ board: 'lab', url: 'ws://127.0.0.1:1/ws' }) as { integrations: { name: string; status: string; setup: string }[] }
  const row = ({ name }: { name: string }) => out.integrations.find(i => i.name === name)!
  assert.equal(row({ name: 'hooks' }).status, 'hook script missing')
  assert.match(row({ name: 'paseo' }).status, /^not running: Paseo is not running/)
  assert.equal(row({ name: 'command' }).status, 'not set')
  assert.match(row({ name: 'firstmate' }).setup, /setup hydra --home/)
})

test('a hook entry naming an occupied task keeps its session off that task', () => {
  const { folder, run, state } = lab()
  run({ args: ['task', 'create', '--title', 'Busy', '--folder', folder] })
  const task = Object.values(state().cards).find(c => c.title === 'Busy')!.id
  const entry = ({ session, id }: { session: string; id: string }) => ({ v: 1, id, at, harness: 'claude', event: 'SessionStart', task, payload: { session_id: session, cwd: folder } })
  spoolWrite({ board: 'lab', entry: entry({ session: 'a', id: 'e1' }) })
  spoolWrite({ board: 'lab', entry: entry({ session: 'b', id: 'e2' }) })
  ingestSpool({ board: 'lab' })
  assert.deepEqual(state().cards[task]!.sessionIds, ['claude-code:a'])
})
