# Running Second Brain on a Raspberry Pi

This guide covers setting up Second Brain as a 24/7 server on a Raspberry Pi 3B or newer.

---

## Requirements

- Raspberry Pi 3B or newer
- microSD card (16 GB minimum, 32 GB recommended)
- Power supply: **5V / 2.5A** (Pi 3B) or **5V / 3A** (Pi 4) — insufficient power is the most common cause of boot failures
- Network connection (ethernet recommended for a server)

---

## 1. Flash the SD card

Download and install [Raspberry Pi Imager](https://www.raspberrypi.com/software/) on your computer.

1. Choose **Raspberry Pi OS Lite (64-bit)** — no desktop, less RAM usage
2. Click the gear icon before flashing to pre-configure:
   - **Enable SSH** ✓
   - Set a username and password
   - (Optional) Configure WiFi if not using ethernet
3. Flash the card

---

## 2. Find the Pi's IP address

Connect the Pi to your router with an ethernet cable, insert the SD card, and power it on. After ~30 seconds, find the IP from your computer:

```bash
arp -a
```

Look for a new device. Raspberry Pi MAC addresses start with `b8:27:eb` (Pi 3) or `dc:a6:32` (Pi 4).

Alternatively, check your router's admin panel (usually `http://192.168.1.1`) under connected devices.

> **Tip:** Assign a static IP to the Pi in your router's DHCP reservation settings so the IP never changes.

---

## 3. Connect via SSH

```bash
ssh youruser@<PI_IP>
```

---

## 4. Install Node.js 20

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs git
```

Verify:

```bash
node --version   # should print v20.x.x
```

---

## 5. Clone the repo and configure

```bash
git clone https://github.com/ZenekeZene/second-brain.git
cd second-brain
npm install
cp .env.example .env
nano .env
```

Minimum `.env` for the Pi:

```bash
ANTHROPIC_API_KEY=sk-ant-...       # required — get it at console.anthropic.com
COMPILE_MODEL=claude-sonnet-4-6    # recommended: Sonnet has much higher rate limits than Opus
TELEGRAM_BOT_TOKEN=                # optional — for mobile ingestion and compile notifications
TELEGRAM_ALLOWED_USER_ID=          # optional — your numeric Telegram user ID
```

> **Why Sonnet?** `claude-opus-4-6` has a 10,000 TPM input limit, which compilation exceeds on the first retry loop. `claude-sonnet-4-6` has ~8× higher limits and produces equivalent wiki output.

---

## 6. Install Claude CLI (optional — for Claude Code backend)

The Pi supports two compilation backends. The API backend (`compile-lite.mjs`) requires only `ANTHROPIC_API_KEY` and uses ~60 MB RAM. The Claude Code backend (`compile.mjs`) requires the CLI and uses ~400 MB RAM — fine for a Pi 4 or Pi 5, may be tight on a Pi 3B.

**To use the Claude Code backend (Pi 4/5 recommended):**

```bash
npm install -g @anthropic-ai/claude-code
# Auth on headless Pi — the command prints an OAuth URL; open it on any browser:
claude login
```

Then add to `~/second-brain/.env`:

```bash
SKIP_PI_SYNC=true   # prevents postCompile from trying to rsync back to its own IP
```

**To use the API backend only (any Pi, lighter):** skip this step. `compile-lite.mjs` works with just `ANTHROPIC_API_KEY`.

---

## 7. Set up PM2 (process manager)

PM2 keeps services alive and restarts them automatically on reboot.

```bash
sudo npm install -g pm2

# Start the wiki viewer
pm2 start bin/wiki-server.mjs --name brain-wiki

# Start the Telegram bot (if configured)
pm2 start bin/telegram-bot.mjs --name brain-bot

# Persist across reboots
pm2 save
pm2 startup   # copy and run the command it prints
```

---

## 8. Set up cron jobs

```bash
crontab -e
```

Add:

**API backend** (any Pi, ~60 MB RAM, requires `ANTHROPIC_API_KEY`):

```
PATH=/usr/local/bin:/usr/bin:/bin
0 7 * * *     cd ~/second-brain && node bin/compile-lite.mjs >> .state/compile.log 2>&1
0 8 * * *     cd ~/second-brain && node bin/daily-digest.mjs >> .state/digest.log 2>&1
0 9 * * 0     cd ~/second-brain && node bin/resurface.mjs >> .state/resurface.log 2>&1
*/15 * * * *  cd ~/second-brain && node bin/reminder-check.mjs >> .state/reminders.log 2>&1
```

**Claude Code backend** (Pi 4/5, ~400 MB RAM, $0 per compile — requires `claude login`):

```
PATH=/usr/local/bin:/usr/bin:/bin:/home/zeneke/.npm-global/bin
0 7 * * *     cd ~/second-brain && node bin/compile.mjs >> .state/compile.log 2>&1
0 8 * * *     cd ~/second-brain && node bin/daily-digest.mjs >> .state/digest.log 2>&1
0 9 * * 0     cd ~/second-brain && node bin/resurface.mjs >> .state/resurface.log 2>&1
*/15 * * * *  cd ~/second-brain && node bin/reminder-check.mjs >> .state/reminders.log 2>&1
```

> The `PATH=` line at the top ensures `node` (and `claude`) are found by cron's minimal shell environment. Adjust the path to match the output of `which claude` on your Pi.

**What each cron does:**
- `7:00` — compiles all pending items into wiki articles
- `8:00` — Morning Briefing: compilation summary, pending count, spaced repetition, stale bookmarks
- `9:00 Sunday` — standalone spaced repetition session (`resurface.mjs`)
- `every 15 min` — checks for due reminders and sends Telegram alerts (`reminder-check.mjs`)

The Pi compiles at 7:00 and auto-syncs the wiki back to any connected machine. The main machine is not required to be on.

> Note: `sync-rss.mjs` is intentionally omitted. RSS feeds can bring in large volumes of articles and trigger rate limits. Configure it manually only if needed.

**Cron jobs on your main machine** (optional — only needed to pull Pi content):

```
*/30 * * * * rsync -az youruser@<PI_IP>:~/second-brain/raw/ /path/to/second-brain/raw/ && rsync -az youruser@<PI_IP>:~/second-brain/.state/ /path/to/second-brain/.state/ && rsync -az youruser@<PI_IP>:~/second-brain/wiki/ /path/to/second-brain/wiki/ && rsync -az youruser@<PI_IP>:~/second-brain/INDEX.md /path/to/second-brain/INDEX.md
```

Every 30 minutes the main machine pulls `raw/`, `.state/`, `wiki/` and `INDEX.md` from the Pi. When the Pi compiles at 7:00, the main machine will have the updated wiki within 30 minutes.

You can also run it manually at any time:

```bash
node bin/sync-from-pi.mjs
```

---

## 9. Sync your wiki content from your main machine

Wiki content (`wiki/`, `raw/`, `.state/`) is not stored in git. To copy it to the Pi:

```bash
# Run from your main machine (not the Pi)
rsync -az wiki/   youruser@<PI_IP>:~/second-brain/wiki/
rsync -az raw/    youruser@<PI_IP>:~/second-brain/raw/
rsync -az .state/ youruser@<PI_IP>:~/second-brain/.state/
rsync -az INDEX.md youruser@<PI_IP>:~/second-brain/INDEX.md
```

### Auto-sync after every compilation

Add these variables to your `.env` on your **main machine** (Mac/PC):

```
PI_HOST=<PI_IP>
PI_USER=youruser
PI_PATH=/home/youruser/second-brain
```

After that, every `compile` run will automatically sync the wiki to the Pi — no manual steps needed.

> **Warning:** Do NOT set `PI_HOST` / `PI_USER` in the Pi's own `.env`.
> If the Pi has these set, it will try to rsync to itself after every compilation.

### Skip password prompts

Set up SSH key authentication so rsync never asks for a password:

```bash
ssh-keygen -t ed25519   # press Enter on all prompts
ssh-copy-id youruser@<PI_IP>
```

### Manual sync

If you edit a wiki article directly (without compiling), force a sync manually:

```bash
node bin/sync-pi.mjs
```

### Auto-restart on the Pi (PM2 watch mode)

Set up PM2 to watch the `wiki/` folder and restart the server automatically when files change:

```bash
pm2 delete brain-wiki
pm2 start bin/wiki-server.mjs --name brain-wiki --watch wiki --ignore-watch="node_modules"
pm2 save
```

With this, the full flow is completely automatic:
1. Ingest content and compile on your main machine
2. `sync-pi.mjs` copies the files to the Pi
3. PM2 detects the changes and restarts the wiki server

---

## 10. Access the wiki

Open in your browser from any device on the same network:

```
http://<PI_IP>:4321
```

---

## Remote access (outside your home network)

By default the wiki is only accessible on your local network. To access it from anywhere, use **Tailscale**.

### Setup

1. Install Tailscale on the Pi:
```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
```
Authenticate via the URL it prints.

2. Install Tailscale on your Mac and other devices from the [App Store](https://apps.apple.com/app/tailscale/id1475387142) and sign in with the same account.

3. The Pi will appear as `second-brain` in your Tailscale network. Access the wiki from any device:
```
http://second-brain:4321
```

Works from Mac, iPhone, Android — any device with Tailscale installed and signed in to the same account.

### Conflict with other VPNs

Tailscale may conflict with other VPNs (e.g. a corporate AWS VPN client). If you use both:
- Disconnect the other VPN before activating Tailscale
- Or access the wiki only on your local network (`http://192.168.1.x:4321`) when the other VPN is active

---

## Troubleshooting

### Compilation never runs / log is empty

The most common causes on a Pi 3B:

1. **PATH not set in crontab** — cron uses a minimal PATH (`/usr/bin:/bin`). Add `PATH=/usr/local/bin:/usr/bin:/bin` at the top of your crontab (see section 8). If using the Claude Code backend, also add the npm global bin dir (e.g. `/home/zeneke/.npm-global/bin`).
2. **ANTHROPIC_API_KEY missing** — required for the API backend. Check with `grep ANTHROPIC_API_KEY ~/second-brain/.env`.
3. **Claude CLI not authenticated** — required for the Claude Code backend. Run `claude login` and complete the OAuth flow. Test with `claude --version`.
4. **OOM kill** — the process is killed by the kernel with no output. Check with `dmesg | grep -i "oom\|killed process"`. The Claude Code backend uses ~400 MB — use the API backend on a Pi 3B.

Quick diagnostics:

```bash
# Memory available
free -h

# Recent OOM kills
dmesg | grep -i "oom\|killed process"

# Test compile manually
cd ~/second-brain && node bin/compile-lite.mjs --dry-run

# Test API connectivity
node -e "import('@anthropic-ai/sdk').then(m => new m.default().messages.create({model:'claude-haiku-4-5-20251001',max_tokens:10,messages:[{role:'user',content:'hi'}]}).then(r=>console.log('API OK')).catch(e=>console.error(e.message)))"
```

### Out of memory during compilation

Enable a 2 GB swap file (uses the SD card as overflow — slower but prevents crashes):

```bash
sudo dphys-swapfile swapoff
sudo sed -i 's/CONF_SWAPSIZE=.*/CONF_SWAPSIZE=2048/' /etc/dphys-swapfile
sudo dphys-swapfile setup
sudo dphys-swapfile swapon
```

Verify:

```bash
swapon --show   # should list /var/swap with 2 GB
free -h
```

### Compilation is slow / rate limit retries

If you see `Rate limit hit — retrying in Xs...` in `compile.log`, your `COMPILE_MODEL` is hitting the Anthropic input TPM limit. Fix:

```bash
# In the Pi's .env:
COMPILE_MODEL=claude-sonnet-4-6
```

`claude-opus-4-6` has a 10,000 input TPM cap. Sonnet has ~8× more headroom and is sufficient for wiki compilation.

### PI_HOST self-sync loop

If compilation finishes but `sync-pi.mjs` fails or the wiki server goes down right after:

```bash
grep "PI_HOST\|PI_USER" ~/second-brain/.env
```

If these are set, remove them from the Pi's `.env`. They should only be set on your main machine.

---

### Pi won't boot / no LED activity

- Check the power supply — it must output **5V / 2.5A or more**. A 1A phone charger is not enough.
- Try a different microUSB cable (cheap cables limit current).

### No video output / boot loop on large monitors

Edit `/boot/firmware/config.txt` (or `/boot/config.txt` on older OS) from another computer:

```ini
hdmi_force_hotplug=1   # force HDMI output even if no monitor detected
hdmi_safe=1            # safe mode: 720p, widely compatible
```

Or force a specific resolution:

```ini
hdmi_force_hotplug=1
hdmi_group=2    # DMT (monitors); use 1 for TVs
hdmi_mode=82    # 1920x1080 @60Hz
```

| Mode | Resolution |
|------|-----------|
| 4    | 640x480 @60Hz |
| 16   | 1024x768 @60Hz |
| 35   | 1280x1024 @60Hz |
| 82   | 1920x1080 @60Hz |
| 85   | 1280x720 @60Hz |

### SSH "host key changed" warning

Normal after reflashing the SD card. Fix with:

```bash
ssh-keygen -R <PI_IP>
```

### Node.js install fails (old OS)

If you see `404 Not Found` errors for `jessie` or `stretch` repositories, your OS is too old.
Reflash the SD with **Raspberry Pi OS Bookworm (current)** using Raspberry Pi Imager.

---

## PM2 quick reference

```bash
pm2 list                  # show running processes
pm2 logs brain-wiki       # tail wiki server logs
pm2 restart brain-wiki    # restart after a sync
pm2 stop brain-bot        # stop a process
```
