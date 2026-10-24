// Свои MCP-серверы: KamHarn отдаёт их обоим движкам. Значения ключей хаб не показывает — только имена.
import { useEffect, useState } from "react";
import { ScrollView, StyleSheet, Switch, Text, TextInput, View } from "react-native";
import { joinArgs, parsePairs, splitArgs, type McpOverview, type McpServer, type McpServerStatus, type McpServerView, t } from "@kamharn/client";
import { client } from "../store.ts";
import { back } from "../nav.ts";
import { dialog } from "../dialog.tsx";
import { Btn } from "../ui.tsx";
import { C, S, mono } from "../theme.ts";

/** статус сервера от движка — человеческими словами на текущем языке */
const statusLabel = (s: string): string =>
  ({
    connected: t("подключён", "connected"),
    failed: t("ошибка", "error"),
    pending: t("подключается", "connecting"),
    disabled: t("выключен", "disabled"),
    needs_auth: t("нужен вход", "sign-in needed"),
    needs_client_registration: t("нужен вход", "sign-in needed"),
  })[s] ?? s;
const enginesLabel = (e: McpServer["engines"]) =>
  e === "both" ? t("Claude и opencode", "Claude and opencode") : e === "claude" ? t("только Claude", "Claude only") : t("только opencode", "opencode only");

function Status({ label, s }: { label: string; s?: McpServerStatus }) {
  const color = s?.status === "connected" ? C.ok : s?.status === "failed" ? C.err : C.muted;
  return <Text style={[st.status, { color }]}>{`${label}: ${s ? statusLabel(s.status) : t("ещё не запускался", "not started yet")}`}</Text>;
}

/** Сервер из вида для сохранения без правки секретов: пустые значения = оставить прежние. */
function toServer(s: McpServerView): McpServer {
  const { envKeys, headerKeys, status: _status, ...rest } = s;
  return { ...rest, env: Object.fromEntries(envKeys.map((k) => [k, ""])), headers: Object.fromEntries(headerKeys.map((k) => [k, ""])) };
}

