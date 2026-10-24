// Список сессий по группам: статус, движок, папка; создание новой и настройки.
// Долгое нажатие на сессию — перенести в группу.
import { useEffect, useMemo, useState } from "react";
import { Image, Pressable, SectionList, StyleSheet, Text, View } from "react-native";
import { t, type SessionGroup, type SessionInfo, locale } from "@kamharn/client";
import { client, recall, remember, useHub } from "../store.ts";
import { APP_VERSION, useUpdate } from "../update.ts";
import { go } from "../nav.ts";
import { Btn, connLabel, ConnDot, EngineBadge, Limits, ListSheet } from "../ui.tsx";
import { C, S } from "../theme.ts";
import { WakePanel } from "../WakePanel.tsx";
import { HubUpdateBanner } from "../HubUpdate.tsx";
import { dialog } from "../dialog.tsx";

function when(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const hm = `${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;
  if (d.toDateString() === now.toDateString()) return hm;
  return `${d.getDate()}.${String(d.getMonth() + 1).padStart(2, "0")} ${hm}`;
}

const shortDir = (p: string) => {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts.length > 2 ? "…\\" + parts.slice(-2).join("\\") : p;
};

export function Sessions() {
  const state = useHub();
  const update = useUpdate();
  // связи нет дольше нескольких секунд — возможно, ПК спит
  const [longOffline, setLongOffline] = useState(false);
  const offline = state.conn === "offline" || state.conn === "connecting";
  useEffect(() => {
    if (!offline) return setLongOffline(false);
    const timer = setTimeout(() => setLongOffline(true), 5000);
    return () => clearTimeout(timer);
  }, [offline]);
  return (
    <View style={S.screen}>
      <View style={S.head}>
        <Image source={require("../../assets/logo.png")} style={{ width: 28, height: 28, marginRight: -4 }} />
        <Text style={S.h1}>KraBness</Text>
        <ConnDot conn={state.conn} />
        <Text style={[S.muted, { flex: 1 }]}>{state.conn === "online" ? "" : connLabel(state.conn)}</Text>
        <Btn small kind="primary" title={t("+ Новая", "+ New")} onPress={() => go({ page: "new" })} />
        <Btn small title="⚙" onPress={() => go({ page: "settings" })} />
      </View>
      <Limits limits={state.limits} style={{ paddingHorizontal: 16, paddingVertical: 6, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: C.line }} />
      {update.release ? (
        <View style={st.update}>
          <Text style={[S.text, { flex: 1 }]}>
            {t("Новая версия", "New version")} {update.release.version} <Text style={S.muted}>({t("у тебя", "you have")} {APP_VERSION})</Text>
            {update.busy ? (
              <Text style={S.muted}>
                {" · "}
                {update.progress !== undefined ? `${Math.round(update.progress * 100)}% · ` : ""}
                {update.stage ?? t("качаю", "downloading")} · {t("можно свернуть", "you can minimize")}
              </Text>
            ) : null}
          </Text>
          <Btn small kind="primary" title={update.ready ? t("Установить", "Install") : t("Обновить", "Update")} busy={update.busy} onPress={() => void update.install()} />
        </View>
      ) : null}
      {update.error ? <Text style={[S.error, { paddingHorizontal: 16 }]}>{update.error}</Text> : null}
      <HubUpdateBanner />
      {longOffline ? (
        <View style={st.wake}>
          <WakePanel hint={t("ПК не отвечает. Может, он спит?", "The PC doesn't answer. Maybe it's asleep?")} />
        </View>
      ) : null}
      <Grouped sessions={state.sessions} groups={state.groups} empty={state.conn === "online" ? t("Сессий пока нет. Нажми «+ Новая».", "No sessions yet. Tap “+ New”.") : t("Загрузка…", "Loading…")} />
    </View>
  );
}

/** Секции по группам (свёрнутые — без сессий) и «Без группы» в конце. */
function Grouped({ sessions, groups, empty }: { sessions: SessionInfo[]; groups: SessionGroup[]; empty: string }) {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(() => recall("groups.collapsed") ?? {});
  const [moving, setMoving] = useState<SessionInfo>();
  const toggle = (key: string) => {
    const next = { ...collapsed, [key]: !collapsed[key] };
    setCollapsed(next);
    remember("groups.collapsed", next);
  };
  const sections = useMemo(() => {
    const known = new Set(groups.map((g) => g.id));
    const all = [
      ...groups.map((g) => ({ key: g.id, group: g as SessionGroup | undefined, items: sessions.filter((s) => s.groupId === g.id) })),
      { key: "", group: undefined, items: sessions.filter((s) => !s.groupId || !known.has(s.groupId)) },
    ];
    return all
      .filter((x) => x.group || x.items.length)
      .map((x) => ({ ...x, data: collapsed[x.key] ? [] : x.items }));
  }, [sessions, groups, collapsed]);

  const move = (s: SessionInfo, groupId: string) => {
    if (groupId === "+") return go({ page: "group", id: "new" });
    if ((s.groupId ?? "") === groupId) return;
    void client?.moveSession(s.id, groupId || null).catch((e: Error) => dialog(t("Не получилось", "Failed"), e.message));
  };

  return (
    <>
      <SectionList
        sections={sections}
        keyExtractor={(s) => s.id}
        stickySectionHeadersEnabled={false}
        renderItem={({ item }) => <Row s={item} onLongPress={() => setMoving(item)} />}
        ItemSeparatorComponent={() => <View style={st.sep} />}
        renderSectionHeader={({ section }) =>
          groups.length ? <GroupHead group={section.group} count={section.items.length} busy={section.items.some((s) => s.status === "busy")} collapsed={!!collapsed[section.key]} onToggle={() => toggle(section.key)} /> : null
        }
        ListEmptyComponent={<Text style={[S.muted, st.empty]}>{empty}</Text>}
        ListFooterComponent={
          <Pressable onPress={() => go({ page: "group", id: "new" })} style={st.addGroup}>
            <Text style={S.muted}>{t("+ Группа", "+ Group")}</Text>
          </Pressable>
        }
      />
      <ListSheet
        visible={!!moving}
        title={moving ? `${t("В группу", "Move to group")}: ${moving.title.length > 40 ? moving.title.slice(0, 39) + "…" : moving.title}` : ""}
        value={moving?.groupId ?? ""}
        options={[
          ...groups.map((g) => ({ value: g.id, label: `${g.icon ?? "📁"} ${g.name}`, ...(g.prompt ? { hint: t("свой системный промпт", "custom system prompt") } : {}) })),
          { value: "", label: t("Без группы", "No group") },
          { value: "+", label: t("+ Новая группа…", "+ New group…") },
        ]}
        onClose={() => setMoving(undefined)}
        onPick={(v) => moving && move(moving, v)}
      />
    </>
  );
}

function GroupHead({ group, count, busy, collapsed, onToggle }: { group?: SessionGroup; count: number; busy: boolean; collapsed: boolean; onToggle: () => void }) {
  return (
    <View style={st.groupHead}>
      <Pressable style={st.groupToggle} onPress={onToggle} hitSlop={6}>
        <Text style={S.muted}>{collapsed ? "▸" : "▾"}</Text>
        <Text style={st.groupName} numberOfLines={1}>
          {group ? `${group.icon ? group.icon + " " : ""}${group.name}` : t("Без группы", "Ungrouped")}
        </Text>
        <Text style={S.muted}>{count}</Text>
        {busy ? <Text style={st.busy}>●</Text> : null}
        {group?.prompt ? <Text style={S.muted}>✎</Text> : null}
      </Pressable>
      {group ? (
        <>
          <Btn small kind="ghost" title="+" onPress={() => go({ page: "new", group: group.id })} />
          <Btn small kind="ghost" title="⋯" onPress={() => go({ page: "group", id: group.id })} />
        </>
      ) : null}
    </View>
  );
}

function Row({ s, onLongPress }: { s: SessionInfo; onLongPress: () => void }) {
  const busy = s.status === "busy" || s.status === "retry";
  return (
    <Pressable style={({ pressed }) => [st.row, pressed && { backgroundColor: C.bg2 }]} onPress={() => go({ page: "session", id: s.id })} onLongPress={onLongPress} delayLongPress={350}>
      <View style={st.line}>
        <Text style={st.title} numberOfLines={1}>
          {s.title}
        </Text>
        <Text style={S.muted}>{when(s.updatedAt)}</Text>
      </View>
      <View style={st.line}>
        <EngineBadge engine={s.engine} />
        {busy ? <Text style={st.busy}>● {t("работает", "running")}</Text> : null}
        {s.resumeAt ? <Text style={st.busy}>⏳ {new Date(s.resumeAt).toLocaleTimeString(locale(), { hour: "2-digit", minute: "2-digit" })}</Text> : null}
        <Text style={[S.muted, { flex: 1 }]} numberOfLines={1}>
          {shortDir(s.directory)}
        </Text>
      </View>
    </Pressable>
  );
}

const st = StyleSheet.create({
  wake: { padding: 16, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: C.line },
  row: { paddingHorizontal: 16, paddingVertical: 12, gap: 6 },
  line: { flexDirection: "row", alignItems: "center", gap: 8 },
  title: { color: C.text, fontSize: 16, fontWeight: "600", flex: 1 },
  busy: { color: C.warn, fontSize: 12 },
  sep: { height: StyleSheet.hairlineWidth, backgroundColor: C.line, marginLeft: 16 },
  groupHead: { flexDirection: "row", alignItems: "center", paddingLeft: 12, paddingRight: 6, paddingTop: 14, paddingBottom: 4, backgroundColor: C.bg },
  groupToggle: { flex: 1, flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 4 },
  groupName: { color: C.text, fontSize: 14, fontWeight: "700", flexShrink: 1 },
  addGroup: { paddingHorizontal: 16, paddingVertical: 18 },
  empty: { textAlign: "center", marginTop: 40 },
  update: { flexDirection: "row", alignItems: "center", gap: 10, margin: 10, padding: 12, borderRadius: 12, backgroundColor: "#16233a", borderWidth: 1, borderColor: C.accent },
});
