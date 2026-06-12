import { DurableObject } from "cloudflare:workers";

export interface Env {
  REALM: DurableObjectNamespace<SingleRealm>;
  REALM_ID: string;
  REALM_TOKEN: string;
  REALM_NAME_PATTERN?: string;
  DEBUG?: string;
}

const SESSION_TTL_MS = 60_000;
const CONNECT_RESPONSE_TIMEOUT_MS = 10_000;
const EVENTS_BUFFER_SIZE = 16;
const MAX_PENDING_ATTEMPTS = EVENTS_BUFFER_SIZE;
const MAX_REQUEST_BODY_BYTES = 4 << 10;
const MAX_ADDRESSES = 8;
const SSE_KEEPALIVE_MS = 15_000;
const NONCE_HEX_LENGTH = 32;
const OBFS_HEX_LENGTH = 64;
const DEFAULT_REALM_NAME_PATTERN = "^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$";

type StoredSession = {
  id: string;
  realmId: string;
  addresses: string[];
  expiresAt: number;
};

type PendingAttempt = {
  resolve: (addresses: string[] | null) => void;
  timer: ReturnType<typeof setTimeout>;
};

type Route =
  | { kind: "register" | "deregister" | "events" | "heartbeat" | "connect"; realmId: string }
  | { kind: "connectResponse"; realmId: string; nonce: string };

type RouteResult =
  | Route
  | { kind: "badRequest"; message: string }
  | { kind: "methodNotAllowed"; realmId: string };

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const id = env.REALM.idFromName("single");
    const stub = env.REALM.get(id);
    return stub.fetch(request);
  },
};

export class SingleRealm extends DurableObject<Env> {
  private session: StoredSession | null = null;
  private eventWriter: WritableStreamDefaultWriter<Uint8Array> | null = null;
  private eventKeepalive: ReturnType<typeof setInterval> | null = null;
  private eventQueue: string[] = [];
  private pending = new Map<string, PendingAttempt>();

  async fetch(request: Request): Promise<Response> {
    const route = parseRoute(new URL(request.url).pathname, request.method);
    if (!route) {
      return errorResponse(404, "not_found", "unknown path");
    }
    if (route.kind === "badRequest") {
      return errorResponse(400, "bad_request", route.message);
    }

    const namePattern = this.env.REALM_NAME_PATTERN || DEFAULT_REALM_NAME_PATTERN;
    if (!new RegExp(namePattern).test(route.realmId)) {
      return errorResponse(400, "bad_request", "invalid realm name");
    }
    if (route.realmId !== this.env.REALM_ID) {
      this.debug(
        "realm id mismatch request_len=%d configured_len=%d",
        route.realmId.length,
        this.env.REALM_ID.length,
      );
      return errorResponse(404, "realm_not_found", "realm not found");
    }
    if (!this.env.REALM_TOKEN) {
      return errorResponse(500, "bad_request", "REALM_TOKEN is not configured");
    }
    if (route.kind === "methodNotAllowed") {
      return errorResponse(405, "bad_request", "method not allowed");
    }

    switch (route.kind) {
      case "register":
        return this.register(request, route.realmId);
      case "deregister":
        return this.deregister(request, route.realmId);
      case "events":
        return this.events(request, route.realmId);
      case "heartbeat":
        return this.heartbeat(request, route.realmId);
      case "connect":
        return this.handleConnect(request, route.realmId);
      case "connectResponse":
        return this.connectResponse(request, route.realmId, route.nonce);
    }
  }

  async alarm(): Promise<void> {
    const session = await this.getSession();
    if (!session) {
      this.debug("alarm fired without session");
      return;
    }
    if (Date.now() > session.expiresAt) {
      await this.clearSession();
      this.debug("session expired realm=%s session=%s", session.realmId, session.id);
    }
  }

