import type { LoadHookSync } from 'node:module'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

// eslint-disable-next-line pnyx/object-params -- Node owns the load hook's signature.
export const load: LoadHookSync = (
  url,
  context,
  next,
) => {
  if (!url.endsWith('.tsx')) {
    return next(
      url,
      context,
    )
  }

  return {
    format: 'module',
    shortCircuit: true,
    source: ts.transpileModule(
      readFileSync(
        fileURLToPath(url),
        'utf8',
      ),
      {
        compilerOptions: {
          jsx: ts.JsxEmit.ReactJSX,
          module: ts.ModuleKind.ESNext,
        },
      },
    ).outputText,
  }
}
