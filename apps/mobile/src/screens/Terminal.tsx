// Мини-терминал в папке сессии (вкладка «Терминал» на экране проекта): команда без агента и без расхода лимита.
import { useEffect, useRef, useState, type ComponentRef } from "react";
import { KeyboardAvoidingView, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { client } from "../store.ts";
import { Btn } from "../ui.tsx";
import { C, S, mono } from "../theme.ts";
import { t } from "@kamharn/client";

export function Terminal({ sessionId }: { sessionId: string }) {
  const [history, setHistory] = useState<string[]>([]);
  const [cmd, setCmd] = useState("");
  const [runId, setRunId] = useState<string>();
  const [running, setRunning] = useState<string>();
  const [output, setOutput] = useState("");
  const [exit, setExit] = useState<number | null>();
  const [error, setError] = useState<string>();
  const scroll = useRef<ComponentRef<typeof ScrollView>>(null);

  const refresh = () => client?.termInfo(sessionId).then((i) => setHistory(i.history), () => {});
  // при открытии: подцепиться к команде, которая ещё идёт
  useEffect(() => {
    void client?.termInfo(sessionId).then((i) => {
      setHistory(i.history);
      if (i.running) (setRunning(i.running.command), setRunId(i.running.runId));
    }, () => {});
  }, [sessionId]);

  // забираем вывод кусками, пока команда не закончится; обрыв связи — просто пробуем ещё
  useEffect(() => {
    if (!runId || !client) return;
    const c = client;
    let alive = true;
    let from = 0;
    setOutput("");
    setExit(undefined);
    void (async () => {
      while (alive) {
        try {
          const r = await c.termRead(runId, from);
          if (!alive) return;
          from = r.next;
          if (r.data) setOutput((o) => o + r.data);
          if (r.done) {
            setExit(r.exitCode ?? null);
            setRunning(undefined);
            void refresh();
            return;
          }
          await new Promise((res) => setTimeout(res, 700));
        } catch {
          await new Promise((res) => setTimeout(res, 2000));
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, [runId]);

  const run = async (command: string) => {
    if (!command.trim() || running || !client) return;
    setError(undefined);
    try {
      const r = await client.termRun(sessionId, command);
      setRunning(command.trim());
      setRunId(r.runId);
      setCmd("");
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const status = running ? `⋯ ${running}` : exit === undefined ? "" : exit === 0 ? t("✓ готово (код 0)", "✓ done (exit 0)") : `✗ ${t("код", "exit")} ${exit ?? "—"}`;
  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior="height">
      <View style={st.input}>
        <TextInput
          style={st.cmd}
          value={cmd}
          onChangeText={setCmd}
          placeholder="git status, npm test…"
          placeholderTextColor={C.muted}
          autoCapitalize="none"
          autoCorrect={false}
          editable={!running}
          returnKeyType="go"
          onSubmitEditing={() => void run(cmd)}
        />
        {running ? <Btn small kind="danger" title={t("Стоп", "Stop")} onPress={() => runId && void client?.termStop(runId)} /> : <Btn small kind="primary" title="▶" disabled={!cmd.trim()} onPress={() => void run(cmd)} />}
      </View>
      {history.length ? (
        <ScrollView horizontal style={st.historyRow} contentContainerStyle={st.history} keyboardShouldPersistTaps="handled">
          {history.slice(0, 10).map((h) => (
            <Pressable key={h} style={st.chip} disabled={!!running} onPress={() => void run(h)}>
              <Text style={st.chipText} numberOfLines={1}>
                {h}
              </Text>
            </Pressable>
          ))}
        </ScrollView>
      ) : null}
      {error ? <Text style={[S.error, { paddingHorizontal: 12 }]}>{error}</Text> : null}
      {status ? <Text style={[S.muted, { paddingHorizontal: 12, paddingBottom: 6 }]}>{status}</Text> : null}
      <ScrollView ref={scroll} style={st.out} onContentSizeChange={() => scroll.current?.scrollToEnd({ animated: false })}>
        <Text style={st.outText} selectable>
          {output || (runId ? "" : t("Команда выполняется в папке сессии через cmd.exe. Интерактивный ввод не поддерживается.", "The command runs in the session folder via cmd.exe. Interactive input isn't supported."))}
        </Text>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const st = StyleSheet.create({
  input: { flexDirection: "row", alignItems: "center", gap: 8, padding: 12 },
  cmd: { flex: 1, color: C.text, fontFamily: mono, fontSize: 14, backgroundColor: C.bg3, borderRadius: 8, borderWidth: 1, borderColor: C.line, paddingHorizontal: 10, paddingVertical: 8 },
  historyRow: { flexGrow: 0 },
  history: { gap: 6, paddingHorizontal: 12, paddingBottom: 8 },
  chip: { backgroundColor: C.bg3, borderRadius: 999, borderWidth: 1, borderColor: C.line, paddingHorizontal: 10, paddingVertical: 4, maxWidth: 260 },
  chipText: { color: C.text, fontFamily: mono, fontSize: 12 },
  out: { flex: 1, marginHorizontal: 12, marginBottom: 12, backgroundColor: "#0b0d12", borderRadius: 8, borderWidth: 1, borderColor: C.line, padding: 10 },
  outText: { color: C.text, fontFamily: mono, fontSize: 12 },
});
