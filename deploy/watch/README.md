# Cowl watch — scheduled, and addressed to a person

Puts `npm run watch` on a timer and gives its alarms somewhere to arrive. The
check itself is [`scripts/watch-pool.mjs`](../../scripts/watch-pool.mjs) and it
is unchanged by any of this; what is added is a clock and a channel.

Read [`audits/monitoring/README.md`](../../audits/monitoring/README.md) first.
It says what each alarm means and what to do when one fires — a notification
that reaches somebody who does not know the playbook is a notification that
wakes them up for nothing.

**This bundle is written, proven locally, and not deployed.** Every command
below is for a human at the VPS.

## What runs

| Unit | When | Says |
|---|---|---|
| `cowl-watch.timer` | every 15 minutes | only when something is wrong, or when a wrong thing clears |
| `cowl-watch-heartbeat.timer` | daily, 09:00 | always, so a heartbeat that stops arriving is the signal |

The 15-minute cadence is set against the float alarm, not against the swap
delay: 100 spends left is roughly half an hour of headroom at the busiest rate
this pool has ever run. A verifier swap sits behind seven days, so the quarter
hour costs nothing there.

## Why a checkout and not the npm package

The watcher reads `src/networks.ts` and the relayer's own client through
esbuild, so it needs the repository. `@cowlprotocol/cli` ships `dist/` only, by
design — the published package is the product, not the tooling.

It follows that the box is running whatever the checkout is at. `git pull` is
the deploy step, and a watcher nobody updates is a watcher that keeps checking
last month's baseline.

## Paths

| Path | What |
|---|---|
| `/opt/cowl-watch/cli` | the checkout the units run from |
| `/etc/cowl-watch/watch.env` | `COWL_WATCH_WEBHOOK`, root-only |
| `/var/lib/cowl-watch/state.json` | what has already been said, so repeats stay quiet |
| `/var/lib/cowl-watch/build` | esbuild's scratch, so the checkout stays read-only |

State lives outside the checkout on purpose: a `git pull` must never reset what
the box has already told a person.

## 1. User and directories

```bash
sudo useradd --system --home /opt/cowl-watch --shell /usr/sbin/nologin cowl-watch
sudo mkdir -p /opt/cowl-watch /var/lib/cowl-watch /etc/cowl-watch
sudo chown -R cowl-watch:cowl-watch /opt/cowl-watch /var/lib/cowl-watch
sudo chmod 700 /var/lib/cowl-watch
```

## 2. The checkout

```bash
sudo -u cowl-watch git clone https://github.com/Cowl-Protocol/cli /opt/cowl-watch/cli
cd /opt/cowl-watch/cli && sudo -u cowl-watch npm ci
```

`npm ci` rather than `npm install`: the lockfile is what
[`audits/supplychain/`](../../audits/supplychain/README.md) gates on, and a box
that resolved its own versions is outside that gate.

## 3. The sink

Create a channel nobody else posts to, and get its webhook URL. Then:

```bash
sudo cp watch.env.example /etc/cowl-watch/watch.env
sudo $EDITOR /etc/cowl-watch/watch.env      # paste the URL
sudo chown root:root /etc/cowl-watch/watch.env
sudo chmod 600 /etc/cowl-watch/watch.env
```

The URL is a credential — Discord, Slack and Telegram all put the secret in the
path. `600` is the same line the relayer's passphrase file is held to on this
box, and `COWL_WATCH_WEBHOOK_FILE` is refused outright if it is looser than
that.

**What leaves the machine.** The alert body is the watcher's output: pool
address, token balances, the relayer's payout address and float. All of it is
already public on chain and none of it is a key. It is still a third party
receiving it, which is why the sink is a private channel rather than one
anybody can join.

## 4. Prove it before trusting it

```bash
cd /opt/cowl-watch/cli
sudo -u cowl-watch COWL_WATCH_STATE=/var/lib/cowl-watch/state.json \
  node scripts/notify.mjs --dry-run --heartbeat
```

`--dry-run` prints exactly what would be sent and sends nothing. Then send one
for real, so the channel is proven end to end rather than assumed:

```bash
sudo -u cowl-watch env $(sudo cat /etc/cowl-watch/watch.env | grep -v '^#') \
  COWL_WATCH_STATE=/var/lib/cowl-watch/state.json \
  node scripts/notify.mjs --heartbeat
```

If that message does not arrive, nothing below is worth installing.

## 5. Install the units

```bash
sudo cp cowl-watch.service cowl-watch.timer \
        cowl-watch-heartbeat.service cowl-watch-heartbeat.timer \
        /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now cowl-watch.timer cowl-watch-heartbeat.timer
```

```bash
systemctl list-timers 'cowl-watch*'      # when it next fires
journalctl -u cowl-watch -n 50           # what the last run found
```

## Exit codes, as systemd sees them

| Code | Meaning | In the journal |
|---|---|---|
| 0 | clean, or a repeat deliberately not resent | success |
| 1 | something to look at, and a person was told | failed |
| 2 | could not check, and a person was told | failed |
| 3 | **the result is known and nobody was told** | failed |

3 is the one to grep for. 1 and 2 mean the system worked: it found something
and said so. 3 means the channel is broken, which is the failure that looks
exactly like silence from the outside.

There is deliberately no `Restart=`. The next tick is fifteen minutes away, and
a retry storm against a rate-limited RPC is how a watcher becomes the outage it
was installed to catch.

## What this still does not cover

**It cannot notice its own absence.** A timer that stops firing sends nothing,
and nothing is what a healthy quiet run looks like too. The heartbeat is the
cheap half of the answer — a daily message whose absence is the signal — and it
only works if somebody notices it missing. The complete answer is an external
dead-man's switch, which costs an account, and that is the same open row as the
Tenderly alert in the monitoring report.
