---
name: write-skill
description: Create or change an agent skill in Pnyx, either a contributor skill in .agents/skills or a skill shipped with the CLI in skills/. Covers naming, frontmatter, what belongs in a skill versus docs, keeping it short, and registering it. Read before writing any SKILL.md.
---

# Write a skill

Skills follow the [Agent Skills](https://agentskills.io) format: a folder holding a `SKILL.md` with YAML frontmatter and Markdown instructions. Pnyx has two kinds:

- **Contributor skills** live in `.agents/skills/<name>/` and guide work on this repository. Claude Code finds them through `.claude/skills`, a committed link to `../.agents/skills`, so a new one needs no extra link.
- **Shipped skills** live in `skills/<name>/`, are installed by Pnyx's setup and read by agents using Pnyx. Their names start with `pnyx-`, and tests read them, so `pnpm verify` runs those tests when they change.

## Naming and frontmatter

- [ ] Name the action, verb first where it reads naturally (`review-code`, `write-front-end`, `pnyx-manage-workers`), not the tool that runs it or a vague category. Use lowercase letters, numbers and single hyphens. The frontmatter `name` must equal the folder name.
- [ ] Give the frontmatter `name` and `description`. The description, under 1,024 characters, says what the skill does and when to read it, with the words a future agent would match on. Add `paths` only when the skill applies to a fixed set of files, as `write-front-end` does for `web/**`.

## Body

- [ ] Write instructions for doing the task: the checks, their order and what to report. Use checklists or numbered steps, with plain sentences.
- [ ] Point to the rule's home (`AGENTS.md`, `docs/`, another skill) instead of restating it, so rules have one home and cannot drift apart. A skill holds what an agent needs only while doing that task.
- [ ] Keep it short. Detail needed only sometimes goes in a `references/` file the body links to.
- [ ] Describe the current project. A skill never asks for session journals, handoff files or a running history of reviews and test results.
- [ ] Apply [deslop](../deslop/SKILL.md) to the text.

## Registration

- [ ] For a shipped skill, add its name to `src/setup/skill-names.ts`, in `GLOBAL_SKILLS` for every agent or `HYDRA_SKILLS` for Hydra's own, so setup installs it, and to the `skills/` row of the layout table in `AGENTS.md`.
- [ ] For a contributor skill that is a required step, link it where the step is described (`AGENTS.md`, `CONTRIBUTING.md` or `docs/development.md`).
- [ ] Re-check the hard rules before committing: `name` matches the folder, the description fits, and the file reads as plain Markdown.
