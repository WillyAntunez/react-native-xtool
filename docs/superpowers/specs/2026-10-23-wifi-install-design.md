# Wi‑Fi install (`install --network`) — diseño corto

Fecha: 2026-10-23. Decisión de Willy: implementar nativo en TypeScript, sin Python.

## Hallazgos (spike `.superpowers/wifi-install-spike.md`)

- iOS acepta conexiones lockdown por TCP (puerto 62078) a la IP del iPhone con el registro de
  emparejamiento creado por USB, una vez activado `EnableWifiConnections`
  (`com.apple.mobile.wireless_lockdown`). No requiere mDNS, túnel RSD, root ni cambiar `usbmuxd`.
- iOS cierra cualquier conexión de servicio por Wi‑Fi salvo que el host mantenga abierta una sesión
  `com.apple.mobile.heartbeat` respondiendo Marco→Polo. Con el latido activo, AFC e
  `installation_proxy` funcionan: 139 MB instalados en 71 s con el USB desconectado.
- Un probe en Node (solo `net`, `tls`, `plist`) ya hizo lockdown TLS + heartbeat + Lookup en 0,6 s.
- El iPhone bloqueado/dormido deja de responder en red durante minutos.

## Objetivo

`expo-xtool install --network [<ip>]` instala el `.ipa` firmado por xtool sin cable; `setup --wifi`
activa la opción en el iPhone por USB (una vez); `doctor` informa del estado Wi‑Fi. WSL2 queda
cubierto documentando el emparejamiento único (usbipd-win o copia del registro).

## No objetivos

- Reemplazar la instalación USB (xtool) — sigue siendo el camino por defecto.
- Depuración/launch por red (debugserver/RSD).
- Descubrimiento mDNS (no funciona en redes con repetidores; se podrá añadir después).

## Cómo

1. `src/device/lockdown.ts`: cliente lockdown por TCP: plist length-prefixed, `QueryType`,
   `ValidateRelease`/`StartSession` con el registro de emparejamiento (TLS 1.2 con el certificado y la
   clave del host del registro), `GetValue`, `StartService` (+`EnableServiceSSL`), conexión a servicio
   con TLS. Registro de emparejamiento: leer vía usbmuxd (`ReadPairRecord`) cuando el USB está
   presente, cachear en `~/.cache/expo-xtool/pair-records/<UDID>.plist` para uso sin cable; permitir
   `--pair-record <file>` (WSL).
2. `src/device/heartbeat.ts`: abrir `com.apple.mobile.heartbeat` y responder Polo a cada Marco
   mientras dure la operación.
3. `src/device/afc.ts`: subida en streaming a `PublicStaging/<name>.ipa` (operaciones MakeDir,
   FileOpen, FileWrite por bloques, FileClose) con progreso.
4. `src/device/installproxy.ts`: `Install` (PackagePath staged) con bucle de `PercentComplete`/`Status`
   hasta `Complete`, errores legibles (`ApplicationVerificationFailed` → "firma inválida/caducada",
   `DeviceOSVersionTooLow`, etc.).
5. `src/commands/install.ts`: `--network [ip]`: `xtool dev build --sign --ipa` → instalar vía 1-4;
   sin IP: usar la última conocida del estado, si no, escanear /24 por 62078 e identificar por UDID
   (como en el spike), guardar en el estado. Mensajes: iPhone dormido/bloqueado → "Desbloquea el iPhone"
   con reintentos (3 × 10 s). `setup --wifi`: por USB (lockdown vía usbmuxd) `SetValue
   EnableWifiConnections=true` con confirmación explícita. `doctor`: `wifi` check (activado, IP
   conocida, alcanzable).
6. Tests: parsers y máquinas de estado puras con fixtures (plist binarios/XML grabados), servidor TLS
   falso para lockdown/heartbeat/AFC/installd; E2E opt-in `EXPO_XTOOL_E2E_WIFI=1` contra el iPhone.
7. Docs: README (flujo: cable una vez, luego Wi‑Fi), WSL2 (usbipd-win o copiar
   `/var/lib/lockdown/<UDID>.plist`), troubleshooting (dormido, otra red, IP cambiada).

## Fallos externos

| Fallo | Decisión |
| --- | --- |
| iPhone bloqueado/dormido (no responde en red) | handle: error claro + 3 reintentos espaciados |
| IP del iPhone cambia (DHCP) | handle: `--network` sin IP reescanea y verifica UDID; guarda la nueva |
| Sin registro de emparejamiento (PC nuevo / WSL) | handle: mensaje con los dos caminos (USB una vez, o `--pair-record`) |
| Subida interrumpida (Wi‑Fi cae) | handle: limpiar `PublicStaging`, reintentar una vez |
| Firma caducada (7 días, cuenta gratuita) | handle: mapear `ApplicationVerificationFailed` a "vuelve a ejecutar install (re-firma)" |
| Otro dispositivo Apple responde en 62078 | handle: comprobar UDID antes de instalar |
