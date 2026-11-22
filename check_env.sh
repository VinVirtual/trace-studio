#!/usr/bin/env bash
# Checks what trace-studio needs and prints how to fix anything missing. Tested on Linux only.
# The replay page, the stats and the anonymiser need only Node 18+. The summary video also needs
# ffmpeg, Playwright with a browser, and (for the voice) Python with Kokoro.
# Overrides: KOKORO_HOME, KOKORO_MODEL, KOKORO_VOICES, TRACE_STUDIO_PYTHON, FF, PLAYWRIGHT_CORE, TRACE_STUDIO_CHROME
R="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if ! command -v node >/dev/null 2>&1; then
  echo "MISS node (version 18 or newer)"
  echo "       install Node.js from https://nodejs.org, or with nvm or your package manager"
  exit 1
fi
exec node "$R/engine/cli.mjs" check
