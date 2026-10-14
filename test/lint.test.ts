import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ESLint } from 'eslint'

const fix = async (code: string) => {
  const eslint = new ESLint({ cwd: process.cwd(), fix: true })
  const [result] = await eslint.lintText(code, { filePath: 'web/src/lint-fixture.tsx' })

  return result.output ?? code
}

test('lint:fix keeps the space between JSX text and an expression', async () => {
  const code = 'export const Label = ({ title }: { title: string }) => <label>Reply to {title}</label>\n'
  assert.equal(await fix(code), code)
})

test('lint:fix still puts each JSX element child on its own line', async () => {
  const code = 'export const Hint = () => <span>Help <kbd>?</kbd></span>\n'
  assert.notEqual(await fix(code), code)
})