  private async register(request: Request, realmId: string): Promise<Response> {
    if (!this.checkRealmToken(request)) {
      this.debug("register unauthorized realm=%s", realmId);
      return errorResponse(401, "invalid_token", "invalid realm token");
    }
    this.debug("register requested realm=%s", realmId);

    const body = await readJson<{ addresses?: unknown }>(request);
    if (body instanceof Response) {
      return body;
    }
    const addresses = body.addresses;
    if (!Array.isArray(addresses) || !addresses.every((value) => typeof value === "string")) {
      return errorResponse(400, "bad_request", "at least one address required");
    }
    const addressError = validateAddresses(addresses);
    if (addressError) {
      return errorResponse(400, "bad_request", addressError);
    }

    const existing = await this.getSession();
    if (existing) {
      this.debug("register replacing existing realm=%s session=%s", realmId, existing.id);
      await this.clearSession();
    }

    const session: StoredSession = {
      id: randomHex(16),
      realmId,
      addresses: [...addresses],
      expiresAt: Date.now() + SESSION_TTL_MS,
    };
    await this.storeSession(session);
    this.eventQueue = [];
    this.debug("registered realm=%s session=%s addresses=%d", realmId, session.id, session.addresses.length);
    return jsonResponse(200, { session_id: session.id, ttl: SESSION_TTL_MS / 1000 });
  }

  private async deregister(request: Request, realmId: string): Promise<Response> {
    const session = await this.requireSession(request, realmId);
    if (session instanceof Response) {
      return session;
    }
    await this.clearSession();
    this.debug("deregistered realm=%s session=%s", realmId, session.id);
    return new Response(null, { status: 204 });
  }

  private async heartbeat(request: Request, realmId: string): Promise<Response> {
    const session = await this.requireSession(request, realmId);
    if (session instanceof Response) {
      return session;
    }

    const body = await readJson<{ addresses?: unknown }>(request, true);
    if (body instanceof Response) {
      return body;
    }
    let addresses = session.addresses;
    if (body.addresses !== undefined) {
      if (!Array.isArray(body.addresses) || !body.addresses.every((value) => typeof value === "string")) {
        return errorResponse(400, "bad_request", "at least one address required");
      }
      const addressError = validateAddresses(body.addresses);
      if (addressError) {
        return errorResponse(400, "bad_request", addressError);
      }
      addresses = [...body.addresses];
    }

    const updated: StoredSession = {
      ...session,
      addresses,
      expiresAt: Date.now() + SESSION_TTL_MS,
    };
    await this.storeSession(updated);
    this.debug("heartbeat realm=%s session=%s addressesUpdated=%s", realmId, session.id, body.addresses !== undefined ? "true" : "false");
    this.sendEvent("heartbeat_ack", { ttl: SESSION_TTL_MS / 1000 });
    return jsonResponse(200, { ttl: SESSION_TTL_MS / 1000 });
  }

