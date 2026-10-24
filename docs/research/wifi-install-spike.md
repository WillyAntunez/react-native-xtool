# Wi-Fi install spike (pymobiledevice3 11.43.1, iPhone 00008030-001645A61EBB802E, iOS 26.5)

Date: 2026-10-23. No repo was modified. The only device change was reinstalling our own app
(`XTL-G7T6C5W9ZU.com.willyantuneztowerhouse.app`). No settings were changed, nothing was
unpaired, no tunnel was started and no developer image was mounted.

## TL;DR

- **The Wi-Fi install works.** The USB cable was unplugged (`lsusb` showed no Apple device and
  usbmuxd was inactive). A 139 MB `App.ipa` was installed over plain lockdown TCP to
  `192.168.1.10:62078` in **70.8 s** (71.2 s wall clock including Python startup).
  `installation_proxy` confirmed it afterwards: version 1.0.0 (1), signed by
  `Apple Development: willyantunezg@gmail.com (ZDK9NF3T6Z)`.
- **Root cause of the AFC drop: no heartbeat.** Over Wi-Fi, iOS closes every lockdown
  service connection right after the TLS handshake, on the first request, unless the host
  keeps a `com.apple.mobile.heartbeat` connection open and answers each `Marco` with
  `Polo`. Over USB, usbmuxd keeps the device present, so no heartbeat is needed. Over the
  network, Apple's usbmuxd and jkcoxson's netmuxd (`src/heartbeat.rs`) both start a
  heartbeat before they report the device as present. pymobiledevice3's
  `create_using_tcp` does **not** start one.
- Nothing is wrong with the pair record, TLS, the escrow bag or iOS 17+ RSD. The lockdown
  services AFC and `installation_proxy` still work over plain lockdown Wi-Fi on iOS 26.5.
  No tunnel and no root are needed.
- **Recommendation: implement it natively in TypeScript**, with no Python dependency. A
  140-line Node probe using only `net`, `tls` and the `plist` package that expo-xtool
  already depends on did this over Wi-Fi: lockdown session, TLS, heartbeat and
  `installation_proxy` Lookup in 0.64 s. The rest is AFC upload plus the `Install`
  command. Estimate: about 2–3 days with tests.

## 1. Evidence: same session, with and without the heartbeat

All probes use `rec = await pair_records.get_preferred_pair_record(UDID, None)`. With USB
unplugged this record comes from `/var/lib/lockdown/<UDID>.plist`, which is world-readable,
owned by usbmux:plugdev and stored as XML. The probes then call
`l = await create_using_tcp(hostname="192.168.1.10", autopair=False, pair_record=rec)`.

### Without a heartbeat (`t1.py`, `t2.py`, `t4.py`): every service dies

```
pair record keys: ['DeviceCertificate','EscrowBag','HostCertificate','HostID','HostPrivateKey',
                   'RootCertificate','RootPrivateKey','SystemBUID','WiFiMACAddress']
WiFiMACAddress in record: 14:7d:da:ed:7d:8c
device WiFiAddress:       14:7d:da:ed:7d:8c        <- matches (the ARP MAC ce:0a:c5:… is the private Wi-Fi MAC; irrelevant)
paired True udid 00008030-001645A61EBB802E session 5FD218B6-…
lockdown session TLS: TLSv1.2
com.apple.afc                       -> {'EnableServiceSSL': True, 'Port': 50294, ...}
com.apple.mobile.installation_proxy -> {'EnableServiceSSL': True, 'Port': 50295, ...}
com.apple.mobile.diagnostics_relay  -> {'EnableServiceSSL': True, 'Port': 50296, ...}

AFC (raw READ_DIR "/"), max TLS1.3: TLS: TLSv1.2 ('ECDHE-RSA-AES256-GCM-SHA384') -> recv 0 b''   (EOF)
AFC (raw READ_DIR "/"), max TLS1.2: TLS: TLSv1.2 ('ECDHE-RSA-AES256-GCM-SHA384') -> recv 0 b''   (EOF)
diag.mobilegestalt     FAIL ConnectionTerminatedError
installproxy.get_apps  FAIL ConnectionTerminatedError
raw installation_proxy Browse plist FAIL ConnectionTerminatedError
```

