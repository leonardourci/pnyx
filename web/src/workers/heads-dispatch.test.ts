import assert from 'node:assert/strict'
import { test } from 'node:test'
import { hydraDefault } from './heads-dispatch.ts'

test(
  'one default tuple keeps same-account controls and resets controls when changing account',
  () => {
    const rule = {
      harness: 'claude' as const,
      account: 'personal',
      model: 'opus',
      effort: 'high',
      mode: 'default',
      fast: true,
    }
    const same = hydraDefault({
      rule,
      next: {
        harness: 'claude',
        account: 'personal',
        model: 'sonnet',
      },
    })
    assert.deepEqual(
      same,
      {
        ...rule,
        model: 'sonnet',
      },
    )
    const other = hydraDefault({
      rule,
      next: {
        harness: 'claude',
        account: 'work',
        model: 'sonnet',
      },
    })
    assert.equal(
      other.account,
      'work',
    )
    assert.equal(
      other.model,
      'sonnet',
    )
    assert.equal(
      other.effort,
      undefined,
    )
    assert.equal(
      other.mode,
      undefined,
    )
    assert.equal(
      other.fast,
      undefined,
    )
    assert.equal(
      rule.account,
      'personal',
    )
    assert.equal(
      rule.model,
      'opus',
    )
  },
)
