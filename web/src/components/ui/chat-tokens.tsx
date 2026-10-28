import { createContext, Fragment, useContext } from 'react'
import type { SavedLabelColor } from '../../../../src/tasks/model.ts'
import type { Suggestion } from '../../../../src/thread/catalog.ts'
import type { PreparedChatTokens } from '../../hydra/chat-tokens.ts'
import { SkillBadge } from './skill-badge.tsx'
import type { SkillReference } from '../../../../src/thread/skill-reference.ts'
import { CHIP_SPACE } from '../../hydra/draft.ts'

export const ChatTokensContext = createContext<{
  suggestions?: Suggestion[]
  colors?: SavedLabelColor[]
  tokens?: PreparedChatTokens
}>({})

export function SkillToken({ skill }: { skill: SkillReference }) {
  const { colors } = useContext(ChatTokensContext)

  return <>{CHIP_SPACE}<SkillBadge skill={skill} colors={colors} />{CHIP_SPACE}</>
}

export function ChatTokenText({
  text,
  code = false,
}: {
  text: string
  code?: boolean
}) {
  const {
    tokens,
    colors,
  } = useContext(ChatTokensContext)
  const parts = tokens?.split({
    text,
    code,
  }) ?? [{ text }]

  return (
    <>{parts.map((
      part,
      index,
    ) => 'item' in part && part.item ? (
      <Fragment key={index}>
        {CHIP_SPACE}<SkillBadge
          skill={{
            name: part.item.command.slice(1),
            command: part.item.command,
            project: part.item.project,
            projectPath: part.item.projectPath,
          }}
          colors={colors}
        />{CHIP_SPACE}
      </Fragment>
    ) : <Fragment key={index}>{part.text}</Fragment>)}
    </>
  )
}