  private async events(request: Request, realmId: string): Promise<Response> {
    const session = await this.requireSession(request, realmId);
    if (session instanceof Response) {
      return session;
    }

    const stream = new TransformStream<Uint8Array, Uint8Array>();
    const writer = stream.writable.getWriter();
    this.closeEventWriter();
    this.eventWriter = writer;
    this.eventKeepalive = setInterval(() => {
      if (this.eventWriter !== writer) {
        return;
      }
      writer.write(encode(": keepalive\n\n")).catch((error) => {
        this.debug("events keepalive failed realm=%s session=%s error=%s", realmId, session.id, String(error));
        if (this.eventWriter === writer) {
          this.eventWriter = null;
        }
        this.clearEventKeepalive();
      });
    }, SSE_KEEPALIVE_MS);

    request.signal.addEventListener("abort", () => {
      this.debug("events aborted realm=%s session=%s", realmId, session.id);
      if (this.eventWriter === writer) {
        this.eventWriter = null;
      }
      this.clearEventKeepalive();
      writer.close().catch(() => undefined);
    });

    this.debug("events connected realm=%s session=%s", realmId, session.id);
    this.flushEventWriter(writer, realmId, session.id);
    return new Response(stream.readable, {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
      },
    });
  }

  private async handleConnect(request: Request, realmId: string): Promise<Response> {
    if (!this.checkRealmToken(request)) {
      return errorResponse(401, "invalid_token", "invalid realm token");
    }

    const body = await readJson<{ addresses?: unknown; nonce?: unknown; obfs?: unknown }>(request);
    if (body instanceof Response) {
      return body;
    }
    if (!Array.isArray(body.addresses) || !body.addresses.every((value) => typeof value === "string")) {
      return errorResponse(400, "bad_request", "at least one address required");
    }
    const addressError = validateAddresses(body.addresses);
    if (addressError) {
      return errorResponse(400, "bad_request", addressError);
    }
    if (typeof body.nonce !== "string") {
      return errorResponse(400, "bad_request", `nonce must be ${NONCE_HEX_LENGTH} hex characters`);
    }
    const nonceError = validateHexField("nonce", body.nonce, NONCE_HEX_LENGTH);
    if (nonceError) {
      return errorResponse(400, "bad_request", nonceError);
    }
    if (typeof body.obfs !== "string") {
      return errorResponse(400, "bad_request", `obfs must be ${OBFS_HEX_LENGTH} hex characters`);
    }
    const obfsError = validateHexField("obfs", body.obfs, OBFS_HEX_LENGTH);
    if (obfsError) {
      return errorResponse(400, "bad_request", obfsError);
    }

    const session = await this.getSession();
    if (!session || session.realmId !== realmId) {
      this.debug("connect rejected realm=%s session_present=%s", realmId, session ? "true" : "false");
      return errorResponse(404, "realm_not_found", "realm not registered");
    }
    this.debug("connect requested realm=%s session=%s clientAddresses=%d", realmId, session.id, body.addresses.length);
    if (this.pending.size >= MAX_PENDING_ATTEMPTS || this.pending.has(body.nonce)) {
      return errorResponse(503, "rate_limited", "too many in-flight connect attempts");
    }

    const freshAddresses = new Promise<string[] | null>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(body.nonce as string);
        this.debug("connect response timed out realm=%s session=%s", realmId, session.id);
        resolve([]);
      }, CONNECT_RESPONSE_TIMEOUT_MS);
      this.pending.set(body.nonce as string, { resolve, timer });
    });

    const sent = this.sendEvent("punch", {
      addresses: body.addresses,
      nonce: body.nonce,
      obfs: body.obfs,
    });
    if (!sent) {
      const pending = this.pending.get(body.nonce);
      if (pending) {
        clearTimeout(pending.timer);
        this.pending.delete(body.nonce);
      }
      return errorResponse(503, "rate_limited", "server event buffer full");
    }
    this.debug("connect punch queued realm=%s session=%s serverAddresses=%d", realmId, session.id, session.addresses.length);

    const addresses = await freshAddresses;
    if (addresses === null) {
      this.debug("connect canceled realm=%s session=%s", realmId, session.id);
      return errorResponse(404, "realm_not_found", "realm not registered");
    }
    this.debug("connect returning realm=%s session=%s freshAddresses=%d", realmId, session.id, addresses.length);
    return jsonResponse(200, {
      addresses: addresses.length > 0 ? addresses : session.addresses,
      nonce: body.nonce,
      obfs: body.obfs,
    });
  }

  private async connectResponse(request: Request, realmId: string, nonce: string): Promise<Response> {
    const nonceError = validateHexField("nonce", nonce, NONCE_HEX_LENGTH);
    if (nonceError) {
      return errorResponse(400, "bad_request", nonceError);
    }
    const session = await this.requireSession(request, realmId);
    if (session instanceof Response) {
      return session;
    }

    const body = await readJson<{ addresses?: unknown }>(request);
    if (body instanceof Response) {
      return body;
    }
    if (!Array.isArray(body.addresses) || !body.addresses.every((value) => typeof value === "string")) {
      return errorResponse(400, "bad_request", "at least one address required");
    }
    const addressError = validateAddresses(body.addresses);
    if (addressError) {
      return errorResponse(400, "bad_request", addressError);
    }

    const pending = this.pending.get(nonce);
    if (!pending) {
      this.debug("connect-response no pending realm=%s session=%s", realmId, session.id);
      return errorResponse(404, "attempt_not_found", "no pending attempt for nonce");
    }
    clearTimeout(pending.timer);
    this.pending.delete(nonce);
    pending.resolve([...body.addresses]);
    this.debug("connect-response delivered realm=%s session=%s addresses=%d", realmId, session.id, body.addresses.length);
    return new Response(null, { status: 204 });
  }

  private async requireSession(request: Request, realmId: string): Promise<StoredSession | Response> {
    const session = await this.getSession();
    if (!session || session.realmId !== realmId || bearer(request) !== session.id) {
      return errorResponse(401, "invalid_token", "invalid session token");
    }
    return session;
  }

  private async getSession(): Promise<StoredSession | null> {
    if (this.session && Date.now() > this.session.expiresAt) {
      await this.clearSession();
      return null;
    }
    return this.session;
  }

  private async storeSession(session: StoredSession): Promise<void> {
    this.session = session;
    await this.ctx.storage.setAlarm(session.expiresAt + 1_000);
  }

  private async clearSession(): Promise<void> {
    this.session = null;
    await this.ctx.storage.deleteAlarm();
    for (const [nonce, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.resolve(null);
      this.pending.delete(nonce);
    }
    this.eventQueue = [];
    this.closeEventWriter();
  }

  private closeEventWriter(): void {
    this.clearEventKeepalive();
    const writer = this.eventWriter;
    this.eventWriter = null;
    if (writer) {
      writer.close().catch(() => undefined);
    }
  }

  private async flushEventWriter(
    writer: WritableStreamDefaultWriter<Uint8Array>,
    realmId: string,
    sessionId: string,
  ): Promise<void> {
    try {
      await writer.write(encode(": connected\n\n"));
      while (this.eventWriter === writer && this.eventQueue.length > 0) {
        const event = this.eventQueue.shift();
        if (event) {
          await writer.write(encode(event));
        }
      }
    } catch (error) {
      this.debug("events flush failed realm=%s session=%s error=%s", realmId, sessionId, String(error));
      if (this.eventWriter === writer) {
        this.eventWriter = null;
      }
      this.clearEventKeepalive();
    }
  }

  private clearEventKeepalive(): void {
    if (this.eventKeepalive) {
      clearInterval(this.eventKeepalive);
      this.eventKeepalive = null;
    }
  }

  private sendEvent(kind: string, data: unknown): boolean {
    const payload = `event: ${kind}\ndata: ${JSON.stringify(data)}\n\n`;
    if (this.eventWriter) {
      const writer = this.eventWriter;
      writer.write(encode(payload)).catch((error) => {
        this.debug("event write failed kind=%s error=%s", kind, String(error));
        if (this.eventWriter === writer) {
          this.eventWriter = null;
        }
      });
      return true;
    }
    if (this.eventQueue.length >= EVENTS_BUFFER_SIZE) {
      return false;
    }
    this.eventQueue.push(payload);
    return true;
  }

  private checkRealmToken(request: Request): boolean {
    return bearer(request) === this.env.REALM_TOKEN;
  }

  private debug(message: string, ...args: unknown[]): void {
    if (this.env.DEBUG === "true") {
      console.log(message, ...args);
    }
  }
}

