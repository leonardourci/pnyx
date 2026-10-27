import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ESLint } from 'eslint'

const eslint = new ESLint({
  cwd: process.cwd(),
  fix: true,
  overrideConfig: {
    rules: {
      'pnyx/object-params': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
      '@typescript-eslint/no-empty-object-type': 'off',
      'no-undef': 'off',
      'no-sparse-arrays': 'off',
    },
  },
})

const format = async ({ code }: { code: string }) => {
  const [result] = await eslint.lintText(
    code,
    { filePath: 'src/lint-fixture.ts' },
  )
  assert.deepEqual(
    result.messages,
    [],
    code,
  )
  const output = result.output ?? code
  const [again] = await eslint.lintText(
    output,
    { filePath: 'src/lint-fixture.ts' },
  )
  assert.deepEqual(
    again.messages,
    [],
    output,
  )
  assert.equal(
    again.output ?? output,
    output,
    'autofix is stable',
  )

  return output
}

test(
  'lint:fix puts multiple items on separate lines',
  async () => {
    for (const [
      code,
      expected,
    ] of [
        [
          'const value = { a: 1, b: 2 }',
          'const value = {\n  a: 1,\n  b: 2,\n}',
        ],
        [
          'const { a, b } = source',
          'const {\n  a,\n  b,\n} = source',
        ],
        [
          'type Value = { a: number; b: number }',
          'type Value = {\n  a: number\n  b: number\n}',
        ],
        [
          'interface Value { a: number; b: number }',
          'interface Value {\n  a: number\n  b: number\n}',
        ],
        [
          'const value = [1, 2]',
          'const value = [\n  1,\n  2,\n]',
        ],
        [
          'const [a, ...rest] = source',
          'const [\n  a,\n  ...rest\n] = source',
        ],
        [
          'call(1, 2)',
          'call(\n  1,\n  2,\n)',
        ],
      ]) {
      assert.equal(
        await format({ code }),
        expected,
      )
    }
  },
)

test(
  'lint:fix breaks parameters and their parentheses in every kind of signature',
  async () => {
    // One per visitor the rule registers.
    for (const code of [
      'function f(a: number, b: number) {}',
      'class C { method(a: number, b: number) {} }',
      'const f = (a: number, b: number) => a',
      'declare function f(a: number, b: number): void',
      'abstract class C { abstract method(a: number, b: number): void }',
      'type F = (a: number, b: number) => void',
      'interface C { method(a: number, b: number): void }',
      'interface F { (a: number, b: number): void }',
      'interface C { new (a: number, b: number): object }',
      'type C = new (a: number, b: number) => object',
    ]) {
      assert.match(
        await format({ code }),
        /\(\n\s+a: number,\n\s+b: number,?\n\s*\)/u,
        code,
      )
    }
  },
)

test(
  'lint:fix allows zero or one item inline',
  async () => {
    for (const code of [
      'const value = {}',
      'const value = { a: 1 }',
      'const { a } = source',
      'type Value = { a: number }',
      'interface Value { a: number }',
      'const value = [1]',
      'function f(a: number) {}',
      'call(1)',
    ]) {
      assert.equal(
        await format({ code }),
        code,
      )
    }
  },
)

test(
  'lint:fix keeps each comment once while breaking items, beside a brace or before a type annotation',
  async () => {
    for (const code of [
      'const value = { a: 1, /* keep */ b: 2 }',
      'type Value = { a: number; /* keep */ b: number }',
      'type F = (a: number, /* keep */ b: number) => void',
      'const value = { /* keep */ a: 1, b: 2 }',
      'interface Value { a: number; b: number /* keep */ }',
      'const { /* keep */ a, b }: Value = source',
    ]) {
      const output = await format({ code })
      assert.equal(
        output.match(/\/\* keep \*\//gu)?.length,
        1,
        code,
      )
      assert.match(
        output,
        /[{(]\n[^]*\n[})]/u,
        output,
      )
    }
  },
)

test(
  'lint:fix separates bindings across skipped array slots without shifting them',
  async () => {
    const output = await format({ code: 'const [a,, c] = source' })
    assert.equal(
      output,
      'const [\n  a,,\n  c,\n] = source',
    )
    assert.deepEqual(
      new Function(
        'source',
        `${output}; return [a, c]`,
      )([
        10,
        20,
        30,
      ]),
      [
        10,
        30,
      ],
    )
  },
)
