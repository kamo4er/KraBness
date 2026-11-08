# apps/mobile — Android-клиент KamHarn (Expo SDK 58, RN 0.88)

- Не входит в npm workspaces: свои `node_modules` и `package-lock.json`. Зависимости ставить из этой папки через `npx expo install <pkg>` (подбирает версии под SDK).
- `@kamharn/client` и `@kamharn/protocol` берутся из исходников `packages/*` через `metro.config.js` (`extraNodeModules`) и `tsconfig.json` (`paths`).
- Expo меняется от SDK к SDK: API модулей сверять по `.d.ts` в `node_modules` или по https://docs.expo.dev/versions/v58.0.0/, не по памяти.
- `android/` генерируется (`npx expo prebuild -p android`) и в git не идёт. Нативные настройки — только через `app.json` и плагины (`plugins/with-local-toolchain.js` — JDK 17 и CMake 3.31 только для проекта, `plugins/with-release-signing.js` — подпись ключом из `credentials/`).
- Хаб ходит по голому http (Tailscale), поэтому `usesCleartextTraffic: true` в `expo-build-properties`.
- Проверка: `npx tsc --noEmit`, затем эмулятор (MEmu, `adb devices` → `127.0.0.1:21503`) с `adb reverse tcp:7420 tcp:7420` и `tcp:8081 tcp:8081`.
- Выпуск новой версии: поднять `expo.version` и `expo.android.versionCode` в `app.json` → `npm run release` (сборка + публикация в `data/apk`). Приложение само покажет плашку «Новая версия»; веб-настройки дают ссылку на APK для первой установки.
