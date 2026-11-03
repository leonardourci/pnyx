import assert from 'node:assert/strict'
import { test } from 'node:test'
import { modelOptions } from './model-options.ts'

const models = [
  {
    value: 'default',
    label: 'Default (recommended)',
    resolvedModel: 'claude-opus-5-5',
  },
  {
    value: 'opus',
    label: 'Opus 5.5',
    resolvedModel: 'claude-opus-5-5',
  },
  {
    value: 'sonnet',
    label: 'Sonnet 5.5',
    resolvedModel: 'claude-sonnet-5-5',
  },
]

test(
  'the model picker resolves the CLI default to a concrete named option',
  () => {
    const picker = modelOptions({ models })
    assert.equal(
      picker.value,
      'opus',
    )
    assert.deepEqual(
      picker.options.map(option => option.label),
      [
        'Opus 5.5',
        'Sonnet 5.5',
      ],
    )
    assert.equal(
      picker.options.some(option => !option.value || option.value === 'default'),
      false,
    )
  },
)

test(
  'one default tuple keeps same-account controls and resets controls when changing account',
  async () => {
    const { hydraDefault } = await import('./heads-dispatch.ts')
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
