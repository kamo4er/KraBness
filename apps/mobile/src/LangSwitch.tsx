// «Язык / Language»: одна настройка на хабе — меняется сразу везде (веб, приложение, уведомления, бот).
import { Text, View } from "react-native";
import { getLangSetting, t, type LangSetting } from "@kamharn/client";
import { client } from "./store.ts";
import { dialog } from "./dialog.tsx";
import { Btn } from "./ui.tsx";
import { S } from "./theme.ts";

const OPTIONS: Array<[LangSetting, string]> = [
  ["auto", ""],
  ["ru", "Русский"],
  ["en", "English"],
];

export function LangSwitch() {
  const cur = getLangSetting();
  return (
    <View style={{ gap: 8 }}>
      <View style={{ flexDirection: "row", gap: 8 }}>
        {OPTIONS.map(([v, label]) => (
          <Btn
            key={v}
            small
            kind={cur === v ? "primary" : "default"}
            title={v === "auto" ? t("Как в системе", "System") : label}
            style={{ flex: 1 }}
            onPress={() => void client?.setLanguage(v).catch((e: Error) => dialog(t("Не получилось", "Failed"), e.message))}
          />
        ))}
      </View>
      <Text style={S.muted}>
        {cur === "auto"
          ? t("Сейчас: русский (язык телефона). Уведомления и бот — на языке ПК.", "Now: English (phone language). Notifications and the bot use the PC language.")
          : t("Для всех устройств, уведомлений и бота.", "For all devices, notifications and the bot.")}
      </Text>
    </View>
  );
}
