import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fastModel, hydraFastReaches, type ModelOption } from './provider.ts'

const MODELS: ModelOption[] = [
  {
    value: 'default',
    label: 'Default',
    resolvedModel: 'claude-sonnet',
    isDefault: true,
  },
  {
    value: 'opus',
    label: 'Opus',
    resolvedModel: 'claude-opus',
    fast: true,
  },
]

test(
  'a model has Fast only when its catalog option offers it, by name or resolved model, and the default stands in for none',
  () => {
    assert.equal(
      fastModel({
        models: MODELS,
        model: 'opus',
      }),
      true,
    )
    assert.equal(
      fastModel({
        models: MODELS,
        model: 'claude-opus',
      }),
      true,
    )
    assert.equal(
      fastModel({ models: MODELS }),
      false,
    )
    assert.equal(
      fastModel({
        models: MODELS,
        model: 'default',
      }),
      false,
    )
    assert.equal(
      fastModel({
        models: [
          MODELS[1]!,
          {
            ...MODELS[0]!,
            fast: true,
          },
        ],
      }),
      true,
    )
    assert.equal(
      fastModel({
        models: MODELS,
        model: 'unknown',
      }),
      false,
    )
  },
)

test(
  'Hydra Fast reaches a model with a Fast tier, never reads the catalog when off, and a failed catalog read leaves Fast off',
  async () => {
    assert.equal(
      await hydraFastReaches({
        hydraFast: true,
        models: async () => MODELS,
        model: 'opus',
      }),
      true,
    )
    assert.equal(
      await hydraFastReaches({
        hydraFast: false,
        models: async () => {
          throw new Error('Hydra Fast off must not read the catalog')
        },
        model: 'opus',
      }),
      false,
    )
    assert.equal(
      await hydraFastReaches({
        hydraFast: true,
        models: async () => {
          throw new Error('catalog unavailable')
        },
        model: 'opus',
      }),
      false,
    )
  },
)
