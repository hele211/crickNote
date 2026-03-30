#!/bin/bash
set -e

cd "$(dirname "$0")/.."

echo "Building CrickNote Obsidian plugin..."

npx esbuild obsidian-plugin/main.ts \
  --bundle \
  --external:obsidian \
  --external:electron \
  --external:node:* \
  --external:events \
  --external:fs \
  --external:path \
  --external:@codemirror/autocomplete \
  --external:@codemirror/collab \
  --external:@codemirror/commands \
  --external:@codemirror/language \
  --external:@codemirror/lint \
  --external:@codemirror/search \
  --external:@codemirror/state \
  --external:@codemirror/view \
  --format=cjs \
  --target=es2022 \
  --outfile=obsidian-plugin/main.js

echo "Plugin built: obsidian-plugin/main.js"
