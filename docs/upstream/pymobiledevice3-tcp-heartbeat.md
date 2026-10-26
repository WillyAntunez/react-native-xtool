# pymobiledevice3: `create_using_tcp` needs a heartbeat for services over Wi‑Fi

Candidate upstream issue for [doronz88/pymobiledevice3](https://github.com/doronz88/pymobiledevice3).
Found while building rn-xtool's `install --network` (spike: `docs/research/wifi-install-spike.md`).
Checked with pymobiledevice3 11.43.1, iPhone (A13) on iOS 26.5, Linux host.

## Symptom

With a pair record made over USB and `EnableWifiConnections` on, `create_using_tcp(hostname=<ip>,
pair_record=rec)` pairs, starts a TLS session and `get_value()` works. Every service started from it
then dies: `StartService` succeeds (with `EnableServiceSSL: True`), the service TLS handshake
completes, and the device closes the connection without a byte on the first request:

```
AFC (raw READ_DIR "/")      -> recv 0 b''   (EOF)
diag.mobilegestalt          FAIL ConnectionTerminatedError
installproxy.get_apps       FAIL ConnectionTerminatedError
```

It looks like a pairing, TLS or escrow-bag problem but is none of them.

## Cause

Over the network, lockdownd keeps service connections alive only while the host answers a
`com.apple.mobile.heartbeat` session (`Marco` → `Polo`, the device sends `Marco` at once and then
every `Interval` seconds). Over USB, usbmuxd runs that heartbeat itself, so USB clients never see
it. Apple's usbmuxd and jkcoxson's netmuxd (`src/heartbeat.rs`) both start the heartbeat before they
report a network device; `create_using_tcp` does not.

Minimal fix in user code, before any other service:

```python
hb = await lockdown.start_lockdown_service("com.apple.mobile.heartbeat")
await hb.recv_plist()                 # {'Command': 'Marco', 'Interval': 10, 'SupportsSleepyTime': True}
await hb.send_plist({"Command": "Polo"})
# ...and keep answering every Marco for as long as other services are in use.
```

With that, AFC and `installation_proxy` work over plain lockdown TCP on iOS 26.5: a 139 MB `.ipa`
installed in about 71 s with the cable unplugged.

## Suggested change

- `create_using_tcp` (or `TcpLockdownClient`) starts a background `HeartbeatService` task after
  `validate_pairing`, waits for the first `Marco`, and cancels it on `close()`; or
- at least document the requirement next to `create_using_tcp` and in the Wi‑Fi section of the
  README, with the snippet above.

Related details worth noting in the same issue:

- `SleepyTime` from the device means it is going to sleep; services stop working afterwards.
- `install_from_local` reads the whole package into memory (about 780 MB RSS for a 139 MB `.ipa`);
  streaming it from disk in `fwrite` chunks would avoid that.
