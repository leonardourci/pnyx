import { createHash, randomUUID } from 'node:crypto'
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { fail } from './protocol.ts'

const MANIFEST = 'native-bundle.json'
const FORMAT = 1
export type Bundle = {
  format: number
  build: string
  entry: string
  files: Record<string, string>
}

function contents({
  directory,
  prefix = '',
}: {
  directory: string
  prefix?: string
}): Record<string, string> {
  const files: Record<string, string> = {}

  for (const item of readdirSync(
    join(
      directory,
      prefix,
    ),
    { withFileTypes: true },
  )) {
    const name = join(
      prefix,
      item.name,
    )

    if (name === MANIFEST) {
      continue
    }

    if (item.isSymbolicLink()) {
      fail({
        code: 'MUTABLE_BUNDLE',
        message: 'Runtime bundles cannot reference code outside their copied tree',
      })
    }

    if (item.isDirectory()) {
      Object.assign(
        files,
        contents({
          directory,
          prefix: name,
        }),
      )
    } else if (item.isFile()) {
      files[name] = createHash('sha256').update(readFileSync(join(
        directory,
        name,
      )))
        .digest('hex')
    } else {
      fail({
        code: 'INVALID_BUNDLE',
        message: 'Runtime bundles contain only files and directories',
      })
    }
  }

  return Object.fromEntries(Object.entries(files).sort((
    [left],
    [right],
  ) => left.localeCompare(right)))
}

export function validateBundle({ directory }: { directory: string }): Bundle {
  const canonical = realpathSync(directory)

  if (!lstatSync(join(
    canonical,
    MANIFEST,
  )).isFile()) {
    fail({
      code: 'INVALID_BUNDLE',
      message: 'The runtime manifest must be a regular copied file',
    })
  }

  const manifest: Bundle = JSON.parse(readFileSync(
    join(
      canonical,
      MANIFEST,
    ),
    'utf8',
  ))
  const entry = typeof manifest.entry === 'string' ? resolve(
    canonical,
    manifest.entry,
  ) : ''
  const inside = entry && !isAbsolute(relative(
    canonical,
    entry,
  )) && !relative(
    canonical,
    entry,
  ).startsWith('..')

  if (manifest.format !== FORMAT || !inside || !manifest.files || !manifest.files[manifest.entry]
    || JSON.stringify(contents({ directory: canonical })) !== JSON.stringify(manifest.files)) {
    fail({
      code: 'INVALID_BUNDLE',
      message: 'The immutable native runtime bundle failed validation',
    })
  }

  return manifest
}

export function stageBundle({
  source,
  directory,
  build,
  entry,
}: {
  source: string
  directory: string
  build: string
  entry: string
}) {
  if (!/^[a-zA-Z0-9.-]+$/.test(build) || isAbsolute(entry) || entry.split('/').includes('..')) {
    fail({
      code: 'INVALID_BUNDLE',
      message: 'Use a relative runtime entry and a plain build identifier',
    })
  }

  mkdirSync(
    directory,
    {
      recursive: true,
      mode: 0o700,
    },
  )
  const sourcePath = realpathSync(source)
  const destinationRoot = realpathSync(directory)
  const belowSource = relative(
    sourcePath,
    destinationRoot,
  )

  if (belowSource === '' || !belowSource.startsWith('..') && !isAbsolute(belowSource)) {
    fail({
      code: 'INVALID_BUNDLE',
      message: 'Stage native bundles outside their source payload',
    })
  }

  const stage = join(
    directory,
    `.stage-${randomUUID()}`,
  )

  try {
    // The staging input is a built production payload; dereferencing pins its dependency bytes.
    cpSync(
      source,
      stage,
      {
        recursive: true,
        dereference: true,
      },
    )
    const files = contents({ directory: stage })

    if (!files[entry]) {
      fail({
        code: 'INVALID_BUNDLE',
        message: 'The runtime entry is missing from the staged payload',
      })
    }

    const identity = createHash('sha256').update(JSON.stringify({
      files,
      entry,
      format: FORMAT,
    }))
      .digest('hex')
    const destination = join(
      directory,
      `${build}-${identity.slice(
        0,
        16,
      )}`,
    )
    const manifest: Bundle = {
      format: FORMAT,
      build,
      entry,
      files,
    }
    writeFileSync(
      join(
        stage,
        MANIFEST,
      ),
      JSON.stringify(manifest),
      { mode: 0o400 },
    )
    validateBundle({ directory: stage })

    for (const file of Object.keys(files)) {
      const path = join(
        stage,
        file,
      )
      const executable = (lstatSync(path).mode & 0o111) !== 0
      chmodSync(
        path,
        executable ? 0o500 : 0o400,
      )
    }

    if (existsSync(destination)) {
      validateBundle({ directory: destination })

      return destination
    }

    renameSync(
      stage,
      destination,
    )

    return destination
  } finally {
    rmSync(
      stage,
      {
        recursive: true,
        force: true,
      },
    )
  }
}
