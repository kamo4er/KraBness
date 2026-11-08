// Pairing: скан QR из настроек веб-UI на ПК ({kamharn:1, urls, code}) или ввод адреса и кода вручную.
import { useRef, useState } from "react";
import { KeyboardAvoidingView, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { CameraView, useCameraPermissions } from "expo-camera";
import { normalizeUrl, pair } from "../store.ts";
import { Btn } from "../ui.tsx";
import { C, S } from "../theme.ts";
import { t } from "@kamharn/client";

interface Payload {
  kamharn: 1;
  urls: string[];
  code: string;
}

function parsePayload(data: string): Payload | undefined {
  try {
    const j = JSON.parse(data) as Payload;
    if (j.kamharn === 1 && Array.isArray(j.urls) && j.urls.length && typeof j.code === "string") return j;
  } catch {
    /* не наш QR */
  }
  return undefined;
}

export function Pair({ reason }: { reason?: string }) {
  const [perm, requestPerm] = useCameraPermissions();
  const [scan, setScan] = useState(false);
  const [url, setUrl] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const handled = useRef(false);

  async function run(urls: string[], c: string) {
    setBusy(true);
    setError(undefined);
    try {
      await pair(urls, c);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
      handled.current = false;
    }
  }

  async function startScan() {
    setError(undefined);
    const p = perm?.granted ? perm : await requestPerm();
    if (!p.granted) return setError(t("Нет доступа к камере — введи адрес и код вручную.", "No camera access — enter the address and code manually."));
    handled.current = false;
    setScan(true);
  }

  if (scan) {
    return (
      <View style={S.screen}>
        <CameraView
          style={StyleSheet.absoluteFill}
          facing="back"
          barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
          onBarcodeScanned={({ data }) => {
            if (handled.current) return;
            const p = parsePayload(data);
            if (!p) return setError(t("Это не QR-код KraBness", "This isn't a KraBness QR code"));
            handled.current = true;
            setScan(false);
            void run(p.urls, p.code);
          }}
        />
        <View style={st.scanBar}>
          <Text style={st.scanHint}>{t("Наведи камеру на QR в веб-UI: Настройки → Подключить устройство", "Point the camera at the QR in the web UI: Settings → Connect a device")}</Text>
          {error ? <Text style={S.error}>{error}</Text> : null}
          <Btn title={t("Отмена", "Cancel")} onPress={() => setScan(false)} />
        </View>
      </View>
    );
  }

  const canManual = url.trim().length > 0 && /^\d{6}$/.test(code.trim());
  return (
    <KeyboardAvoidingView style={S.screen} behavior="height">
      <ScrollView contentContainerStyle={st.body} keyboardShouldPersistTaps="handled">
        <Text style={st.logo}>KraBness</Text>
        <Text style={[S.muted, st.center]}>{t("Подключение к хабу на ПК", "Connect to the hub on your PC")}</Text>
        {reason ? <Text style={[S.error, st.center]}>{reason}</Text> : null}

        <Btn kind="primary" title={t("📷  Сканировать QR", "📷  Scan QR")} onPress={() => void startScan()} disabled={busy} style={st.big} />
        <Text style={[S.muted, st.center]}>{t("QR — в веб-UI на ПК: ⚙ Настройки → «Подключить устройство»", "The QR is in the web UI on the PC: ⚙ Settings → “Connect a device”")}</Text>

        <Text style={S.h3}>{t("Или вручную", "Or manually")}</Text>
        <TextInput
          style={S.input}
          placeholder={t("адрес хаба, например 100.64.0.10:7420", "hub address, e.g. 100.64.0.10:7420")}
          placeholderTextColor={C.muted}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          value={url}
          onChangeText={setUrl}
        />
        <TextInput
          style={[S.input, st.code]}
          placeholder="••••••"
          placeholderTextColor={C.muted}
          keyboardType="number-pad"
          maxLength={6}
          value={code}
          onChangeText={setCode}
        />
        {error ? <Text style={S.error}>{error}</Text> : null}
        <Btn title={t("Подключиться", "Connect")} disabled={!canManual} busy={busy} onPress={() => void run([normalizeUrl(url)], code)} />
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const st = StyleSheet.create({
  body: { padding: 20, gap: 12, paddingTop: 48 },
  logo: { color: C.text, fontSize: 30, fontWeight: "800", textAlign: "center" },
  center: { textAlign: "center" },
  big: { marginTop: 24, minHeight: 54 },
  code: { letterSpacing: 6, fontSize: 20, textAlign: "center" },
  scanBar: { position: "absolute", left: 0, right: 0, bottom: 0, padding: 20, gap: 10, backgroundColor: "rgba(17,19,24,.85)" },
  scanHint: { color: C.text, textAlign: "center" },
});
