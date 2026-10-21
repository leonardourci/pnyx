import assert from 'node:assert/strict'
import { test } from 'node:test'
import { modelOptions } from '../web/src/hydra/model-options.ts'

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
  'the configured rule model takes precedence and resolves explicit model IDs',
  () => {
    assert.equal(
      modelOptions({
        models,
        selected: 'sonnet',
      }).value,
      'sonnet',
    )
    assert.equal(
      modelOptions({
        models,
        selected: 'claude-sonnet-5-5',
      }).value,
      'sonnet',
    )
    assert.equal(
      modelOptions({
        models,
        selected: 'default',
      }).value,
      'opus',
    )
  },
)

test(
  'Codex uses the catalog default even when it is not the first entry',
  () => {
    const picker = modelOptions({
      models: [
        {
          value: 'small',
          label: 'Small Model',
        },
        {
          value: 'large',
          label: 'Large Model',
          isDefault: true,
        },
      ],
    })
    assert.equal(
      picker.value,
      'large',
    )
  },
)

test(
  'an explicit model missing from the catalog stays selected',
  () => {
    const picker = modelOptions({
      models,
      selected: 'custom-model',
    })
    assert.equal(
      picker.value,
      'custom-model',
    )
    assert.equal(
      picker.options.at(-1)?.label,
      'custom-model',
    )
  },
)

test(
  'an empty catalog does not invent a model or placeholder option',
  () => {
    assert.deepEqual(
      modelOptions({ models: [] }),
      {
        options: [],
        value: undefined,
      },
    )
  },
)
