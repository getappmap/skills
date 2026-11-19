#!/usr/bin/env bash
# Turn the PR movie's voice track into files GitHub and podcast apps can play.
#
#   podcast.sh <movie-dir>
#
# Reads  podcast.m4a and poster.png
# Writes podcast.mp3 (audio only) and podcast.mp4 (the audio over the diagram
# as a still frame; GitHub plays MP4 inline but not audio files).
set -euo pipefail

dir="${1:?usage: podcast.sh <movie-dir>}"
audio="$dir/podcast.m4a"
poster="$dir/poster.png"

command -v ffmpeg >/dev/null || { echo "error: ffmpeg is not installed" >&2; exit 1; }
[[ -s "$audio" ]] || { echo "error: $audio is missing" >&2; exit 1; }

ffmpeg -nostdin -loglevel error -y -i "$audio" -codec:a libmp3lame -q:a 4 "$dir/podcast.mp3"

if [[ -s "$poster" ]]; then
  # Still frame: 1 fps, scaled to an even width so H.264 accepts it.
  ffmpeg -nostdin -loglevel error -y -loop 1 -framerate 1 -i "$poster" -i "$audio" \
    -vf "scale=720:-2,format=yuv420p" -c:v libx264 -preset veryfast -tune stillimage \
    -c:a aac -b:a 128k -shortest -movflags +faststart "$dir/podcast.mp4"
fi

if [[ -s "$dir/podcast.mp4" ]]; then
  echo "wrote $dir/podcast.mp3 and $dir/podcast.mp4"
else
  echo "wrote $dir/podcast.mp3 (no poster.png, so no podcast.mp4)"
fi
