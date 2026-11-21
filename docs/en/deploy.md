# ZRA — setting up the phone

The **phone → machine** path, in order. ZRA scripts
never install anything: they show what would be done, and act with
`--apply`; the steps marked **admin** require an administrator PowerShell.

## The principle: a single address, locally and remotely

```
 at home, at the office                   remotely
 phone ── Wi-Fi ──► machine               phone ══ wg-easy tunnel ══► homelab ──► local network ──► machine
            http://192.168.1.20:7777                (AllowedIPs 0.0.0.0/0)
```

The daemon listens on the machine's **local network** (its private IPv4 addresses), in addition to
loopback. On the same Wi-Fi, the phone connects to it directly. Remotely,
the homelab tunnel in "all traffic" mode (`AllowedIPs = 0.0.0.0/0, ::/0`,
wg-easy's default config) brings the phone onto that same network:
**the same address works in both cases**, nothing to switch. WireGuard is not
ZRA's business: the tunnel is already there, the daemon only reads the
machine's interfaces.

The local network is held as a trusted place, unless it is marked
"Public": the daemon does not listen there (§1). **Each device still pairs
once** with a code (§2). The daemon serves the web client itself: no
separate host, the page and the WebSocket have the same origin.

---

## 1. The daemon, reachable from the network

```bash
npm run daemon          # loopback + local network (+ tunnel if there is one on the machine)
npm run daemon:dev      # loopback only, for dev
```

The log says where it listens; the pairing code is shown on the terminal
(never in a log) and can be seen again with `npm run pair`:

```
listening http://192.168.1.20:7777
local network: Wi-Fi (192.168.1.20)
pairing: 0 paired device(s) — code: npm run pair

  pairing code: 482 913
```

The code can only be used once. After 10 failed attempts, across all devices,
pairing locks: `npm run pair` on the machine reopens it with a
new code.

It follows address changes (home Wi-Fi then office, renewed DHCP
lease) without restarting. To expose it only to a specific network:
`"lanCidrs": ["192.168.1.0/24"]` in `zra.config.json`.

**admin** — Windows firewall: on first launch, Windows may ask to
allow Node on private networks; otherwise, an explicit rule, limited
to private networks and to the daemon port:

```powershell
New-NetFirewallRule -DisplayName "ZRA daemon" -Direction Inbound -Protocol TCP -LocalPort 7777 -Profile Private,Domain -Action Allow
```

The Wi-Fi must use the **Private** profile (Settings › Network › Wi-Fi ›
Properties): on a **Public** network, the daemon does not listen at all, and says so
at startup. Tunnels (WireGuard, Tailscale), which Windows always marks
"Public", are not affected. On Linux, no equivalent: restrict listening with
`"lanCidrs": ["192.168.1.0/24"]` in `zra.config.json`. On a corporate machine, a policy may block any local
rule: take it up with IT.

**Check** — from the phone, on the same Wi-Fi:
`http://<machine's local IP>:7777` shows the PWA, with "pairing required".

---

## 2. Pairing the phone

Once per device. The PWA shows the machine with **"Enter the code"**; the
code is in the daemon log, or:

```bash
npm run pair                 # the code, and the devices already paired
npm run pair -- rotate       # another code
npm run pair -- revoke <id>  # remove a device (lost phone): connection closed
```

The code can only be used once; the PWA receives a token it keeps, and
later connections happen without entering anything. The machine itself (loopback)
has nothing to pair. 5 attempts per minute from the same address, the code
changes after 20 failures.

---

## 3. The phone

1. Open `http://<machine's local IP>:7777`: the machine adds itself (the
   page comes from it). Pair (§2).
2. Remotely: turn on the wg-easy tunnel, same address.
3. Another machine: Settings › Add a machine, its IP (port 7777 is
   inferred over `http://`, 443 over `https://`), then pair it.

A laptop that changes network (home, office) changes IP: in the PWA,
those are two addresses, hence two machines to add — one offline when you
are on the other network. For a single address everywhere: §3.1.

### 3.1 Machine outside the local network: put it on the VPN

The machine joins the **same VPN** as the phone, and you target it by its **VPN
IP**: fixed, whatever network it is on (office, phone
tethering). The daemon listens on the tunnel interface automatically (the log
announces it: "listening http://10.8.0.3:7777").

**The simplest: Tailscale** (or ZeroTier). Machine and phone in the same
tailnet, each has its fixed `100.x` IP, without open ports or configuration. Not
tried with ZRA.

**With WireGuard (wg-easy)**. In the machine's config:

- `AllowedIPs`: the VPN subnet (`10.8.0.0/24`), plus that of the HTTPS
  proxy if it is not in the VPN. Anything not in it is rejected, even
  with a successful handshake;
- `PersistentKeepalive = 25`: it is the proxy that opens the connection to the
  machine, and without keepalive a machine behind a router becomes unreachable again.

If wg-easy runs in Docker in `bridge` networking, `10.8.0.0/24` only exists
inside its container: the proxy host must know how to route there (`ip route … via
<container IP>`, to be made persistent), or wg-easy switches to
`network_mode: host`. Test from the proxy server:
`curl http://10.8.0.3:7777/` must answer with HTML.

**Installing on the home screen** requires HTTPS (§4). Over HTTP, everything
works (reading, sending, permissions, streaming) except installation and the
offline app.

---

## 4. HTTPS (optional): the installed app

A page loaded over `https://` can only open `wss://`: it is a
browser rule (mixed content blocked). Client over HTTPS ⇒ each daemon
reached over HTTPS too. Two ways to get there.

### 4.1 Behind a reverse proxy (recommended with a homelab)

The homelab carries HTTPS, the machines stay on HTTP on the local network or
the tunnel. Example with Nginx Proxy Manager and a wildcard
certificate already in place:

> **Not on the machine itself.** A proxy or tunnel set up on the machine
> (`cloudflared`, `tailscale serve`, `ssh -R`, local Caddy…) relays to
> `127.0.0.1` and extends loopback to the network. ZRA detects the
> `forwarded` headers and requires pairing for these connections; to go further,
> `"auth": { "exemptLoopback": false }` in `zra.config.json` — loopback
> pairs too.

- proxy host `zra.example.com` → the static client served on the homelab
  (`python3 -m http.server 8080 --directory zra-client`, or any
  static server), SSL forced;
- **one proxy host per machine**, on a subdomain covered by the wildcard:
  `zra-dell.example.com` → `http://192.168.1.20:7777`, **Websockets Support
  enabled**, SSL forced;
- in each machine's `zra.config.json`:
  `"allowedOrigins": ["https://zra.example.com"]`, then restart the daemon
  (`npm run service -- stop`, then `start`);
- in the PWA: Settings › Add a machine › `zra-dell.example.com` (page over
  `https://`: `https://` and 443 inferred), then pair (§2).

No certificate on the machines. One sub-path per machine on a single domain
(NPM Custom Location `/dell/`) did not work: NPM passes the path as
is, and the daemon answers "not found". The subdomain avoids the problem.
The proxy targets a fixed IP: the machine's IP on the VPN (§3.1), so that it stays
reachable whatever its network.

### 4.2 Certificate on the daemon

For a private IP, the workable path: a **domain name** with an
**A** record pointing to the machine's local IP (`zra.example.com → 192.168.1.20`),
and a **Let's Encrypt certificate through DNS-01 validation** (Let's Encrypt cannot
reach a private IP, it checks a TXT record instead).

