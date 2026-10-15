import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { readCatalog } from '../src/thread/catalog.ts'
import { emptyHydra, reduce } from '../src/core/reducer.ts'
import { decidePush } from '../src/core/decide.ts'

const write = ({ path, text }: { path: string; text: string }) => {
  mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text)
}

const skill = ({ name, description = 'Local fixture skill', extra = '' }: { name: string; description?: string; extra?: string }) => `---\nname: ${name}\ndescription: ${description}\n${extra}---\nNever executed: $(touch not-a-command)\n`

function setup({ t, provider = 'claude' }: { t: { after(fn: () => void): void }; provider?: string }) {
  const home = mkdtempSync(join(tmpdir(), 'pnyx-catalog-')); t.after(() => rmSync(home, { recursive: true, force: true }))
  const cwd = join(home, 'project/service'); mkdirSync(cwd, { recursive: true }); write({ path: join(home, 'project/.git'), text: 'fixture worktree marker' })
  const decision = decidePush({ state: emptyHydra(), key: 'fixture', input: { agent: { provider, sessionId: 'fixture-session', cwd } }, meta: { actor: 'test', at: '2026-10-14T10:00:00Z' } }); assert.ok('event' in decision)
  const card = reduce({ state: emptyHydra(), event: decision.event }).cards.c1!

  return { home, cwd, card, locations: { home, claude: join(home, '.claude'), codex: join(home, '.codex') } }
}

test('Claude catalog uses personal, project and enabled plugin metadata with deterministic precedence', async t => {
  const { home, cwd, card, locations } = setup({ t })
  write({ path: join(home, '.claude/skills/review/SKILL.md'), text: skill({ name: 'review', description: 'Personal wins' }) })
  write({ path: join(cwd, '.claude/skills/review/SKILL.md'), text: skill({ name: 'review', description: 'Project copy' }) })
  write({ path: join(home, 'project/.claude/commands/check.md'), text: '---\ndescription: Ancestor command\n---\nBody' })
  write({ path: join(home, '.claude/commands/review.md'), text: 'Command shadowed by skill' })
  write({ path: join(home, '.claude/skills/hidden/SKILL.md'), text: skill({ name: 'hidden', description: 'Hidden', extra: 'user-invocable: false\n' }) })
  write({ path: join(home, '.claude/skills/off/SKILL.md'), text: skill({ name: 'off' }) })
  write({ path: join(home, '.claude/settings.json'), text: JSON.stringify({ enabledPlugins: { 'good@market': true, 'bad@market': false }, skillOverrides: { off: 'off' } }) })
  const plugins = Object.fromEntries(['good', 'bad', 'other'].map(name => {
    const root = join(home, 'installed', name); write({ path: join(root, '.claude-plugin/plugin.json'), text: JSON.stringify({ name, commands: ['./extra.md', '../../escape.md'] }) }); write({ path: join(root, 'skills/plan/SKILL.md'), text: skill({ name: 'plan' }) }); write({ path: join(root, 'extra.md'), text: '---\ndescription: Plugin command\n---\nBody' })

    return [`${name}@market`, [{ scope: name === 'other' ? 'project' : 'user', projectPath: join(home, 'elsewhere'), installPath: root }]]
  }))
  write({ path: join(home, '.claude/plugins/installed_plugins.json'), text: JSON.stringify({ version: 2, plugins }) })
  write({ path: join(home, 'escape.md'), text: 'Should not appear' })
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
  const { home, cwd, card, locations } = setup({ t, provider: 'codex' })
  write({ path: join(home, '.agents/skills/review/SKILL.md'), text: skill({ name: 'review' }) })
  write({ path: join(cwd, '.agents/skills/project/SKILL.md'), text: skill({ name: 'project' }) })
  write({ path: join(home, '.codex/prompts/draft.md'), text: '---\ndescription: Draft from $ARGUMENTS\n---\nBody is not returned' })
  write({ path: join(home, '.codex/prompts/nested/ignored.md'), text: 'Ignored' })
  write({ path: join(home, '.claude/commands/wrong.md'), text: 'Wrong harness' })
  const result = await readCatalog({ card, locations })
  assert.deepEqual(result.suggestions.map(s => s.command), ['$project', '$review', '/prompts:draft'])
  assert.equal(result.suggestions.at(-1)?.description, 'Draft from $ARGUMENTS')
})
test('catalog bounds malformed metadata, oversized files, symlink cycles, and unavailable sessions', async t => {
  const { home, cwd, card, locations } = setup({ t })
  write({ path: join(cwd, '.claude/skills/broken/SKILL.md'), text: '---\nname: [bad\n---\nBody' })
  write({ path: join(cwd, '.claude/skills/large/SKILL.md'), text: 'x'.repeat(70_000) })
  write({ path: join(home, 'linked/SKILL.md'), text: skill({ name: 'linked' }) })
  symlinkSync(join(home, 'linked'), join(cwd, '.claude/skills/linked'))
  mkdirSync(join(cwd, '.claude/commands'), { recursive: true }); symlinkSync(join(cwd, '.claude/commands'), join(cwd, '.claude/commands/loop'))
  const result = await readCatalog({ card, locations })
  assert.deepEqual(result.suggestions.map(s => s.command), ['/linked']); assert.match(result.note!, /could not be read/)
  assert.match((await readCatalog({ card: { ...card, agent: { ...card.agent!, cwd: undefined } }, locations })).unavailable!, /No working folder/)
  assert.match((await readCatalog({ card: { ...card, agent: { ...card.agent!, cwd: join(home, 'missing') } }, locations })).unavailable!, /unavailable/)
  assert.match((await readCatalog({ card: { ...card, agent: { ...card.agent!, provider: 'unknown' } }, locations })).unavailable!, /no supported/)
})
