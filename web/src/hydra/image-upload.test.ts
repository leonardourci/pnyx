import assert from 'node:assert/strict'
import { test } from 'node:test'
import { MAX_IMAGE_BYTES } from '#hydra/images.ts'
import { checkImages } from './image-upload.ts'

test(
  'only images Pnyx can store are added, and every other file says why',
  () => {
    const screen = new File(
      ['png'],
      'screen.png',
      { type: 'image/png' },
    )
    const notes = new File(
      ['text'],
      'notes.txt',
      { type: 'text/plain' },
    )
    const large = new File(
      [new Uint8Array(MAX_IMAGE_BYTES + 1)],
      'large.png',
      { type: 'image/png' },
    )
    const {
      images,
      failures,
    } = checkImages({
      files: [
        screen,
        notes,
        large,
      ],
    })
    assert.deepEqual(
      images,
      [screen],
    )
    assert.deepEqual(
      failures,
      [
        'Only PNG, JPEG, GIF and WebP images can be added here.',
        'large.png is over 3.75 MB.',
      ],
    )
  },
)
