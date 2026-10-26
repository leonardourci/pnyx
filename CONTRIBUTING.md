## Verification by change kind

Run `pnpm verify` on the clean, pushed PR head. It prints the changed path groups, required review boxes and selected checks. Tick only the required `Ran` boxes after completing those checklists; other template boxes may stay unticked. Mixed changes take the union of their requirements.

| Change kind | Required reviews | Checks |
| --- | --- | --- |
| Files under `docs/`, or Markdown outside shipped skills and test fixtures | `deslop` | None |
| Shipped skill Markdown under `skills/` | `deslop` | Build and tests that read the shipped skills |
| Test files (`test/**/*.test.ts`) | `audit-tests` | Lint fixes, type checks, ESLint, build when needed, and the changed test files |
| UI or back-end code, configuration, test helpers or fixtures | `review-code`, `audit-tests`, `deslop` | Full suite: lint fixes, type checks, ESLint, build, unit tests and scenarios |
| Explicit mechanical rename or move | `deslop` | Full suite |

For a mechanical rename or move, run `pnpm verify --mechanical` and put exactly one standalone line, `Change: mechanical (rename)` or `Change: mechanical (move)`, in the PR description. The flag requires the visible declaration and records it in the verification marker. It changes only the required reviews and always runs the full suite. `--mechanical` cannot be combined with `--checks-only`, which never reads or edits the PR description.

Verification does not merge a PR. Merging requires explicit approval.
