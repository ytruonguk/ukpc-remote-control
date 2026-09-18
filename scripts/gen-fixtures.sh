#!/usr/bin/env bash
set -euo pipefail
mkdir -p fixtures
if ! command -v ffmpeg >/dev/null; then
  echo "ffmpeg not found — fake-agent will use synthetic Annex-B. Install ffmpeg for real H.264 fixtures."
  exit 0
fi
ffmpeg -y -f lavfi -i testsrc=size=720x1152:rate=30 -t 20 \
  -c:v libx264 -profile:v baseline -g 60 -bf 0 -b:v 1500k \
  -f h264 fixtures/test-720x1152.h264
ffmpeg -y -f lavfi -i testsrc=size=480x768:rate=30 -t 20 \
  -c:v libx264 -profile:v baseline -g 60 -bf 0 -b:v 600k \
  -f h264 fixtures/test-480x768.h264
echo "wrote fixtures/*.h264"
