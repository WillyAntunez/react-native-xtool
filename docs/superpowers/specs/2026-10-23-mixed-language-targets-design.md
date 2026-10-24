# Mixed-language (Swift + Objective-C) modules — diseño corto

Fecha: 2026-10-23. Decisión de Willy: ir por el target mixto único de SwiftPM.

## Hallazgos (ver `docs/research/`)

- SwiftPM 6.4.1 (nuestro toolchain) soporta targets mixtos Swift + C/ObjC de forma experimental con la
  cabecera `// swift-tools-version: 6.4;(experimentalMultiLang)`; SE-0541 (aceptada) lo hace estándar en
  tools-version 6.5 sin bandera. Con el backend swiftbuild y el SDK de Darwin, un módulo mixto en ambas
  direcciones (ObjC→Swift vía `<Module>-Swift.h`, Swift→ObjC vía umbrella) compila y enlaza (spike).
- Encuesta de 35 módulos: 23 funcionan hoy; necesitan target mixto: expo-application (→
  expo-notifications), expo-sqlite, expo-updates(-interface), react-native-pager-view, expo-dev-launcher
  y expo-dev-menu (circulares → dev client); async-storage necesita además `binaryTarget` (xcframework).
- El plugin SPM de Expo rechaza módulos ObjC puros (expo-json-utils, expo-structured-headers), módulos con
  un `.m` vacío (expo-updates-interface) y el meta-pod sin fuentes expo-dev-client.

## Objetivo del paso 1

`expo-xtool build` compila librerías mixtas (A, B y circulares) con un único target SwiftPM mixto, sin
adaptación por librería. Éxito: expo-notifications (vía expo-application) compila, instala y dispara una
notificación local en el the test iPhone.

## No objetivos (paso 1)

- `binaryTarget` para xcframeworks vendidos (paso 3). Dev client completo (paso 2).
- Esperar a Swift 6.5: se usa la bandera experimental y se deja preparado `Package@swift-6.5.swift`
  cuando el scaffolder lo permita.

## Cómo

1. **RN scaffolder (parche `react-native+0.88.0.patch`)**: cuando una librería mezcla Swift y C-family,
   en vez de saltarla ("mixed → skip") emitir un target mixto: cabecera de tools-version con
   `experimentalMultiLang`, `sources` de ambos lenguajes, `publicHeadersPath`/`include` shim como hoy,
   umbrella header generado para Swift (Foundation/UIKit + headers públicos del módulo, como CocoaPods),
   y para el ObjC un `-I` al directorio donde SwiftPM/Swift Build deja `<Module>-Swift.h` (pasado por
   variable de entorno desde expo-xtool para no hornear rutas absolutas en un `Package.swift` que se
   commitea como patch). Validar con el spike (`.superpowers/oss-survey/exp/`) como referencia de flags.
2. **Plugin de Expo (parche `expo+58.0.17.patch`)**: tratar módulos mixtos sin manifiesto igual
   (generar target mixto en el paquete fuente), aceptar módulos ObjC puros, ignorar `.m` vacíos, y
   tratar meta-pods sin fuentes como no-op. Clasificar como "con fuentes nativas" también `vendor/`
   (expo-sqlite).
3. **expo-xtool**: exportar la variable de entorno con la ruta de los headers generados al invocar RN
   (`rnSpm`), documentar, tests sobre los módulos patcheados con fixtures (A, B, circular), y verificación
   real: expo-application + expo-notifications en el iPhone.
4. Docs: `docs/upstream/` (RN bug 10 "mixed modules"; Expo "mixed modules / pure ObjC / empty .m /
   meta-pod"), `docs/research/` con las dos encuestas (sin rutas ni nombres privados), matriz.

## Fallos externos

| Fallo | Decisión |
| --- | --- |
| La bandera `experimentalMultiLang` cambia o desaparece en Swift 6.5 | handle: detectar tools-version del toolchain y emitir `Package@swift-6.5.swift` sin bandera cuando exista; test de ambas cabeceras |
| `-Swift.h` no se genera donde esperamos (cambio de layout de Swift Build) | handle: localizarlo por glob tras el primer build y fallar con mensaje claro si no aparece |
| Módulo mixto con script phases o resource bundles | accept: igual que hoy (warning), paso posterior |
