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

for (const {
  code,
  expected,
} of [
    {
      code: 'const value = { a: 1, b: 2 }',
      expected: 'const value = {\n  a: 1,\n  b: 2,\n}',
    },
    {
      code: 'const { a, b } = source',
      expected: 'const {\n  a,\n  b,\n} = source',
    },
    {
      code: 'const { a = 1, ...rest } = source',
      expected: 'const {\n  a = 1,\n  ...rest\n} = source',
    },
    {
      code: 'type Value = { a: number; b: number }',
      expected: 'type Value = {\n  a: number\n  b: number\n}',
    },
    {
      code: 'interface Value { a: number; b: number }',
      expected: 'interface Value {\n  a: number\n  b: number\n}',
    },
    {
      code: 'const value = [1, 2]',
      expected: 'const value = [\n  1,\n  2,\n]',
    },
    {
      code: 'const [a, ...rest] = source',
      expected: 'const [\n  a,\n  ...rest\n] = source',
    },
    {
      code: 'call(1, 2)',
      expected: 'call(\n  1,\n  2,\n)',
    },
    {
      code: 'new Value(1, 2)',
      expected: 'new Value(\n  1,\n  2,\n)',
    },
    {
      code: "import('module', { with: { type: 'json' } })",
      expected: "import(\n  'module',\n  { with: { type: 'json' } },\n)",
    },
  ]) {
  test(
    `lint:fix puts multiple items on separate lines: ${code}`,
    async () => {
      assert.equal(
        await format({ code }),
        expected,
      )
    },
  )
}

for (const code of [
  'function f(a: number, b: number) {}',
  'const f = function (a: number, b: number) {}',
  'const f = (a: number, b: number) => a',
  'const f = <T>(a: number, b: number) => a',
  'class C { constructor(a: number, b: number) {} }',
  'class C { method(a: number, b: number) {} }',
  'const value = { method(a: number, b: number) {} }',
  'declare function f(a: number, b: number): void',
  'abstract class C { abstract method(a: number, b: number): void }',
  'class C { method(a: number, b: number): void; method(...args: number[]) {} }',
  'type F = (a: number, b: number) => void',
  'type F = <T>(a: number, b: number) => T',
  'interface C { method(a: number, b: number): void }',
  'interface F { (a: number, b: number): void }',
  'interface C { new (a: number, b: number): object }',
  'type C = new (a: number, b: number) => object',
]) {
  test(
    `lint:fix breaks parameters and their parentheses: ${code}`,
    async () => {
      assert.match(
        await format({ code }),
        /\(\n\s+a: number,\n\s+b: number,?\n\s*\)/u,
      )
    },
  )
}

for (const code of [
  'const value = {}',
  'const value = { a: 1 }',
  'const { a } = source',
  'type Value = { a: number }',
  'interface Value { a: number }',
  'const value = []',
  'const value = [1]',
  'const [a] = source',
  'function f() {}',
  'function f(a: number) {}',
  'const f = (a: number) => a',
  'type F = (a: number) => void',
  'type C = new (a: number) => object',
  'interface F { (a: number): void }',
  'call()',
  'call(1)',
  'new Value(1)',
]) {
  test(
    `lint:fix allows zero or one item inline: ${code}`,
    async () => {
      assert.equal(
        await format({ code }),
        code,
      )
    },
  )
}

for (const code of [
  'const value = { a: 1, /* keep */ b: 2 }',
  'const { a, /* keep */ b } = source',
  'type Value = { a: number; /* keep */ b: number }',
  'const value = [1, /* keep */ 2]',
  'call(1, /* keep */ 2)',
  'type F = (a: number, /* keep */ b: number) => void',
]) {
  test(
    `lint:fix preserves comments while breaking items: ${code}`,
    async () => {
      const output = await format({ code })
      assert.equal(
        output.match(/\/\* keep \*\//gu)?.length,
        1,
      )
      assert.match(
        output,
        /\/\* keep \*\/\n/u,
      )
    },
  )
}

for (const code of [
  'const value = { /* keep */ a: 1, b: 2 }',
  'const value = { a: 1, b: 2 /* keep */ }',
  'const { /* keep */ a, b } = source',
  'const { a, b /* keep */ } = source',
  'type Value = { /* keep */ a: number; b: number }',
  'type Value = { a: number; b: number /* keep */ }',
  'interface Value { /* keep */ a: number; b: number }',
  'interface Value { a: number; b: number /* keep */ }',
  'const { /* keep */ a, b }: Value = source',
]) {
  test(
    `lint:fix preserves comments beside object braces: ${code}`,
    async () => {
      const output = await format({ code })
      assert.equal(
        output.match(/\/\* keep \*\//gu)?.length,
        1,
      )
      assert.match(
        output,
        /\{\n/u,
      )
      assert.match(
        output,
        /\n\}/u,
      )
    },
  )
}

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
