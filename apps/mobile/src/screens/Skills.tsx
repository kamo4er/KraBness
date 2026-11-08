// Скиллы (~/.claude/skills на ПК): написать, загрузить SKILL.md/zip, поставить из GitHub, изменить, удалить.
import { useEffect, useState } from "react";
import { ScrollView, StyleSheet, Text, TextInput, ToastAndroid, View } from "react-native";
import { ApiError, ago, type SkillInfo, t, tn } from "@kamharn/client";
import { client } from "../store.ts";
import { back } from "../nav.ts";
import { dialog } from "../dialog.tsx";
import { pickOne, uploadSkill } from "../files.ts";
import { Btn } from "../ui.tsx";
import { C, S, mono } from "../theme.ts";

const template = (name: string, description: string, body: string) => `---\nname: ${name}\ndescription: ${description.replace(/\n/g, " ")}\n---\n\n${body.trim()}\n`;
const size = (n: number) => (n < 1024 ? `${n} ${t("Б", "B")}` : n < 1024 * 1024 ? `${Math.round(n / 1024)} ${t("КБ", "KB")}` : `${(n / 1024 / 1024).toFixed(1)} ${t("МБ", "MB")}`);

/** 409 «уже есть» → спросить «Заменить?» и повторить; false — отказались */
async function withReplace(f: (overwrite: boolean) => Promise<unknown>): Promise<boolean> {
  try {
    await f(false);
    return true;
  } catch (e) {
    if (!(e instanceof ApiError) || e.status !== 409) throw e;
    // закрытие диалога мимо кнопок тоже вызывает «Отмену»
    const yes = await new Promise<boolean>((res) =>
      dialog(e.message, t("Заменить его?", "Replace it?"), [
        { text: t("Отмена", "Cancel"), style: "cancel", onPress: () => res(false) },
        { text: t("Заменить", "Replace"), style: "destructive", onPress: () => res(true) },
      ]),
    );
    if (yes) await f(true);
    return yes;
  }
}

export function Skills() {
  const [list, setList] = useState<SkillInfo[]>();
  const [error, setError] = useState<string>();
  const [mode, setMode] = useState<"new" | "github" | { edit: string }>();
  const [busy, setBusy] = useState(false);
  const load = () => client?.skills().then(setList, (e: Error) => setError(e.message));
  useEffect(() => void load(), []);

  const start = async (f: (overwrite: boolean) => Promise<unknown>, msg: string) => {
    setBusy(true);
    try {
      if (await withReplace(f)) {
        setMode(undefined);
        ToastAndroid.show(msg, ToastAndroid.SHORT);
      }
    } catch (e) {
      dialog(t("Не получилось", "Failed"), (e as Error).message);
    } finally {
      setBusy(false);
      void load();
    }
  };

  return (
    <View style={S.screen}>
      <View style={S.head}>
        <Btn small kind="ghost" title="←" onPress={back} />
        <Text style={[S.h2, { flex: 1 }]}>{t("Скиллы", "Skills")}</Text>
      </View>
      <ScrollView contentContainerStyle={{ padding: 16, gap: 10 }} keyboardShouldPersistTaps="handled">
        <Text style={S.muted}>
          {t(
            "Инструкции и скрипты, которые агент берёт сам, когда задача подходит под описание; вручную — «/имя» в чате. Лежат на ПК в ~/.claude/skills: их видят Claude (в KraBness, VS Code, терминале) и opencode.",
            "Instructions and scripts the agent picks up by itself when a task matches the description; manually — “/name” in chat. They live on the PC in ~/.claude/skills: seen by Claude (in KraBness, VS Code, the terminal) and opencode.",
          )}
        </Text>
        <View style={st.row}>
          <Btn small title={t("+ Написать", "+ Write")} style={{ flex: 1 }} onPress={() => setMode("new")} />
          <Btn
            small
            title={t("Файл", "File")}
            style={{ flex: 1 }}
            onPress={async () => {
              const f = await pickOne();
              if (f) await start((o) => uploadSkill(f, o), `${t("Поставил из", "Installed from")} ${f.name}`);
            }}
          />
          <Btn small title="GitHub" style={{ flex: 1 }} onPress={() => setMode("github")} />
        </View>
        <Text style={S.muted}>{t("Файл — SKILL.md или zip с папкой скилла.", "File — SKILL.md or a zip with the skill folder.")}</Text>
        {error ? <Text style={S.error}>{error}</Text> : null}

        {mode === "github" ? <GithubForm busy={busy} onRun={(url) => void start((o) => client!.skillFromGithub(url, o), t("Скилл поставлен", "Skill installed"))} onCancel={() => setMode(undefined)} /> : null}
        {mode === "new" ? (
          <Editor busy={busy} onSave={(name, text) => void start(() => client!.saveSkill(name, text, true), t(`Скилл «${name}» создан`, `Skill “${name}” created`))} onCancel={() => setMode(undefined)} />
        ) : null}

        <Text style={S.h3}>{t("Установлены", "Installed")}</Text>
        {!list && !error ? <Text style={S.muted}>{t("Загрузка…", "Loading…")}</Text> : null}
        {list?.length === 0 ? <Text style={S.muted}>{t("Пока нет.", "None yet.")}</Text> : null}
        {list?.map((s) =>
          typeof mode === "object" && mode.edit === s.name ? (
            <Editor key={s.name} name={s.name} busy={busy} onSave={(name, text) => void start(() => client!.saveSkill(name, text), t("Сохранено", "Saved"))} onCancel={() => setMode(undefined)} />
          ) : (
            <View key={s.name} style={st.card}>
              <Text style={st.name}>/{s.name}</Text>
              {s.description ? (
                <Text style={S.muted} numberOfLines={3}>
                  {s.description}
                </Text>
              ) : null}
              <Text style={S.muted}>
                {tn(s.files, ["файл", "файла", "файлов"], ["file", "files"])} · {size(s.size)} · {ago(s.updatedAt)}
              </Text>
              <View style={st.row}>
                <Btn small title={t("Изменить", "Edit")} onPress={() => setMode({ edit: s.name })} />
                <Btn
                  small
                  kind="danger"
                  title={t("Удалить", "Delete")}
                  onPress={() =>
                    dialog(t(`Удалить «${s.name}»?`, `Delete “${s.name}”?`), t("Скилл удалится со всеми файлами и пропадёт и в Claude Code.", "The skill will be deleted with all its files and disappear from Claude Code too."), [
                      { text: t("Отмена", "Cancel"), style: "cancel" },
                      { text: t("Удалить", "Delete"), style: "destructive", onPress: () => void start(() => client!.removeSkill(s.name), t("Удалён", "Deleted")) },
                    ])
                  }
                />
              </View>
            </View>
          ),
        )}
      </ScrollView>
    </View>
  );
}

