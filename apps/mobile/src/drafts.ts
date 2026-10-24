// Черновики сообщений по сессиям: ушёл в другую сессию или приложение выгрузили — текст в поле остаётся.
// Текст лежит в documents/drafts.json; загруженные вложения — только в памяти (uri с телефона живут недолго).
import { AppState } from "react-native";
import { File, Paths } from "expo-file-system";

const SAVE_DELAY_MS = 1000;
const file = new File(Paths.document, "drafts.json");

let texts: Record<string, string> | undefined;
const attachments = new Map<string, unknown[]>();
let timer: ReturnType<typeof setTimeout> | undefined;

function load(): Record<string, string> {
  if (texts) return texts;
  try {
    const data = file.exists ? (JSON.parse(file.textSync()) as unknown) : {};
    texts = data && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, string>) : {};
  } catch {
    texts = {};
  }
  return texts;
}

function flush(): void {
  if (timer) clearTimeout(timer);
  timer = undefined;
  // не записалось — останется в памяти до следующей попытки
  file.write(JSON.stringify(load())).catch(() => {});
}

AppState.addEventListener("change", (s) => {
  if (s !== "active" && timer) flush();
});

export const getDraft = (sessionId: string): string => load()[sessionId] ?? "";

export function setDraft(sessionId: string, text: string): void {
  const all = load();
  if ((all[sessionId] ?? "") === text) return;
  if (text) all[sessionId] = text;
  else delete all[sessionId];
  if (!timer) timer = setTimeout(flush, SAVE_DELAY_MS);
}

export const getDraftFiles = <T>(sessionId: string): T[] => (attachments.get(sessionId) as T[] | undefined) ?? [];

export function setDraftFiles(sessionId: string, files: unknown[]): void {
  if (files.length) attachments.set(sessionId, files);
  else attachments.delete(sessionId);
}
