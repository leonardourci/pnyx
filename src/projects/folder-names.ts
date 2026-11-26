export const startsWithTyped = ({
  name,
  typed,
}: {
  name: string
  typed: string
}) => name.toLowerCase().startsWith(typed.toLowerCase())

export const hiddenUntilDotTyped = ({
  name,
  typed,
}: {
  name: string
  typed: string
}) => name.startsWith('.') && !typed.startsWith('.')
