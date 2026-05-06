import { Router } from "express";
import type { BridgeGatewayClient } from "../gateway-client.js";
import { randomUUID } from "node:crypto";
import { asyncHandler, toOpenclawSessionKey, toNanobotSessionId, extractTextContent, stripInboundMetadata, cleanSessionTitle } from "../utils.js";
import { loadConfig } from "../config.js";

interface OpenclawSessionRow {
  key: string;
  updatedAt: number | null;
  [key: string]: unknown;
}

interface OpenclawSessionsListResult {
  sessions: OpenclawSessionRow[];
  [key: string]: unknown;
}

interface OpenclawChatHistoryResult {
  messages: Array<{
    role: string;
    content: unknown;
    timestamp?: number;
    [key: string]: unknown;
  }>;
  [key: string]: unknown;
}

function normalizeGeneratedTitle(value: string): string {
  const firstLine = value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean) || "";
  const cleaned = firstLine
    .replace(/^["'“”‘’「」《》]+|["'“”‘’「」《》。.!！?？]+$/g, "")
    .replace(/^标题[:：]\s*/i, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return "";
  return Array.from(cleaned).slice(0, 24).join("");
}

const sessionsWithTitleGenerationStarted = new Set<string>();

async function generateSessionTitle(message: string): Promise<string> {
  const fallback = "新对话";
  const config = loadConfig();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);

  try {
    const response = await fetch(`${config.proxyUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.proxyToken}`,
      },
      body: JSON.stringify({
        model: config.model,
        temperature: 0.2,
        max_tokens: 32,
        messages: [
          {
            role: "system",
            content: [
              "你是对话标题生成器。",
              "请只根据用户第一条消息概括其真实意图和要求。",
              "输出一个中文短标题，8到16个汉字为宜，最多24个汉字。",
              "不要使用引号、句号、编号、解释、Markdown。",
              "不要照抄用户原文，要提炼问题主题。",
              "不要根据助手回答内容生成标题。",
              "如果用户只是在询问某个助手能做什么，也要说明具体对象，例如“询问演示文稿助手能力”。",
            ].join("\n"),
          },
          {
            role: "user",
            content: message,
          },
        ],
      }),
    });
    if (!response.ok) return fallback;
    const data = await response.json() as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    return normalizeGeneratedTitle(data.choices?.[0]?.message?.content || "") || fallback;
  } catch {
    return fallback;
  } finally {
    clearTimeout(timer);
  }
}

function hasStoredSessionTitle(row: OpenclawSessionRow | undefined): boolean {
  if (!row) return false;
  const displayName = typeof row.displayName === "string" && row.displayName !== "OpenClaw Bridge"
    ? cleanSessionTitle(row.displayName)
    : "";
  const label = typeof row.label === "string" ? cleanSessionTitle(row.label) : "";
  const derivedTitle = typeof row.derivedTitle === "string" ? cleanSessionTitle(row.derivedTitle) : "";
  return Boolean(displayName || label || derivedTitle);
}

async function shouldCreateFirstQuestionTitle(params: {
  client: BridgeGatewayClient;
  key: string;
}): Promise<boolean> {
  if (sessionsWithTitleGenerationStarted.has(params.key)) return false;

  const sessionRow = await params.client.request<OpenclawSessionsListResult>("sessions.list", {
    includeDerivedTitles: true,
  })
    .then((result) => (result.sessions || []).find((s) => toOpenclawSessionKey(String(s.key)) === params.key))
    .catch(() => undefined);

  return !hasStoredSessionTitle(sessionRow);
}

/** Convert "agent:programmer:session-1773503840989" → "programmer 会话" */
function friendlySessionKey(key: string): string {
  const parts = key.split(":");
  // agent:<name>:session-<ts> or agent:<name>:<channel>:<id>
  if (parts.length >= 2 && parts[0] === "agent") {
    const agentName = parts[1]!;
    return `${agentName} 会话`;
  }
  return key;
}

