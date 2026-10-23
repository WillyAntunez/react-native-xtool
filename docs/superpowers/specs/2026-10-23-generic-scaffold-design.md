# Generic SwiftPM scaffolding for CocoaPods-only libraries — diseño corto

Fecha: 2026-10-23. Decisión de Willy: **no adaptar librerías una por una**; arreglar el mecanismo
genérico y automatizarlo.

## Intención

Que cualquier librería React Native que solo trae `.podspec` se enlace en `expo-xtool build` sin
intervención manual, usando el scaffolder oficial de RN 0.88 (`npx react-native spm scaffold`),
y que los huecos de ese scaffolder se arreglen de forma genérica (parche local + PR upstream),
nunca con un `Package.swift` escrito a mano por librería.

## Hallazgos (matriz de librerías, 2026-10-23)

- `react-native-safe-area-context`: trae `Package.swift` → enlaza solo.
- `react-native-screens`: sin SwiftPM → `spm scaffold` genera un `Package.swift` válido → compila.
- `react-native-gesture-handler`: `spm scaffold` genera un paquete inválido por dos bugs genéricos:
  1. `scripts/spm/read-podspec.js` `getArrayField` solo entiende `= [..]` o un string; la forma
     Ruby `s.source_files = "apple/**/*.{h,m,mm}", "shared/**/*.{h,cpp}"` pierde todo menos el
     primer glob (faltan fuentes y search paths de `shared/`).
  2. `scripts/spm/scaffold-package-swift.js` elige `publicHeadersPath` = primer prefijo de los
     globs (`apple`); si ese directorio contiene el header paraguas `<SwiftName>.h` junto a
     subdirectorios (`Handlers/`, `*.xcodeproj`), SwiftPM rechaza el target ("invalid header
     layout"). El propio scaffolder ya tiene el mecanismo `include/<SwiftName>/` (shim de
     stubs `#import`) para headers en la raíz; basta aplicarlo también en este caso.
  Con ambos arreglos aplicados a mano, gesture-handler compila y enlaza (spike verificado).

## Objetivos

1. Dos parches genéricos a `react-native` (patch-package, `patches/react-native+0.88.0.patch`) que
   corrigen los bugs anteriores, con tests unitarios en expo-xtool que ejercitan los módulos de RN
   parcheados sobre fixtures (podspec multi-valor; layout con paraguas + subdirs).
2. `expo-xtool build` ejecuta `spm scaffold` automáticamente cuando RN reporta
   `Package.swift is missing for library "<x>"`, persiste el resultado con patch-package en
   `<proyecto>/patches/<lib>+<ver>.patch` y reintenta `update`. Idempotente.
3. Preparar el texto de PR upstream a facebook/react-native con los dos arreglos (en `docs/upstream/`).

## No objetivos

- Catálogo de overrides por librería (solo si la matriz demuestra que hace falta).
- Soporte SDK ≤ 57.

## Enfoque (decidido)

- Parches a RN en vez de reimplementar el scaffolder: menor superficie, upstreamable.
- Auto-scaffold reactivo (al error) y no preventivo: respeta el diseño de RN ("scaffolding es un
  paso explícito") pero lo hace explícito *desde expo-xtool*, con log claro de qué se generó y
  dónde quedó el patch.

## Tareas

1. Parche `read-podspec.js`: `getArrayField` acepta `= "a", "b"` (lista separada por comas sin
   corchetes). Test con fixture podspec. Verificar con el podspec real de gesture-handler.
2. Parche `scaffold-package-swift.js`: si `publicHeadersPath` elegido contiene `<SwiftName>.h`
   y tiene subdirectorios, usar el shim `include/` con todos los headers públicos (archivos stub con `#import`, no symlinks) y
   `publicHeadersPath: "include"`. Test con fixture de layout.
3. `src/pipeline/rnSpm.ts`: detectar el error de `Package.swift is missing` (capturar stderr),
   ejecutar `scaffold`, `patch-package <lib>` (con la copia fijada), log, reintentar `update` una
   vez. Tests con runner inyectado.
4. Verificación real: gesture-handler desde cero (`rm node_modules/react-native-gesture-handler/Package.swift`,
   `expo-xtool build`) compila; luego reanimated + worklets como siguiente caso de la matriz.
5. `docs/upstream/react-native-scaffolder.md`: descripción de los dos bugs y los diffs para el PR.

## Fallos externos

| Fallo | Decisión |
| --- | --- |
| `patch-package <lib>` necesita lockfile y red; si falla, no se persiste el `Package.swift` | handle: aviso (`⚠ Could not persist ...`) y el build continúa; se re-escaffoldea tras la próxima instalación limpia |
| Instalación limpia (`node_modules` nuevo) | handle: expo-xtool aplica los parches del proyecto (`patches/`) en el paso `patches`; se recomienda `"postinstall": "patch-package"` |
| Monorepo / hoisting | accept: documentado, solo layout plano de npm / yarn classic |