These results show the following:
- `StartService` succeeds and returns `EnableServiceSSL: True` for every service over
  Wi-Fi. pymobiledevice3 honours it: `start_lockdown_service` builds an SSL context from
  `HostCertificate` and `HostPrivateKey`.
- The service TLS 1.2 handshake **completes**. In TLS 1.2, the client certificate is checked
  before `Finished`, so the certificate is accepted.
- The device then closes the connection without sending anything, on the first application
  record. This happens for all services, not just AFC. So it is not an AFC or `makedirs`
  bug, not a TLS version or cipher problem, and not a pair record problem. `WiFiMACAddress`
  matches and `EscrowBag` is present; the escrow bag only matters for locked-device
  services.

### With a heartbeat (`t5.py`): everything works

```
heartbeat first msg after 0.0s: {'Command': 'Marco', 'Interval': 10, 'SupportsSleepyTime': True}
afc listdir: ['Podcasts', 'Downloads', 'CloudAssets', 'Books', 'Photos', 'Deferred', 'Music', 'PhotoStreamsData']
get_apps OK: [... 'XTL-G7T6C5W9ZU.com.willyantuneztowerhouse.app', ...]
```

The only change from the failing probes was these two lines, run before any other
service:
`hb = await l.start_lockdown_service("com.apple.mobile.heartbeat"); await hb.recv_plist(); await hb.send_plist({"Command":"Polo"})`.

## 2. Full install over Wi-Fi (USB unplugged)

The script is at
`<path>`.

```
$ /usr/bin/time -v .../pmd3/bin/python wifi_install.py 192.168.1.10 00008030-001645A61EBB802E \
    <path> XTL-G7T6C5W9ZU.com.willyantuneztowerhouse.app
open at 21:58:43; usb: 0
heartbeat up after 0.9s
progress 100%
install done in 69.9s (total 70.8s)
verify: XTL-G7T6C5W9ZU.com.willyantuneztowerhouse.app installed {'CFBundleShortVersionString': '1.0.0',
        'CFBundleVersion': '1', 'SignerIdentity': 'Apple Development: willyantunezg@gmail.com (ZDK9NF3T6Z)'}
Elapsed (wall clock) time: 1:11.22
Maximum resident set size: 782644 kB    <- pymobiledevice3 reads the whole ipa into memory (and copies it)
```

The 69.9 s covers the AFC upload of 139 MB plus installd's work. I did not time the two
parts separately.

The working code (essentials):

```python
rec = await pair_records.get_preferred_pair_record(udid, None)          # from /var/lib/lockdown or usbmuxd
lockdown = await create_using_tcp(hostname=ip, autopair=False, pair_record=rec)
assert lockdown.paired and lockdown.udid == udid

async def heartbeat(lockdown, ready):
    svc = await lockdown.start_lockdown_service("com.apple.mobile.heartbeat")
    while True:
        await svc.recv_plist()                      # {"Command":"Marco","Interval":10,...}
        await svc.send_plist({"Command": "Polo"})
        ready.set()

ready = asyncio.Event(); hb = asyncio.create_task(heartbeat(lockdown, ready))
await asyncio.wait_for(ready.wait(), 30)            # must be up BEFORE any other StartService'd connection is used
await InstallationProxyService(lockdown=lockdown).install_from_local(Path(ipa), handler=progress)
apps = await InstallationProxyService(lockdown=lockdown).get_apps(bundle_identifiers=[bundle_id])
hb.cancel()
```

**USB:** the cable does not need to be unplugged. The successful install ran with USB
unplugged. Earlier failing runs with USB plugged in failed only because they had no
heartbeat. Plain TCP to port 62078 does not go through usbmuxd, so having USB plugged in
does not change which path is used.

