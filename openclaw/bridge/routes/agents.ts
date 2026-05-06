import { Router } from "express";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { BridgeGatewayClient } from "../gateway-client.js";
import { asyncHandler } from "../utils.js";

function hashText(input: string): number {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function escapeXml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const TEMP_ICON_DIR = path.join(os.tmpdir(), "openclaw-agent-icons");
const TEMP_ICON_TTL_MS = 24 * 60 * 60 * 1000;

function isSafeIconId(input: string): boolean {
  return /^[a-z0-9_-]{12,64}$/i.test(input);
}

async function cleanupOldTempIcons(): Promise<void> {
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(TEMP_ICON_DIR, { withFileTypes: true });
  } catch {
    return;
  }
  const now = Date.now();
  await Promise.all(entries.map(async (entry) => {
    if (!entry.isFile() || !entry.name.endsWith(".svg")) return;
    const filePath = path.join(TEMP_ICON_DIR, entry.name);
    try {
      const stat = await fs.promises.stat(filePath);
      if (now - stat.mtimeMs > TEMP_ICON_TTL_MS) {
        await fs.promises.rm(filePath, { force: true });
      }
    } catch {
      // Best-effort cleanup only.
    }
  }));
}

async function deleteTempIcon(iconId: string | undefined): Promise<void> {
  if (!iconId || !isSafeIconId(iconId)) return;
  await fs.promises.rm(path.join(TEMP_ICON_DIR, `${iconId}.svg`), { force: true }).catch(() => {});
}

function createTempIconId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

function resolveRole(text: string): "teacher" | "developer" | "doctor" | "researcher" | "writer" | "manager" | "assistant" {
  const lower = text.toLowerCase();
  if (/english|英语|grammar|语法|pronunciation|发音|language|语言|teacher|老师/.test(lower)) return "teacher";
  if (/code|程序|开发|编程|program|developer|工程/.test(lower)) return "developer";
  if (/doctor|医疗|医生|health|诊断|病|clinic/.test(lower)) return "doctor";
  if (/research|研究|论文|资料|搜索|学术/.test(lower)) return "researcher";
  if (/write|写作|文案|润色|编辑|内容/.test(lower)) return "writer";
  if (/manager|管理|计划|项目|协调|运营/.test(lower)) return "manager";
  return "assistant";
}

