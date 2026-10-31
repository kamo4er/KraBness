// MCP-сервер хаба для движков (только localhost):
//   POST /mcp/<secret>/opencode          — инструменты для opencode
//   POST /mcp/<secret>/<claudeSessionId> — инструменты для сессии Claude (+ approve)
import type { FastifyInstance } from "fastify";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { isAbsolute, resolve } from "node:path";
import { isLoopback, tunnelSockets } from "./auth.ts";
import { FILE_MARKER, type FileStore } from "./files.ts";
import type { ClaudeEngine } from "./engines/claude.ts";
import { L } from "./lang.ts";
import type { Dispatcher } from "./dispatcher.ts";

export interface McpDeps {
  secret: string;
  files: FileStore;
  claude?: ClaudeEngine;
  /** рабочая папка сессии Claude — для относительных путей */
  claudeSessionDir: (engineSessionId: string) => string | undefined;
  /** Диспетчер: его сессия получает инструменты управления харнессом */
  dispatcher?: Dispatcher;
}



function buildServer(deps: McpDeps, scope: string): McpServer {
  const server = new McpServer({ name: "kamharn", version: "0.1.0" });
  const cwd = scope === "opencode" ? undefined : deps.claudeSessionDir(scope);

  server.registerTool(
    "send_file_to_user",
    {
      description:
        "Send a file from the computer to the user (they will see it in KraBness on the phone or in the browser and can download or open it). " +
        "Use it when the user asks to send, show or hand over a file. The path is absolute (or relative to the working folder).",
      inputSchema: { path: z.string().describe("path to the file") },
    },
    async ({ path }) => {
      try {
        const full = isAbsolute(path) ? path : cwd ? resolve(cwd, path) : path;
        const f = await deps.files.registerOutgoing(full, scope === "opencode" ? null : scope);
        return {
          content: [{ type: "text", text: `File “${f.name}” (${Math.ceil(f.size / 1024)} KB) sent to the user. ${FILE_MARKER}${f.id}` }],
        };
      } catch (e) {
        return { content: [{ type: "text", text: `Couldn't send the file: ${(e as Error).message}` }], isError: true };
      }
    },
  );

  if (scope !== "opencode" && deps.claude) {
    const claude = deps.claude;
    server.registerTool(
      "approve",
      {
        description: "KraBness internal tool: asks the user for permission. Don't call it yourself.",
        inputSchema: { tool_name: z.string(), input: z.any(), tool_use_id: z.string().optional() },
      },
      async ({ tool_name, input }) => {
        if (tool_name === "AskUserQuestion") {
          return { content: [{ type: "text", text: JSON.stringify(await claude.answerQuestion(scope, input)) }] };
        }
        const reply = await claude.requestPermission(scope, tool_name, input);
        const decision =
          reply === "reject"
            ? { behavior: "deny", message: "The user denied this action." }
            : { behavior: "allow", updatedInput: input ?? {} };
        return { content: [{ type: "text", text: JSON.stringify(decision) }] };
      },
    );
  }
  if (scope !== "opencode" && deps.dispatcher?.isScope(scope)) registerHarness(server, deps.dispatcher, scope);
  return server;
}