## 3. Points from the brief that were checked and ruled out

- **USB vs TCP service start.** `start_lockdown_service` is the same code for both. Only
  `create_service_connection` differs: usbmux `Connect` vs `asyncio.open_connection`. Both
  wrap the socket in TLS when `EnableServiceSSL` is set. With the heartbeat running, the
  TCP path works unchanged.
- **Session SSL.** `validate_pairing` gets `EnableSessionSSL` and upgrades the lockdown
  connection to TLS 1.2. `get_value` works over it.
- **Pair record contents.** `WiFiMACAddress` matches the device's `WiFiAddress`.
  `EscrowBag`, `HostID` and `SystemBUID` are present. Nothing is missing for Wi-Fi.
- **Copying the record into pymobiledevice3's cache folder** (item 2 of the brief). Not
  done because it is not needed: passing `pair_record=` works once the heartbeat runs.
  `~/.pymobiledevice3` does not exist and was left alone.
- **iOS 17+ / RSD** (item 3). The RSD/CoreDevice tunnel is needed only for developer
  services such as debugserver, DVT and DDI. pymobiledevice3's `misc/RemoteXPC.md` lists AFC
  and installd as `*.shim.remote` shims over RSD, but plain lockdown still serves them over
  Wi-Fi on iOS 26.5, as shown in section 2.
- **USB baseline** (item 4). Not run: the user unplugged the cable during the spike, so
  usbmuxd stopped (it was `inactive (dead)`). It was not needed either, because the Wi-Fi
  install itself proves both the ipa and the install path.

## 4. Operational caveat: the phone's Wi-Fi sleeps

While the iPhone was locked or idle, `192.168.1.10` stopped answering for minutes at a time:
ping showed 100% loss and TCP connections to port 62078 timed out. It came back when the
phone woke. Each probe was gated on a `/dev/tcp/192.168.1.10/62078` wait loop. Once
connected, a running heartbeat keeps the session alive; Apple's `SupportsSleepyTime: True`
flag relates to this. The CLI must:
- give a clear "wake/unlock the iPhone" error on connect timeout, and
- consider retrying for N seconds.

## 5. How expo-xtool should implement `install --network <ip>`

### Option A: Python helper (pymobiledevice3)

The code is in section 2 (about 50 lines). Effort: about 0.5 day.

Against it:
- A heavy runtime dependency: a Python venv plus pymobiledevice3 and its many native wheels.
- Version fragility: the 11.43.1 CLI already crashes on import under Python 3.14.
- About 780 MB RSS for a 139 MB ipa.
- A second toolchain to install and support in `doctor`.

### Option B: native TypeScript (recommended)

The Node probe at
`<path>`
already works over Wi-Fi with only `node:net`, `node:tls` and `plist` (Node 24, OpenSSL
3.5.5):

```
QueryType com.apple.mobile.lockdown
StartSession EnableSessionSSL true
lockdown TLS TLSv1.2 UDID 00008030-001645A61EBB802E
heartbeat: { Command: 'Marco', Interval: 10, SupportsSleepyTime: true }
Lookup: {"XTL-G7T6C5W9ZU.com.willyantuneztowerhouse.app":{"CFBundleVersion":"1",...}} (639 ms)
```

Implementation notes from the probe:
- **Framing.** Lockdown and plist services use a 4-byte big-endian length followed by a
  plist. Requests are sent as XML. Replies can be **binary** plists (`bplist00`): pass
  `plist.parse` a `Uint8Array` for those, not a string.
- **TLS.**
  - Use `tls.connect({socket, cert: HostCertificate, key: HostPrivateKey, rejectUnauthorized: false})`.
  - TLS 1.2 is what gets negotiated (ECDHE-RSA-AES256-GCM-SHA384).
  - The pair record certificates are RSA-2048 with sha256, so Node's default OpenSSL
    security level is fine and no `@SECLEVEL=0` is needed.
  - To upgrade the lockdown socket after `StartSession`, wrap the existing socket and stop
    reading raw data from it first.

