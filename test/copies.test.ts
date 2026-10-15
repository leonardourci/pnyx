import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { commands } from '../src/cli/commands.ts'
import { startTask } from '../src/cli/start.ts'
import { decidePush } from '../src/core/decide.ts'
import { settleDone } from '../src/copies/copies.ts'
import { ingestSpool } from '../src/integrations/hooks/ingest.ts'
import { project } from '../src/projects/cli.ts'
import { hydraDir, loadHydra, withWriter } from '../src/store/hydra-store.ts'

process.env.PNYX_SEMANTIC = 'off'
const meta = { at: '2026-10-15T00:00:00Z', actor: 'test' }
const ROOT = join(import.meta.dirname, '..')
const GIT_ENV = { GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com' }

const git = ({ cwd, args }: { cwd: string; args: string[] }) =>
  execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: { ...process.env, ...GIT_ENV }, stdio: ['ignore', 'pipe', 'pipe'] }).trim()

async function lab() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pnyx-copies-')))
  process.env.PNYX_HOME = join(root, 'pnyx')
  const repo = join(root, 'app')
  mkdirSync(repo)
  git({ cwd: repo, args: ['init', '-q', '-b', 'main'] })
  writeFileSync(join(repo, 'README.md'), 'app\n')
  git({ cwd: repo, args: ['add', '.'] })
  git({ cwd: repo, args: ['commit', '-q', '-m', 'init'] })
  const run = ({ args, hydra = 'lab' }: { args: string[]; hydra?: string }) => commands[args[0] as keyof typeof commands]([...args.slice(1), '--hydra', hydra])
  run({ args: ['hydra', 'create', 'lab'] })
  run({ args: ['hydra', 'set', '--command', 'true'] })
  await project(['add', repo, '--hydra', 'lab'])
  run({ args: ['task', 'create', '--title', 'Fix it', '--key', 'fix', '--project', 'app'] })
  const state = () => loadHydra({ hydraId: 'lab' }).state
  const task = state().keys.fix!

  return { root, repo, run, state, task, card: () => state().cards[task]! }
}

test('a start makes the task its own git worktree and later starts reuse it', async () => {
  const { repo, state, task, card } = await lab()
  await startTask({ hydraId: 'lab', task, via: 'command', meta: { ...meta, id: 's1' } })
  const copy = card().copy!
  assert.equal(copy.path, realpathSync(join(hydraDir({ hydraId: 'lab' }), 'copies', `${task}-app`)))
  assert.deepEqual({ via: copy.via, branch: copy.branch, base: copy.base, state: copy.state, project: copy.project }, { via: 'worktree', branch: `pnyx/lab-${task}`, base: 'main', state: 'active', project: repo })
  assert.equal(git({ cwd: copy.path, args: ['rev-parse', '--abbrev-ref', 'HEAD'] }), `pnyx/lab-${task}`)
  assert.equal(card().folder, copy.path)
  assert.equal(card().launch?.folder, copy.path)

  await startTask({ hydraId: 'lab', task, via: 'command', meta: { ...meta, id: 's2' } })
  assert.equal(Object.values(state().cards).filter(c => c.copy).length, 1)
  assert.equal(card().launch?.folder, copy.path)
})

test('a copy made under boards/ keeps working after its Hydra moves to hydras/', async () => {
  const { root, repo, run, task, card } = await lab()
  await startTask({ hydraId: 'lab', task, via: 'command', meta: { ...meta, id: 's1' } })
  const home = process.env.PNYX_HOME!
  const { path, branch } = card().copy!
  writeFileSync(join(path, 'fix.txt'), 'fixed\n')
  git({ cwd: path, args: ['add', '.'] })
  git({ cwd: path, args: ['commit', '-q', '-m', 'fix'] })
  git({ cwd: repo, args: ['merge', '-q', '--ff-only', branch!] })
  const old = join(home, 'boards/lab/copies', `${task}-app`)
  const moved = join(home, 'hydras/lab/copies', `${task}-app`)
  // Lay the Hydra out as an older version left it, then look from a new process's view.
  renameSync(join(home, 'hydras'), join(home, 'boards'))
  const log = join(home, 'boards/lab/events.jsonl')
  writeFileSync(log, readFileSync(log, 'utf8').replaceAll(`${home}/hydras/`, `${home}/boards/`))
  rmSync(join(home, 'boards/lab/snapshot.json'))
  git({ cwd: repo, args: ['worktree', 'repair', old] })
  symlinkSync(home, join(root, 'later'))
  process.env.PNYX_HOME = join(root, 'later')

  assert.equal(card().copy?.path, old)
  assert.ok(git({ cwd: repo, args: ['worktree', 'list', '--porcelain'] }).includes(`worktree ${moved}\n`))
  run({ args: ['move', task, 'done', '--actor', 'web'] })
  assert.equal(settleDone({ hydraId: 'lab' }), 1)
  assert.deepEqual([card().copy?.state, card().copy?.path], ['removed', moved])
  assert.equal(existsSync(moved), false)
})

