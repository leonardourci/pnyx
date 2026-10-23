#!/bin/sh
# Fake gh-axi for tests: `pr view 42 --repo o/r --full` prints a pull request in
# gh-axi's TOON shape; `pr view 8 --repo o/r` prints a draft with a check still
# running and comments; `pr view <n> --repo <repo>` prints any other pull request as
# open with no checks; anything else fails like an unknown pull request.
if [ "$1 $2 $3 $4 $5 $6" = "pr view 42 --repo o/r --full" ]; then
  cat <<'TOON'
pull_request:
  number: 42
  title: "Nightly invoice export"
  state: open
  author: someone
  draft: no
  body: "Moves the invoice export to a 2am UTC batch.\n\n<details><summary>Pipeline evidence</summary>\n\npipelineevidenceword\n</details>\n<!-- templatemarkerword -->"
  comment_count: 0
TOON
  exit 0
fi
if [ "$1 $2 $3 $4 $5" = "pr view 8 --repo o/r" ] && [ -z "$6" ]; then
  cat <<'TOON'
pull_request:
  number: 8
  state: open
  draft: yes
  checks: "3 passed, 1 failed, 1 skipped, 6 total — run gh-axi pr checks 8 for details"
  comment_count: 2 — use --comments to see full comments
  review_count: 1 — use --reviews to see full reviews
TOON
  exit 0
fi
if [ "$1 $2 $3 $4 $5" = "pr view 10 --repo o/r" ]; then
  printf 'pull_request:\n  number: 10\n  state: open\n'
  exit 0
fi
if [ "$1 $2 $4" = "pr view --repo" ] && [ -z "$6" ]; then
  cat <<TOON
pull_request:
  number: $3
  state: open
  draft: no
  checks: "0 passed, 0 failed — this PR has no CI checks configured"
  comment_count: 0 — use --comments to see full comments
  review_count: 0 — use --reviews to see full reviews
TOON
  exit 0
fi
echo "error: Item #$3 does not exist in this repository"
echo "code: NOT_FOUND"
exit 1
