import assert from 'node:assert/strict'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { setupSkills, skillLinks, skillStatus } from '../src/integrations/skills/install.ts'

test('global skill links cover both harnesses, stay current and remove only links', t => {
  const userHome = mkdtempSync(join(tmpdir(), 'pnyx-skills-'))
  t.after(() => rmSync(userHome, { recursive: true, force: true }))
  const options = { userHome, claudeConfigDir: join(userHome, 'custom-claude') }
  const preview = setupSkills({ ...options, preview: true })
  assert.equal(preview.skills.length, 4)
  assert.ok(preview.skills.every(link => link.change === 'installed' && !existsSync(link.path)))
  assert.match(skillStatus(options), /missing:/)
  const installed = setupSkills(options)

  for (const link of installed.skills) {
    assert.ok(lstatSync(link.path).isSymbolicLink())
    assert.equal(readlinkSync(link.path), link.source)
    assert.equal(readFileSync(join(link.path, 'SKILL.md'), 'utf8'), readFileSync(join(link.source, 'SKILL.md'), 'utf8'))
  }

  assert.ok(!existsSync(join(userHome, '.claude')))
  assert.equal(skillStatus(options), 'ready')
  assert.ok(setupSkills(options).skills.every(link => link.change === 'unchanged'))
  setupSkills({ ...options, remove: true, preview: true })
  assert.equal(skillStatus(options), 'ready')
  setupSkills({ ...options, remove: true })
  assert.ok(installed.skills.every(link => !existsSync(link.path) && existsSync(join(link.source, 'SKILL.md'))))
  assert.ok(setupSkills({ ...options, remove: true }).skills.every(link => link.change === 'unchanged'))
})

test('conflicting directories, files and dangling links are preserved without partial setup', t => {
  const userHome = mkdtempSync(join(tmpdir(), 'pnyx-skills-conflict-'))
  t.after(() => rmSync(userHome, { recursive: true, force: true }))
  const options = { userHome, claudeConfigDir: '' }
  const links = skillLinks(options)
  const conflict = links.at(-1)!
  mkdirSync(dirname(conflict.path), { recursive: true })

  for (const kind of ['directory', 'file', 'link']) {
    if (kind === 'directory') {
      mkdirSync(conflict.path)
      writeFileSync(join(conflict.path, 'SKILL.md'), 'User skill')
    } else if (kind === 'file') {
      writeFileSync(conflict.path, 'User skill')
    } else {
      symlinkSync(join(userHome, 'missing'), conflict.path)
    }

    assert.throws(() => setupSkills(options), { code: 'SKILL_CONFLICT' })
    assert.ok(!existsSync(links[0]!.path))
    assert.match(skillStatus(options), /conflict:/)
    assert.ok(setupSkills({ ...options, remove: true }).skills.every(link => link.change === 'unchanged'))
    assert.ok(lstatSync(conflict.path))
    rmSync(conflict.path, { recursive: true, force: true })
  }
})

test('shared global folders and linked config parents install each skill once', t => {
  const userHome = mkdtempSync(join(tmpdir(), 'pnyx-skills-alias-'))
  t.after(() => rmSync(userHome, { recursive: true, force: true }))
  mkdirSync(join(userHome, '.agents'))
  symlinkSync(join(userHome, '.agents'), join(userHome, '.claude'), 'dir')
  const options = { userHome, claudeConfigDir: '' }
  assert.equal(setupSkills(options).skills.length, 2)
  assert.equal(skillStatus(options), 'ready')
  setupSkills({ ...options, remove: true })
  assert.ok(!existsSync(join(userHome, '.agents', 'skills', 'pnyx-worker')))
})
