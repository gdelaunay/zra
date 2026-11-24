# ZRA — setting up the phone

The **phone → machine** path, in order. ZRA scripts
never install anything: they show what would be done, and act with
`--apply`; the steps marked **admin** require an administrator PowerShell.

## The principle: two paths

```
 direct (local network)                   with the relay (homelab)
 phone ── Wi-Fi ──► machine               phone ── https ──► zra-relay ── ws ──► machine A
            http://192.168.1.20:7777                             └───────── ws ──► machine B
```

- **Direct**: the daemon listens on the machine's **local network** (its
  private IPv4 addresses), in addition to loopback, and serves the web client
  itself — the page and the WebSocket have the same origin, no separate host.
  On the same Wi-Fi, the phone connects to it with a single address. Remotely,
  an "all traffic" tunnel (WireGuard, Tailscale… §3.1) brings the phone onto
  that same network: the same address works in both cases.
- **With the relay** (`zra-relay`, §4.1): a small server on the homelab serves
  the PWA over HTTPS and relays to each machine by its IP. A single HTTPS
  config, the relay's; adding a machine = typing its IP. The phone needs no
  VPN: it reaches the relay, the relay reaches the machines.

The local network is held as a trusted place, unless it is marked
"Public": the daemon does not listen there (§1). **Each device still pairs
once** with a code (§2) — including through the relay: pairing is end-to-end,
between the PWA and the daemon.

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

Through the relay (§4.1), pairing is unchanged: the relay only sees frames
passing, it does not terminate pairing and cannot read anything. Each machine
pairs from the PWA served by the relay, just like direct.

---

## 3. The phone

1. Open `http://<machine's local IP>:7777`: the machine adds itself (the
   page comes from it). Pair (§2).
2. Remotely: turn on the tunnel (§3.1), same address.
3. Another machine: Settings › Add a machine, its IP (port 7777 is
   inferred over `http://`, 443 over `https://`), then pair it.

With the relay (§4.1): open the relay's URL, then Settings › Add a machine ›
each machine's IP. That's all.

A laptop that changes network (home, office) changes IP: in the PWA,
those are two addresses, hence two machines to add — one offline when you
are on the other network. For a single address everywhere: §3.1, or the relay
(machines are targeted by their tunnel IP, fixed).

### 3.1 Machine outside the local network: put it on a VPN

