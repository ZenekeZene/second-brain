#!/usr/bin/env bash
# Second Brain — Raspberry Pi setup script
#
# Usage (from the project root on your Pi):
#   bash bin/setup-pi.sh
#
# Or one-liner (clones the repo too):
#   curl -fsSL https://raw.githubusercontent.com/ZenekeZene/second-brain/master/bin/setup-pi.sh | bash
#
# Safe to re-run — idempotent.

set -euo pipefail

# ── Colors ────────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
BOLD='\033[1m'; DIM='\033[2m'; RESET='\033[0m'
ok()   { echo -e "  ${GREEN}✓${RESET} $1"; }
warn() { echo -e "  ${YELLOW}!${RESET} $1"; }
err()  { echo -e "  ${RED}✗${RESET} $1"; }
step() { echo -e "\n${BOLD}$1${RESET}"; }
ask()  { echo -en "  ${BOLD}$1${RESET} " < /dev/tty; read -r "$2" < /dev/tty; }
ask_secret() { echo -en "  ${BOLD}$1${RESET} " < /dev/tty; read -rs "$2" < /dev/tty; echo < /dev/tty; }

# ── Banner ─────────────────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}Second Brain — Pi Setup${RESET}"
echo -e "${DIM}A self-hosted AI that builds your knowledge base overnight.${RESET}"
echo ""

# ── Detect architecture ────────────────────────────────────────────────────────
PI_MODEL=""
if [[ -f /proc/device-tree/model ]]; then
  PI_MODEL=$(tr -d '\0' < /proc/device-tree/model 2>/dev/null || true)
fi
IS_PI3=false
if echo "$PI_MODEL" | grep -q "Raspberry Pi 3"; then
  IS_PI3=true
  warn "Pi 3B detected — API backend recommended (~60 MB RAM vs ~400 MB for Claude Code)"
elif [[ -n "$PI_MODEL" ]]; then
  ok "Detected: $PI_MODEL"
fi

# ── Step 1: Node.js ───────────────────────────────────────────────────────────
step "1/6  Node.js 20"

if command -v node &>/dev/null && node --version | grep -q "^v2[0-9]"; then
  ok "Node.js $(node --version) already installed"
else
  warn "Installing Node.js 20..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - >/dev/null 2>&1
  sudo apt-get install -y nodejs >/dev/null 2>&1
  ok "Node.js $(node --version) installed"
fi

# ── Step 2: Clone or locate repo ─────────────────────────────────────────────
step "2/6  Repository"

BRAIN_DIR=""
# If we're already inside the repo, use current dir
if [[ -f "$(pwd)/CLAUDE.md" ]] && [[ -f "$(pwd)/package.json" ]]; then
  BRAIN_DIR="$(pwd)"
  ok "Already inside second-brain at $BRAIN_DIR"
elif [[ -d "$HOME/second-brain" ]]; then
  BRAIN_DIR="$HOME/second-brain"
  ok "Found existing repo at $BRAIN_DIR"
else
  warn "Cloning second-brain into $HOME/second-brain..."
  git clone https://github.com/ZenekeZene/second-brain.git "$HOME/second-brain" >/dev/null 2>&1
  BRAIN_DIR="$HOME/second-brain"
  ok "Cloned to $BRAIN_DIR"
fi

cd "$BRAIN_DIR"

# ── Step 3: npm install ───────────────────────────────────────────────────────
step "3/6  Dependencies"

if [[ -d node_modules ]]; then
  ok "node_modules already present — running npm install to update"
fi
npm install --silent
ok "npm packages installed"

# ── Step 4: .env configuration ───────────────────────────────────────────────
step "4/6  Configuration"

if [[ -f .env ]]; then
  warn ".env already exists — skipping creation (edit manually if needed)"
else
  echo -e "  ${DIM}Fill in the values below. Press Enter to skip optional fields.${RESET}"
  echo ""

  ask "Anthropic API key (required — get it at console.anthropic.com):" ANTHROPIC_KEY
  ask_secret "Telegram bot token (optional — from @BotFather):" TG_TOKEN
  ask "Telegram allowed user ID (optional — find via @userinfobot):" TG_USER

  cat > .env <<EOF
# ── Required ────────────────────────────────────────────────────────────────
ANTHROPIC_API_KEY=${ANTHROPIC_KEY}

# ── Compilation ─────────────────────────────────────────────────────────────
COMPILE_MODEL=claude-sonnet-4-6     # Sonnet has 8x higher rate limits than Opus
COMPILE_BACKEND=api                 # api (default) or claude (needs claude login)
SKIP_PI_SYNC=true                   # prevents Pi from rsyncing to its own IP

# ── Telegram (optional) ────────────────────────────────────────────────────
TELEGRAM_BOT_TOKEN=${TG_TOKEN}
TELEGRAM_ALLOWED_USER_ID=${TG_USER}

# ── OpenAI (optional — voice + image analysis) ────────────────────────────
OPENAI_API_KEY=