export function Mcp() {
  const [ov, setOv] = useState<McpOverview>();
  const [error, setError] = useState<string>();
  const [edit, setEdit] = useState<McpServerView | "new">();
  useEffect(() => void client?.mcpOverview().then(setOv, (e: Error) => setError(e.message)), []);

  const act = (f: () => Promise<McpOverview>) =>
    f().then(setOv, (e: Error) => dialog(t("Не получилось", "Failed"), e.message));

  return (
    <View style={S.screen}>
      <View style={S.head}>
        <Btn small kind="ghost" title="←" onPress={back} />
        <Text style={[S.h2, { flex: 1 }]}>{t("MCP-серверы", "MCP servers")}</Text>
      </View>
      <ScrollView contentContainerStyle={{ padding: 16, gap: 10 }} keyboardShouldPersistTaps="handled">
        <Text style={S.muted}>
          {t(
            "Инструменты для агентов: браузер, базы, API. Список хранит KraBness и подключает к Claude и opencode в своих сессиях — настройки Claude Code в VS Code не меняются. Claude подхватит со следующего сообщения, opencode перезапустится (работающий в нём агент прервётся).",
            "Tools for agents: a browser, databases, APIs. KraBness keeps the list and plugs it into Claude and opencode in its own sessions — your Claude Code settings in VS Code aren't changed. Claude picks it up from the next message, opencode restarts (an agent running in it will be interrupted).",
          )}
        </Text>
        {error ? <Text style={S.error}>{error}</Text> : null}
        {ov?.opencodeError ? <Text style={S.error}>{ov.opencodeError}</Text> : null}
        {!ov && !error ? <Text style={S.muted}>{t("Загрузка…", "Loading…")}</Text> : null}

        {ov ? <Text style={S.h3}>{t("Свои серверы", "Your servers")}</Text> : null}
        {ov && !ov.servers.length && edit !== "new" ? <Text style={S.muted}>{t("Пока нет. Например, браузер для агента: команда npx, аргументы -y @playwright/mcp@latest.", "None yet. For example, a browser for the agent: command npx, arguments -y @playwright/mcp@latest.")}</Text> : null}
        {ov?.servers.map((s) =>
          edit !== "new" && edit?.name === s.name ? (
            <McpForm key={s.name} initial={s} onSaved={(o) => (setOv(o), setEdit(undefined))} onCancel={() => setEdit(undefined)} />
          ) : (
            <View key={s.name} style={[st.card, !s.enabled && { opacity: 0.6 }]}>
              <View style={st.row}>
                <Text style={[st.name, { flex: 1 }]}>{s.name}</Text>
                <Switch value={s.enabled} onValueChange={(v) => void act(() => client!.saveMcp({ ...toServer(s), enabled: v }, s.name))} />
              </View>
              <Text style={S.muted}>
                {s.type === "stdio" ? t("команда", "command") : s.type.toUpperCase()} · {enginesLabel(s.engines)}
              </Text>
              <Text style={st.cmd} numberOfLines={2}>
                {s.type === "stdio" ? `${s.command} ${joinArgs(s.args)}` : s.url}
              </Text>
              {s.envKeys.length || s.headerKeys.length ? (
                <Text style={S.muted}>
                  {s.envKeys.length ? `${t("Переменные", "Variables")}: ${s.envKeys.join(", ")} ` : ""}
                  {s.headerKeys.length ? `${t("Заголовки", "Headers")}: ${s.headerKeys.join(", ")}` : ""}
                </Text>
              ) : null}
              {s.enabled ? (
                <View style={[st.row, { flexWrap: "wrap" }]}>
                  {s.engines !== "opencode" ? <Status label="Claude" s={s.status.claude} /> : null}
                  {s.engines !== "claude" ? <Status label="opencode" s={s.status.opencode} /> : null}
                </View>
              ) : null}
              {s.status.opencode?.error ? <Text style={[S.muted, { color: C.err }]}>{s.status.opencode.error}</Text> : null}
              <View style={st.row}>
                <Btn small title={t("Изменить", "Edit")} onPress={() => setEdit(s)} />
                <Btn
                  small
                  kind="danger"
                  title={t("Удалить", "Delete")}
                  onPress={() =>
                    dialog(t(`Удалить «${s.name}»?`, `Delete “${s.name}”?`), t("Сервер пропадёт у обоих движков.", "The server will be removed from both engines."), [
                      { text: t("Отмена", "Cancel"), style: "cancel" },
                      { text: t("Удалить", "Delete"), style: "destructive", onPress: () => void act(() => client!.removeMcp(s.name)) },
                    ])
                  }
                />
              </View>
            </View>
          ),
        )}
        {ov ? edit === "new" ? <McpForm onSaved={(o) => (setOv(o), setEdit(undefined))} onCancel={() => setEdit(undefined)} /> : <Btn title={t("+ Добавить сервер", "+ Add server")} onPress={() => setEdit("new")} /> : null}

        {ov ? (
          <>
            <Text style={S.h3}>{t("Из настроек Claude Code", "From Claude Code settings")}</Text>
            <View style={st.card}>
              <View style={st.row}>
                <Text style={[S.text, { flex: 1 }]}>{t("Подключать в сессиях Claude серверы из ~/.claude.json и .mcp.json проекта", "Use servers from ~/.claude.json and the project's .mcp.json in Claude sessions")}</Text>
                <Switch value={ov.claude.enabled} onValueChange={(v) => void act(() => client!.setClaudeUserMcp(v))} />
              </View>
              <Text style={S.muted}>
                {ov.claude.servers.length ? `${t("Там сейчас", "Currently there")}: ${ov.claude.servers.join(", ")}.` : t("Там серверов нет.", "No servers there.")}{" "}
                {t("Меняются в самом Claude Code. Старт сессии с MCP медленнее.", "They are managed in Claude Code itself. Sessions with MCP start slower.")}
              </Text>
            </View>
          </>
        ) : null}
      </ScrollView>
    </View>
  );
}

function Seg<T extends string>({ value, options, onChange }: { value: T; options: Array<[T, string]>; onChange: (v: T) => void }) {
  return (
    <View style={st.row}>
      {options.map(([v, label]) => (
        <Btn key={v} small kind={value === v ? "primary" : "default"} title={label} style={{ flex: 1 }} onPress={() => onChange(v)} />
      ))}
    </View>
  );
}

