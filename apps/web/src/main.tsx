import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { client, useLang } from "./hub.ts";
import { startPresence } from "./presence.ts";
import "./styles.css";

client.connect();
// вкладка вернулась из фона — сразу переподключаемся, а не ждём backoff
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") client.reconnectNow();
});
window.addEventListener("online", () => client.reconnectNow());
startPresence();

// сменили язык — перерисовываем всё (строки берутся при отрисовке)
function Root() {
  const lang = useLang();
  return <App key={lang} />;
}

createRoot(document.getElementById("root")!).render(<Root />);
