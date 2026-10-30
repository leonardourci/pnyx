import assert from 'node:assert/strict'
import { test } from 'node:test'
import { clickTogglesCard } from './card-click.ts'

// Matches a selector list by tag name, so a control missing from the card's list turns a test red.
const element = ({ tag }: { tag: string }) => ({
  // eslint-disable-next-line pnyx/object-params -- Element.closest owns this signature.
  closest: (selector: string) => (selector.split(', ').includes(tag) ? {} : null),
}) as unknown as Element

const text = element({ tag: 'p' }), button = element({ tag: 'button' }), viewer = element({ tag: 'dialog' })
const onTheCard = new Set<unknown>([
  text,
  button,
])
const card = { contains: onTheCard.has.bind(onTheCard) }

test(
  'closing an image opened from a card leaves the card open',
  () => {
    assert.equal(
      clickTogglesCard({
        card,
        target: viewer,
        selecting: false,
      }),
      false,
    )
  },
)

test(
  'a click on the card itself toggles it, unless it lands on a control or ends a text selection',
  () => {
    assert.equal(
      clickTogglesCard({
        card,
        target: text,
        selecting: false,
      }),
      true,
      'plain card text',
    )
    assert.equal(
      clickTogglesCard({
        card,
        target: button,
        selecting: false,
      }),
      false,
      'a button keeps its own click',
    )
    assert.equal(
      clickTogglesCard({
        card,
        target: text,
        selecting: true,
      }),
      false,
      'selecting text',
    )
  },
)
