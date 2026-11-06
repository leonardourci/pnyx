export const selectionEnds = ({ field }: { field: HTMLTextAreaElement }) => field.selectionDirection === 'backward'
  ? {
    anchor: field.selectionEnd,
    focus: field.selectionStart,
  }
  : {
    anchor: field.selectionStart,
    focus: field.selectionEnd,
  }

export const select = ({
  field,
  anchor,
  focus,
}: {
  field: HTMLTextAreaElement
  anchor: number
  focus: number
}) => field.setSelectionRange(
  Math.min(
    anchor,
    focus,
  ),
  Math.max(
    anchor,
    focus,
  ),
  focus < anchor ? 'backward' : 'forward',
)