function parseRoute(pathname: string, method: string): RouteResult | null {
  const parts = pathname.split("/").filter(Boolean);
  if (parts.length < 2 || parts[0] !== "v1") {
    return null;
  }
  let realmId: string;
  try {
    realmId = decodeURIComponent(parts[1]);
  } catch {
    return { kind: "badRequest", message: "invalid realm name" };
  }
  if (parts.length === 2) {
    if (method === "POST") {
      return { kind: "register", realmId };
    }
    if (method === "DELETE") {
      return { kind: "deregister", realmId };
    }
    return { kind: "methodNotAllowed", realmId };
  }
  if (parts.length === 3) {
    if (parts[2] === "events") {
      return method === "GET" ? { kind: "events", realmId } : { kind: "methodNotAllowed", realmId };
    }
    if (parts[2] === "heartbeat") {
      return method === "POST" ? { kind: "heartbeat", realmId } : { kind: "methodNotAllowed", realmId };
    }
    if (parts[2] === "connect") {
      return method === "POST" ? { kind: "connect", realmId } : { kind: "methodNotAllowed", realmId };
    }
  }
  if (parts.length === 4 && parts[2] === "connects") {
    return method === "POST"
      ? { kind: "connectResponse", realmId, nonce: parts[3] }
      : { kind: "methodNotAllowed", realmId };
  }
  return null;
}

