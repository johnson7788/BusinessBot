import crypto, { randomUUID } from "node:crypto";
import WebSocket from "ws";

export interface GatewayEvent {
  type: "event";
  event: string;
  payload: Record<string, unknown>;
  seq?: number;
}

export interface GatewayResponse {
  type: "res";
  id: string;
  ok: boolean;
  payload?: unknown;
  error?: { code: string; message: string };
}

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

// --- Device identity helpers (Ed25519) ---

function base64UrlEncode(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** SPKI DER prefix for Ed25519 public keys (12 bytes) */
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

function publicKeyRawFromPem(pem: string): Buffer {
  const key = crypto.createPublicKey(pem);
  const der = key.export({ type: "spki", format: "der" });
  // Strip the 12-byte SPKI prefix to get raw 32-byte public key
  return der.subarray(ED25519_SPKI_PREFIX.length);
}

function deriveDeviceId(publicKeyPem: string): string {
  const raw = publicKeyRawFromPem(publicKeyPem);
  return crypto.createHash("sha256").update(raw).digest("hex");
}

function normalizeDeviceMetadata(s: string): string {
  return s.trim().replace(/[A-Z]/g, (c) => c.toLowerCase());
}

interface DeviceIdentity {
  publicKeyPem: string;
  privateKeyPem: string;
  deviceId: string;
  publicKeyBase64Url: string;
}

function generateDeviceIdentity(): DeviceIdentity {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const deviceId = deriveDeviceId(publicKeyPem);
  const publicKeyBase64Url = base64UrlEncode(publicKeyRawFromPem(publicKeyPem));
  return { publicKeyPem, privateKeyPem, deviceId, publicKeyBase64Url };
}

function signPayload(privateKeyPem: string, payload: string): string {
  const key = crypto.createPrivateKey(privateKeyPem);
  const sig = crypto.sign(null, Buffer.from(payload, "utf8"), key);
  return base64UrlEncode(sig);
}

function buildDeviceAuthPayloadV3(params: {
  deviceId: string;
  clientId: string;
  clientMode: string;
  role: string;
  scopes: string[];
  signedAtMs: number;
  token: string;
  nonce: string;
  platform: string;
  deviceFamily: string;
}): string {
  return [
    "v3",
    params.deviceId,
    params.clientId,
    params.clientMode,
    params.role,
    params.scopes.join(","),
    String(params.signedAtMs),
    params.token,
    params.nonce,
    normalizeDeviceMetadata(params.platform),
    normalizeDeviceMetadata(params.deviceFamily),
  ].join("|");
}

// --- Gateway client ---

/**
 * Lightweight gateway client that connects to openclaw gateway via WebSocket.
 * Generates an ephemeral Ed25519 device identity for the connect handshake.
 */
export class BridgeGatewayClient {
  private ws: WebSocket | null = null;
  private pending = new Map<string, PendingRequest>();
  private eventListeners: Array<(evt: GatewayEvent) => void> = [];
  private connected = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private device: DeviceIdentity;

  constructor(
    private url: string,
    private requestTimeoutMs = 60_000,
  ) {
    this.device = generateDeviceIdentity();
  }

  onEvent(listener: (evt: GatewayEvent) => void): void {
    this.eventListeners.push(listener);
  }

  offEvent(listener: (evt: GatewayEvent) => void): void {
    const idx = this.eventListeners.indexOf(listener);
    if (idx !== -1) this.eventListeners.splice(idx, 1);
  }

  isConnected(): boolean {
    return this.connected;
  }

  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.stopped = false;
      this.connect(resolve, reject);
    });
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.connected = false;
    // Reject all pending requests
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error("Client stopped"));
      this.pending.delete(id);
    }
  }

  private connect(onFirstConnect?: (value: void) => void, onFirstError?: (err: Error) => void): void {
    if (this.stopped) return;

    const ws = new WebSocket(this.url, {
      headers: {
        origin: this.url.replace(/^ws:/, "http:").replace(/^wss:/, "https:"),
      },
    });
    this.ws = ws;

    ws.on("open", () => {
      // Wait for connect.challenge event
    });

    ws.on("message", (data) => {
      let frame: Record<string, unknown>;
      try {
        frame = JSON.parse(data.toString());
      } catch {
        return;
      }

      if (frame.type === "event") {
        const evt = frame as unknown as GatewayEvent;

        if (evt.event === "connect.challenge") {
          const nonce = String((evt.payload as Record<string, unknown>).nonce || "").trim();
          const signedAtMs = Date.now();
          const clientId = "openclaw-control-ui";
          const clientMode = "webchat";
          const role = "operator";
          const scopes = ["operator.admin"];
          const platform = process.platform;

          // Build v3 payload and sign with device key
          const payload = buildDeviceAuthPayloadV3({
            deviceId: this.device.deviceId,
            clientId,
            clientMode,
            role,
            scopes,
            signedAtMs,
            token: "",
            nonce,
            platform,
            deviceFamily: platform,
          });
          const signature = signPayload(this.device.privateKeyPem, payload);

          const connectReq = {
            type: "req",
            id: randomUUID(),
            method: "connect",
            params: {
              minProtocol: 3,
              maxProtocol: 3,
              client: {
                id: clientId,
                displayName: "OpenClaw Bridge",
                version: "1.0.0",
                platform,
                mode: clientMode,
                deviceFamily: platform,
              },
              role,
              scopes,
              device: {
                id: this.device.deviceId,
                publicKey: this.device.publicKeyBase64Url,
                signature,
                signedAt: signedAtMs,
                nonce,
              },
            },
          };
          ws.send(JSON.stringify(connectReq));
          return;
        }

        if (evt.event === "connect.ok" || evt.event === "hello") {
          this.connected = true;
          if (onFirstConnect) {
            onFirstConnect();
            onFirstConnect = undefined;
            onFirstError = undefined;
          }
          return;
        }

        // Forward other events to listeners
        for (const listener of this.eventListeners) {
          listener(evt);
        }
      } else if (frame.type === "res") {
        const res = frame as unknown as GatewayResponse;

        // Check if this is the connect response
        if (!this.connected && res.ok) {
          this.connected = true;
          if (onFirstConnect) {
            onFirstConnect();
            onFirstConnect = undefined;
            onFirstError = undefined;
          }
        }

        const pending = this.pending.get(res.id);
        if (pending) {
          clearTimeout(pending.timer);
          this.pending.delete(res.id);
          if (res.ok) {
            pending.resolve(res.payload);
          } else {
            pending.reject(new Error(res.error?.message || "Request failed"));
          }
        }
      }
    });

    ws.on("close", (_code: number, reason: Buffer) => {
      this.connected = false;
      const reasonStr = reason.toString();
      if (onFirstError && !this.stopped) {
        onFirstError(new Error(`WebSocket closed: ${reasonStr}`));
        onFirstConnect = undefined;
        onFirstError = undefined;
      }
      if (!this.stopped) {
        console.log(`[gateway-client] Connection closed (${reasonStr}), reconnecting in 2s...`);
        this.reconnectTimer = setTimeout(() => this.connect(), 2000);
      }
    });

    ws.on("error", (err) => {
      if (onFirstError) {
        onFirstError(err);
        onFirstConnect = undefined;
        onFirstError = undefined;
      }
    });
  }

  async request<T = unknown>(method: string, params?: unknown): Promise<T> {
    if (!this.ws || !this.connected) {
      throw new Error("Gateway client not connected");
    }

    const id = randomUUID();
    const frame = { type: "req", id, method, params: params || {} };

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Request timeout: ${method}`));
      }, this.requestTimeoutMs);

      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      });

      this.ws!.send(JSON.stringify(frame));
    });
  }
}
