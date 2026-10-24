// Локальная сборка на Windows, системные переменные не трогаем:
// - Gradle на JDK 17 (рекомендация React Native): KAMHARN_JDK или свежая jdk-17* в Eclipse Adoptium;
// - CMake 3.31+ из Android SDK: его ninja умеет пути длиннее 260 символов, ninja из 3.22.1 — нет
//   (codegen safe-area-context в monorepo даёт пути ~360 символов).
const { withAppBuildGradle, withDangerousMod, withGradleProperties } = require("expo/config-plugins");
const { existsSync, readFileSync, readdirSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");

const latest = (base, re) => (existsSync(base) ? readdirSync(base).filter((d) => re.test(d)).sort().pop() : undefined);

function findJdk17() {
  if (process.env.KAMHARN_JDK) return process.env.KAMHARN_JDK;
  const base = "C:\\Program Files\\Eclipse Adoptium";
  const jdk = latest(base, /^jdk-17/);
  return jdk ? join(base, jdk) : undefined;
}

function findCmake() {
  const sdk = process.env.ANDROID_HOME || (process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, "Android", "Sdk"));
  if (!sdk) return undefined;
  const v = latest(join(sdk, "cmake"), /^3\.(3[1-9]|[4-9]\d)\./);
  return v ? join(sdk, "cmake", v) : undefined;
}

// в .properties обратный слэш экранируется
const prop = (p) => p.replace(/\\/g, "\\\\");

module.exports = function withLocalToolchain(config) {
  config = withGradleProperties(config, (c) => {
    // без этого gradle-плагин RN вшивает в APK IP-адрес машины сборки (react_native_dev_server_ip) — у нас это был адрес ПК в Tailscale
    c.modResults = c.modResults.filter((p) => !(p.type === "property" && p.key === "reactNativeDevServerIp"));
    c.modResults.push({ type: "property", key: "reactNativeDevServerIp", value: "localhost" });
    const jdk = findJdk17();
    if (!jdk) return c;
    c.modResults = c.modResults.filter((p) => !(p.type === "property" && p.key === "org.gradle.java.home"));
    c.modResults.push({ type: "property", key: "org.gradle.java.home", value: prop(jdk) });
    return c;
  });
  // нативный код вшивает пути исходников (__FILE__) — там домашняя папка сборщика (C:/Users/<имя>/.gradle/...): заменяем на ~
  config = withAppBuildGradle(config, (c) => {
    const flag = `externalNativeBuild { cmake { cppFlags "-ffile-prefix-map=\${System.getProperty('user.home').replace('\\\\', '/')}=~" } }`;
    if (!c.modResults.contents.includes("-ffile-prefix-map")) c.modResults.contents = c.modResults.contents.replace(/defaultConfig \{\n/, (m) => `${m}        ${flag}\n`);
    return c;
  });
  return withDangerousMod(config, [
    "android",
    (c) => {
      const cmake = findCmake();
      if (!cmake) return c;
      const file = join(c.modRequest.platformProjectRoot, "local.properties");
      const lines = existsSync(file) ? readFileSync(file, "utf8").split(/\r?\n/).filter((l) => l && !l.startsWith("cmake.dir=")) : [];
      lines.push(`cmake.dir=${prop(cmake)}`);
      writeFileSync(file, lines.join("\n") + "\n");
      return c;
    },
  ]);
};
