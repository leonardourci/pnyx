#!/bin/sh
# Fake gh-axi for tests: `pr view 42 --repo o/r --full` prints a pull request in
# gh-axi's TOON shape; anything else fails like an unknown pull request.
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
echo "error: Item #$3 does not exist in this repository"
echo "code: NOT_FOUND"
exit 1