Modules to write:
1. `lockdown.ts`: connect, QueryType, StartSession, TLS, GetValue, StartService. Reads the
   pair record from `/var/lib/lockdown/<udid>.plist`, falling back to usbmuxd
   `ReadPairRecord` when usbmuxd is running. About 150 lines.
2. `heartbeat.ts`: start the service, run the Marco/Polo loop with a timeout of
   `Interval + 5` s, and on failure abort the whole install with a clear error. About
   40 lines.
3. `afc.ts`: only the operations we need.
   - Header: `CFA6LPAA`, entire_len, this_len, packet_num, opcode (each u64 LE).
   - Opcodes: MAKE_DIR (9), FILE_OPEN (13, mode 3 = wb), FILE_WRITE (16), FILE_CLOSE (20),
     REMOVE_PATH (8).
   - Read status replies (opcode 1).
   - Stream the ipa from disk in chunks of about 1 MB rather than loading it into memory.
   - About 150 lines.
4. `installProxy.ts`:
   - `Install` with `{PackagePath, ClientOptions:{}}`; loop on `Status`, `PercentComplete`
     and `Error` until `Status == "Complete"`.
   - `Lookup` to verify the install.
   - About 80 lines.
5. `commands/install.ts`: add `--network <ip>` (and `--udid`, defaulting to the single pair
   record or `state`). Skip the USB device filter on this path. Install the ipa that
   `xtool dev build --ipa` produces instead of calling `xtool dev run`.

Tests:
- Unit tests for framing, the AFC header codec and installd status parsing, using recorded
  replies.
- A fake-device TCP and TLS server in vitest for the lockdown handshake, plus the
  heartbeat-missing → EOF behaviour.
- A manual device check (`Lookup` after install).

Effort: about 600 lines of TypeScript plus tests, **2–3 days**.

Benefits:
- No Python and no usbmuxd2 or Avahi: we use the IP directly, so mDNS is not needed.
- The same code can later back `install --udid` over USB through usbmuxd `Connect`.

Out of scope for both options: `dev run --network`, meaning launch plus debugserver. That
needs the iOS 17+ RSD tunnel (CoreDevice), which is a separate, larger problem. The install
is enough for an Expo dev client: the user taps the icon and the dev launcher connects to
Metro.

## 6. Failure walk (for the plan; rulings are Willy's)

Hops:
1. Read the pair record.
2. TCP connect to `<ip>:62078`.
3. Lockdown StartSession and TLS.
4. Start the heartbeat.
5. StartService for AFC and the AFC upload.
6. StartService for `installation_proxy` and `Install`.
7. Verify with Lookup.
8. Clean up the staged ipa.

| # | Failure | Who learns | Proposed ruling |
|---|---|---|---|
| 1 | No pair record (never paired over USB) | CLI | handle: clear error "pair over USB once" |
| 2 | Phone asleep or locked: TCP timeout (seen repeatedly in this spike); wrong IP; DHCP changed the IP | CLI | handle: timeout plus a "wake/unlock iPhone, check IP" message; optional retry window |
| 3 | Pairing removed on the device ("Trust" reset): TLS EOF in StartSession | CLI | handle: specific error |
| 4 | Heartbeat missing or dies mid-upload (Wi-Fi roam, sleep): services EOF | CLI | handle: abort with a reason; do not report success |
| 5 | Upload partially done, then a drop: an orphan file in `/PublicStaging` | nobody | accept or handle: best-effort rm on the next run (pymobiledevice3 uses a random name each time) |
| 6 | installd error (signature or provisioning profile not covering the device, expired free-account cert, low disk space) | CLI | handle: surface the installd `Error`/`ErrorDescription` verbatim |
| 7 | Install reports Complete but the app is not launchable (Developer Mode off, cert not trusted) | user, on the device | accept: the existing `firstRunChecklist` covers it |
| 8 | Two hosts installing at once, or a duplicate run | device | accept |