function buildAgentIconSvg(name: string, description: string, seed?: string): string {
  const palette = [
    ["#0891b2", "#22c55e"],
    ["#2563eb", "#06b6d4"],
    ["#7c3aed", "#ec4899"],
    ["#16a34a", "#84cc16"],
    ["#dc2626", "#f97316"],
    ["#0f766e", "#14b8a6"],
  ];
  const source = `${name}\n${description}\n${seed || ""}`;
  const hash = hashText(source);
  const [primary, secondary] = palette[hash % palette.length];
  const role = resolveRole(`${name} ${description}`);
  const skin = ["#f7c59f", "#e8b48a", "#d99a72", "#f1d0b5"][hash % 4];
  const hair = ["#293241", "#3d2c2e", "#4a3428", "#1f2937"][(hash >>> 3) % 4];
  const shirt = ["#ffffff", "#ecfeff", "#f8fafc", "#eef2ff"][(hash >>> 5) % 4];
  const accent = secondary;
  const accessory =
    role === "teacher"
      ? `<path d="M34 80h17v9H34z" fill="#fff" opacity=".9"/><path d="M37 83h11" stroke="${primary}" stroke-width="2" stroke-linecap="round"/>`
      : role === "developer"
        ? `<rect x="72" y="70" width="20" height="14" rx="3" fill="#0f172a" opacity=".84"/><path d="M78 75l-3 2 3 2M86 75l3 2-3 2" stroke="#fff" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>`
        : role === "doctor"
          ? `<path d="M79 69v16a9 9 0 0 1-18 0v-3" fill="none" stroke="#fff" stroke-width="4" stroke-linecap="round"/><circle cx="61" cy="82" r="4" fill="#fff"/>`
          : role === "researcher"
            ? `<circle cx="83" cy="77" r="8" fill="none" stroke="#fff" stroke-width="4"/><path d="M89 83l7 7" stroke="#fff" stroke-width="4" stroke-linecap="round"/>`
            : role === "writer"
              ? `<path d="M78 67l13 13-14 6-5-5z" fill="#fff" opacity=".92"/><path d="M76 83l-3 7 7-3" fill="${accent}"/>`
              : role === "manager"
                ? `<path d="M78 68h16v22H78z" fill="#fff" opacity=".9"/><path d="M82 75h8M82 82h8" stroke="${primary}" stroke-width="2" stroke-linecap="round"/>`
                : `<circle cx="84" cy="78" r="9" fill="#fff" opacity=".9"/><path d="M80 78h8M84 74v8" stroke="${primary}" stroke-width="2.4" stroke-linecap="round"/>`;

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120" role="img" aria-label="${escapeXml(name || "Agent")} icon">
  <defs>
    <linearGradient id="g" x1="18" y1="12" x2="102" y2="108" gradientUnits="userSpaceOnUse">
      <stop stop-color="${primary}"/>
      <stop offset="1" stop-color="${secondary}"/>
    </linearGradient>
    <filter id="s" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="8" stdDeviation="8" flood-color="${primary}" flood-opacity=".22"/>
    </filter>
    <clipPath id="r"><rect x="14" y="14" width="92" height="92" rx="28"/></clipPath>
  </defs>
  <rect x="14" y="14" width="92" height="92" rx="28" fill="url(#g)" filter="url(#s)"/>
  <g clip-path="url(#r)">
    <circle cx="30" cy="30" r="18" fill="rgba(255,255,255,.16)"/>
    <circle cx="96" cy="96" r="30" fill="rgba(255,255,255,.13)"/>
    <path d="M33 112c4-24 18-37 36-37s32 13 36 37" fill="${shirt}" opacity=".96"/>
    <path d="M43 112c5-18 14-27 26-27s21 9 26 27" fill="${accent}" opacity=".2"/>
    <circle cx="60" cy="48" r="24" fill="${skin}"/>
    <path d="M36 47c2-19 13-31 31-31 14 0 24 8 28 21-10-3-19-9-26-17-8 12-18 20-33 27z" fill="${hair}"/>
    <circle cx="51" cy="52" r="2.3" fill="#1f2937"/>
    <circle cx="69" cy="52" r="2.3" fill="#1f2937"/>
    <path d="M53 63c4 4 10 4 14 0" stroke="#7f1d1d" stroke-width="2.4" stroke-linecap="round" fill="none"/>
    <path d="M44 45c-4 1-7 5-6 10 1 4 4 7 8 7" fill="${skin}" opacity=".96"/>
    <path d="M76 45c4 1 7 5 6 10-1 4-4 7-8 7" fill="${skin}" opacity=".96"/>
    ${accessory}
  </g>
</svg>`;
}

export function agentsRoutes(client: BridgeGatewayClient): Router {
  const router = Router();

  // GET /api/agents — list agents
  router.get("/agents", asyncHandler(async (_req, res) => {
    try {
      const result = await client.request<unknown[]>("agents.list", {});
      res.json(result || []);
    } catch (err) {
      res.status(500).json({ detail: (err as Error).message });
    }
  }));

  // POST /api/agents — create agent
  router.post("/agents", asyncHandler(async (req, res) => {
    const { name, workspace, emoji, avatar } = req.body;

    try {
      const defaultWorkspace = `~/.openclaw/workspace-${name}`;
      const params: Record<string, unknown> = { name, workspace: workspace || defaultWorkspace };
      if (emoji !== undefined) params.emoji = emoji;
      if (avatar !== undefined) params.avatar = avatar;

      const result = await client.request<Record<string, unknown>>("agents.create", params);
      res.json(result);
    } catch (err) {
      res.status(500).json({ detail: (err as Error).message });
    }
  }));

  // POST /api/agents/icon — generate a lightweight SVG avatar from agent text
  router.post("/agents/icon", asyncHandler(async (req, res) => {
    const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
    const description = typeof req.body?.description === "string" ? req.body.description.trim() : "";
    const seed = typeof req.body?.seed === "string" ? req.body.seed.trim() : "";
    const previousIconId = typeof req.body?.previousIconId === "string" ? req.body.previousIconId.trim() : "";
    await fs.promises.mkdir(TEMP_ICON_DIR, { recursive: true });
    await Promise.all([cleanupOldTempIcons(), deleteTempIcon(previousIconId)]);
    const svg = buildAgentIconSvg(name, description, seed);
    const iconId = createTempIconId();
    await fs.promises.writeFile(path.join(TEMP_ICON_DIR, `${iconId}.svg`), svg, "utf-8");
    res.json({
      id: iconId,
      url: `/api/agents/icon/temp/${iconId}.svg`,
      expiresInMs: TEMP_ICON_TTL_MS,
    });
  }));

  router.get("/agents/icon/temp/:iconId.svg", asyncHandler(async (req, res) => {
    const iconId = req.params.iconId;
    if (!isSafeIconId(iconId)) {
      res.status(404).end();
      return;
    }
    const filePath = path.join(TEMP_ICON_DIR, `${iconId}.svg`);
    try {
      const svg = await fs.promises.readFile(filePath, "utf-8");
      res.setHeader("content-type", "image/svg+xml; charset=utf-8");
      res.setHeader("cache-control", "no-store");
      res.send(svg);
    } catch {
      res.status(404).end();
    }
  }));

  // PUT /api/agents/:agentId — update agent
  router.put("/agents/:agentId", asyncHandler(async (req, res) => {
    const { name, workspace, model, avatar } = req.body;

    try {
      const params: Record<string, unknown> = { agentId: req.params.agentId };
      if (name !== undefined) params.name = name;
      if (workspace !== undefined) params.workspace = workspace;
      if (model !== undefined) params.model = model;
      if (avatar !== undefined) params.avatar = avatar;

      const result = await client.request<Record<string, unknown>>("agents.update", params);
      res.json(result);
    } catch (err) {
      const msg = (err as Error).message;
      if (msg.includes("not found")) {
        res.status(404).json({ detail: "Agent not found" });
      } else {
        res.status(500).json({ detail: msg });
      }
    }
  }));

  // DELETE /api/agents/:agentId — delete agent
  router.delete("/agents/:agentId", asyncHandler(async (req, res) => {
    const deleteFiles = req.query.delete_files === "true";
    const agentId = req.params.agentId;

    try {
      await client.request("agents.delete", {
        agentId,
        deleteFiles,
      });
      res.json({ ok: true });
    } catch (err) {
      const msg = (err as Error).message;
      if (msg.includes("not found")) {
        // Gateway only knows about agents in openclaw.json config, but agents
        // can also be discovered from disk (workspace-<id> directories).
        // If the gateway says "not found", try to clean up the disk-only agent.
        const openclawHome = process.env.OPENCLAW_STATE_DIR || path.join(os.homedir(), ".openclaw");
        const workspaceDir = path.join(openclawHome, `workspace-${agentId}`);
        const agentDir = path.join(openclawHome, "agents", agentId);
        let cleaned = false;

        for (const dir of [workspaceDir, agentDir]) {
          try {
            await fs.promises.access(dir);
            await fs.promises.rm(dir, { recursive: true, force: true });
            cleaned = true;
          } catch {
            // Directory doesn't exist or can't be removed — skip
          }
        }

        if (cleaned) {
          res.json({ ok: true, diskOnly: true });
        } else {
          res.status(404).json({ detail: "Agent not found" });
        }
      } else {
        res.status(500).json({ detail: msg });
      }
    }
  }));

  // GET /api/agents/:agentId/files — list agent files
  router.get("/agents/:agentId/files", asyncHandler(async (req, res) => {
    try {
      const result = await client.request<unknown[]>("agents.files.list", {
        agentId: req.params.agentId,
      });
      res.json(result || []);
    } catch (err) {
      const msg = (err as Error).message;
      if (msg.includes("not found")) {
        res.status(404).json({ detail: "Agent not found" });
      } else {
        res.status(500).json({ detail: msg });
      }
    }
  }));

  // GET /api/agents/:agentId/files/:name — get agent file
  router.get("/agents/:agentId/files/:name", asyncHandler(async (req, res) => {
    try {
      const result = await client.request<Record<string, unknown>>("agents.files.get", {
        agentId: req.params.agentId,
        name: req.params.name,
      });
      res.json(result);
    } catch (err) {
      const msg = (err as Error).message;
      if (msg.includes("not found")) {
        res.status(404).json({ detail: "File not found" });
      } else {
        res.status(500).json({ detail: msg });
      }
    }
  }));

  // PUT /api/agents/:agentId/files/:name — set agent file
  router.put("/agents/:agentId/files/:name", asyncHandler(async (req, res) => {
    const { content } = req.body;

    try {
      const result = await client.request<Record<string, unknown>>("agents.files.set", {
        agentId: req.params.agentId,
        name: req.params.name,
        content,
      });
      res.json(result);
    } catch (err) {
      const msg = (err as Error).message;
      if (msg.includes("not found")) {
        res.status(404).json({ detail: "Agent not found" });
      } else {
        res.status(500).json({ detail: msg });
      }
    }
  }));

  // GET /api/models — list available models from gateway + configured model
  router.get("/models", asyncHandler(async (_req, res) => {
    try {
      // Get models from gateway RPC
      const result = await client.request<{ models: Array<{ id: string; name: string; provider: string; contextWindow?: number; reasoning?: boolean }> }>(
        "models.list",
        {},
      );

      // Read openclaw.json to find the configured/default model
      const openclawHome = process.env.OPENCLAW_STATE_DIR || path.join(os.homedir(), ".openclaw");
      const configPath = path.join(openclawHome, "openclaw.json");
      let configuredModel = "";
      let configuredProviders: Record<string, unknown> = {};

      if (fs.existsSync(configPath)) {
        try {
          const cfg = JSON.parse(fs.readFileSync(configPath, "utf-8"));
          configuredModel = cfg?.agents?.defaults?.model || "";
          configuredProviders = cfg?.models?.providers || {};
        } catch { /* ignore parse errors */ }
      }

      // Only expose the system default model in platform-proxy to the frontend UI.
      // Use the env var (fixed at container start) so users can always switch back.
      if (configuredProviders["platform-proxy"]) {
        const pp = configuredProviders["platform-proxy"] as Record<string, unknown>;
        if (Array.isArray(pp.models) && pp.models.length > 0) {
          const envModel = process.env.NANOBOT_AGENTS__DEFAULTS__MODEL || "";
          pp.models = pp.models.filter((m: { id?: string }) => m.id === envModel);
        }
      }

      res.json({
        models: result?.models || [],
        configuredModel,
        configuredProviders,
      });
    } catch (err) {
      res.status(500).json({ detail: (err as Error).message });
    }
  }));

  // PUT /api/models/config — update models config in openclaw.json
  router.put("/models/config", asyncHandler(async (req, res) => {
    const { providers, defaultModel } = req.body;

    const openclawHome = process.env.OPENCLAW_STATE_DIR || path.join(os.homedir(), ".openclaw");
    const configPath = path.join(openclawHome, "openclaw.json");

    let cfg: Record<string, unknown> = {};
    if (fs.existsSync(configPath)) {
      try {
        cfg = JSON.parse(fs.readFileSync(configPath, "utf-8"));
      } catch { /* start fresh */ }
    }

    // Update providers if provided
    if (providers !== undefined) {
      if (!cfg.models || typeof cfg.models !== "object") {
        cfg.models = { mode: "replace", providers: {} };
      }
      (cfg.models as Record<string, unknown>).providers = providers;
    }

    // Update default model if provided
    if (defaultModel !== undefined) {
      if (!cfg.agents || typeof cfg.agents !== "object") {
        cfg.agents = { defaults: {} };
      }
      const agents = cfg.agents as Record<string, unknown>;
      if (!agents.defaults || typeof agents.defaults !== "object") {
        agents.defaults = {};
      }
      (agents.defaults as Record<string, unknown>).model = defaultModel;
    }

    fs.mkdirSync(openclawHome, { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2), "utf-8");
    res.json({ ok: true });
  }));

  return router;
}
