// Отладочный клиент хаба.
//   npm run cli -- engines
//   npm run cli -- ls
//   npm run cli -- new <папка> [provider/model] [manual|acceptEdits|auto]
//   npm run cli -- send <sessionId> <текст...>
//   npm run cli -- watch <sessionId>
//   npm run cli -- perm <sessionId> <permId> once|always|reject
//   npm run cli -- abort <sessionId>
//   npm run cli -- pair
import WebSocket from "ws";
import type { ServerMessage } from "@kamharn/protocol";
import { L } from "./lang.ts";

const BASE = process.env.KAMHARN_URL ?? "http://127.0.0.1:7420";
const TOKEN = process.env.KAMHARN_TOKEN;

async function api(method: string, path: string, body?: unknown): Promise<any> {
  const r = await fetch(BASE + path, {
    method,
    headers: { ...(TOKEN ? { authorization: `Bearer ${TOKEN}` } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${r.status}: ${j.error ?? JSON.stringify(j)}`);
  return j;
}

const [cmd, ...args] = process.argv.slice(2);
const out = (x: unknown) => console.log(JSON.stringify(x, null, 2));

switch (cmd) {
  case "engines": {
    const engines = await api("GET", "/api/engines");
    for (const e of engines) {
      console.log(`${e.id}: ${e.available ? "ok" : L("НЕДОСТУПЕН ", "UNAVAILABLE ") + e.error}; ${L("по умолчанию", "default")} ${e.defaultModel ? e.defaultModel.providerId + "/" + e.defaultModel.modelId : "—"}`);
      for (const m of e.models) console.log(`  ${m.providerId}/${m.modelId}  ${m.name}${m.free ? "  (free)" : ""}`);
    }
    break;
  }
  case "ls":
    for (const s of await api("GET", "/api/sessions")) console.log(`${s.id}  [${s.engine} ${s.status}]  ${s.title}  ${s.directory}`);
    break;
  case "new": {
    const [directory, model, mode] = args;
    const [providerId, ...rest] = (model ?? "").split("/");
    out(await api("POST", "/api/sessions", {
      engine: "opencode",
      directory,
      ...(model ? { model: { providerId, modelId: rest.join("/") } } : {}),
      ...(mode ? { permissionMode: mode } : {}),
    }));
    break;
  }
  case "send":
    out(await api("POST", `/api/sessions/${args[0]}/prompt`, { text: args.slice(1).join(" ") }));
    break;
  case "perm":
    out(await api("POST", `/api/sessions/${args[0]}/permissions/${args[1]}`, { reply: args[2] ?? "once" }));
    break;
  case "abort":
    out(await api("POST", `/api/sessions/${args[0]}/abort`, {}));
    break;
  case "pair":
    out(await api("POST", "/api/pair/start", {}));
    break;
  case "watch": {
    const sid = args[0]!;
    const ws = new WebSocket(BASE.replace(/^http/, "ws") + "/ws" + (TOKEN ? `?token=${TOKEN}` : ""));
    ws.on("open", () => ws.send(JSON.stringify({ t: "sub", sessionId: sid, after: 0 })));
    let streaming = false;
    ws.on("message", (raw) => {
      const m = JSON.parse(String(raw)) as ServerMessage;
      if (m.t === "delta") {
        if (!streaming) process.stdout.write("  … ");
        streaming = true;
        process.stdout.write(m.delta);
        return;
      }
      if (streaming) process.stdout.write("\n");
      streaming = false;
      if (m.t === "ev") {
        const e = m.event;
        if (e.type === "part.upserted" && e.part.type === "tool") console.log(`#${m.seq} tool ${e.part.tool} [${e.part.status}] ${e.part.title ?? ""}`);
        else if (e.type === "part.upserted" && (e.part.type === "text" || e.part.type === "reasoning")) console.log(`#${m.seq} ${e.part.type}: ${e.part.text.slice(0, 200)}`);
        else if (e.type === "permission.asked") console.log(`#${m.seq} ❓ ${L("разрешение", "permission")} ${e.request.id}: ${e.request.tool} ${e.request.title}`);
        else console.log(`#${m.seq} ${e.type} ${JSON.stringify("patch" in e ? e.patch : "message" in e ? e.message : "").slice(0, 160)}`);
      } else if (m.t === "live") console.log(L(`— live с seq ${m.seq}, стримится частей: ${m.parts.length}`, `— live from seq ${m.seq}, streaming parts: ${m.parts.length}`));
      else if (m.t === "err") console.log("ERR", m.message);
    });
    break;
  }
  default:
    console.log(L("команды: engines | ls | new | send | watch | perm | abort | pair", "commands: engines | ls | new | send | watch | perm | abort | pair"));
}
