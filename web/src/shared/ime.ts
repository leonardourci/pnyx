// Safari sends the Enter that commits an IME candidate after compositionend, marked only by keyCode 229.
export const composing = ({ event }: { event: KeyboardEvent }) =>
  event.isComposing || event.keyCode === 229
