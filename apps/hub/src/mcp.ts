// MCP-сервер хаба для движков (только localhost):
//   POST /mcp/<secret>/opencode          — инструменты для opencode
//   POST /mcp/<secret>/<claudeSessionId> — инструменты для сессии Claude (+ approve)
import type { FastifyInstance } from "fastify";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { isAbsolute, resolve } from "node:path";
import { isLoopback } from "./auth.ts";
import { FILE_MARKER, type FileStore } from "./files.ts";
import type { ClaudeEngine } from "./engines/claude.ts";
import { L } from "./lang.ts";

export interface McpDeps {
  secret: string;
  files: FileStore;
  claude?: ClaudeEngine;
  /** рабочая папка сессии Claude — для относительных путей */
  claudeSessionDir: (engineSessionId: string) => string | undefined;
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
  return server;
}

export function registerMcp(app: FastifyInstance, deps: McpDeps): void {
  app.post<{ Params: { secret: string; scope: string } }>("/mcp/:secret/:scope", async (req, reply) => {
    if (!isLoopback(req.socket.remoteAddress) || req.params.secret !== deps.secret) {
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