function GithubForm({ busy, onRun, onCancel }: { busy: boolean; onRun: (url: string) => void; onCancel: () => void }) {
  const [url, setUrl] = useState("");
  return (
    <View style={st.card}>
      <Text style={st.name}>{t("Поставить из GitHub", "Install from GitHub")}</Text>
      <Text style={S.muted}>{t("Ссылка на папку скилла, например github.com/anthropics/skills/tree/main/skills/pdf. В скиллах бывают скрипты — ставь из мест, которым доверяешь.", "A link to the skill folder, e.g. github.com/anthropics/skills/tree/main/skills/pdf. Skills may contain scripts — install only from sources you trust.")}</Text>
      <TextInput style={[S.input, st.mono]} placeholder="https://github.com/…/tree/main/…" placeholderTextColor={C.muted} autoCapitalize="none" autoCorrect={false} keyboardType="url" value={url} onChangeText={setUrl} />
      <View style={st.row}>
        <Btn kind="primary" title={busy ? t("Скачиваю…", "Downloading…") : t("Поставить", "Install")} busy={busy} disabled={!url.trim()} style={{ flex: 1 }} onPress={() => onRun(url.trim())} />
        <Btn title={t("Отмена", "Cancel")} disabled={busy} onPress={onCancel} />
      </View>
    </View>
  );
}

/** Новый скилл — имя, описание, инструкция; существующий — весь SKILL.md целиком. */
function Editor({ name: existing, busy, onSave, onCancel }: { name?: string; busy: boolean; onSave: (name: string, text: string) => void; onCancel: () => void }) {
  const [name, setName] = useState(existing ?? "");
  const [description, setDescription] = useState("");
  const [body, setBody] = useState("");
  const [text, setText] = useState<string>();
  const [loadError, setLoadError] = useState<string>();
  useEffect(() => {
    if (existing) void client?.skillText(existing).then((r) => setText(r.text), (e: Error) => setLoadError(e.message));
  }, [existing]);
  const input = { placeholderTextColor: C.muted };
  return (
    <View style={st.card}>
      <Text style={st.name}>{existing ? `${t("Изменить", "Edit")} /${existing}` : t("Новый скилл", "New skill")}</Text>
      {existing ? (
        text === undefined ? (
          <Text style={loadError ? S.error : S.muted}>{loadError ?? t("Загрузка…", "Loading…")}</Text>
        ) : (
          <TextInput style={[S.input, st.mono, { minHeight: 260, textAlignVertical: "top" }]} multiline autoCorrect={false} value={text} onChangeText={setText} />
        )
      ) : (
        <>
          <TextInput style={[S.input, st.mono]} placeholder={t("Имя: code-review", "Name: code-review")} autoCapitalize="none" autoCorrect={false} value={name} onChangeText={(t) => setName(t.toLowerCase())} {...input} />
          <TextInput style={S.input} placeholder={t("Когда применять: «Ревью кода перед коммитом…»", "When to use: “Code review before a commit…”")} value={description} onChangeText={setDescription} {...input} />
          <TextInput style={[S.input, { minHeight: 160, textAlignVertical: "top" }]} multiline placeholder={t("Инструкция для агента: что и как делать по шагам.", "Instructions for the agent: what to do, step by step.")} value={body} onChangeText={setBody} {...input} />
          <Text style={S.muted}>{t("Имя — строчная латиница, цифры, дефис. По описанию агент решает, когда брать скилл.", "Name — lowercase latin, digits, hyphen. The agent decides when to use the skill by its description.")}</Text>
        </>
      )}
      <View style={st.row}>
        <Btn
          kind="primary"
          title={t("Сохранить", "Save")}
          busy={busy}
          disabled={existing ? !text : !name.trim() || !description.trim() || !body.trim()}
          style={{ flex: 1 }}
          onPress={() => onSave(existing ?? name.trim(), existing ? text! : template(name.trim(), description.trim(), body))}
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
  mono: { fontFamily: mono, fontSize: 13 },
});
