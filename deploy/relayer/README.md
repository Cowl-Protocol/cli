# Cowl relayer — public deployment

Run a public gasless relayer for Cowl on a VPS. It submits other people's proven
spends and trades from its own wallet, terminates TLS at `relay.cowlprotocol.com`,
and survives reboots under systemd. Every install of the CLI can already relay
(`cowl relay serve`); this turns that into a hardened, always-on public endpoint
so anyone who installs Cowl gets gasless private operations out of the box.

A relayer can steal nothing: recipient, relayer, and fee are all bound into each
proof, so a submitted spend pays out exactly as proven or it reverts. The daemon
dry-runs every submission first, so an invalid proof or a stale root costs a free
`eth_call`, never gas.

## What you provide

- A small Linux VPS (1 vCPU / 1 GB is plenty). Ubuntu or Debian assumed below.
- A DNS **A record**: `relay.cowlprotocol.com` points at the VPS IP.
- Node.js 18+ installed system-wide (`node -v`).

## What it earns and spends

The relayer signs and pays gas from a **dedicated wallet**, and earns each
spend's fee leg back: raw gas plus your `--margin` (default 25%). On testnet that
is testnet ETH, so keep a gas float and top it up from the faucet if it runs dry.

## Paths this runbook uses

| Path | What |
|---|---|
| `/opt/cowl-relayer/data` | `COWL_HOME`, the relayer's dedicated keystore |
| `/etc/cowl-relayer/relayer.env` | `COWL_PASSPHRASE`, root-only |
| `/etc/systemd/system/cowl-relayer.service` | the unit |
| `/etc/caddy/Caddyfile` | TLS and reverse proxy |

Copy the three files in this directory (`cowl-relayer.service`, `Caddyfile`,
`relayer.env.example`) onto the VPS, then work through the steps.

## 1. System user and directories

```bash
sudo useradd --system --home /opt/cowl-relayer --shell /usr/sbin/nologin cowl-relayer
sudo mkdir -p /opt/cowl-relayer/data
sudo chown -R cowl-relayer:cowl-relayer /opt/cowl-relayer
sudo chmod 700 /opt/cowl-relayer/data
```

## 2. Install the CLI

```bash
sudo npm install -g @cowlprotocol/cli
which cowl        # note the path; the unit assumes /usr/local/bin/cowl
cowl --version    # expect 0.6.0 or newer
```

If `node` comes from nvm rather than a system install, systemd will not find it.
Install a system-wide Node, or set the unit's `ExecStart` to the absolute path.

## 3. A dedicated relayer wallet (never the deployer)

Create a fresh wallet that this relayer owns and nothing else. Do **not** copy the
deployer keystore onto the VPS.

```bash
sudo -u cowl-relayer COWL_HOME=/opt/cowl-relayer/data cowl network use robinhood-testnet
sudo -u cowl-relayer COWL_HOME=/opt/cowl-relayer/data cowl wallet new --key
# pick a strong passphrase when asked — it goes in the env file in step 4
sudo -u cowl-relayer COWL_HOME=/opt/cowl-relayer/data cowl wallet address
```

Fund that address with testnet ETH so it can pay gas. `cowl faucet` prints the
faucet links for the active network. A relayer with no gas can quote but cannot
submit.

## 4. The passphrase env file

```bash
sudo mkdir -p /etc/cowl-relayer
sudo cp relayer.env.example /etc/cowl-relayer/relayer.env
sudo nano /etc/cowl-relayer/relayer.env      # set COWL_PASSPHRASE to the wallet's passphrase
sudo chown root:root /etc/cowl-relayer/relayer.env
sudo chmod 600 /etc/cowl-relayer/relayer.env
```

## 5. systemd

```bash
sudo cp cowl-relayer.service /etc/systemd/system/cowl-relayer.service
# if `which cowl` was not /usr/local/bin/cowl, fix ExecStart to match
sudo systemctl daemon-reload
sudo systemctl enable --now cowl-relayer
systemctl status cowl-relayer --no-pager
journalctl -u cowl-relayer -f                # watch it come up and relay
```

## 6. TLS with Caddy

```bash
sudo cp Caddyfile /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

Caddy fetches and renews a Let's Encrypt certificate for `relay.cowlprotocol.com`
on its own, provided the A record resolves and ports 80 and 443 are reachable.

## 7. Firewall — keep 4663 private

The daemon listens on `0.0.0.0:4663`, so only Caddy on localhost should reach it.
Expose 443, never 4663.

```bash
sudo ufw allow 22
sudo ufw allow 80
sudo ufw allow 443
sudo ufw enable
# 4663 stays blocked from the outside; Caddy reaches it over loopback.
```

## 8. Verify

```bash
curl -s https://relay.cowlprotocol.com/quote | jq
```

Expect a JSON quote with `relayer`, `feeWei`, `chainId: 46630`, and the pool
address. From any machine:

```bash
cowl relay quote https://relay.cowlprotocol.com
cowl unshield 0.001 --relay https://relay.cowlprotocol.com    # a real relayed spend
```

## 9. Make it the default (after it is proven live)

Once the endpoint answers reliably, add its URL as the network's default relay in
`src/networks.ts` so every install relays through it without a `--relay` flag.
This is a small code change; hold it until the endpoint is verified so the CLI
never points users at a dead URL.

## Operating it

- **Logs**: `journalctl -u cowl-relayer -f`. Quotes, relays (with tx link and gas
  used), and rejections all print.
- **Restart / stop**: `sudo systemctl restart cowl-relayer` / `stop`.
- **Gas**: watch the wallet balance and top up from the faucet before it empties.
  It earns fees back on every relay.
- **Margin**: change the take by editing `--margin` in the unit, then
  `sudo systemctl daemon-reload && sudo systemctl restart cowl-relayer`.
- **Rotate the passphrase**: `cowl wallet passphrase` as the `cowl-relayer` user,
  update `/etc/cowl-relayer/relayer.env`, then restart.

## Security

- The relayer wallet is dedicated and holds only a gas float. It is never the
  deployer, and the deployer keystore never touches this box.
- `/etc/cowl-relayer/relayer.env` is root-only (`chmod 600`); the keystore in
  `COWL_HOME` is the CLI's `0600` scrypt + AES-256-GCM file.
- Port 4663 is never exposed publicly; TLS terminates at Caddy.
- A relayer cannot redirect funds. Recipient, relayer, and fee are bound into
  every proof, and the worst a bad payload does is get rejected as a 400 or 409.
