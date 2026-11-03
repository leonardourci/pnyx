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
