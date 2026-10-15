import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { listFolders } from '../src/projects/folders.ts'

process.env.PNYX_SEMANTIC = 'off'

test('folder search completes disk paths and previews empty, parent and new clone destinations', async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'pnyx-folders-')))
  process.env.PNYX_HOME = join(home, 'pnyx')

  try {
    const empty = join(home, 'empty'), parent = join(home, 'parent')
    mkdirSync(empty); mkdirSync(parent); mkdirSync(join(parent, 'nested'))
    writeFileSync(join(home, 'plain-file'), '')
    symlinkSync(empty, join(home, 'empty-link'))
    symlinkSync(join(home, 'missing'), join(home, 'empty-broken'))
    const match = await listFolders({ path: join(home, 'emp'), home })
    assert.deepEqual(match.folders.map(f => f.name), ['empty', 'empty-link'])
    assert.equal(match.selected, undefined)
    assert.equal((await listFolders({ path: empty, repository: 'git@example.com:team/repo.git', home })).cloneInto, empty)
    assert.equal((await listFolders({ path: parent, repository: 'https://example.com/team/repo.git/', home })).cloneInto, join(parent, 'repo'))
    assert.equal((await listFolders({ path: '~/parent', repository: '/local/repo.git', home })).cloneInto, join(parent, 'repo'))
    assert.equal((await listFolders({ path: join(home, 'new-folder'), repository: '/local/repo.git', home })).cloneInto, join(home, 'new-folder'))
    assert.equal((await listFolders({ path: '', repository: '/local/repo.git', home })).cloneInto, undefined)
    await assert.rejects(listFolders({ path: 'relative', home }), /absolute/)
    await assert.rejects(listFolders({ path: join(home, 'missing', 'nested'), home }), { code: 'ENOENT' })
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
