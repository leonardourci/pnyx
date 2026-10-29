import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
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
        file: join(
          dir,
          'attachments',
          attachment,
        ),
        type: 'image/png',
        stored: true,
      },
    )
    assert.deepEqual(
      served({ route: 'copies/pnyx-1/.lavish/icons/alts%20crop.png' }),
      {
        file: join(
          shots,
          'alts crop.png',
        ),
        type: 'image/png',
        stored: false,
      },
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
      served({ route: 'attachments/notes.png' }),
      undefined,
      'an attachment Pnyx did not name',
    )
  },
)
