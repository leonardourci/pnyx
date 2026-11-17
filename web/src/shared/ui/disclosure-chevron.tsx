import { Icon } from './icon.tsx'

export function DisclosureChevron({
  expanded,
  size = 14,
}: {
  expanded: boolean
  size?: number
}) {
  return <Icon name={expanded ? 'chevron_up' : 'chevron_down'} size={size} />
}
