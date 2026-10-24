# expo-xtool — diseño (paso 1)

Fecha: 2026-10-23. Estado: borrador para aprobación.

## Intención

Que un desarrollador con Linux (sin Mac) compile, firme e instale el dev build de iOS de un
proyecto Expo en su iPhone con un par de comandos, y luego desarrolle con Metro y Fast Refresh
por WiFi como lo haría con Xcode.

Hoy esto existe como una receta a mano en `expo-ios-linux/app/ios-xtool/` (Package.swift,
xtool.yml, Info.plist, scripts y parches) validada el 2026-10-23 en un iPhone real. expo-xtool
convierte esa receta en una herramienta.

**Por qué ahora:** Expo SDK 58 / RN 0.88 movieron el ensamblaje nativo de iOS de CocoaPods a
SwiftPM + xcframeworks precompilados. Esa capa corre en Linux casi sin cambios; es la primera vez
que esto es viable sin reimplementar CocoaPods.

## Objetivos

- Proyectos Expo **SDK 58 o superior** (RN 0.88+), nuevos o migrados.
- Dos comandos: `expo-xtool setup` (una vez por máquina) y `expo-xtool run` (build + firma +
  instalación + Metro). Todo lo demás son subcomandos de apoyo.
- Soportar el conjunto de librerías que usan las apps de referencia (ver "Librerías objetivo").
- Éxito del paso 1: una app nueva en SDK 58 con esas librerías corre en el the test iPhone con
  Fast Refresh, instalada desde Ubuntu.

## No objetivos (paso 1)

- SDK ≤ 57 (es el paso 2: traductor podspec → SwiftPM completo).
- Builds de producción / App Store (los hace EAS).
- expo-dev-client (no es SwiftPM-ready en Expo 58). El dev build carga JS desde Metro vía
  `RCTBundleURLProvider` + `ip.txt`; el menú de desarrollo es el de React Native.
- Simulador iOS (solo existe en macOS).
- macOS / Windows nativo. WSL se considera "Linux" pero no se prueba en el paso 1.
- Publicar en npm / GitHub (se trabaja en local; el repo queda listo para publicar).

## Anti-objetivos

- Forkear xtool. xtool se consume como binario oficial sin modificar, con versión fijada.
  Lo que falte se rodea desde el CLI o se propone como PR upstream.
- Redistribuir cualquier cosa de Apple. El usuario trae su propio `Xcode.xip`.
- Ocultar los límites de la cuenta gratuita (7 días, 3 apps, sin push ni entitlements). El CLI
  los muestra; no promete lo que Apple no permite.

## Restricciones

- Linux x86_64 (arm64 debería funcionar; no se prueba).
- Swift 6.4+ vía swiftly (SwiftPM < 6.4 no resuelve xcframeworks en Linux).
- xtool 1.23.0 (pin inicial) + Darwin SDK extraído de Xcode 27.x.
- Node 20+.
- Firma con Apple ID gratuito o de pago; el bundle ID instalado es `XTL-<TEAM>.<bundleID>`.
- Metro debe ser alcanzable desde el iPhone: IP de LAN, puerto libre, firewall abierto.

## Enfoques considerados

1. **CLI independiente `expo-xtool` (elegido).** Paquete npm en TypeScript que orquesta el
   pipeline SwiftPM oficial de RN y Expo, genera los archivos de xtool y llama al AppImage.
   Pros: cero forks, publicable con `npx`, toda la lógica nueva en un repo. Contra: duplica algo
   de lo que hace el plugin SPM de Expo (resolver Info.plist, fases de xcodebuild).
2. **Fork de xtool con soporte Expo.** Más integrado, pero ata a Swift, obliga a mantener fork y
   depende de upstream. Descartado hasta que la receta sea estable.
3. **Config plugin de Expo únicamente.** No alcanza: el trabajo es fuera de `expo prebuild`
   (compilar, firmar, instalar). Podría añadirse después como azúcar.

## Cómo se construye (decidido)

### Repo y paquete

Un solo repo (`expo-xtool`), un paquete npm. Carpetas:

- `src/` — CLI en TypeScript (commander o yargs; decisión del builder), ejecutable `expo-xtool`.
- `templates/` — `Package.swift`, `xtool.yml`, `Info.plist` como plantillas con variables.
- `scripts/` — `build-expo-modules-jsi.sh`, `stage-frameworks.sh` (ya existen, se mueven).
- `shims/` — `plutil`, `otool` (ya existen).
- `patches/` — diffs a node_modules (ya existen), aplicados con `patch-package` o lógica propia.
- `catalog/` — (fase posterior del paso 1) `Package.swift` por librería CocoaPods-only.
- `docs/` — este diseño, notas de investigación migradas desde `expo-ios-linux/notes/`.

### Comandos

- `expo-xtool setup`: instala swiftly + Swift 6.4, descarga el AppImage de xtool (versión pinneada
  en `src/versions.ts`), instala el Darwin SDK desde la ruta al `Xcode.xip` que da el usuario,
  verifica `xtool auth status` y guía el `xtool auth login` (interactivo, se delega a xtool).
  Comprueba firewall (ufw) y avisa. Idempotente.
