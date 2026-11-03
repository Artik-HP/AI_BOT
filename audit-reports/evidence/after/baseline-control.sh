#!/usr/bin/env bash
# Runs the integration tests that can drive an arbitrary checkout (tests/helpers/app.js) against the ORIGINAL
# pre-audit code and against the new code, and prints a per-test comparison.
#
#   git worktree add /tmp/ai_bot_baseline pre-audit-baseline && (cd /tmp/ai_bot_baseline && npm ci)
#   bash audit-reports/evidence/after/baseline-control.sh [output-dir]
#
# account-assistant.test.js and userbot.test.js import the modules directly (dependency injection), so they cannot be
# pointed at the old code; the old behaviour of those areas is documented by the scenarios in evidence/harness.
set -u

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
BASELINE="${BASELINE_ROOT:-/tmp/ai_bot_baseline}"
OUT="${1:-$ROOT/audit-reports/evidence/after}"
FILES=(
  tests/integration/bot-flow.test.js
  tests/integration/bot-resilience.test.js
  tests/integration/bot-commands.test.js
  tests/integration/bot-edge-cases.test.js
)

cd "$ROOT" || exit 2

echo "== NEW code ($ROOT)"
node --test --test-reporter=tap "${FILES[@]}" > "$OUT/control-new.tap" 2>&1
echo "exit: $?"

echo "== ORIGINAL code ($BASELINE)"
APP_ROOT="$BASELINE" LEGACY_BASELINE=1 node --test --test-reporter=tap "${FILES[@]}" > "$OUT/control-baseline.tap" 2>&1
echo "exit: $?"

for variant in new baseline; do
  file="$OUT/control-$variant.tap"
  pass=$(grep -cE '^ok [0-9]+ - ' "$file")
  fail=$(grep -cE '^not ok [0-9]+ - ' "$file")
  echo "$variant: pass=$pass fail=$fail"
done
