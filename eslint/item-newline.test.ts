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