# ── Reactive compilation (disabled — cron compiles daily at 7:00) ─────────
REACTIVE_THRESHOLD_ITEMS=9999
REACTIVE_THRESHOLD_HOURS=9999
EOF
  ok ".env created"
fi

# ── Step 5: State directories ─────────────────────────────────────────────────
step "5/6  Directories"

mkdir -p .state wiki raw/articles raw/notes raw/bookmarks raw/files raw/images outputs
ok "Directory structure ready"

# ── Step 6: PM2 + cron ────────────────────────────────────────────────────────
step "6/6  Services"

# Install PM2
if ! command -v pm2 &>/dev/null; then
  warn "Installing PM2..."
  sudo npm install -g pm2 --silent
  ok "PM2 installed"
else
  ok "PM2 already installed"
fi

# Start wiki server (stops existing one first if running)
pm2 describe brain-wiki >/dev/null 2>&1 && pm2 delete brain-wiki >/dev/null 2>&1 || true
pm2 start bin/wiki-server.mjs --name brain-wiki --watch wiki --ignore-watch="node_modules .state" >/dev/null 2>&1
ok "brain-wiki started (wiki server + /compile Telegram bot)"

# Start Telegram ingest bot (if token is set)
if grep -q "^TELEGRAM_BOT_TOKEN=.\+" .env 2>/dev/null; then
  pm2 describe brain-bot >/dev/null 2>&1 && pm2 delete brain-bot >/dev/null 2>&1 || true
  pm2 start bin/telegram-bot.mjs --name brain-bot >/dev/null 2>&1
  ok "brain-bot started (Telegram ingest)"
else
  warn "TELEGRAM_BOT_TOKEN not set — skipping brain-bot (add it to .env and re-run)"
fi

pm2 save >/dev/null 2>&1
ok "PM2 state saved"

# PM2 startup
STARTUP_CMD=$(pm2 startup 2>/dev/null | grep "sudo env" || true)
if [[ -n "$STARTUP_CMD" ]]; then
  eval "$STARTUP_CMD" >/dev/null 2>&1 && ok "PM2 autostart on boot configured" || warn "Run this manually to enable autostart:\n  $STARTUP_CMD"
fi

# Cron jobs
NODE_BIN=$(which node)
NODE_DIR=$(dirname "$NODE_BIN")
CURRENT_CRON=$(crontab -l 2>/dev/null || true)

add_cron_if_missing() {
  local job="$1"
  local marker="$2"
  if ! echo "$CURRENT_CRON" | grep -qF "$marker"; then
    CURRENT_CRON="${CURRENT_CRON}"$'\n'"${job}"
  fi
}

# PATH line
if ! echo "$CURRENT_CRON" | grep -q "^PATH="; then
  CURRENT_CRON="PATH=${NODE_DIR}:/usr/local/bin:/usr/bin:/bin"$'\n'"${CURRENT_CRON}"
fi

add_cron_if_missing "0 7 * * *    cd $BRAIN_DIR && node bin/compile-lite.mjs >> .state/compile.log 2>&1"   "compile-lite.mjs"
add_cron_if_missing "0 8 * * *    cd $BRAIN_DIR && node bin/daily-digest.mjs >> .state/digest.log 2>&1"    "daily-digest.mjs"
add_cron_if_missing "0 9 * * 0    cd $BRAIN_DIR && node bin/resurface.mjs >> .state/resurface.log 2>&1"    "resurface.mjs"
add_cron_if_missing "*/15 * * * * cd $BRAIN_DIR && node bin/reminder-check.mjs >> .state/reminders.log 2>&1" "reminder-check.mjs"

echo "$CURRENT_CRON" | crontab -
ok "Cron jobs configured (compile 7:00, digest 8:00, resurface Sun 9:00, reminders every 15m)"

# ── Done ──────────────────────────────────────────────────────────────────────
PI_IP=$(hostname -I 2>/dev/null | awk '{print $1}' || echo "<PI_IP>")

echo ""
echo -e "${GREEN}${BOLD}Setup complete.${RESET}"
echo ""
echo -e "  Wiki:       ${BOLD}http://${PI_IP}:4321${RESET}"
echo -e "  Inbox:      ${BOLD}http://${PI_IP}:4321/inbox${RESET}"
echo ""
echo -e "  ${DIM}Compiles daily at 07:00 · Briefing at 08:00 · Reminders every 15m${RESET}"
echo ""

if $IS_PI3; then
  warn "Pi 3B: if compilation is slow, enable swap — see RASPBERRY.md"
fi

echo -e "  ${DIM}To copy your existing wiki content from your main machine:${RESET}"
echo -e "  ${DIM}  rsync -az wiki/ raw/ .state/ INDEX.md ${USER}@${PI_IP}:${BRAIN_DIR}/${RESET}"
echo ""
echo -e "  ${DIM}Full guide: ${BRAIN_DIR}/RASPBERRY.md${RESET}"
echo ""