```powershell
Install-Module Posh-ACME -Scope CurrentUser     # once, without admin
pwsh scripts/cert.ps1 -Domain zra.example.com -Contact me@example.com -Plugin Cloudflare -PluginArgs @{ CFToken = (Read-Host -AsSecureString) }
```

`-Plugin`: the one for your DNS host (`Get-PAPlugin`: Cloudflare, OVH,
Gandi, Infomaniak…), or `Manual` (the TXT record to create by hand, to
redo every 60 days). `-Staging` for a trial without quota. The certificate
lands in `.zra/tls/`; in `zra.config.json`:

```jsonc
"tls": { "cert": ".zra/tls/zra.crt", "key": ".zra/tls/zra.key" }
```

Then `https://zra.example.com:7777` on the phone. Renewal, to schedule
once (without admin) — the daemon reloads the certificate live:

```powershell
schtasks /Create /TN "ZRA certificate" /SC DAILY /ST 12:00 /TR "pwsh -NoProfile -WindowStyle Hidden -File \"<repository>\scripts\cert.ps1\" -Renew"
```

Some routers filter public names that resolve to a private IP
("DNS rebinding protection"): allow the domain in the router if the page cannot
be found from home.

`scripts/cert.ps1` has not been tried for real yet.

---

## 5. Automatic startup

A scheduled task **of the user**: started at session login, in
the interactive session (keyboard control of Zed needs it), without a
window, without elevation, without a stored password.

```bash
npm run service -- install            # shows the task, creates nothing
npm run service -- install --apply    # creates it
npm run service -- start              # starts it right away
npm run service                       # status: task, daemon, end of the log
npm run service -- logs               # log: .zra/logs/daemon.log (pairing code: npm run pair)
npm run service -- stop | uninstall --apply
```

