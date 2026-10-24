// Приложение не входит в npm workspaces (свои версии React/RN), общие пакеты берём из исходников.
const { getDefaultConfig } = require("expo/metro-config");
const path = require("node:path");

const config = getDefaultConfig(__dirname);
const packages = path.resolve(__dirname, "../../packages");

config.watchFolders = [packages];
config.resolver.extraNodeModules = {
  "@kamharn/client": path.join(packages, "client/src/index.ts"),
  "@kamharn/protocol": path.join(packages, "protocol/src/index.ts"),
};
// зависимости общих пакетов (react и т.п.) ищем только в node_modules приложения
config.resolver.nodeModulesPaths = [path.resolve(__dirname, "node_modules")];

module.exports = config;
