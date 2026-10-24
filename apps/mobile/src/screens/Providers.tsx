// Модели и провайдеры (opencode): подключить по ключу или по подписке, свой сервер (LM Studio, Ollama), избранные модели.
import { useEffect, useMemo, useState } from "react";
import { Linking, Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from "react-native";
import { t, tn, type OAuthStart, type ProviderAuthMethod, type ProviderEntry, type ProviderModel } from "@kamharn/client";
import { client } from "../store.ts";
import { back } from "../nav.ts";
import { dialog } from "../dialog.tsx";
import { Btn } from "../ui.tsx";
import { C, S, mono } from "../theme.ts";


export function Providers() {
  const [list, setList] = useState<ProviderEntry[]>();
  const [error, setError] = useState<string>();
  const [open, setOpen] = useState<string>();
  const [query, setQuery] = useState("");
  const load = () => client?.providers().then(setList, (e: Error) => setError(e.message));
  useEffect(() => void load(), []);

  const connected = list?.filter((p) => p.connected) ?? [];
  const rest = useMemo(() => {
    const q = query.trim().toLowerCase();
    const all = list?.filter((p) => !p.connected) ?? [];
    return q ? all.filter((p) => p.name.toLowerCase().includes(q) || p.id.includes(q)).slice(0, 30) : all.filter((p) => p.popular);
  }, [list, query]);

  return (
    <View style={S.screen}>
      <View style={S.head}>
        <Btn small kind="ghost" title="←" onPress={back} />
        <Text style={[S.h2, { flex: 1 }]}>{t("Модели и провайдеры", "Models and providers")}</Text>
      </View>
      <ScrollView contentContainerStyle={{ padding: 16, gap: 10 }} keyboardShouldPersistTaps="handled">
        <Text style={S.muted}>{t("Для движка opencode. Ключи и входы хранятся на ПК у opencode. Claude Code работает по своей подписке отдельно.", "For the opencode engine. Keys and sign-ins are stored on the PC by opencode. Claude Code uses its own subscription separately.")}</Text>
        {error ? <Text style={S.error}>{error}</Text> : null}
        {!list && !error ? <Text style={S.muted}>{t("Загрузка…", "Loading…")}</Text> : null}

        {connected.length ? <Text style={S.h3}>{t("Подключены", "Connected")}</Text> : null}
        {connected.map((p) => (
          <Connected key={p.id} p={p} onChange={load} />
        ))}

        <Text style={S.h3}>{t("Подключить провайдера", "Connect a provider")}</Text>
        <TextInput style={S.input} value={query} onChangeText={setQuery} placeholder={t("Поиск: kimi, glm, mistral, groq…", "Search: kimi, glm, mistral, groq…")} placeholderTextColor={C.muted} autoCapitalize="none" />
        {rest.map((p) => (
          <View key={p.id} style={st.card}>
            <Pressable style={st.head} onPress={() => setOpen(open === p.id ? undefined : p.id)}>
              <Text style={st.name}>{p.name}</Text>
              <Text style={S.muted}>
                {tn(p.models, ["модель", "модели", "моделей"], ["model", "models"])}
                {p.methods.some((m) => m.type === "oauth") ? ` · ${t("подписка", "subscription")}` : ""}
              </Text>
            </Pressable>
            {open === p.id ? <Connect p={p} onDone={() => (setOpen(undefined), void load())} /> : null}
          </View>
        ))}
        {query && !rest.length ? <Text style={S.muted}>{t("Не нашёл. Если это свой сервер — добавь его ниже.", "Not found. If it's your own server, add it below.")}</Text> : null}

        <Text style={S.h3}>{t("Свой сервер (LM Studio, Ollama…)", "Your own server (LM Studio, Ollama…)")}</Text>
        <CustomServer onDone={load} />
      </ScrollView>
    </View>
  );
}

function Connected({ p, onChange }: { p: ProviderEntry; onChange: () => void }) {
  const [models, setModels] = useState<ProviderModel[]>();
  const [pick, setPick] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState("");
  const toggleModels = async () => {
    if (models) return setModels(undefined);
    const m = (await client?.providerModels(p.id)) ?? [];
    setModels(m);
    setPick(new Set(m.filter((x) => x.favorite).map((x) => x.id)));
  };
  const save = async (ids: string[]) => {
    await client?.setFavorites(p.id, ids);
    setModels(undefined);
    onChange();
  };
  const disconnect = () =>
    dialog(`${t("Отключить", "Disconnect")} ${p.name}?`, p.custom ? t("Сервер пропадёт из списка моделей.", "The server will be removed from the model list.") : t("Ключ или вход удалятся с ПК.", "The key or sign-in will be removed from the PC."), [
      { text: t("Отмена", "Cancel"), style: "cancel" },
      { text: t("Отключить", "Disconnect"), style: "destructive", onPress: () => void client?.disconnectProvider(p.id).then(onChange, (e: Error) => dialog(t("Не получилось", "Failed"), e.message)) },
    ]);
  const shown = models?.filter((m) => !filter || m.name.toLowerCase().includes(filter.toLowerCase()));
  return (
    <View style={[st.card, { padding: 12, gap: 8 }]}>
      <View style={st.row}>
        <View style={{ flex: 1 }}>
          <Text style={st.name}>{p.name}</Text>
          <Text style={S.muted}>
            {p.custom ? `${t("свой сервер", "own server")} · ` : ""}
            {p.favorites ? t(`в выборе ${p.favorites} из ${p.models}`, `${p.favorites} of ${p.models} in the picker`) : t(`в выборе все ${tn(p.models, ["модель", "модели", "моделей"], ["model", "models"])}`, `all ${p.models} models in the picker`)}
          </Text>
        </View>
        <Btn small title={t("Модели", "Models")} onPress={() => void toggleModels()} />
        <Btn small kind="danger" title="✕" onPress={disconnect} />
      </View>
      {shown ? (
        <>
          {models!.length > 15 ? <TextInput style={S.input} value={filter} onChangeText={setFilter} placeholder={t("Поиск модели", "Search models")} placeholderTextColor={C.muted} /> : null}
          {shown.slice(0, 80).map((m) => (
            <View key={m.id} style={st.row}>
              <Text style={[S.text, { flex: 1 }]} numberOfLines={1}>
                {m.name}
                {m.free ? <Text style={S.muted}> · {t("бесплатно", "free")}</Text> : null}
              </Text>
              <Switch
                value={pick.has(m.id)}
                onValueChange={(v) => {
                  const n = new Set(pick);
                  if (v) n.add(m.id);
                  else n.delete(m.id);
                  setPick(n);
                }}
              />
            </View>
          ))}
          <View style={st.row}>
            <Btn small kind="primary" title={`${t("Отмеченные", "Checked")} (${pick.size})`} disabled={!pick.size} onPress={() => void save([...pick])} />
            <Btn small title={t("Все", "All")} onPress={() => void save([])} />
          </View>
        </>
      ) : null}
    </View>
  );
}

function hint(m: ProviderAuthMethod): string {
  if (m.type === "api") return t("ключ: по токенам или ключ подписки", "key: pay per token or a subscription key");
  if (/headless/i.test(m.label)) return `${m.label.replace(/\s*\(headless\)/i, "")}: ${t("ссылка и код — подходит для телефона", "link and code — works on a phone")}`;
  if (/browser/i.test(m.label)) return `${m.label.replace(/\s*\(browser\)/i, "")}: ${t("откроется браузер на ПК", "opens a browser on the PC")}`;
  return m.label;
}

function Connect({ p, onDone }: { p: ProviderEntry; onDone: () => void }) {
  const [method, setMethod] = useState<ProviderAuthMethod>(p.methods.find((m) => m.type === "oauth" && /headless/i.test(m.label)) ?? p.methods[0]!);
  const [key, setKey] = useState("");
  const [inputs, setInputs] = useState<Record<string, string>>({});
  const [oauth, setOauth] = useState<OAuthStart>();
  const [code, setCode] = useState("");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!oauth || oauth.method !== "auto") return;
    const timer = setInterval(() => {
      void client?.oauthStatus(p.id).then((s) => {
        if (s.status === "done") (clearInterval(timer), onDone());
        if (s.status === "error") (clearInterval(timer), setError(s.error), setOauth(undefined));
      });
    }, 2000);
    return () => clearInterval(timer);
  }, [oauth]);

  const run = async (f: () => Promise<unknown>) => {
    setBusy(true);
    setError(undefined);
    try {
      await f();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const userCode = /code[:\s]+([A-Z0-9-]{4,})/i.exec(oauth?.instructions ?? "")?.[1];

  return (
    <View style={{ paddingHorizontal: 12, paddingBottom: 12, gap: 8 }}>
      {p.methods.length > 1
        ? p.methods.map((m) => (
            <Pressable key={m.index} style={[st.method, method.index === m.index && st.methodOn]} onPress={() => (setMethod(m), setOauth(undefined), setError(undefined))}>
              <Text style={[S.text, { fontWeight: "700" }]}>{m.type === "api" ? t("API-ключ", "API key") : t("Вход по подписке", "Subscription sign-in")}</Text>
              <Text style={S.muted}>{hint(m)}</Text>
            </Pressable>
          ))
        : null}
      {method.prompts?.map((q) => (
        <TextInput
          key={q.key}
          style={S.input}
          value={inputs[q.key] ?? ""}
          onChangeText={(v) => setInputs({ ...inputs, [q.key]: v })}
          placeholder={q.message}
          placeholderTextColor={C.muted}
          autoCapitalize="none"
        />
      ))}
      {method.type === "api" ? (
        <>
          <TextInput style={S.input} value={key} onChangeText={setKey} placeholder={`${t("API-ключ", "API key")} ${p.name}`} placeholderTextColor={C.muted} secureTextEntry autoCapitalize="none" autoCorrect={false} />
          <Btn kind="primary" title={t("Подключить", "Connect")} busy={busy} disabled={!key.trim()} onPress={() => void run(async () => (await client?.setProviderKey(p.id, key, inputs), onDone()))} />
        </>
      ) : !oauth ? (
        <Btn kind="primary" title={t("Войти", "Sign in")} busy={busy} onPress={() => void run(async () => setOauth(await client!.oauthStart(p.id, method.index, inputs)))} />
      ) : (
        <View style={{ gap: 8 }}>
          {userCode ? (
            <>
              <Text style={S.text}>{t("1. Запомни код (долгое нажатие — скопировать):", "1. Remember the code (long-press to copy):")}</Text>
              <Text selectable style={st.code}>
                {userCode}
              </Text>
              <Text style={S.text}>{t("2. Открой страницу, введи код и войди в аккаунт:", "2. Open the page, enter the code and sign in:")}</Text>
            </>
          ) : (
            <Text style={S.muted}>{oauth.instructions}</Text>
          )}
          <Btn title={t("Открыть страницу входа ↗", "Open the sign-in page ↗")} onPress={() => void Linking.openURL(oauth.url)} />
          {oauth.method === "auto" ? (
            <Text style={S.muted}>⋯ {t("Жду, пока войдёшь — потом вернись сюда", "Waiting for you to sign in — then come back here")}</Text>
          ) : (
            <>
              <TextInput style={S.input} value={code} onChangeText={setCode} placeholder={t("Код со страницы", "Code from the page")} placeholderTextColor={C.muted} autoCapitalize="none" />
              <Btn kind="primary" title={t("Готово", "Done")} busy={busy} disabled={!code.trim()} onPress={() => void run(async () => (await client?.oauthCode(p.id, method.index, code), onDone()))} />
            </>
          )}
        </View>
      )}
      {error ? <Text style={S.error}>{error}</Text> : null}
    </View>
  );
}

function CustomServer({ onDone }: { onDone: () => void }) {
  const [name, setName] = useState("LM Studio");
  const [url, setUrl] = useState("http://127.0.0.1:1234/v1");
  const [key, setKey] = useState("");
  const [found, setFound] = useState<string[]>();
  const [pick, setPick] = useState<Set<string>>(new Set());
  const [manual, setManual] = useState("");
  const [msg, setMsg] = useState<string>();
  const [busy, setBusy] = useState(false);
  const run = async (f: () => Promise<void>) => {
    setBusy(true);
    setMsg(undefined);
    try {
      await f();
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <View style={[st.card, { padding: 12, gap: 8 }]}>
      <TextInput style={S.input} value={name} onChangeText={setName} placeholder={t("Название", "Name")} placeholderTextColor={C.muted} />
      <TextInput style={S.input} value={url} onChangeText={setUrl} placeholder={t("Адрес сервера (как его видит ПК)", "Server URL (as the PC sees it)")} placeholderTextColor={C.muted} autoCapitalize="none" autoCorrect={false} keyboardType="url" />
      <Text style={S.muted}>{t("Адрес — с точки зрения ПК: LM Studio на этом же ПК — http://127.0.0.1:1234/v1, Ollama — http://127.0.0.1:11434/v1.", "The URL as the PC sees it: LM Studio on the same PC — http://127.0.0.1:1234/v1, Ollama — http://127.0.0.1:11434/v1.")}</Text>
      <TextInput style={S.input} value={key} onChangeText={setKey} placeholder={t("Ключ (если сервер требует)", "Key (if the server needs one)")} placeholderTextColor={C.muted} secureTextEntry autoCapitalize="none" />
      <Btn
        title={t("Найти модели", "Find models")}
        busy={busy}
        disabled={!url.trim()}
        onPress={() =>
          void run(async () => {
            const r = await client!.probeServer(url, key);
            setFound(r.models);
            setPick(new Set(r.models));
          })
        }
      />
      {found?.map((m) => (
        <View key={m} style={st.row}>
          <Text style={[S.text, { flex: 1, fontFamily: mono, fontSize: 13 }]} numberOfLines={1}>
            {m}
          </Text>
          <Switch
            value={pick.has(m)}
            onValueChange={(v) => {
              const n = new Set(pick);
              if (v) n.add(m);
              else n.delete(m);
              setPick(n);
            }}
          />
        </View>
      ))}
      <TextInput style={S.input} value={manual} onChangeText={setManual} placeholder={t("Или впиши названия моделей через запятую", "Or type model names, comma-separated")} placeholderTextColor={C.muted} autoCapitalize="none" />
      <Btn
        kind="primary"
        title={t("Добавить сервер", "Add server")}
        busy={busy}
        disabled={!name.trim() || (!pick.size && !manual.trim())}
        onPress={() =>
          void run(async () => {
            const p = await client!.addCustomProvider({ name, baseURL: url, apiKey: key, models: [...pick, ...manual.split(/[\s,]+/).filter(Boolean)] });
            setFound(undefined);
            setMsg(t(`Добавлен «${p.name}» — модели появятся в выборе модели opencode`, `Added “${p.name}” — its models will appear in the opencode model picker`));
            onDone();
          })
        }
      />
      {msg ? <Text style={S.muted}>{msg}</Text> : null}
    </View>
  );
}

const st = StyleSheet.create({
  card: { backgroundColor: C.bg2, borderRadius: 12, borderWidth: 1, borderColor: C.line },
  head: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 8, padding: 12 },
  name: { color: C.text, fontSize: 16, fontWeight: "700" },
  row: { flexDirection: "row", alignItems: "center", gap: 8 },
  method: { borderWidth: 1, borderColor: C.line, borderRadius: 10, padding: 10, gap: 2 },
  methodOn: { borderColor: C.accent, backgroundColor: C.bg3 },
  code: { color: C.text, fontFamily: mono, fontSize: 26, letterSpacing: 2, textAlign: "center", paddingVertical: 10, backgroundColor: C.bg3, borderRadius: 10 },
});
