import { useEffect } from "react";
import { BackHandler, KeyboardAvoidingView, View } from "react-native";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider, useSafeAreaInsets } from "react-native-safe-area-context";
import { client, start, useConn, useHub, useLang } from "./src/store.ts";
import { persistChats } from "./src/cache.ts";
import { back, go, useRoute } from "./src/nav.ts";
import { onNotificationOpen, watchPushToken } from "./src/push.ts";
import { registerNotifications, useLocalNotices } from "./src/notify.ts";
import { Pair } from "./src/screens/Pair.tsx";
import { Sessions } from "./src/screens/Sessions.tsx";
import { Chat } from "./src/screens/Chat.tsx";
import { Project } from "./src/screens/Project.tsx";
import { FileViewer } from "./src/screens/FileViewer.tsx";
import { NewSession } from "./src/screens/NewSession.tsx";
import { Settings } from "./src/screens/Settings.tsx";
import { Task, Tasks } from "./src/screens/Tasks.tsx";
import { Group } from "./src/screens/Group.tsx";
import { Providers } from "./src/screens/Providers.tsx";
import { Mcp } from "./src/screens/Mcp.tsx";
import { Skills } from "./src/screens/Skills.tsx";
import { ModelPickHost } from "./src/modelPick.tsx";
import { C } from "./src/theme.ts";
import { syncWake } from "./src/wake.ts";
import { DialogHost } from "./src/dialog.tsx";
import { useKeepAlive } from "./src/keepalive.ts";
import { t } from "@kamharn/client";

export default function App() {
  return (
    <SafeAreaProvider>
      <StatusBar style="light" />
      <LangRoot />
    </SafeAreaProvider>
  );
}

// сменили язык — перерисовываем всё (строки берутся при отрисовке)
function LangRoot() {
  const lang = useLang();
  return <Root key={lang} />;
}

function Root() {
  const insets = useSafeAreaInsets();
  const conn = useConn();
  const state = useHub();
  const route = useRoute();

  useEffect(start, [conn?.token]);
  useKeepAlive();
  useLocalNotices();
  useEffect(() => (client ? persistChats(client) : undefined), [conn?.token]);
  useEffect(() => {
    const sub = BackHandler.addEventListener("hardwareBackPress", back);
    return () => sub.remove();
  }, []);
  // пуши: как только есть связь — регистрируем токен устройства в хабе
  const online = state.conn === "online";
  useEffect(() => {
    if (online) registerNotifications().catch(() => {});
    if (online) void syncWake();
  }, [online, conn?.token]);
  useEffect(() => {
    const offToken = watchPushToken();
    const offOpen = onNotificationOpen((id) => go({ page: "session", id }));
    return () => (offToken(), offOpen());
  }, []);

  let screen;
  if (!conn) screen = <Pair />;
  else if (state.conn === "unauthorized") screen = <Pair reason={t("Хаб не принял токен устройства (отключено на ПК?). Подключись заново.", "The hub rejected this device's token (disconnected on the PC?). Connect again.")} />;
  else if (route.page === "session") screen = <Chat key={route.id} id={route.id} />;
  else if (route.page === "project") screen = <Project key={`${route.id}|${route.file ?? ""}|${route.line ?? ""}`} id={route.id} file={route.file} line={route.line} />;
  else if (route.page === "file") screen = <FileViewer key={route.fileId} {...route} />;
  else if (route.page === "new") screen = <NewSession key={route.group ?? ""} group={route.group} />;
  else if (route.page === "group") screen = <Group key={route.id} id={route.id} />;
  else if (route.page === "tasks") screen = <Tasks />;
  else if (route.page === "task") screen = <Task key={route.id} id={route.id} />;
  else if (route.page === "settings") screen = <Settings key={route.section ?? ""} section={route.section} />;
  else if (route.page === "providers") screen = <Providers />;
  else if (route.page === "mcp") screen = <Mcp />;
  else if (route.page === "skills") screen = <Skills />;
  else screen = <Sessions />;

  return (
    <View style={{ flex: 1, backgroundColor: C.bg, paddingTop: insets.top, paddingBottom: insets.bottom }}>
      {/* edge-to-edge: Android окно под клавиатуру не ужимает — поднимаем сами, на всех экранах.
          KeyboardAvoidingView меряет себя относительно родителя (а он ниже строки состояния на insets.top),
          а клавиатуру — в координатах экрана, поэтому поправка на insets.top обязательна */}
      <KeyboardAvoidingView style={{ flex: 1 }} behavior="padding" keyboardVerticalOffset={insets.top}>
        {screen}
      </KeyboardAvoidingView>
      <DialogHost />
      <ModelPickHost />
    </View>
  );
}
