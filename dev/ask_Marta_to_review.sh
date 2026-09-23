#!/bin/bash

echo "Asking Marta to review PR#$1 ..."

/usr/local/bin/node dev/type-and-submit.mjs \
  --headless \
  --executable=/snap/bin/chromium \
  --profile="../chas-ege-chromium-profiles/marta-auto" \
  --url="https://chat.qwen.ai" \
  --wait-after-load=16000 \
  --text="https://github.com/nickkolok/chas-ege/pull/$1" \
  --fast-insert \
  --hold-open=30000 \
  --slow-mo=100
