import type { Ask, Card } from './model.ts'
import type { PermissionRequest, Attention, Reply } from '#workers/model.ts'
import { requestId } from '#workers/answers.ts'
import { PERMISSION_PREFIX, pendingPermissions } from '#workers/permission-rules.ts'
import { INTERRUPTED } from '#workers/session-attachments.ts'
import { answerDelivery, askWording, openAsks } from './ask-state.ts'

export interface OwnerQuestion {
  text: string
  permission?: PermissionRequest
  attention?: Attention
  ask?: Ask
  // The receipt of an answer the owner gave that has not been confirmed yet.
  delivery?: Reply
}

// A pending permission's prompt is listed once, as the permission; an interrupted turn waits on nobody.
export const waitingPrompt = ({ prompt }: { prompt: Attention }) =>
  prompt.blocking && !prompt.answered
  && prompt.key !== INTERRUPTED && !prompt.key.startsWith(PERMISSION_PREFIX)

const asked = ({ questions }: { questions?: { question: string }[] }) => questions?.map(q => q.question).join(' ')

// Everything on the card waiting on the owner; the status word and the closed card's question box both read it.
export function ownerQuestions({ card }: { card: Card }): OwnerQuestion[] {
  const permissions = pendingPermissions({ card })
    .map((permission): OwnerQuestion => {
      const own = card.attention.find(prompt => prompt.key === `${PERMISSION_PREFIX}${permission.id}`)

      return {
        text: asked({ questions: permission.questions }) || own?.text || permission.tool,
        permission,
      }
    })
  const prompts = card.attention.filter(prompt => waitingPrompt({ prompt }))
    .map((attention): OwnerQuestion => ({
      text: attention.text || asked({ questions: attention.questions }) || attention.kind,
      attention,
      delivery: answerDelivery({
        card,
        question: requestId({ request: attention }),
      }),
    }))
  const asks = openAsks({
    card,
    audience: 'owner',
  }).map((ask): OwnerQuestion => ({
    text: askWording({ ask }).question,
    ask,
    delivery: answerDelivery({
      card,
      question: ask.id,
    }),
  }))

  return [
    ...permissions,
    ...prompts,
    ...asks,
  ]
}