test('Done removes a clean, landed copy and keeps its branch', async () => {
  const { repo, run, task, card } = await lab()
  await startTask({ hydraId: 'lab', task, via: 'command', meta })
  const { path, branch } = card().copy!
  writeFileSync(join(path, 'fix.txt'), 'fixed\n')
  git({ cwd: path, args: ['add', '.'] })
  git({ cwd: path, args: ['commit', '-q', '-m', 'fix'] })
  git({ cwd: repo, args: ['merge', '-q', '--ff-only', branch!] })

  assert.equal(settleDone({ hydraId: 'lab' }), 0)
  run({ args: ['move', task, 'done', '--actor', 'web'] })
  assert.equal(settleDone({ hydraId: 'lab' }), 1)
  assert.equal(card().copy?.state, 'removed')
  assert.equal(existsSync(path), false)
  assert.ok(git({ cwd: repo, args: ['rev-parse', '--verify', branch!] }))
  assert.equal(settleDone({ hydraId: 'lab' }), 0)
})

test('an unlanded or dirty copy is flagged for Hydra, and only the owner discards it', async () => {
  const { run, state, task, card } = await lab()
  await startTask({ hydraId: 'lab', task, via: 'command', meta })
  const { path } = card().copy!
  writeFileSync(join(path, 'draft.txt'), 'draft\n')
  run({ args: ['move', task, 'done', '--actor', 'web'] })
  settleDone({ hydraId: 'lab' })
  assert.equal(card().copy?.state, 'flagged')
  assert.equal(card().copy?.reason, 'it has uncommitted changes')
  assert.match(state().hydraMessages!.at(-1)!.text, new RegExp(`copy of task ${task}.*uncommitted changes`))
  assert.ok(existsSync(path))

  await assert.rejects(async () => run({ args: ['task', 'copy', task, 'remove', '--safe', '--actor', 'hydra'] }), /uncommitted changes/)
  await assert.rejects(async () => run({ args: ['task', 'copy', task, 'remove', '--discard', '--actor', 'hydra'] }), /needs the owner/)
  const asked = await run({ args: ['task', 'copy', task, 'remove', '--discard'] }) as Record<string, unknown>
  assert.equal(asked.confirmation, 'needed')
  assert.ok(existsSync(path))
  await run({ args: ['task', 'copy', task, 'remove', '--discard', '--confirm', String(asked.token)] })
  assert.equal(card().copy?.state, 'removed')
  assert.equal(existsSync(path), false)
})

test('a merged linked pull request counts as landed when Hydra settles a flagged copy', async () => {
  const { run, task, card } = await lab()
  await startTask({ hydraId: 'lab', task, via: 'command', meta })
  const { path } = card().copy!
  writeFileSync(join(path, 'fix.txt'), 'fixed\n')
  git({ cwd: path, args: ['add', '.'] })
  git({ cwd: path, args: ['commit', '-q', '-m', 'fix'] })
  run({ args: ['move', task, 'done', '--actor', 'web'] })
  settleDone({ hydraId: 'lab' })
  assert.match(card().copy?.reason ?? '', /has not landed on main/)

  run({ args: ['link', task, '--url', 'https://github.com/o/app/pull/7', '--state', 'merged'] })
  await run({ args: ['task', 'copy', task, 'remove', '--actor', 'hydra'] })
  assert.equal(card().copy?.state, 'removed')
  assert.equal(existsSync(path), false)
})

test('--in-place works in the project folder unless another Hydra has a worker there', async () => {
  const { repo, run, task, card } = await lab()
  run({ args: ['hydra', 'create', 'other'], hydra: 'other' })
  run({ args: ['task', 'create', '--title', 'Elsewhere', '--key', 'elsewhere'], hydra: 'other' })
  const elsewhere = loadHydra({ hydraId: 'other' }).state.keys.elsewhere!
  const payload = JSON.stringify({ session_id: 'other-1', hook_event_name: 'SessionStart', cwd: repo, prompt: 'go' })
  const hooked = spawnSync('/bin/sh', [join(ROOT, 'setup', 'hooks', 'pnyx-hook.sh'), 'claude', 'SessionStart'], { input: payload, env: { PATH: process.env.PATH, PNYX_HOME: process.env.PNYX_HOME, PNYX_HYDRA: 'other', PNYX_TASK: elsewhere } })
  assert.equal(hooked.status, 0)
  ingestSpool({ hydraId: 'other' })
  assert.deepEqual(loadHydra({ hydraId: 'other' }).state.cards[elsewhere]!.sessionIds, ['claude-code:other-1'])

  await assert.rejects(startTask({ hydraId: 'lab', task, via: 'command', inPlace: true, meta }), /worker of Hydra other already runs/)
  await assert.rejects(startTask({ hydraId: 'lab', task, via: 'command', folder: repo, meta }), /worker of Hydra other/)
  assert.equal(card().copy, undefined)

  run({ args: ['task', 'detach', elsewhere], hydra: 'other' })
  await startTask({ hydraId: 'lab', task, via: 'command', inPlace: true, meta })
  assert.equal(card().launch?.folder, repo)
  assert.equal(card().copy, undefined)
})

