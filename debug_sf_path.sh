#!/bin/bash
# Run this from Terminal to diagnose why Vendavis can't find the sf CLI.
# Usage: bash debug_sf_path.sh

echo "=== Vendavis SF CLI Path Diagnostic ==="
echo ""

echo "--- Shell PATH ---"
echo $PATH | tr ':' '\n'
echo ""

echo "--- which sf / sfdx ---"
which sf 2>/dev/null && echo "  ^^^ sf found" || echo "  sf not on shell PATH"
which sfdx 2>/dev/null && echo "  ^^^ sfdx found" || echo "  sfdx not on shell PATH"
echo ""

echo "--- npm global bin ---"
NPM_BIN=$(npm root -g 2>/dev/null | xargs -I{} dirname {} 2>/dev/null)/bin
echo "  npm root -g bin dir: $NPM_BIN"
ls -la "$NPM_BIN/sf" 2>/dev/null && echo "  ^^^ sf found via npm" || echo "  sf not in npm bin"
echo ""

echo "--- Common install locations ---"
for p in \
  "/usr/local/sf/bin/sf" \
  "/usr/local/bin/sf" \
  "/usr/local/bin/sfdx" \
  "/opt/homebrew/bin/sf" \
  "/opt/homebrew/bin/sfdx" \
  "$HOME/.npm-global/bin/sf" \
  "$HOME/.volta/bin/sf" \
  "$HOME/Library/sf/bin/sf"
do
  if [ -f "$p" ]; then
    echo "  ✅ FOUND: $p"
  fi
done
echo ""

echo "--- Broad find (may take a moment) ---"
find /usr/local /opt/homebrew "$HOME/.npm-global" "$HOME/.volta" "$HOME/Library/sf" \
  -name "sf" -type f 2>/dev/null | head -10
echo ""
echo "=== Copy the sf path above and let the team know ==="
