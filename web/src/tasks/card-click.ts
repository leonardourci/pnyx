const CONTROLS = 'a, button, input, textarea, form, summary, .menu, .resize'

// React bubbles a portal's events, like the image viewer's, to the card, so only ones in the card's own DOM count.
const onCard = ({
  card,
  target,
}: {
  card: Pick<Node, 'contains'>
  target: EventTarget | null
}) => target !== null && card.contains(target as Node)

export const clickTogglesCard = ({
  card,
  target,
  selecting,
}: {
  card: Pick<Node, 'contains'>
  target: Element | null
  selecting: boolean
}) => onCard({
  card,
  target,
}) && !target!.closest(CONTROLS) && !selecting
