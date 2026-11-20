import { ESLint } from 'eslint'
import { expect, test } from 'vitest'

test(
  'only the Node watcher assignment keeps its positional signature',
  async () => {
    const eslint = new ESLint()
    const cases = [
      {
        source: "import fs from 'node:fs'; fs.watch = ((...args: unknown[]) => Reflect.apply(original, fs, args)) as typeof fs.watch",
        errors: 0,
      },
      {
        source: "import * as filesystem from 'node:fs'; filesystem.watch = (...args: unknown[]) => Reflect.apply(original, filesystem, args)",
        errors: 0,
      },
      {
        source: 'function ordinary(path, listener) { return listener(path) }',
        errors: 1,
      },
      {
        source: 'const fs = {}; fs.watch = (...args) => original(...args)',
        errors: 1,
      },
      {
        source: "import fs from 'node:fs'; fs.readFile = (...args) => original(...args)",
        errors: 1,
      },
    ]

    for (const {
      source,
      errors,
    } of cases) {
      const results = await eslint.lintText(
        source,
        { filePath: 'tests/watcher-policy.ts' },
      )
      expect(results).toHaveLength(1)
      expect(results[0]!.fatalErrorCount).toBe(0)
      const rejected = results.flatMap(result => result.messages)
        .filter(message => message.ruleId === 'pnyx/object-params')
      expect(rejected).toHaveLength(errors)
    }
  },
)