The daemon is restarted there if it stops on an error. A dev daemon already
running holds the port: the task retries until it stops.

**PowerShell policy** — the keyboard script and the scheduled task launch
PowerShell with `-ExecutionPolicy Bypass`: a deliberate choice so that control
works whatever the machine. The bypass only applies to the launched
process; the machine (and user) policy is not changed.

---

## 5.1 Linux: automatic startup

Same commands as on Windows (`npm run service -- install --apply`, `start`,
`status`, `logs`, `stop`, `uninstall --apply`); the backend is detected:

| Machine | Backend | File |
|---|---|---|
| systemd is init (Debian, Ubuntu, Fedora, Arch) | `systemd --user` | `~/.config/systemd/user/zra-daemon.service` |
| systemd is **not** init (MX Linux and derivatives) | XDG autostart | `~/.config/autostart/zra-daemon.desktop` + launcher `.zra/service/zra-daemon.sh` |

The session's PATH and graphical environment (`DISPLAY`…) are copied
at install time: without them, neither CLIs outside `/usr/bin` nor `xdotool` work.

- **systemd**: without `loginctl enable-linger $USER` (no sudo), the service
  dies at logout; `install` and `status` remind you. Restarted if it crashes.
- **XDG autostart**: no supervision (a crashed daemon stays stopped until
  the next session) and stops when the session closes. Log in
  `.zra/logs/daemon.log`.

---

## 5.2 Linux: certificate (certbot / acme.sh)

`scripts/cert.ps1` is Windows-only (Posh-ACME). On Linux, use `certbot` or
`acme.sh` with DNS-01 validation (same principle: domain name + TXT
record, certificate in `.zra/tls/`).

```bash
# Example with certbot (adapt to the DNS provider)
certbot certonly --manual --preferred-challenges dns -d zra.example.com
# then copy the certs:
cp /etc/letsencrypt/live/zra.example.com/fullchain.pem .zra/tls/zra.crt
cp /etc/letsencrypt/live/zra.example.com/privkey.pem .zra/tls/zra.key
```

In `zra.config.json`:

```jsonc
"tls": { "cert": ".zra/tls/zra.crt", "key": ".zra/tls/zra.key" }
```

Renewal: `certbot renew` (cron or systemd timer), then restart the
daemon (`npm run service -- stop && start`) so that it reloads the certificate.

---

## 5.3 Linux: keyboard control under Wayland

Under X11, `xdotool` works with no setup. Under Wayland, Zed is forced under
XWayland through `WAYLAND_DISPLAY=` in Zed's `.desktop`
(`~/.local/share/applications/dev.zed.Zed.desktop`), which lets `xdotool`
see its windows and target them.

Setup can do it — a step separate from installation, dry run by
default, backup in `.zra/backups/`:

```bash
npm run setup -- xwayland            # shows the diff, touches nothing
npm run setup -- xwayland --apply    # applies (restart Zed afterwards)
```

Zed under XWayland is slightly less smooth (no native vsync), but
keyboard control works.

---

## 6. If it does not work

| Symptom | Where to look |
|---|---|
| the `… (zra)` agents no longer start in Zed, or threads are no longer drivable | repository moved or Node changed (absolute paths): `npm run setup` reports it (stale entry or preload), `npm run setup install apply` and `npm run service -- install --apply` fix it. A stale preload is silent on Zed's side (fail-open: the agent runs without ZRA) |
| the page does not load locally | same Wi-Fi? Private network profile? firewall rule (§1)? |
| the page does not load remotely | tunnel on? in "all traffic"? does the homelab see the machine (same network)? |
| "pairing required" in a loop | token revoked or `.zra/auth.json` deleted: enter a code again |
| "wrong code" | the code changed (single use): `npm run pair` |
| "machine unreachable" | `npm run service`: does the daemon answer? `npm run service -- logs` |
| Zed not found at setup | native install required; Flatpak/Snap not supported → `zedDb`/`zedSettings` in `zra.config.json` (`docs/en/limitations.md`) |
| WebSocket refused (403) | log: "origin … not allowed" → `allowedOrigins` |
| no installation offered | page over `http://`: no certificate (§4) |

---

## Appendix — generating a WireGuard tunnel (experimental, untested)

Without an existing tunnel: `npm run wireguard -- init --endpoint <machine address>`
generates in `.zra/wireguard/` a machine ↔ phone tunnel (keys, configurations,
QR) and the **admin** commands to bring it up. The phone must reach the
machine over UDP. Full usage: at the top of `scripts/wireguard.mjs`.
