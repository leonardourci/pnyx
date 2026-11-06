---
name: write-pull-request
description: Write or update a Pnyx pull request description, including Problem, Fix, Validation and Review. Read before opening a PR or changing its title or body, and after every push to keep the description true to the final diff.
---

# Write a pull request

Use the [PR template](../../../.github/pull_request_template.md) and the checks in [CONTRIBUTING.md](../../../CONTRIBUTING.md#pull-requests-and-checks). Write for a reviewer who has not seen the conversation.

- [ ] **Problem:** explain what is wrong or missing and who it affects. Include discovery context only when it helps explain the failure.
- [ ] **Fix:** describe the resulting behavior and material limits. Cover the whole diff against the PR's base; a stacked PR describes only its own change. Link any agreed design or issue needed to judge it.
- [ ] **Validation:** name the checks actually run and their results. State failures, skipped checks and pending checks honestly. Include before/after media for visible changes; say when there is no visible UI change.
- [ ] **Review:** record findings and fixes, or no findings, from each required checklist in order. Tick only completed, required boxes. The boxes alone do not replace the review results.
- [ ] Remove the template placeholders. Keep all four headings, each with substantive text; hidden comments and examples do not count. `pnpm verify` checks structure, not whether the claims are true.
- [ ] After every push, compare the description with the final diff and current validation. Rewrite stale claims, changed scope and validation gaps. Preserve the hidden verification marker and the review boxes; rerun `pnpm verify` on the pushed head after editing the body.
- [ ] Read the final title, body and changed code comments using [deslop](../deslop/SKILL.md). Use plain English, keep enough context to assess the change and remove session history.
