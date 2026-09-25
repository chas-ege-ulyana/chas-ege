#!/bin/bash

echo "Asking Marta to review PR#$1 ..."

profile=$(shuf -e \
	"marta-auto" \
	"marta-auto-2" \
-n 1)

echo "Using profile: $profile"

/usr/local/bin/node dev/type-and-submit.mjs \
  --headless \
  --no-sandbox \
  --executable=/snap/bin/chromium \
  --profile="../chas-ege-chromium-profiles/$profile" \
  --url="https://chat.qwen.ai" \
  --check-auth=chat.qwen.ai \
  --wait-after-load=16000 \
  --text="https://github.com/nickkolok/chas-ege/pull/$1" \
  --fast-insert \
  --hold-open=30000 \
  --slow-mo=100