/** Инструменты управления харнессом — только у Диспетчера. Описания для модели — по-английски, как у остальных. */
function registerHarness(server: McpServer, d: Dispatcher, scope: string): void {
  const run = (f: () => Promise<string> | string) => async () => {
    try {
      return { content: [{ type: "text" as const, text: await f() }] };
    } catch (e) {
      return { content: [{ type: "text" as const, text: (e as Error).message }], isError: true };
    }
  };
  server.registerTool(
    "list_sessions",
    { description: "List KraBness sessions (id, title, status, engine and model, folder, last message). Task steps and your own session are hidden.", inputSchema: {} },
    () => run(() => d.listSessions())(),
  );
  server.registerTool(
    "read_session",
    {
      description: "Read the tail of a session: the last messages without tool output, plus pending questions and permission requests with their request_id.",
      inputSchema: { session_id: z.string(), messages: z.number().int().optional().describe("how many last messages, default 6, max 40") },
    },
    ({ session_id, messages }) => run(() => d.readSession(session_id, messages ?? 6))(),
  );
  server.registerTool(
    "send_to_session",
    {
      description: "Send a prompt to a session as the Dispatcher (the chat shows it marked as yours). Then call wait_session to get the result.",
      inputSchema: { session_id: z.string(), text: z.string() },
    },
    ({ session_id, text }) => run(() => d.send(session_id, text))(),
  );
  server.registerTool(
    "wait_session",
    {
      description: "Wait until the session finishes its turn, asks a question or asks for permission; returns the tail of the session.",
      inputSchema: { session_id: z.string(), timeout_sec: z.number().int().optional().describe("default 300, max 1200") },
    },
    ({ session_id, timeout_sec }) => run(() => d.wait(session_id, timeout_sec ?? 300))(),
  );
  server.registerTool(
    "answer_request",
    {
      description:
        "Answer a session's pending permission request (reply: once | always | reject) or question (answers: chosen labels or own text per question, or reply for a single answer). " +
        "Irreversible actions (push, deletion) are refused — ask the user instead.",
      inputSchema: {
        session_id: z.string(),
        request_id: z.string(),
        reply: z.string().optional(),
        answers: z.array(z.array(z.string())).optional(),
      },
    },
    ({ session_id, request_id, reply, answers }) => run(() => d.answer(session_id, request_id, reply, answers))(),
  );
  server.registerTool(
    "create_session",
    {
      description: "Create a new coding session in a project folder. engine: claude | opencode; model: provider/model from list_models (default — the engine's default). worktree: work in a separate git branch.",
      inputSchema: { directory: z.string(), engine: z.enum(["claude", "opencode"]), model: z.string().optional(), title: z.string().optional(), worktree: z.boolean().optional() },
    },
    ({ directory, engine, model, title, worktree }) =>
      run(() => {
        const slash = model?.indexOf("/") ?? -1;
        const ref = model && slash > 0 ? { providerId: model.slice(0, slash), modelId: model.slice(slash + 1) } : undefined;
        return d.createSession({ directory, engine, ...(ref ? { model: ref } : {}), ...(title ? { title } : {}), ...(worktree ? { worktree } : {}) });
      })(),
  );
  server.registerTool(
    "create_task",
    {
      description: "Create an orchestrator task: a worker session in a separate branch, automatic checks and review, then a report for the user to merge. For big pieces of work from goal to result.",
      inputSchema: { goal: z.string(), directory: z.string(), title: z.string().optional() },
    },
    ({ goal, directory, title }) => run(() => d.createTask({ goal, directory, ...(title ? { title } : {}) }))(),
  );
  server.registerTool(
    "show_screen",
    { description: "Take a screenshot of the user's whole desktop and send it to them in this chat. Use it to show the result of computer actions (Windows-MCP screenshots can't be sent).", inputSchema: {} },
    () => run(() => d.showScreen(scope))(),
  );
  server.registerTool(
    "list_models",
    { description: "Engines and models available for new sessions (provider/model ids).", inputSchema: {} },
    () => run(() => d.listModels())(),
  );
}

export function registerMcp(app: FastifyInstance, deps: McpDeps): void {
  app.post<{ Params: { secret: string; scope: string } }>("/mcp/:secret/:scope", async (req, reply) => {
    if (!isLoopback(req.socket.remoteAddress) || tunnelSockets.has(req.socket) || req.params.secret !== deps.secret) {
      return reply.code(403).send({ error: "forbidden" });
    }
    const server = buildServer(deps, req.params.scope);
    // stateless: новый транспорт на каждый запрос
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    reply.hijack();
    reply.raw.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req.raw, reply.raw, req.body);
  });
  const notAllowed = async (_req: unknown, reply: { code: (n: number) => { send: (b: unknown) => unknown } }) =>
    reply.code(405).send({ error: "Method not allowed" });
  app.get("/mcp/:secret/:scope", notAllowed);
  app.delete("/mcp/:secret/:scope", notAllowed);
}
