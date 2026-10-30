import { createRequire } from 'node:module'
import { createHash, randomUUID } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, parse } from 'node:path'
import { stageBundle, validateBundle } from './bundle.ts'
import { fail } from './protocol.ts'
import { replaceFile } from './output.ts'

const MAX_PACKAGES = 1000

type Package = {
  name: string
  version: string
  dependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
}

function packageRoot({ entry }: { entry: string }): string {
  let root = dirname(entry)

  while (root !== parse(root).root) {
    if (existsSync(join(
      root,
      'package.json',
    ))) {
      const manifest = JSON.parse(readFileSync(
        join(
          root,
          'package.json',
        ),
        'utf8',
      ))

      if (typeof manifest.name === 'string' && typeof manifest.version === 'string') {
        return realpathSync(root)
      }
    }

    root = dirname(root)
  }

  return fail({
    code: 'INVALID_BUNDLE',
    message: 'A native dependency has no package manifest',
  })
}

export function installBundle({
  source,
  directory,
}: {
  source: string
  directory: string
}): string {
  mkdirSync(
    directory,
    {
      recursive: true,
      mode: 0o700,
    },
  )
  const payload = mkdtempSync(join(
    directory,
    '.payload-',
  ))
  const compiled = join(
    source,
    'dist',
  )

  if (!existsSync(join(
    compiled,
    'agent-host/main.js',
  ))) {
    rmSync(
      payload,
      {
        recursive: true,
        force: true,
      },
    )
    fail({
      code: 'NOT_BUILT',
      message: 'Build Pnyx before installing its native runtime',
    })
  }

  try {
    for (const folder of [
      'agent-host',
      'workers',
      'store',
    ]) {
      cpSync(
        join(
          compiled,
          folder,
        ),
        join(
          payload,
          'dist',
          folder,
        ),
        {
          recursive: true,
          dereference: true,
        },
      )
    }

    writeFileSync(
      join(
        payload,
        'package.json',
      ),
      JSON.stringify({
        type: 'module',
        imports: { '#*.ts': './dist/*.js' },
      }),
    )
    let copied = 0
    const roots = new Map<string, string>()

    const copy = ({
      root,
      parent,
      ancestors = [],
    }: {
      root: string
      parent: string
      ancestors?: string[]
    }) => {
      if (ancestors.includes(root)) {
        return
      }

      const manifest: Package = JSON.parse(readFileSync(
        join(
          root,
          'package.json',
        ),
        'utf8',
      ))
      const installed = roots.get(manifest.name)

      if (installed === root) {
        return
      }

      const targetParent = installed ? parent : payload
      const target = join(
        targetParent,
        'node_modules',
        manifest.name,
      )

      if (++copied > MAX_PACKAGES) {
        fail({
          code: 'INVALID_BUNDLE',
          message: 'Native dependency closure exceeds its package bound',
        })
      }

      mkdirSync(
        dirname(target),
        { recursive: true },
      )
      cpSync(
        root,
        target,
        {
          recursive: true,
          dereference: true,
          // eslint-disable-next-line pnyx/object-params -- cpSync owns the filter signature.
          filter: path => path !== join(
            root,
            'node_modules',
          ),
        },
      )

      if (!installed) {
        roots.set(
          manifest.name,
          root,
        )
      }

      const require = createRequire(join(
        root,
        'package.json',
      ))
      const required = Object.keys(manifest.dependencies ?? {})
      const optional = Object.keys({
        ...manifest.optionalDependencies,
        ...manifest.peerDependencies,
      })

      for (const name of new Set([
        ...required,
        ...optional,
      ])) {
        let entry: string

        try {
          entry = require.resolve(`${name}/package.json`)
        } catch {
          try {
            entry = require.resolve(name)
          } catch {
            if (required.includes(name)) {
              fail({
                code: 'DEPENDENCY_MISSING',
                message: `Install the native dependency ${name}`,
              })
            }

            continue
          }
        }

        copy({
          root: packageRoot({ entry }),
          parent: target,
          ancestors: [
            ...ancestors,
            root,
          ],
        })
      }
    }

    const require = createRequire(join(
      source,
      'package.json',
    ))
    copy({
      root: packageRoot({ entry: require.resolve('@anthropic-ai/claude-agent-sdk') }),
      parent: payload,
    })
    const build = createHash('sha256').update(readFileSync(join(
      compiled,
      'agent-host/main.js',
    )))
      .digest('hex')
      .slice(
        0,
        16,
      )

    return stageBundle({
      source: payload,
      directory,
      build,
      entry: 'dist/agent-host/main.js',
    })
  } finally {
    rmSync(
      payload,
      {
        recursive: true,
        force: true,
      },
    )
  }
}

export function selectBundle({
  path,
  bundle,
}: {
  path: string
  bundle: string
}) {
  validateBundle({ directory: bundle })
  replaceFile({
    path,
    text: JSON.stringify({
      bundle,
      revision: randomUUID(),
    }),
  })
}
