import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { readCatalog } from '../src/thread/catalog.ts'
import { emptyBoard, reduce } from '../src/core/reducer.ts'
import { decidePush } from '../src/core/decide.ts'

const write = (path: string, text: string) => {
  mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text)
}

const skill = (name: string, description = 'Local fixture skill', extra = '') => `---\nname: ${name}\ndescription: ${description}\n${extra}---\nNever executed: $(touch not-a-command)\n`

function setup(t: { after(fn: () => void): void }, provider = 'claude') {
  const home = mkdtempSync(join(tmpdir(), 'pnyx-catalog-')); t.after(() => rmSync(home, { recursive: true, force: true }))
  const cwd = join(home, 'project/service'); mkdirSync(cwd, { recursive: true }); write(join(home, 'project/.git'), 'fixture worktree marker')
  const decision = decidePush({ state: emptyBoard(), key: 'fixture', input: { agent: { provider, sessionId: 'fixture-session', cwd } }, meta: { actor: 'test', at: '2026-10-14T10:00:00Z' } }); assert.ok('event' in decision)
  const card = reduce({ state: emptyBoard(), event: decision.event }).cards.c1!

  return { home, cwd, card, locations: { home, claude: join(home, '.claude'), codex: join(home, '.codex') } }
}

test('Claude catalog uses personal, project and enabled plugin metadata with deterministic precedence', async t => {
  const { home, cwd, card, locations } = setup(t)
  write(join(home, '.claude/skills/review/SKILL.md'), skill('review', 'Personal wins'))
  write(join(cwd, '.claude/skills/review/SKILL.md'), skill('review', 'Project copy'))
  write(join(home, 'project/.claude/commands/check.md'), '---\ndescription: Ancestor command\n---\nBody')
  write(join(home, '.claude/commands/review.md'), 'Command shadowed by skill')
  write(join(home, '.claude/skills/hidden/SKILL.md'), skill('hidden', 'Hidden', 'user-invocable: false\n'))
  write(join(home, '.claude/skills/off/SKILL.md'), skill('off'))
  write(join(home, '.claude/settings.json'), JSON.stringify({ enabledPlugins: { 'good@market': true, 'bad@market': false }, skillOverrides: { off: 'off' } }))
  const plugins = Object.fromEntries(['good', 'bad', 'other'].map(name => {
    const root = join(home, 'installed', name); write(join(root, '.claude-plugin/plugin.json'), JSON.stringify({ name, commands: ['./extra.md', '../../escape.md'] })); write(join(root, 'skills/plan/SKILL.md'), skill('plan')); write(join(root, 'extra.md'), '---\ndescription: Plugin command\n---\nBody')

    return [`${name}@market`, [{ scope: name === 'other' ? 'project' : 'user', projectPath: join(home, 'elsewhere'), installPath: root }]]
  }))
  write(join(home, '.claude/plugins/installed_plugins.json'), JSON.stringify({ version: 2, plugins }))
  write(join(home, 'escape.md'), 'Should not appear')
  const first = await readCatalog({
      card,
      locations,
    }), second = await readCatalog({
      card,
      locations,
    })
  assert.deepEqual(first, second)
  assert.deepEqual(first.suggestions.map(s => s.command), ['/check', '/good:extra', '/good:plan', '/review'])
  assert.equal(first.suggestions.at(-1)?.description, 'Personal wins')
  assert.equal(JSON.stringify(first).includes(home), false, 'catalog does not expose private filesystem paths')
})
test('Codex exposes native skill mentions and top-level prompts, with project scope and literal text', async t => {
  const { home, cwd, card, locations } = setup(t, 'codex')
  write(join(home, '.agents/skills/review/SKILL.md'), skill('review'))
  write(join(cwd, '.agents/skills/project/SKILL.md'), skill('project'))
  write(join(home, '.codex/prompts/draft.md'), '---\ndescription: Draft from $ARGUMENTS\n---\nBody is not returned')
  write(join(home, '.codex/prompts/nested/ignored.md'), 'Ignored')
  write(join(home, '.claude/commands/wrong.md'), 'Wrong harness')
  const result = await readCatalog({ card, locations })
  assert.deepEqual(result.suggestions.map(s => s.command), ['$project', '$review', '/prompts:draft'])
  assert.equal(result.suggestions.at(-1)?.description, 'Draft from $ARGUMENTS')
})
test('catalog bounds malformed metadata, oversized files, symlink cycles, and unavailable sessions', async t => {
  const { home, cwd, card, locations } = setup(t)
  write(join(cwd, '.claude/skills/broken/SKILL.md'), '---\nname: [bad\n---\nBody')
  write(join(cwd, '.claude/skills/large/SKILL.md'), 'x'.repeat(70_000))
  write(join(home, 'linked/SKILL.md'), skill('linked'))
  symlinkSync(join(home, 'linked'), join(cwd, '.claude/skills/linked'))
  mkdirSync(join(cwd, '.claude/commands'), { recursive: true }); symlinkSync(join(cwd, '.claude/commands'), join(cwd, '.claude/commands/loop'))
  const result = await readCatalog({ card, locations })
  assert.deepEqual(result.suggestions.map(s => s.command), ['/linked']); assert.match(result.note!, /could not be read/)
  assert.match((await readCatalog({ card: { ...card, agent: { ...card.agent!, cwd: undefined } }, locations })).unavailable!, /No working folder/)
  assert.match((await readCatalog({ card: { ...card, agent: { ...card.agent!, cwd: join(home, 'missing') } }, locations })).unavailable!, /unavailable/)
  assert.match((await readCatalog({ card: { ...card, agent: { ...card.agent!, provider: 'unknown' } }, locations })).unavailable!, /no supported/)
})
