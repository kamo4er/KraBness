// Цвета и общие стили — в тон веб-UI.
import { Platform, StyleSheet } from "react-native";

export const C = {
  bg: "#111318",
  bg2: "#181b22",
  bg3: "#20242d",
  line: "#2a2f3a",
  text: "#e6e8ee",
  muted: "#8b93a3",
  accent: "#3b82f6",
  accent2: "#2f6fd6",
  ok: "#22c55e",
  warn: "#f59e0b",
  err: "#ef4444",
  claude: "#d97757",
  opencode: "#60a5fa",
};

export const mono = Platform.select({ android: "monospace", default: "Courier" });

export const S = StyleSheet.create({
  screen: { flex: 1, backgroundColor: C.bg },
  head: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: C.line,
    backgroundColor: C.bg2,
  },
  h1: { color: C.text, fontSize: 18, fontWeight: "700" },
  h2: { color: C.text, fontSize: 16, fontWeight: "600" },
  h3: { color: C.muted, fontSize: 13, fontWeight: "600", textTransform: "uppercase", marginTop: 18, marginBottom: 8 },
  text: { color: C.text, fontSize: 15, lineHeight: 21 },
  muted: { color: C.muted, fontSize: 13 },
  error: { color: C.err, fontSize: 14, marginVertical: 6 },
  input: {
    backgroundColor: C.bg3,
    color: C.text,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
    borderWidth: 1,
    borderColor: C.line,
  },
  pre: { fontFamily: mono, fontSize: 12, color: C.text, backgroundColor: C.bg, padding: 8, borderRadius: 6 },
});
