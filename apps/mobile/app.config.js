// Firebase в сборке — только если есть credentials/google-services.json и это не публичная сборка (KRABNESS_PUBLIC=1).
// Публичный APK без Firebase: ключ своего проекта на чужом хабе с ним всё равно не работает (SENDER_ID_MISMATCH),
// поэтому там уведомления сразу «из приложения». Приложение узнаёт это из extra.firebase.
const { existsSync } = require("fs");
const { join } = require("path");

module.exports = ({ config }) => {
  const file = config.android?.googleServicesFile;
  const firebase = !process.env.KRABNESS_PUBLIC && !!file && existsSync(join(__dirname, file));
  const android = { ...config.android };
  if (!firebase) delete android.googleServicesFile;
  return { ...config, android, extra: { ...config.extra, firebase } };
};
