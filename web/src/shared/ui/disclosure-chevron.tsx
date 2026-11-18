import { ICON_SIZE, Icon } from '#web-shared/icons.tsx'

export function DisclosureChevron({
  expanded,
  size = ICON_SIZE.inline,
}: {
  expanded: boolean
  size?: number
}) {
  return <Icon name={expanded ? 'chevron_up' : 'chevron_down'} size={size} />
}