The machine joins a **VPN**, and you target it by its **VPN IP**: fixed,
whatever network it is on (office, phone tethering). The daemon listens on the
tunnel interface automatically (the log announces it: "listening
http://10.8.0.3:7777").

**The network is the user's business**: ZRA does not configure it, it reads
the machine's interfaces. Any tunnel mounted on the machine is listened on —
WireGuard (wg-easy…), Tailscale, ZeroTier… your pick. Two uses:

- **direct**: the phone is on the same VPN as the machine ("all traffic"
  tunnel on the phone side, `AllowedIPs = 0.0.0.0/0, ::/0`), the same address
  works everywhere;
- **with the relay**: the homelab must be able to reach the machines (same
  LAN, or same VPN). The phone itself needs no VPN.

**WireGuard example (wg-easy)** — the real pitfalls:

- the machine's `AllowedIPs`: the VPN subnet (`10.8.0.0/24`), plus that of the
  HTTPS proxy if it is not in the VPN. Anything not in it is rejected, even
  with a successful handshake;
- `PersistentKeepalive = 25`: it is the relay (or the proxy) that opens the
  connection to the machine, and without keepalive a machine behind a router
  becomes unreachable again;
- wg-easy in Docker `bridge` networking: `10.8.0.0/24` only exists inside its
  container — the host must know how to route there (`ip route … via
  <container IP>`, to be made persistent), or wg-easy switches to
  `network_mode: host`. Test from the homelab:
  `curl http://10.8.0.3:7777/` must answer with HTML.

**Installing on the home screen** requires HTTPS (§4). Over HTTP, everything
works (reading, sending, permissions, streaming) except installation and the
offline app.

---

## 4. HTTPS (optional): the installed app

A page loaded over `https://` can only open `wss://`: it is a
browser rule (mixed content blocked). Three paths, from simplest to most
hands-on.

### 4.1 The `zra-relay` relay (recommended with a homelab)

A small Node server (no build, no dependencies) that serves the PWA **and**
relays the WebSockets: `wss://<host>/to/<ip>[:<port>]/ws` →
`ws://<ip>:<port>/ws` (7777 by default). A
single HTTPS config — its own. The machines keep their daemon on HTTP on the
local network or the tunnel, **nothing more to configure**.

```bash
npm run relay               # listens http://0.0.0.0:7777 — PWA + relay
```

- the relay targets **private IPs only** (RFC 1918, tunnel ranges like
  WireGuard/Tailscale): public IP, hostname, loopback → refused. It is not an
  open proxy;
- it only sees frames: pairing stays end-to-end (§2);
- adding a machine = Settings › Add a machine › its IP (optional port:
  `IP:port`, otherwise 7777). The PWA served by the relay builds the route
  itself (automatic detection);
- network prerequisite: the relay must be able to reach the machines (LAN or
  VPN, §3.1). Relay down: the machines carry on, only the PWA is unreachable.

**HTTPS, two forms to choose from:**

1. **Behind the homelab's existing proxy** (Nginx Proxy Manager, Caddy…):
   the relay speaks plain HTTP locally, the proxy carries the certificate.
   With Caddy, it is three lines:

   ```
   zra.example.com {
       reverse_proxy 127.0.0.1:7777
   }
   ```

   With NPM: proxy host `zra.example.com` → `http://127.0.0.1:7777`,
   **Websockets Support enabled**, SSL forced.

2. **Standalone, no proxy**: the relay carries its own certificate
   (Let's Encrypt DNS-01, §4.4):

   ```bash
   ZRA_RELAY_TLS_CERT=.zra/tls/zra.crt ZRA_RELAY_TLS_KEY=.zra/tls/zra.key npm run relay
   ```

   The certificate is reloaded live on renewal; its expiry is announced in
   the log. `ZRA_RELAY_PORT` and `ZRA_RELAY_HOST` change the listening address
   (7777, all interfaces by default).

**Automatic startup** (Linux homelab):

- **With the tray** ("app" archive, relay mode): the management console
  generates the `systemd --user` unit `zra-relay.service` — "Launch ZRA at
  session open" checkbox. The unit launches the binary with `--headless`; it
  supervises the relay with the listening address and TLS from
  `.zra/tray.json`. Linger is checked and enabled if needed
  (`loginctl enable-linger`, no sudo): without it, no boot start on a machine
  with no open session. No more copy-pasted unit.
- **Without the tray** (`npm run relay`), for example a system systemd unit:

```ini
[Unit]
Description=ZRA relay
After=network-online.target

[Service]
WorkingDirectory=/opt/zra
ExecStart=/usr/bin/node zra-relay/index.js
Environment=ZRA_RELAY_TLS_CERT=/opt/zra/.zra/tls/zra.crt
Environment=ZRA_RELAY_TLS_KEY=/opt/zra/.zra/tls/zra.key
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

**Exposure and security — the user's to manage.** ZRA's security is
**pairing** (§2): without a token, no command goes through. How the relay (and
the machines) are exposed is an architecture choice, not a ZRA feature. The
menu, from most closed to most open:

- **LAN only**: relay not exposed, phone on the same network (or VPN);
  firewall accordingly;
- **private VPN**: relay and machines on a VPN (WireGuard, Tailscale…), the
  phone joins it — nothing is public;
- **proxy with an access list**: the relay behind the homelab's proxy,
  filtered by IP (NPM access list, Caddy rules) — only known addresses get in;
- **public HTTPS**: the relay open on the internet (a domain, a certificate).
  Anyone can then attempt pairing against a private IP: the 6-digit code,
  rate-limited and locked after failures, is the barrier — just like an
  exposed daemon. For deliberate use only.

In all cases: a paired device means access to the machine (README,
"Security"), and traffic between the relay and the machines is plain `ws://`
on the LAN/VPN — HTTPS only covers the phone ↔ relay leg.

### 4.2 A reverse proxy per machine (alternative)

Without the relay: the homelab carries HTTPS, each machine has its own proxy
entry. Example with Nginx Proxy Manager and a wildcard certificate already in
place:

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

### 4.3 Certificate on the daemon (alternative)

For a private IP, the workable path: a **domain name** with an
**A** record pointing to the machine's local IP (`zra.example.com → 192.168.1.20`),
and a **Let's Encrypt certificate through DNS-01 validation** (§4.4 — Let's
Encrypt cannot reach a private IP, it checks a TXT record instead). The
certificate lands in `.zra/tls/`; in `zra.config.json`:

```jsonc
"tls": { "cert": ".zra/tls/zra.crt", "key": ".zra/tls/zra.key" }
```

Then `https://zra.example.com:7777` on the phone. The daemon reloads the
certificate live on renewal (§4.4).

Some routers filter public names that resolve to a private IP
("DNS rebinding protection"): allow the domain in the router if the page cannot
be found from home.

### 4.4 Certificates: DNS-01 validation

For the daemon (§4.3) as well as the standalone relay (§4.1). A domain name
with a DNS host (Cloudflare, OVH, Gandi, Infomaniak…) is required.

**Windows — `scripts/cert.ps1`** (Posh-ACME, without admin):

```powershell
Install-Module Posh-ACME -Scope CurrentUser     # once
pwsh scripts/cert.ps1 -Domain zra.example.com -Contact me@example.com -Plugin Cloudflare -PluginArgs @{ CFToken = (Read-Host -AsSecureString) }
```

`-Plugin`: the one for your DNS host (`Get-PAPlugin`), or `Manual`
(the TXT record to create by hand, to redo every 60 days). `-Staging` for a
trial without quota. Renewal, to schedule once (without admin):

```powershell
schtasks /Create /TN "ZRA certificate" /SC DAILY /ST 12:00 /TR "pwsh -NoProfile -WindowStyle Hidden -File \"<repository>\scripts\cert.ps1\" -Renew"
```

`scripts/cert.ps1` has not been tried for real yet.

**Linux — certbot or acme.sh** (same principle, DNS-01 validation):

```bash
# Example with certbot (adapt to the DNS provider)
certbot certonly --manual --preferred-challenges dns -d zra.example.com
# then copy the certs:
cp /etc/letsencrypt/live/zra.example.com/fullchain.pem .zra/tls/zra.crt
cp /etc/letsencrypt/live/zra.example.com/privkey.pem .zra/tls/zra.key
```

Renewal: `certbot renew` (cron or systemd timer). The daemon and the relay
reload the certificate live; a third-party static server has nothing to
reload.

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

**With the tray**: if the `zra-tray` binary is present (`.zra/bin/`, or
`zra-tray/target/` release or debug), the task launches it directly — it
supervises the daemon (restart on crash, logs, single instance) and shows the
notification icon. Without the binary, fallback to the PowerShell launcher
`scripts/daemon-task.ps1`. Develop the tray with `npm run tray` (Rust,
design: `reference/conception-zra-tray.md`). Its menu opens a **management
console** (local page in the browser): service state, workstation/relay
switch, autostart, logs, versions, tray quit.

**Updates ("app" archive)**: single stable channel — the latest release from
the forges (Forgejo, then GitHub as fallback). "Automatic updates" setting
(enabled by default) + "Check" button in the console: the archive is
downloaded in the background, then installed on the tray's next quit or
restart ("Install and restart" for right now). `app/.zra` and
`app/zra.config.json` are preserved; on Windows the running exe is renamed
then replaced, the old one deleted after exit. In repo layout (contributor),
updates come from git — the tray does not touch them.

**Install on the machine (self-install)**: the "app" archive launched as-is
runs **portable**. At onboarding, the "Install on this machine" option
(checked by default) copies the binary and `app/` to a fixed location —
`%LOCALAPPDATA%\Programs\zra` (Windows) or `~/.local/share/zra` (Linux) —
then rewires the absolute paths (Zed, autostart), adds the Start Menu
shortcut and the "Installed apps" key (HKCU, no elevation), and relaunches
ZRA from the target. Unchecking = stay portable (choice remembered); the
button remains available in the console. Installed: no going back, the exit
is uninstall. A portable copy relaunched while an installed instance exists
launches the installed one — no two parallel lives. During onboarding the
process has no tray and no window: relaunching the executable reopens the
page (single-instance lock) instead of exiting silently.

**Uninstall**: from the console, "Uninstall…" leaves the machine as it was
found — service stopped, autostart removed, Zed unwired (agent entries,
keymap, env), the application folder deleted (code, disposable) and the
Windows "Installed apps" key removed. Two choices: uninstall everything (the
user config is removed too), or keep your settings (the config — settings,
pairing, certificates — stays in the user config folder, outside the deleted
folder). Node and Zed are not touched; no firewall rule was ever added,
nothing to remove.
On Windows the running exe is locked: folder deletion is deferred until after
exit. In repo layout, the cloned folder is not deleted.

**PowerShell policy** — the keyboard script and the fallback PowerShell
launcher launch PowerShell with `-ExecutionPolicy Bypass`: a deliberate
choice so that control works whatever the machine. The bypass only applies
to the launched process; the machine (and user) policy is not changed.

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

The relay on the homelab: §4.1 (system systemd unit).

---

## 5.2 Linux: keyboard control under Wayland

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
| the relay's PWA does not load | is the relay running (`npm run relay`)? does the proxy in front answer? valid certificate (§4.4)? |
| "address refused by the relay" | public IP or hostname: the relay only targets private IPv4 (§4.1). Machine off-LAN: put it on the homelab's VPN (§3.1) |
| "the relay answers but not the machine" | does the homelab reach the machine? `curl http://<ip>:7777/` from the homelab; daemon running? VPN keepalive (§3.1)? |
| "pairing required" in a loop | token revoked or `.zra/auth.json` deleted: enter a code again |
| "wrong code" | the code changed (single use): `npm run pair` |
| "machine unreachable" | `npm run service`: does the daemon answer? `npm run service -- logs` |
| Zed not found at setup | native install required; Flatpak/Snap not supported → `zedDb`/`zedSettings` in `zra.config.json` (`docs/en/limitations.md`) |
| WebSocket refused (403) | log: "origin … not allowed" → `allowedOrigins` (§4.2). With the relay: nothing to declare, it presents itself without `Origin` |
| no installation offered | page over `http://`: no certificate (§4) |