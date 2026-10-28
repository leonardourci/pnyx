import { FILE_BLOCK } from './attachments.ts'
import { decodeValue, REFERENCE } from './mentions.ts'
import { readSkillReference } from './transcripts-skill-reference.ts'
import { BUILT_IN_SKILLS } from './built-in-skills.ts'
import { skillSource } from '#setup/skills.ts'

export function resolveSkillReferences({
  text,
  provider,
}: {
  text: string
  provider?: string
}): string {
  const attachments = [...text.matchAll(FILE_BLOCK)].map(match => ({
    start: match.index,
    end: match.index + match[0].length,
  }))

  return text.replace(
    new RegExp(
      REFERENCE.source,
      'g',
    ),
    (
      match,
      _label: string,
      kind: string,
      encoded: string,
      offset: number,
    ) => {
      if (kind !== 'skill' || attachments.some(block => block.start <= offset && offset < block.end)) {
        return match
      }

      const value = decodeValue({ value: encoded })
      const skill = value && readSkillReference({ value })

      if (!skill) {
        return match
      }

      if (skill.builtin && BUILT_IN_SKILLS.some(item => item.name === skill.name)) {
        return `Read and follow the skill ${JSON.stringify(skill.name)} at ${JSON.stringify(skillSource({ name: skill.name }))}.`
      }

      if (skill.file) {
        return `Read and follow the skill ${JSON.stringify(skill.name)} at ${JSON.stringify(skill.file)}.`
      }

      return skill.command ?? `${provider === 'codex' ? '$' : '/'}${skill.name}`
    },
  )
}
