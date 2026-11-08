// Release подписывается своим ключом из apps/mobile/credentials/keystore.properties (в git не идёт).
// Нет файла — release подписывается debug-ключом, как в шаблоне.
const { withAppBuildGradle } = require("expo/config-plugins");

const RELEASE_CONFIG = `
        release {
            def ksFile = file("../../credentials/keystore.properties")
            if (ksFile.exists()) {
                def ks = new Properties()
                ksFile.withInputStream { ks.load(it) }
                storeFile file("../../credentials/" + ks["storeFile"])
                storePassword ks["storePassword"]
                keyAlias ks["keyAlias"]
                keyPassword ks["keyPassword"]
            }
        }`;

module.exports = function withReleaseSigning(config) {
  return withAppBuildGradle(config, (c) => {
    let g = c.modResults.contents;
    if (g.includes("credentials/keystore.properties")) return c;
    const debugBlock = /(signingConfigs\s*\{\s*debug\s*\{[^}]*\})/;
    const releaseUse = /(release\s*\{[^}]*?)signingConfig signingConfigs\.debug/;
    if (!debugBlock.test(g) || !releaseUse.test(g)) throw new Error("with-release-signing: не нашёл signingConfigs в build.gradle");
    g = g.replace(debugBlock, `$1${RELEASE_CONFIG}`);
    g = g.replace(releaseUse, `$1signingConfig file("../../credentials/keystore.properties").exists() ? signingConfigs.release : signingConfigs.debug`);
    c.modResults.contents = g;
    return c;
  });
};
