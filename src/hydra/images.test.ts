import assert from 'node:assert/strict'
import { test } from 'node:test'
import { attachedImages, shownImageNames, shownImagePaths } from './images.ts'

test(
  'shown text treats a bare absolute image path as an image, but only tokens are sent',
  () => {
    const bare = '/Users/owner/.pnyx/hydras/default/copies/pnyx-1/.lavish/icons/alts-crop.png'
    const stored = '/home/.pnyx/hydras/default/attachments/0b6e1f3a-2c4d-4e5f-8a9b-0c1d2e3f4a5b.png'
    const text = `Compare ${bare}. With [image: ${stored}] and (/tmp/b.gif)`
    assert.deepEqual(
      shownImagePaths({ text }),
      [
        bare,
        stored,
        '/tmp/b.gif',
      ],
    )
    assert.deepEqual(
      [...shownImageNames({ text: `${text} ${bare}` }).values()],
      [
        'Image 1',
        'Image 2',
        'Image 3',
      ],
      'a path shown twice keeps one name',
    )
    assert.deepEqual(
      attachedImages({
        text: `${bare} /home/.pnyx/hydras/default/attachments/0b6e1f3a-2c4d-4e5f-8a9b-0c1d2e3f4a5b.png`,
        hydras: '/home/.pnyx/hydras',
      }),
      [],
      'a bare path is never sent to an agent as an image',
    )
  },
)

test(
  'a path inside a URL, a relative or home path, or another extension stays text',
  () => {
    assert.deepEqual(
      shownImagePaths({ text: 'https://example.com/a.png docs/b.png ~/c.png /d.pngx /e.png/f /g.PNG' }),
      [],
    )
  },
)
