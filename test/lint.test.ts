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

const objectErrors = async ({ code, filePath = 'src/lint-fixture.ts' }: {
  code: string
  filePath?: string
}) => {
  const eslint = new ESLint({ cwd: process.cwd() })
  const [result] = await eslint.lintText(code, { filePath })
  assert.ok(!result.messages.some(message => message.fatal), 'fixture parses')

  return result.messages.filter(message => message.ruleId === 'pnyx/object-params')
}

test('functions require one destructured object, including methods and internal callbacks', async () => {
  for (const code of [
    'function f(value: string) {}',
    'const f = (first: string, second: number) => first',
    'const f = (...values: string[]) => values',
    'const f = (options: { value: string }) => options.value',
    'class C { method(value: string) {} }',
    'class C { constructor(value: string) {} }',
    'abstract class C { abstract method(value: string): void }',
    'class C { method(value: { value: string }): void; method({ value }: { value: string }) {} }',
    'const object = { method(value: string) {} }',
    'interface C { method(value: string): void }',
    'type F = (value: string) => void',
    'declare function f(value: string): void',
    'type C = new (value: string) => object',
    'withWriter({ fn: writer => writer })',
    'const f = useCallback(value => value, [])',
    'setInternal(value => value)',
    'const listener = event => event; window.addEventListener("click", listener); listener(1)',
  ]) {
    assert.equal((await objectErrors({ code })).length, 1, code)
  }

  for (const code of [
    'function f() {}',
    'function f({ value }: { value: string }) {}',
    'const f = ({ value = 1 }: { value?: number } = {}) => value',
    'const f = <T>({ value }: { value: T }) => value',
    'type F = ({ value }: { value: string }) => void',
    'abstract class C { abstract method({ value }: { value: string }): void }',
    'class C { method({ value }: { value: string }): void; method({ value }: { value: string }) {} }',
  ]) {
    assert.equal((await objectErrors({ code })).length, 0, code)
  }
})

test('external callbacks keep their positional API signatures', async () => {
  for (const code of [
    '[1, 2].map((value, index) => value + index)',
    '[1, 2].sort((a, b) => a - b)',
    'Promise.resolve(1).then(value => value)',
    'new Promise((resolve, reject) => resolve(1))',
    'setTimeout(value => value, 1, 2)',
    'emitter.on("message", (data, binary) => data)',
    'window.addEventListener("click", event => event)',
    'watch("fixture", (type, file) => file)',
    'test("fixture", context => context)',
    'const [value, setValue] = useState(0); setValue(previous => previous + 1)',
    'const listener = event => event; window.addEventListener("click", listener); window.removeEventListener("click", listener)',
  ]) {
    assert.equal((await objectErrors({ code })).length, 0, code)
  }

  assert.equal((await objectErrors({
    code: 'const View = () => <Input onChange={event => event.target.value} />',
    filePath: 'web/src/lint-fixture.tsx',
  })).length, 0)
  assert.equal((await objectErrors({
    code: 'const View = () => <Resize onCommit={value => value} />',
    filePath: 'web/src/lint-fixture.tsx',
  })).length, 1)
})

test('external entry point exceptions apply only to their owning files and hooks', async () => {
  const code = 'export function serve(args: string[]) {}'
  assert.equal((await objectErrors({ code, filePath: 'src/server/server.ts' })).length, 0)
  assert.equal((await objectErrors({ code })).length, 1)
  const transform = 'new Transform({ transform(chunk, encoding, done) { done(null, chunk) } })'
  assert.equal((await objectErrors({
    code: transform, filePath: 'src/search/models.ts',
  })).length, 0)
  assert.equal((await objectErrors({ code: transform })).length, 1)
})
