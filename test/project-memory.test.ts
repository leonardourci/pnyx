import assert from 'node:assert/strict'
import { test } from 'node:test'
import { normalizedRemote } from '../src/projects/sources.ts'

test(
  'remote identities share across transport and keep unrelated projects, including local paths that differ by .git, separate',
  () => {
    const normalize = ({ remote }: { remote: string }) => normalizedRemote({
      remote,
      path: '/tmp',
    })
    assert.equal(
      normalize({ remote: 'git@github.com:owner/repo.git' }),
      normalize({ remote: 'https://token@GITHUB.com/owner/repo/' }),
    )
    assert.equal(
      normalize({ remote: 'ssh://git@github.com/owner/repo.git' }),
      normalize({ remote: 'https://github.com/owner/repo' }),
    )
    assert.notEqual(
      normalize({ remote: 'https://example.test/a/repo' }),
      normalize({ remote: 'https://example.test/b/repo' }),
    )
    // A local remote is its path, so paths that differ by .git are different projects.
    assert.equal(
      normalize({ remote: '/x/local-remote' }),
      normalize({ remote: 'file:///x/local-remote' }),
    )
    assert.notEqual(
      normalize({ remote: '/x/local-remote' }),
      normalize({ remote: 'file:///x/local-remote.git' }),
    )
  },
)
