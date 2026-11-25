#!/usr/bin/env bash
# Snapshots the app code the eval imports, so edits to app/ or hooks/ during a run can't change it:
#   hooks/model.ts -> eval/frozen/model.ts, app/inbox.ts -> eval/frozen/inbox.ts (import paths adjusted).
# The APP_GUIDE lines in eval/frozen/guide.ts are copied by hand from app/main.ts; this checks they still match.
# Refuses when a source changed in the last 60 seconds (someone may be mid-edit).
set -euo pipefail
cd "$(dirname "$0")/.."
now=$(date +%s)
# GNU stat, else BSD's (macOS).
mtime() { stat -c %Y "$1" 2>/dev/null || stat -f %m "$1"; }
for f in hooks/model.ts app/inbox.ts app/main.ts; do
  age=$(( now - $(mtime "$f") ))
  if [ "$age" -lt 60 ]; then echo "freeze: $f changed ${age}s ago; try again in a minute" >&2; exit 1; fi
done
mkdir -p eval/frozen
cp hooks/model.ts eval/frozen/model.ts
cp app/inbox.ts eval/frozen/inbox.ts
# sed -i with a suffix works with both GNU and BSD sed.
sed -i.orig "s|from '../types'|from '../../types/index.d.ts'|; s|from '../types/index.d.ts'|from '../../types/index.d.ts'|" eval/frozen/model.ts
sed -i.orig "s|from '../hooks/model.ts'|from './model.ts'|; s|from '../types/index.d.ts'|from '../../types/index.d.ts'|; s|from './session.ts'|from '../../app/session.ts'|; s|from './text.ts'|from '../../app/text.ts'|" eval/frozen/inbox.ts
rm -f eval/frozen/model.ts.orig eval/frozen/inbox.ts.orig
# The guide lines in main.ts must be the ones guide.ts holds.
start=$(grep -n '^const APP_GUIDE = \[' app/main.ts | cut -d: -f1)
sed -n "$((start + 3)),$((start + 8))p" app/main.ts > /tmp/tl-freeze-main.txt
grep -E "^  '(The user reads|keep narration|To react|\"✅\"|\"👍\"|\"🎉\")" eval/frozen/guide.ts > /tmp/tl-freeze-guide.txt
if ! diff -q /tmp/tl-freeze-main.txt /tmp/tl-freeze-guide.txt >/dev/null; then
  echo "freeze: APP_GUIDE lines in app/main.ts differ from eval/frozen/guide.ts; update guide.ts:" >&2
  diff /tmp/tl-freeze-main.txt /tmp/tl-freeze-guide.txt >&2 || true
  exit 1
fi
sed -n "${start},$((start + 9))p" app/main.ts > eval/frozen/main-app-guide.txt
node --no-warnings -e "import('./eval/frozen/guide.ts').then(g => console.log('APP_GUIDE', g.APP_GUIDE.length, 'chars'))"
{
  echo "Frozen $(date -Iseconds). sha256 and mtime of the originals at that moment:"
  for f in hooks/model.ts app/inbox.ts app/main.ts; do echo "$(sha256sum "$f" | cut -c1-64)  $(date -r "$f" +%H:%M:%S)  $f"; done
  echo "model.ts and inbox.ts here are those files with import paths changed; guide.ts holds main.ts's APP_GUIDE lines (main-app-guide.txt)."
} > eval/frozen/SOURCES.txt
cat eval/frozen/SOURCES.txt
