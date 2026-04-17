#!/bin/bash
# Daily X bookmarks sync — runs on Mac via launchd, then pushes to Pi
export PATH="/Users/hector/.nvm/versions/node/v24.11.0/bin:$PATH"
cd /Users/hector/Projects/second-brain
npm run sync-x && node bin/sync-pi.mjs
