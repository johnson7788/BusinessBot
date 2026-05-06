import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { loadConfig, writeOpenclawConfig } from "./config.js";
import { BridgeGatewayClient } from "./gateway-client.js";
import { createServer } from "./server.js";
import {
  buildGatewayEnv,
  connectClientWithRetry,
  formatStartupDuration,
  formatStartupStartedAt,
} from "./startup.js";

function resolveGatewayCommand(openclawDir: string): { cmd: string; args: string[] } {
  // In production (Docker), dist/ exists → use node openclaw.mjs directly
  const distEntry = path.join(openclawDir, "dist", "entry.js");
  const openclawMjs = path.join(openclawDir, "openclaw.mjs");

  if (fs.existsSync(distEntry)) {
    return { cmd: process.execPath, args: [openclawMjs] };
  }

  // In dev mode, use scripts/run-node.mjs which auto-builds then runs
  const runNode = path.join(openclawDir, "scripts", "run-node.mjs");
  if (fs.existsSync(runNode)) {
    console.log("[bridge] Dev mode: using run-node.mjs (will auto-build if needed)");
    return { cmd: process.execPath, args: [runNode] };
  }

  // Fallback: try node openclaw.mjs anyway
  return { cmd: process.execPath, args: [openclawMjs] };
}

/**
 * Manages the gateway child process lifecycle, including restart support.
 */
class GatewayManager {
  private proc: ChildProcess | null = null;
  private restarting = false;
  private readonly openclawDir: string;
  private readonly gatewayCmd: string;
  private readonly gatewayArgs: string[];
  private readonly gatewayEnv: Record<string, string | undefined>;
  private readonly gatewayUrl: string;

  client: BridgeGatewayClient;

  constructor(
    openclawDir: string,
    cmd: string,
    args: string[],
    env: Record<string, string | undefined>,
    gatewayUrl: string,
  ) {
    this.openclawDir = openclawDir;
    this.gatewayCmd = cmd;
    this.gatewayArgs = args;
    this.gatewayEnv = env;
    this.gatewayUrl = gatewayUrl;
    this.client = new BridgeGatewayClient(gatewayUrl);
  }

  async start(): Promise<void> {
    this.spawnGateway();
    await connectClientWithRetry(this.client, { maxWaitMs: 180_000 });
    console.log("[bridge] Gateway is ready and connected");
  }

  private spawnGateway(): void {
    console.log(`[bridge] Starting openclaw gateway: ${this.gatewayCmd} ${this.gatewayArgs.join(" ")}`);
    const proc = spawn(this.gatewayCmd, this.gatewayArgs, {
      cwd: this.openclawDir,
      stdio: ["ignore", "pipe", "pipe"],
      env: this.gatewayEnv,
    });

    proc.stdout?.on("data", (data: Buffer) => {
      process.stdout.write(`[gateway] ${data}`);
    });
    proc.stderr?.on("data", (data: Buffer) => {
      process.stderr.write(`[gateway] ${data}`);
    });
    proc.on("exit", (code) => {
      console.error(`[bridge] Gateway process exited with code ${code}`);
      if (!this.restarting && code !== 0) process.exit(1);
    });

    this.proc = proc;
  }

  async restart(): Promise<void> {
    if (this.restarting) throw new Error("Already restarting");
    this.restarting = true;
    console.log("[bridge] Restarting gateway...");

    try {
      // Disconnect bridge client
      this.client.stop();

      // Kill old gateway process
      if (this.proc && !this.proc.killed) {
        this.proc.kill("SIGTERM");
        // Wait for exit (up to 10s)
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            if (this.proc && !this.proc.killed) this.proc.kill("SIGKILL");
            resolve();
          }, 10_000);
          this.proc?.on("exit", () => { clearTimeout(timer); resolve(); });
        });
      }

      // Re-read and write config (may have changed via settings API)
      const config = loadConfig();
      writeOpenclawConfig(config);
      console.log("[bridge] Refreshed openclaw config");

      // Spawn new gateway
      this.spawnGateway();

      // Reconnect bridge client with retry until the gateway is ready
      this.client = new BridgeGatewayClient(this.gatewayUrl);
      await connectClientWithRetry(this.client, { maxWaitMs: 180_000 });
      console.log("[bridge] Gateway restarted and reconnected");
    } finally {
      this.restarting = false;
    }
  }

  shutdown(): void {
    this.client.stop();
    if (this.proc && !this.proc.killed) this.proc.kill("SIGTERM");
  }
}

// Export for use by settings route
export let gatewayManager: GatewayManager | null = null;

async function main(): Promise<void> {
  const startupStartedAt = new Date();
  const startupStartedMs = Date.now();
  console.log(`[bridge] Starting openclaw bridge at ${formatStartupStartedAt(startupStartedAt)}...`);

  const config = loadConfig();

  // Write openclaw config for platform proxy integration
  writeOpenclawConfig(config);
  console.log("[bridge] Wrote openclaw config");

  // Resolve openclaw project directory (bridge/ is inside openclaw/)
  const openclawDir = process.env.OPENCLAW_DIR || path.resolve(process.cwd());

  // Ensure openclaw node_modules exist (should exist in Docker image)
  const nodeModulesDir = path.join(openclawDir, "node_modules");
  if (!fs.existsSync(nodeModulesDir)) {
    console.error("[bridge] CRITICAL: node_modules not found! Docker image may be corrupted.");
    console.error("[bridge] Please rebuild the Docker image using: python deploy_docker.py --rebuild openclaw");
    process.exit(1);
  }

  // Start openclaw gateway as a child process
  const { cmd: gatewayCmd, args: gatewayBaseArgs } = resolveGatewayCommand(openclawDir);
  const gatewayArgs = [
    ...gatewayBaseArgs,
    "gateway", "run",
    "--port", String(config.gatewayPort),
    "--bind", "loopback",
    "--force",
  ];

  const gatewayUrl = `ws://127.0.0.1:${config.gatewayPort}`;
  const manager = new GatewayManager(
    openclawDir,
    gatewayCmd,
    gatewayArgs,
    buildGatewayEnv(process.env, config),
    gatewayUrl,
  );

  gatewayManager = manager;

  console.log(`[bridge] Waiting for gateway at ${gatewayUrl}...`);
  await manager.start();

  // Start bridge HTTP server
  const server = createServer(manager.client, config, manager);
  server.listen(config.bridgePort, "0.0.0.0", () => {
    const startupDurationMs = Date.now() - startupStartedMs;
    console.log(`[bridge] Bridge server listening on port ${config.bridgePort}`);
    console.log(`[bridge] Startup completed in ${formatStartupDuration(startupDurationMs)}`);
  });

  // Graceful shutdown
  const shutdown = () => {
    console.log("[bridge] Shutting down...");
    manager.shutdown();
    server.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("[bridge] Fatal error:", err);
  process.exit(1);
});