async function readJson<T>(request: Request, allowEmpty = false): Promise<T | Response> {
  const bytes = await request.arrayBuffer();
  if (bytes.byteLength > MAX_REQUEST_BODY_BYTES) {
    return errorResponse(400, "bad_request", "request body too large");
  }
  if (bytes.byteLength === 0 && allowEmpty) {
    return {} as T;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as T;
  } catch {
    return errorResponse(400, "bad_request", "invalid json");
  }
}

function validateAddresses(addresses: string[]): string | null {
  if (addresses.length === 0) {
    return "at least one address required";
  }
  if (addresses.length > MAX_ADDRESSES) {
    return `too many addresses (max ${MAX_ADDRESSES})`;
  }
  for (const address of addresses) {
    if (!isAddressPort(address)) {
      return `invalid address: ${address}`;
    }
  }
  return null;
}

function isAddressPort(value: string): boolean {
  let host = "";
  let portText = "";
  if (value.startsWith("[")) {
    const end = value.indexOf("]");
    if (end < 0 || value[end + 1] !== ":") {
      return false;
    }
    host = value.slice(1, end);
    portText = value.slice(end + 2);
  } else {
    const colon = value.lastIndexOf(":");
    if (colon <= 0 || value.indexOf(":") !== colon) {
      return false;
    }
    host = value.slice(0, colon);
    portText = value.slice(colon + 1);
  }

  if (!/^\d+$/.test(portText)) {
    return false;
  }
  const port = Number(portText);
  return Number.isInteger(port) && port >= 0 && port <= 65535 && (isIPv4(host) || isIPv6(host));
}

function isIPv4(value: string): boolean {
  const parts = value.split(".");
  return parts.length === 4 && parts.every((part) => {
    if (!/^\d{1,3}$/.test(part)) {
      return false;
    }
    const octet = Number(part);
    return octet >= 0 && octet <= 255 && String(octet) === part;
  });
}

function isIPv6(value: string): boolean {
  if (!value.includes(":")) {
    return false;
  }
  try {
    new URL(`http://[${value}]/`);
    return true;
  } catch {
    return false;
  }
}

function validateHexField(name: string, value: string, length: number): string | null {
  if (value.length !== length) {
    return `${name} must be ${length} hex characters`;
  }
  if (!/^[0-9a-fA-F]+$/.test(value)) {
    return `${name} must be valid hex`;
  }
  return null;
}

function bearer(request: Request): string {
  const header = request.headers.get("Authorization") || "";
  return header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
}

function jsonResponse(status: number, value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function errorResponse(status: number, code: string, message: string): Response {
  return jsonResponse(status, { error: code, message });
}

function randomHex(bytes: number): string {
  const data = new Uint8Array(bytes);
  crypto.getRandomValues(data);
  return [...data].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function encode(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}