function McpForm({ initial, onSaved, onCancel }: { initial?: McpServerView; onSaved: (o: McpOverview) => void; onCancel: () => void }) {
  const [name, setName] = useState(initial?.name ?? "");
  const [type, setType] = useState<McpServer["type"]>(initial?.type ?? "stdio");
  const [engines, setEngines] = useState<McpServer["engines"]>(initial?.engines ?? "both");
  const [command, setCommand] = useState(initial?.command ?? "");
  const [args, setArgs] = useState(joinArgs(initial?.args));
  const [url, setUrl] = useState(initial?.url ?? "");
  // у существующих ключей значения не знаем: «КЛЮЧ=» — оставить как было
  const [env, setEnv] = useState((initial?.envKeys ?? []).map((k) => `${k}=`).join("\n"));
  const [headers, setHeaders] = useState((initial?.headerKeys ?? []).map((k) => `${k}: `).join("\n"));
  const [busy, setBusy] = useState(false);
  const hasSecrets = !!initial && (initial.envKeys.length > 0 || initial.headerKeys.length > 0);
  const input = { placeholderTextColor: C.muted, autoCapitalize: "none" as const, autoCorrect: false };

  const save = async () => {
    setBusy(true);
    try {
      const server: McpServer =
        type === "stdio"
          ? { name: name.trim(), enabled: initial?.enabled ?? true, engines, type, command: command.trim(), args: splitArgs(args), env: parsePairs(env) }
          : { name: name.trim(), enabled: initial?.enabled ?? true, engines, type, url: url.trim(), headers: parsePairs(headers, ":") };
      onSaved(await client!.saveMcp(server, initial?.name));
    } catch (e) {
      dialog(t("Не получилось", "Failed"), (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={st.card}>
      <Text style={st.name}>{initial ? t(`Изменить «${initial.name}»`, `Edit “${initial.name}”`) : t("Новый MCP-сервер", "New MCP server")}</Text>
      <TextInput style={S.input} placeholder={t("Имя: playwright", "Name: playwright")} value={name} onChangeText={setName} {...input} />
      <Seg value={type} onChange={setType} options={[["stdio", t("Команда", "Command")], ["http", "HTTP"], ["sse", "SSE"]]} />
      <Seg value={engines} onChange={setEngines} options={[["both", t("Оба", "Both")], ["claude", "Claude"], ["opencode", "opencode"]]} />
      {type === "stdio" ? (
        <>
          <TextInput style={[S.input, st.mono]} placeholder={t("Команда: npx", "Command: npx")} value={command} onChangeText={setCommand} {...input} />
          <TextInput style={[S.input, st.mono]} placeholder={t("Аргументы: -y @playwright/mcp@latest", "Arguments: -y @playwright/mcp@latest")} value={args} onChangeText={setArgs} {...input} />
          <Text style={S.muted}>{t("Переменные (ключи API), по одной в строке: КЛЮЧ=значение", "Variables (API keys), one per line: KEY=value")}</Text>
          <TextInput style={[S.input, st.mono, { minHeight: 70, textAlignVertical: "top" }]} multiline placeholder="GITHUB_TOKEN=ghp_…" value={env} onChangeText={setEnv} {...input} />
        </>
      ) : (
        <>
          <TextInput style={[S.input, st.mono]} placeholder="https://example.com/mcp" keyboardType="url" value={url} onChangeText={setUrl} {...input} />
          <Text style={S.muted}>{t("Заголовки, по одному в строке: Имя: значение", "Headers, one per line: Name: value")}</Text>
          <TextInput style={[S.input, st.mono, { minHeight: 60, textAlignVertical: "top" }]} multiline placeholder="Authorization: Bearer …" value={headers} onChangeText={setHeaders} {...input} />
        </>
      )}
      {hasSecrets ? <Text style={S.muted}>{t("Значения ключей не показываются. Пустое значение — оставить прежнее; удалишь строку — ключ уберётся.", "Key values aren't shown. Empty value — keep the current one; delete the line — the key is removed.")}</Text> : null}
      <View style={st.row}>
        <Btn
          kind="primary"
          title={busy ? t("Сохраняю…", "Saving…") : t("Сохранить", "Save")}
          busy={busy}
          disabled={!name.trim() || (type === "stdio" ? !command.trim() : !url.trim())}
          style={{ flex: 1 }}
          onPress={() => void save()}
        />
        <Btn title={t("Отмена", "Cancel")} disabled={busy} onPress={onCancel} />
      </View>
    </View>
  );
}

const st = StyleSheet.create({
  card: { backgroundColor: C.bg2, borderRadius: 12, borderWidth: 1, borderColor: C.line, padding: 12, gap: 8 },
  row: { flexDirection: "row", alignItems: "center", gap: 8 },
  name: { color: C.text, fontSize: 16, fontWeight: "700" },
  cmd: { color: C.muted, fontFamily: mono, fontSize: 12 },
  mono: { fontFamily: mono, fontSize: 13 },
  status: { fontSize: 12, backgroundColor: C.bg3, borderRadius: 999, paddingHorizontal: 8, paddingVertical: 2, overflow: "hidden" },
});
