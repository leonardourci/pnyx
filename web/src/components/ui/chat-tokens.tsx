import { createContext, Fragment, useContext, type ReactNode } from 'react'
import type { SavedLabelColor } from '../../../../src/core/model.ts'
import type { Suggestion } from '../../../../src/thread/catalog.ts'
import { knownCommands } from '../../hydra/chat-tokens.ts'
import { SkillBadge } from './skill-badge.tsx'
import type { SkillReference } from '../../../../src/thread/skill-reference.ts'
import { CHIP_SPACE } from '../../hydra/draft.ts'

export const ChatTokensContext = createContext<{
  suggestions?: Suggestion[]
  colors?: SavedLabelColor[]
}>({})

export function SkillToken({ skill }: { skill: SkillReference }) {
  const { colors } = useContext(ChatTokensContext)

  return <>{CHIP_SPACE}<SkillBadge skill={skill} colors={colors} />{CHIP_SPACE}</>
}

export function ChatTokenText({
  text,
  leading = false,
  codexOnly = false,
}: {
  text: string
  leading?: boolean
  codexOnly?: boolean
}) {
  const {
    suggestions = [],
    colors,
  } = useContext(ChatTokensContext)
  const commands = knownCommands({
    text,
    suggestions,
    leading,
    codexOnly,
  })
  let end = 0
  const tokens: ReactNode[] = commands.map(command => {
    const before = text.slice(
      end,
      command.start,
    )
    end = command.end

    return (
      <Fragment key={command.start}>
        {before}{CHIP_SPACE}<SkillBadge
          skill={{
            name: command.item.command.slice(1),
            command: command.item.command,
            project: command.item.project,
            projectPath: command.item.projectPath,
          }}
          colors={colors}
        />{CHIP_SPACE}
      </Fragment>
    )
  })

  return <>{tokens}{text.slice(end)}</>
}
