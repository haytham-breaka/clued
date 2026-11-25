#!/usr/bin/env bash
# Stops a commit or push that would publish something private:
# personal email addresses, home-folder paths, tokens and keys, or files that never belong in the repo.
#   scripts/check-private.sh          check the staged files (the pre-commit hook)
#   scripts/check-private.sh --all    check every tracked file (the pre-push hook)
set -uo pipefail
cd "$(git rev-parse --show-toplevel)"
if [ "${1:-}" = "--all" ]; then files=$(git ls-files); else files=$(git diff --cached --name-only --diff-filter=ACMR); fi
[ -z "$files" ] && exit 0
bad=0
say() { echo "check-private: $*" >&2; bad=1; }

# Files that never belong in the repo.
echo "$files" | grep -E '(^|/)\.env($|\.)|\.pem$|\.key$|id_rsa|(^|/)raw/.*\.jsonl$|\.log$|sent\.log|\.tgz$' | while read -r f; do echo "check-private: $f should not be committed" >&2; done | grep -q . && bad=1

own="$(git config --global user.email 2>/dev/null || true)"
# Emails other than the safe kinds (GitHub noreply, Anthropic's noreply, example domains).
email='[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}'
safe='users\.noreply\.github\.com|noreply@anthropic\.com|@example\.(com|org)|@[a-z.]*\.example'
secrets='sk-ant-[A-Za-z0-9_-]{10,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|xox[abpr]-[A-Za-z0-9-]{10,}|-----BEGIN [A-Z ]*PRIVATE KEY-----'
home='/(home|Users)/[a-z][a-z0-9_-]+/|C:\\\\Users\\\\[A-Za-z]'

while IFS= read -r f; do
  [ -f "$f" ] || continue
  [ "$f" = "scripts/check-private.sh" ] && continue
  if git ls-files --error-unmatch "$f" >/dev/null 2>&1 && [ "${1:-}" != "--all" ]; then content=$(git show ":$f" 2>/dev/null); else content=$(cat "$f"); fi
  [ -n "$own" ] && grep -qF "$own" <<<"$content" && say "$f contains your git email"
  grep -oE "$email" <<<"$content" | grep -vE "$safe" | head -3 | while read -r m; do echo "check-private: $f contains the email $m" >&2; done | grep -q . && bad=1
  grep -qE "$secrets" <<<"$content" && say "$f looks like it contains a token or key"
  grep -qE "$home" <<<"$content" && say "$f contains a home-folder path ($(grep -oE "$home" <<<"$content" | head -1))"
done <<<"$files"

[ "$bad" -eq 0 ] || { echo "check-private: fix the above, or commit with --no-verify if you are sure." >&2; exit 1; }