export function sessionsRoutes(client: BridgeGatewayClient): Router {
  const router = Router();

  // GET /api/sessions — list sessions
  router.get("/sessions", asyncHandler(async (_req, res) => {
    try {
      const result = await client.request<OpenclawSessionsListResult>("sessions.list", {
        includeDerivedTitles: true,
      });

      const sessions = (result.sessions || []).map((s: OpenclawSessionRow) => {
        // Skip generic origin labels (e.g. "OpenClaw Bridge") — prefer derivedTitle (user's first message)
        const dn = s.displayName && s.displayName !== "OpenClaw Bridge" ? s.displayName : "";
        const rawTitle = String(dn || s.derivedTitle || "");
        const cleaned = cleanSessionTitle(rawTitle);
        const key = toNanobotSessionId(s.key);
        return {
          key,
          created_at: s.updatedAt ? new Date(s.updatedAt).toISOString() : null,
          updated_at: s.updatedAt ? new Date(s.updatedAt).toISOString() : null,
          title: cleaned || friendlySessionKey(key),
        };
      });

      res.json(sessions);
    } catch (err) {
      res.status(500).json({ detail: (err as Error).message });
    }
  }));

  // GET /api/sessions/:key — get session detail with messages
  router.get("/sessions/:key(*)", asyncHandler(async (req, res) => {
    const key = toOpenclawSessionKey(req.params.key);

    try {
      const history = await client.request<OpenclawChatHistoryResult>("chat.history", {
        sessionKey: key,
        limit: 200,
      });

      // Filter: only user and assistant messages (skip tool, system)
      // Also filter intermediate assistant messages that have tool_calls or empty content
      const messages = (history.messages || [])
        .filter((m) => m.role === "user" || m.role === "assistant")
        .filter((m) => {
          if (m.role !== "assistant") return true;
          // Skip assistant messages that are just tool calls
          if (m.tool_calls) return false;
          // Skip assistant messages with empty content (intermediate agent loop artifacts)
          const text = extractTextContent(m.content);
          if (!text.trim()) return false;
          return true;
        })
        .map((m) => ({
          role: m.role,
          content: m.role === "user"
            ? stripInboundMetadata(extractTextContent(m.content))
            : extractTextContent(m.content),
          timestamp: m.timestamp ? new Date(m.timestamp).toISOString() : null,
        }));

      // Determine timestamps from messages
      const firstMsg = messages[0];
      const lastMsg = messages[messages.length - 1];

      res.json({
        key: toNanobotSessionId(key),
        messages,
        created_at: firstMsg?.timestamp || null,
        updated_at: lastMsg?.timestamp || null,
      });
    } catch (err) {
      res.status(500).json({ detail: (err as Error).message });
    }
  }));

  // POST /api/sessions/:key/messages — send a chat message
  router.post("/sessions/:key(*)/messages", asyncHandler(async (req, res) => {
    const key = toOpenclawSessionKey(req.params.key);
    const { message } = req.body;

    if (!message || typeof message !== "string") {
      res.status(400).json({ detail: "message is required" });
      return;
    }

    try {
      const params: Record<string, unknown> = {
        sessionKey: key,
        message,
        deliver: false,
        idempotencyKey: randomUUID(),
      };

      const result = await client.request<Record<string, unknown>>("chat.send", params);

      res.json({ ok: true, runId: result.runId || null, title: null });
    } catch (err) {
      res.status(500).json({ detail: (err as Error).message });
    }
  }));

  // POST /api/sessions/:key/title-summary — summarize the first user question into a fixed title
  router.post("/sessions/:key(*)/title-summary", asyncHandler(async (req, res) => {
    const key = toOpenclawSessionKey(req.params.key);
    const message = typeof req.body?.message === "string" ? req.body.message.trim() : "";

    if (!message) {
      res.status(400).json({ detail: "message is required" });
      return;
    }

    try {
      const shouldGenerateTitle = await shouldCreateFirstQuestionTitle({ client, key });
      if (!shouldGenerateTitle) {
        res.json({ ok: true, key: toNanobotSessionId(key), title: null });
        return;
      }

      sessionsWithTitleGenerationStarted.add(key);
      const title = await generateSessionTitle(message);
      await client.request("sessions.patch", {
        key,
        label: title,
      }).catch(() => {});

      res.json({ ok: true, key: toNanobotSessionId(key), title });
    } catch (err) {
      res.status(500).json({ detail: (err as Error).message });
    }
  }));

  // PUT /api/sessions/:key/title — set or clear a custom session title
  router.put("/sessions/:key(*)/title", asyncHandler(async (req, res) => {
    const key = toOpenclawSessionKey(req.params.key);
    const rawTitle = req.body?.title;
    const title = typeof rawTitle === "string" ? rawTitle.trim() : "";

    try {
      const result = await client.request<Record<string, unknown>>("sessions.patch", {
        key,
        label: title || null,
      });
      res.json({
        ok: true,
        key: toNanobotSessionId(String(result.key || key)),
        title: title || null,
      });
    } catch (err) {
      res.status(500).json({ detail: (err as Error).message });
    }
  }));

  // GET /api/runs/:runId/wait — wait for a specific agent/chat run to finish
  router.get("/runs/:runId/wait", asyncHandler(async (req, res) => {
    const runId = String(req.params.runId || "").trim();
    const rawTimeout = Number(req.query.timeoutMs);
    const timeoutMs = Number.isFinite(rawTimeout)
      ? Math.max(0, Math.min(30_000, Math.floor(rawTimeout)))
      : 25_000;

    if (!runId) {
      res.status(400).json({ detail: "runId is required" });
      return;
    }

    try {
      const result = await client.request<Record<string, unknown>>("agent.wait", {
        runId,
        timeoutMs,
      });
      res.json({
        runId,
        status: result.status || "timeout",
        startedAt: result.startedAt || null,
        endedAt: result.endedAt || null,
        error: result.error || null,
      });
    } catch (err) {
      res.status(500).json({ detail: (err as Error).message });
    }
  }));

  // POST /api/runs/:runId/abort — 终止某个特定对话的逻辑
  router.post("/sessions/:key(*)/abort-active", asyncHandler(async (req, res) => {
    const sessionKey = toOpenclawSessionKey(req.params.key);
    if (!sessionKey) {
      res.status(400).json({ detail: "sessionKey is required" });
      return;
    }

    try {
      const result = await client.request<Record<string, unknown>>("chat.abort", {
        sessionKey,
      });
      const runIds = Array.isArray(result.runIds) ? result.runIds.map(item => String(item)) : [];
      res.json({
        ok: true,
        aborted: Boolean(result.aborted),
        runIds,
      });
    } catch (err) {
      res.status(500).json({ detail: (err as Error).message });
    }
  }));

  router.post("/runs/:runId/abort", asyncHandler(async (req, res) => {
    const runId = String(req.params.runId || "").trim();
    const rawSessionKey = String(req.body?.sessionKey || "").trim();
    const sessionKey = rawSessionKey ? toOpenclawSessionKey(rawSessionKey) : "";

    if (!runId) {
      res.status(400).json({ detail: "runId is required" });
      return;
    }
    if (!sessionKey) {
      res.status(400).json({ detail: "sessionKey is required" });
      return;
    }

    try {
      const result = await client.request<Record<string, unknown>>("chat.abort", {
        sessionKey,
        runId,
      });
      const runIds = Array.isArray(result.runIds) ? result.runIds.map(item => String(item)) : [];
      res.json({
        ok: true,
        aborted: Boolean(result.aborted),
        runIds,
      });
    } catch (err) {
      res.status(500).json({ detail: (err as Error).message });
    }
  }));

  // DELETE /api/sessions/:key — delete session
  router.delete("/sessions/:key(*)", asyncHandler(async (req, res) => {
    const key = toOpenclawSessionKey(req.params.key);

    try {
      await client.request("sessions.delete", { key });
      res.json({ ok: true });
    } catch (err) {
      const msg = (err as Error).message;
      if (msg.includes("not found") || msg.includes("INVALID_REQUEST")) {
        res.status(404).json({ detail: "Session not found" });
      } else {
        res.status(500).json({ detail: msg });
      }
    }
  }));

  return router;
}