- `expo-xtool doctor`: reporta versiones, SDK, login, dispositivo conectado, puerto de Metro.
- `expo-xtool build [--clean]`: `expo prebuild --platform ios` (si falta `ios/`), pipeline SPM de
  RN (`setup-apple-spm.js` con shims en PATH y config de autolinking vía expo-modules-autolinking),
  plugin SPM de Expo, ExpoModulesJSI, staging de frameworks, generación de `ios-xtool/`
  (Package.swift, xtool.yml, Info.plist con **todas** las `$(VARS)` resueltas, `ip.txt`,
  Sources/App enlazados), `xtool dev build`.
- `expo-xtool install`: `xtool dev run --usb` (firma + instala). Avisa si el bundle ID instalado
  cambió y recuerda Modo de desarrollador / confiar certificado la primera vez.
- `expo-xtool start`: detecta IP de LAN y puerto libre (8081 → 8082 → …), escribe `ip.txt` y
  `RCTMetroPort` coherentes (si cambia el puerto, exige reinstalar y lo dice), lanza
  `expo start --lan`.
- `expo-xtool run`: build + install + start.

### Config

`expo-xtool.config.{js,json}` opcional en la raíz del proyecto: ruta del Xcode.xip, puerto de
Metro, IP forzada, apps extra. Lo mínimo funciona sin config.

### Generación de `ios-xtool/`

Fuente única de verdad: `app.json` + lo que `expo prebuild` deja en `ios/`. El CLI lee
`ios/<app>/Info.plist` y el `project.pbxproj` sólo para resolver variables de build
(`PRODUCT_MODULE_NAME`, `MARKETING_VERSION`, etc.); el resto se toma de las salidas del pipeline
SPM (`ios/build/...`). `ios-xtool/` es un artefacto regenerable, no se edita a mano.

### Librerías objetivo y estrategia

Grupo A (Expo, se espera que funcionen vía autolinking SPM): expo-router, expo-notifications
(locales), expo-secure-store, expo-image-picker, expo-calendar, expo-clipboard, expo-haptics,
expo-crypto, expo-linking, expo-localization, expo-web-browser, expo-auth-session, expo-blur,
expo-linear-gradient, expo-splash-screen, expo-system-ui, expo-font, expo-constants.

Grupo B (RN clásicas, hay que comprobar si traen SwiftPM; si no, entran al `catalog/`):
react-native-reanimated, react-native-worklets, react-native-gesture-handler,
react-native-screens, react-native-safe-area-context, react-native-svg, react-native-webview,
react-native-pager-view, @gorhom/bottom-sheet, @react-native-async-storage/async-storage,
@react-native-community/datetimepicker, @react-native-community/netinfo,
@react-native-masked-view/masked-view, @react-native-picker/picker.

Grupo C (requieren cuenta de pago o SDKs externos; se documentan, se prueban al final):
@sentry/react-native, @react-native-google-signin/google-signin, expo-apple-authentication,
push remoto de expo-notifications.

Orden de trabajo: primero verificar grupo A y B **en la app de juguete** (medir qué falla) y
después automatizar; no al revés.

### Parches a node_modules

Se aplican en `build` con `patch-package` (formato `patches/<pkg>+<ver>.patch`) y se proponen
como PRs a Expo: quitar el `if (platform !== 'darwin')` del escáner de módulos, y resolver la
ruta del macro-plugin por plataforma. El tercero (`CppError.message` interno) se reporta a Expo
como incompatibilidad con Swift 6.4.

## Fallos fuera del proceso (walk) — a completar en el plan

Hops externos: descarga de xtool/swiftly/RN prebuilts (red), `xtool auth` (Apple), instalación
por USB (device), Metro por WiFi (red local). Cada hop se tabula en el plan con su regla
(`handle` / `accept` / `defer`).

## Lo que decide el builder

- Librería de CLI, estructura de tests (mínimo: tests unitarios de la resolución de Info.plist
  y de la generación de Package.swift; el e2e es manual con iPhone).
- Formato exacto de plantillas y de `expo-xtool.config`.
- Cómo detectar la IP de LAN (interfaz por defecto vía `ip route`).
- Dónde cachear descargas (`~/.cache/expo-xtool`).

## Enmiendas (2026-10-23)

Cambios surgidos durante la implementación; el texto de arriba se conserva como historia.

- `build` elige y hornea el puerto de Metro y la IP de LAN,
  los escribe en `ip.txt` / `RCTMetroPort` y guarda el estado en `ios-xtool/.expo-xtool-state.json`.
  `start` ya no elige nada: verifica que el puerto horneado esté libre y que la IP no haya cambiado, y
  se niega a arrancar si hay desajuste (hay que reconstruir e reinstalar). Así sustituye a la
  descripción anterior de `start`.
- `templates/` pasó a ser renderizadores en TypeScript bajo `src/generate/` (`packageSwift.ts`,
  `xtoolYml.ts`, `iosXtool.ts`); no hay carpeta `templates/`.
- `scripts/stage-frameworks.sh` fue reemplazado por `src/frameworks.ts` (`stageFrameworks`); el script se
  conserva sólo como referencia de la receta manual.
- La comprobación de ufw vive en `doctor` (no en `setup`).
- `install` imprime el bundle ID instalado (`XTL-<TEAM>.<bundleID>`), tomado del estado de `build`, y exige
  que exista un build previo.
- `setup` respeta `xcodeXipPath` y `xtoolPath` de la config; `patch-package` se ejecuta desde la
  dependencia fijada del CLI en lugar de `npx`.
