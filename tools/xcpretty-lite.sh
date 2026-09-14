#!/usr/bin/env bash
# Filters xcodebuild output down to errors, warnings, test results and the final verdict.
# Exits non-zero when xcodebuild failed (relies on `set -o pipefail` in callers or the
# BUILD FAILED marker).
set -o pipefail
status=0
while IFS= read -r line; do
  case "$line" in
    *"BUILD FAILED"*|*"TEST FAILED"*) echo "$line"; status=1 ;;
    *"error:"*) echo "$line" ;;
    *"warning:"*) echo "$line" ;;
    *"Test Case"*|*"Test Suite"*|*"Executed"*) echo "$line" ;;
    *"BUILD SUCCEEDED"*|*"TEST SUCCEEDED"*) echo "$line" ;;
  esac
done
exit $status
