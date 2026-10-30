import assert from 'node:assert/strict'
import { test } from 'node:test'
import { sliderValue } from './slider-value.ts'

const typed = ({ text }: { text: string }) => sliderValue({
  text,
  value: 480,
  min: 240,
  max: 2400,
})

test(
  'the number box commits a whole number past the slider’s end up to the limit, and nothing else',
  () => {
    assert.equal(
      typed({ text: '1200' }),
      1200,
    )
    assert.equal(
      typed({ text: '2401' }),
      undefined,
    )
    assert.equal(
      typed({ text: '' }),
      undefined,
    )
    assert.equal(
      typed({ text: '13.5' }),
      undefined,
    )
    assert.equal(
      typed({ text: '480' }),
      undefined,
    )
  },
)