test('a project copy command or a command with its own folder replaces the worktree', async () => {
  const { root, repo, run, task, card } = await lab()
  const made = join(root, 'made')
  await project(['set', 'app', '--copy', `mkdir -p "${made}/$PNYX_TASK" && echo "$PNYX_PROJECT" && echo "${made}/$PNYX_TASK"`, '--hydra', 'lab'])
  await startTask({ hydraId: 'lab', task, via: 'command', meta })
  assert.deepEqual({ path: card().copy?.path, via: card().copy?.via }, { path: join(made, task), via: 'command' })
  assert.equal(card().launch?.folder, join(made, task))

  run({ args: ['task', 'create', '--title', 'Own folder', '--key', 'own', '--project', 'app'] })
  run({ args: ['hydra', 'set', '--command-folder', 'own'] })
  const own = loadHydra({ hydraId: 'lab' }).state.keys.own!
  await startTask({ hydraId: 'lab', task: own, via: 'command', meta })
  const card2 = loadHydra({ hydraId: 'lab' }).state.cards[own]!
  assert.equal(card2.launch?.folder, repo)
  assert.equal(card2.copy, undefined)
})

test('a deleted copy is made again on its branch, and a working agent keeps its copy in Done', async () => {
  const { run, task, card } = await lab()
  await startTask({ hydraId: 'lab', task, via: 'command', meta })
  const { path, branch } = card().copy!
  rmSync(path, { recursive: true, force: true })
  await startTask({ hydraId: 'lab', task, via: 'command', meta })
  assert.equal(card().copy?.path, path)
  assert.equal(git({ cwd: path, args: ['symbolic-ref', '--short', 'HEAD'] }), branch)

  withWriter({
    hydraId: 'lab',
    fn: ({ writer }) => {
      const pushed = decidePush({ state: writer.state, key: card().key, input: { activity: 'working' }, meta })

      if ('event' in pushed) {
        writer.append({ event: pushed.event })
      }
    },
  })
  run({ args: ['move', task, 'done', '--actor', 'web'] })
  assert.equal(settleDone({ hydraId: 'lab' }), 0)
  assert.ok(existsSync(path))
})

test('a confirmed-safe copy whose commit is on no branch stays', async () => {
  const { task, card, run } = await lab()
  await startTask({ hydraId: 'lab', task, via: 'command', meta })
  const { path } = card().copy!
  git({ cwd: path, args: ['checkout', '-q', '--detach'] })
  writeFileSync(join(path, 'loose.txt'), 'loose\n')
  git({ cwd: path, args: ['add', '.'] })
  git({ cwd: path, args: ['commit', '-q', '-m', 'loose'] })
  await run({ args: ['task', 'copy', task, 'remove', '--safe', '--actor', 'hydra'] })
  assert.equal(card().copy?.state, 'flagged')
  assert.equal(card().copy?.reason, 'its commit is on no branch')
  assert.ok(existsSync(path))
})

test('a copy from the project copy command is released, never deleted', async () => {
  const { root, run, task, card } = await lab()
  const made = join(root, 'made')
  await project(['set', 'app', '--copy', `mkdir -p "${made}/$PNYX_TASK" && echo "${made}/$PNYX_TASK"`, '--hydra', 'lab'])
  await startTask({ hydraId: 'lab', task, via: 'command', meta })
  run({ args: ['move', task, 'done', '--actor', 'web'] })
  settleDone({ hydraId: 'lab' })
  assert.equal(card().copy?.state, 'flagged')
  await run({ args: ['task', 'copy', task, 'remove', '--safe', '--actor', 'hydra'] })
  assert.equal(card().copy?.state, 'removed')
  assert.match(card().copy?.reason ?? '', /folder stays/)
  assert.ok(existsSync(join(made, task)))
  await assert.rejects(startTask({ hydraId: 'lab', task, via: 'command', folder: made, inPlace: true, meta }), /either --folder or --in-place/)
})
