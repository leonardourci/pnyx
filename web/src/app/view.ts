export const titanTitle = ({ name }: { name: string }) => name || 'Untitled'

export const shouldReload = ({
  loaded,
  server,
}: {
  loaded: string | undefined
  server: string
}) =>
  Boolean(loaded && server && loaded !== server)
