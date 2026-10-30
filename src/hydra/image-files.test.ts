import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { execFileSync, spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { MAX_IMAGE_BYTES } from './images.ts'
import { hydraImageFile } from './image-files.ts'

test(
  'a Hydra serves its stored attachments and the images in its task copies, nothing else',
  () => {
    const home = realpathSync(mkdtempSync(join(
      tmpdir(),
      'pnyx-image-files-',
    )))
    const dir = join(
      home,
      'hydras',
      'default',
    )
    const shots = join(
      dir,
      'copies',
      'pnyx-1',
      '.lavish',
      'icons',
    )
    mkdirSync(
      shots,
      { recursive: true },
    )
    mkdirSync(join(
      dir,
      'attachments',
    ))
    const attachment = '0b6e1f3a-2c4d-4e5f-8a9b-0c1d2e3f4a5b.png'
    writeFileSync(
      join(
        dir,
        'attachments',
        attachment,
      ),
      'png',
    )
    writeFileSync(
      join(
        shots,
        'alts crop.png',
      ),
      'png',
    )
    writeFileSync(
      join(
        shots,
        'notes.txt',
      ),
      'text',
    )
    writeFileSync(
      join(
        shots,
        'photo.jpeg',
      ),
      'jpeg',
    )
    writeFileSync(
      join(
        shots,
        'huge.png',
      ),
      Buffer.alloc(MAX_IMAGE_BYTES + 1),
    )
    writeFileSync(
      join(
        home,
        'secret.png',
      ),
      'png',
    )
    symlinkSync(
      join(
        home,
        'secret.png',
      ),
      join(
        shots,
        'escape.png',
      ),
    )
    const served = ({ route }: { route: string }) => hydraImageFile({
      dir,
      route,
    })

    assert.deepEqual(
      served({ route: `attachments/${attachment}` }),
      {
        body: Buffer.from('png'),
        type: 'image/png',
        stored: true,
      },
    )
    assert.deepEqual(
      served({ route: 'copies/pnyx-1/.lavish/icons/alts%20crop.png' }),
      {
        body: Buffer.from('png'),
        type: 'image/png',
        stored: false,
      },
    )
    assert.deepEqual(
      served({ route: 'copies/pnyx-1/.lavish/icons/photo.jpeg' }),
      {
        body: Buffer.from('jpeg'),
        type: 'image/jpeg',
        stored: false,
      },
      'a .jpeg image',
    )
    assert.equal(
      served({ route: 'copies/pnyx-1/.lavish/icons/notes.txt' }),
      undefined,
      'another file type',
    )
    assert.equal(
      served({ route: 'copies/pnyx-1/.lavish/icons/huge.png' }),
      undefined,
      'over the image size limit',
    )
    assert.equal(
      served({ route: 'copies/pnyx-1/.lavish/icons/escape.png' }),
      undefined,
      'a link out of the copies folder',
    )
    assert.equal(
      served({ route: 'copies/..%2F..%2F..%2Fsecret.png' }),
      undefined,
      'an encoded climb out of the copies folder',
    )
    assert.equal(
      served({ route: 'copies/pnyx-1/missing.png' }),
      undefined,
      'a missing file',
    )
    assert.equal(
      served({ route: 'copies/%E0%A4%A.png' }),
      undefined,
      'a malformed escape',
    )
    assert.equal(
      served({ route: 'attachments/notes.png' }),
      undefined,
      'an attachment Pnyx did not name',
    )
  },
)

const lab = () => {
  const home = realpathSync(mkdtempSync(join(
    tmpdir(),
    'pnyx-image-escape-',
  )))
  const dir = join(
    home,
    'hydra',
  )
  const outside = join(
    home,
    'outside',
  )
  mkdirSync(dir)
  mkdirSync(outside)
  writeFileSync(
    join(
      outside,
      'private.png',
    ),
    'outside',
  )

  return {
    dir,
    outside,
  }
}

test(
  'a copies folder or a parent folder that links elsewhere never makes that place served',
  () => {
    const linkedRoot = lab()
    symlinkSync(
      linkedRoot.outside,
      join(
        linkedRoot.dir,
        'copies',
      ),
    )
    assert.equal(
      hydraImageFile({
        dir: linkedRoot.dir,
        route: 'copies/private.png',
      }),
      undefined,
    )

    const linkedParent = lab()
    mkdirSync(
      join(
        linkedParent.dir,
        'copies',
        'task',
      ),
      { recursive: true },
    )
    symlinkSync(
      linkedParent.outside,
      join(
        linkedParent.dir,
        'copies',
        'task',
        'shots',
      ),
    )
    assert.equal(
      hydraImageFile({
        dir: linkedParent.dir,
        route: 'copies/task/shots/private.png',
      }),
      undefined,
    )
  },
)

test(
  'a FIFO named like an image is refused at once instead of blocking the server',
  () => {
    const { dir } = lab()
    mkdirSync(join(
      dir,
      'copies',
    ))
    execFileSync(
      'mkfifo',
      [
        join(
          dir,
          'copies',
          'pipe.png',
        ),
      ],
    )
    // In a child process, so a reader that blocks fails this test by its deadline instead of hanging the run.
    const child = spawnSync(
      process.execPath,
      [
        '--conditions=source',
        '--input-type=module',
        '-e',
        `import { hydraImageFile } from ${JSON.stringify(new URL(
          './image-files.ts',
          import.meta.url,
        ).href)}
console.log(JSON.stringify(hydraImageFile({ dir: ${JSON.stringify(dir)}, route: 'copies/pipe.png' }) ?? null))`,
      ],
      {
        encoding: 'utf8',
        timeout: 5000,
      },
    )
    assert.equal(
      child.error,
      undefined,
    )
    assert.equal(
      child.stdout.trim(),
      'null',
    )
  },
)
