# Wi‑Fi installs

After pairing once over USB, `rn-xtool install --network` (and `run --network`) installs the app over Wi‑Fi with the
cable unplugged. This page covers the one-time setup, how the install talks to the iPhone, getting a pair record on
WSL2, and what to do when it fails. Metro always serves JS over Wi‑Fi; this page is only about installing the app.

[Back to README](../README.md)

## Setup and daily use

```sh
# Once, with the iPhone plugged in, unlocked and trusted:
rn-xtool install               # the first install must be over USB: it registers the iPhone with Apple
rn-xtool setup --wifi          # caches the pair record, shows what it would change
rn-xtool setup --wifi --yes    # enables "Wi‑Fi connections" on the iPhone

# From then on, cable unplugged, iPhone unlocked on the same Wi‑Fi:
rn-xtool install --network                 # finds the iPhone on your LAN by its UDID
rn-xtool install --network 192.168.1.10    # or give its IP
rn-xtool run --network                     # the daily loop, installing over Wi‑Fi when needed
```

`setup --wifi` also takes `--udid <udid>`; `install --network` takes `--udid <udid>` and `--pair-record <file>`.

The first install over USB matters: signing registers the connected iPhone's UDID with your Apple account, and later
signatures only cover registered devices. An iPhone that never had a USB install from this account gets
`ApplicationVerificationFailed` over Wi‑Fi.

## How it works

`install --network` builds a signed `.ipa` (`xtool dev build --sign --ipa`), then talks to the iPhone's lockdown
service on TCP port 62078: it opens a TLS session with the pair record, keeps a `com.apple.mobile.heartbeat` session
answered for the whole run (without it iOS drops every service connection over Wi‑Fi), uploads the `.ipa` to
`/PublicStaging` over AFC, installs it with `installation_proxy` and checks the result with a lookup. No Python, no extra
daemons, no root. A 139 MB app takes about a minute. Debugging and `launch` over the network are not supported: open the
app by hand.

The iPhone is authenticated: its TLS certificate must be the `DeviceCertificate` of the pair record, and its UDID is
read only inside that session, so nothing is uploaded to another host on the address.

**Finding the iPhone.** It remembers the iPhone's address and UDID in `ios-xtool/.rn-xtool-state.json`; without an IP
it tries that address first and otherwise scans your /24 for port 62078. The scan only runs from a private, non-VPN
address (the configured `lanIp`, or your default route); otherwise pass the IP. If the remembered iPhone is gone and
exactly one other paired iPhone answers, that one is used (and remembered); with several, pass `--udid`.

**Privacy of the scan.** The lockdown protocol sends the pairing's `HostID`/`SystemBUID` (identifiers, not secrets) in
clear before TLS, so a scan shows them to every host answering on port 62078 in that /24. On networks you do not trust
(hotspots, shared Wi‑Fi), pass the IP.

**Pair records.** They are read from usbmuxd (it keeps them in `/var/lib/lockdown`, also with the cable unplugged) and
cached in `~/.cache/rn-xtool/pair-records/<UDID>.plist` (mode 600: it holds this computer's private key for the
iPhone).

The heartbeat requirement is written up for upstream in
[upstream/pymobiledevice3-tcp-heartbeat.md](upstream/pymobiledevice3-tcp-heartbeat.md); the design is in
[design/specs/2026-10-23-wifi-install-design.md](design/specs/2026-10-23-wifi-install-design.md) and the spike in
[research/wifi-install-spike.md](research/wifi-install-spike.md).

## WSL2

Not tested yet: this section is reasoned from how WSL2 works, not from a run. Please report what you find.
WSL2 has no USB by default, and the phone is reached through Windows' network. Ways to get a pair record:

- Attach the iPhone to WSL once with [usbipd-win](https://github.com/dorssel/usbipd-win) (`usbipd bind` /
  `usbipd attach --wsl`), run `usbmuxd` and `rn-xtool setup --wifi`.
- Reuse Windows' own record: if iTunes / Apple Devices ever trusted the iPhone on that PC, it is likely in
  `C:\ProgramData\Apple\Lockdown\<UDID>.plist`, in the same format (believed, not verified yet). Copy it from
  `/mnt/c/ProgramData/Apple/Lockdown/` (it may need an elevated copy on the Windows side).
- Copy `/var/lib/lockdown/<UDID>.plist` from a Linux machine where the iPhone is paired. That directory may be readable
  by root only:
  `sudo cp /var/lib/lockdown/<UDID>.plist ~/<UDID>.plist && sudo chown $USER ~/<UDID>.plist && chmod 600 ~/<UDID>.plist`.

Put the file in `~/.cache/rn-xtool/pair-records/<UDID>.plist` (mode 600) or pass `--pair-record <file>`. Use
`install --network <ip>`: WSL2's NAT usually hides your LAN from the /24 scan (mirrored networking does not), and its
default route is not your Wi‑Fi address, so the scan is refused anyway unless `lanIp` is set.

## Troubleshooting

- **"iPhone did not respond over Wi‑Fi — unlock it and keep it awake, retrying…":** a locked or idle iPhone stops
  answering on the network for minutes. Unlock it and keep the screen on; `install` retries 3 × 10 s, then stops.
- **IP changed (DHCP):** run `install --network` without an IP; it rescans and saves the new address. An explicit IP is
  never rescanned.
- **Nothing found by the scan:** the phone is on another network or VLAN, a guest Wi‑Fi isolates clients, or a firewall
  blocks outgoing TCP to port 62078. Pass the IP (Settings > Wi‑Fi > ⓘ) to rule out the scan.
- **"no longer trusts this computer":** the pairing was reset on the iPhone (or belongs to another host). Plug it in,
  tap Trust, and run `rn-xtool setup --wifi` again.
- **Signature rejected (`ApplicationVerificationFailed`):** free-account signatures expire after 7 days; re-run
  `install --network`, which re-signs. On an iPhone that never had a USB install from this Apple account, do that first
  install over USB.
- **"Not scanning the network":** your default route is a VPN/tunnel or not a private address. Pass the iPhone's IP, or
  set `lanIp` in `rn-xtool.config.json` to your Wi‑Fi address.
- **"Found paired iPhone … pass --udid":** the remembered iPhone did not answer but other paired iPhones did; pick one
  with `--udid <udid>`.
- **"is not the paired iPhone":** something else answers at that address with a different certificate. Check the IP;
  nothing was uploaded to it.
- **Connection lost during the install:** the result on the iPhone is unknown, so it is not retried automatically;
  check the app and run the install again if needed.
- `rn-xtool doctor` shows the `wifi` check: whether Wi‑Fi connections are on (iPhone plugged in) and whether the last
  known address answers.

General build and Metro problems: [troubleshooting.md](troubleshooting.md).
