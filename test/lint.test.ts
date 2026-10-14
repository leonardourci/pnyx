import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ESLint } from 'eslint'
import { createElement, type FunctionComponent } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import ts from 'typescript'

const fix = async ({ code }: { code: string }) => {
  const eslint = new ESLint({ cwd: process.cwd(), fix: true })
  const [result] = await eslint.lintText(code, { filePath: 'web/src/lint-fixture.tsx' })

  return result.output ?? code
}

const render = ({ code }: { code: string }) => {
  const { outputText } = ts.transpileModule(code, {
    compilerOptions: { jsx: ts.JsxEmit.React, module: ts.ModuleKind.CommonJS },
  })
  const exports: { View?: FunctionComponent<{ a: string; title: string }> } = {}
  new Function('exports', 'React', outputText)(exports, { createElement })

  return renderToStaticMarkup(createElement(exports.View!, { a: 'A', title: 'Title' }))
}

for (const jsx of [
  '<span>Help <kbd>?</kbd></span>',
  '<p>Hi <b>x</b> and {a} done</p>',
  '<label>Reply to {title}</label>',
]) {
  test(`lint:fix keeps the rendered text of ${jsx}`, async () => {
    const code = `export const View = ({ a, title }: { a: string; title: string }) => ${jsx}\n`
    assert.equal(render({ code: await fix({ code }) }), render({ code }))
  })
}
