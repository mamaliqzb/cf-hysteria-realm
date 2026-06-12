import { describe, expect, it, vi } from "vitest";
import { SingleRealm, type Env } from "../src/index";

const REALM_ID = "example";
const REALM_TOKEN = "realm-token";
const NONCE = "00112233445566778899aabbccddeeff";
const OBFS = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";

class MemoryStorage {
  private values = new Map<string, unknown>();
  alarmAt: number | null = null;

  async get<T>(key: string): Promise<T | undefined> {
    return this.values.get(key) as T | undefined;
  }

  async put(key: string, value: unknown): Promise<void> {
    this.values.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.values.delete(key);
  }

  async setAlarm(value: number): Promise<void> {
    this.alarmAt = value;
  }

  async deleteAlarm(): Promise<void> {
    this.alarmAt = null;
  }
}

function createRealm(storage = new MemoryStorage()): SingleRealm {
  const ctx = { storage } as unknown as DurableObjectState;
  const env = {
    REALM: {} as DurableObjectNamespace<SingleRealm>,
    REALM_ID,
    REALM_TOKEN,
    DEBUG: "false",
  } satisfies Env;
  return new SingleRealm(ctx, env);
}

function auth(token: string): HeadersInit {
  return { Authorization: `Bearer ${token}` };
}

function request(method: string, path: string, token = REALM_TOKEN, body?: unknown): Request {
  return new Request(`https://realm.test${path}`, {
    method,
    headers: {
      ...auth(token),
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function json<T>(response: Response): Promise<T> {
  return response.json() as Promise<T>;
}

async function register(realm: SingleRealm, addresses = ["203.0.113.10:4433"]): Promise<string> {
  const response = await realm.fetch(request("POST", `/v1/${REALM_ID}`, REALM_TOKEN, { addresses }));
  expect(response.status).toBe(200);
  const body = await json<{ session_id: string }>(response);
  return body.session_id;
}

describe("SingleRealm protocol", () => {
  it("returns 400 instead of throwing for malformed realm names", async () => {
    const realm = createRealm();

    const response = await realm.fetch(request("POST", "/v1/%E0%A4%A", REALM_TOKEN, {
      addresses: ["203.0.113.10:4433"],
    }));
    const body = await json<{ error: string; message: string }>(response);

    expect(response.status).toBe(400);
    expect(body).toEqual({ error: "bad_request", message: "invalid realm name" });
  });

  it("returns 405 for known paths with unsupported methods", async () => {
    const realm = createRealm();

    const response = await realm.fetch(request("POST", `/v1/${REALM_ID}/events`));
    const body = await json<{ error: string; message: string }>(response);

    expect(response.status).toBe(405);
    expect(body).toEqual({ error: "bad_request", message: "method not allowed" });
  });

  it("updates cached addresses through heartbeat and returns them on connect fallback", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-30T00:00:00.000Z"));
    try {
      const realm = createRealm();
      const sessionId = await register(realm);

      const heartbeat = await realm.fetch(request("POST", `/v1/${REALM_ID}/heartbeat`, sessionId, {
        addresses: ["203.0.113.11:4433"],
      }));
      expect(heartbeat.status).toBe(200);

      const connect = realm.fetch(request("POST", `/v1/${REALM_ID}/connect`, REALM_TOKEN, {
        addresses: ["198.51.100.20:4433"],
        nonce: NONCE,
        obfs: OBFS,
      }));

      await vi.advanceTimersByTimeAsync(10_000);

      const response = await connect;
      const body = await json<{ addresses: string[]; nonce: string; obfs: string }>(response);

      expect(response.status).toBe(200);
      expect(body).toEqual({
        addresses: ["203.0.113.11:4433"],
        nonce: NONCE,
        obfs: OBFS,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("waits for connect-response and returns fresh addresses", async () => {
    const realm = createRealm();
    const sessionId = await register(realm, ["203.0.113.10:4433"]);

    const connect = realm.fetch(request("POST", `/v1/${REALM_ID}/connect`, REALM_TOKEN, {
      addresses: ["198.51.100.20:4433"],
      nonce: NONCE,
      obfs: OBFS,
    }));

    await vi.waitFor(async () => {
      const response = await realm.fetch(request("POST", `/v1/${REALM_ID}/connects/${NONCE}`, sessionId, {
        addresses: ["198.51.100.1:9999"],
      }));
      expect(response.status).toBe(204);
    });

    const response = await connect;
    const body = await json<{ addresses: string[]; nonce: string; obfs: string }>(response);

    expect(response.status).toBe(200);
    expect(body).toEqual({
      addresses: ["198.51.100.1:9999"],
      nonce: NONCE,
      obfs: OBFS,
    });
  });

  it("rejects unknown connect-response nonces", async () => {
    const realm = createRealm();
    const sessionId = await register(realm);

    const response = await realm.fetch(request("POST", `/v1/${REALM_ID}/connects/${NONCE}`, sessionId, {
      addresses: ["198.51.100.1:9999"],
    }));
    const body = await json<{ error: string }>(response);

    expect(response.status).toBe(404);
    expect(body.error).toBe("attempt_not_found");
  });

  it("allows duplicate registration when no event stream is attached", async () => {
    const realm = createRealm();
    await register(realm);

    const response = await realm.fetch(request("POST", `/v1/${REALM_ID}`, REALM_TOKEN, {
      addresses: ["203.0.113.11:4433"],
    }));

    expect(response.status).toBe(200);
  });

  it("replaces an active session when registering with the realm token", async () => {
    const realm = createRealm();
    const sessionId = await register(realm);
    const events = await realm.fetch(request("GET", `/v1/${REALM_ID}/events`, sessionId));
    expect(events.status).toBe(200);

    const response = await realm.fetch(request("POST", `/v1/${REALM_ID}`, REALM_TOKEN, {
      addresses: ["203.0.113.11:4433"],
    }));
    const body = await json<{ session_id: string }>(response);

    expect(response.status).toBe(200);
    expect(body.session_id).not.toBe(sessionId);

    const heartbeat = await realm.fetch(request("POST", `/v1/${REALM_ID}/heartbeat`, sessionId, {
      addresses: ["203.0.113.10:4433"],
    }));
    expect(heartbeat.status).toBe(401);
    await events.body?.cancel();
  });

  it("cancels in-flight connects when a new registration replaces the session", async () => {
    const realm = createRealm();
    await register(realm);

    const connect = realm.fetch(request("POST", `/v1/${REALM_ID}/connect`, REALM_TOKEN, {
      addresses: ["198.51.100.20:4433"],
      nonce: NONCE,
      obfs: OBFS,
    }));

    const registerResponse = await realm.fetch(request("POST", `/v1/${REALM_ID}`, REALM_TOKEN, {
      addresses: ["203.0.113.11:4433"],
    }));
    expect(registerResponse.status).toBe(200);

    const response = await connect;
    const body = await json<{ error: string; message: string }>(response);

    expect(response.status).toBe(404);
    expect(body).toEqual({ error: "realm_not_found", message: "realm not registered" });
  });

  it("does not restore sessions from Durable Object storage after a new instance starts", async () => {
    const storage = new MemoryStorage();
    const firstRealm = createRealm(storage);
    await register(firstRealm, ["203.0.113.10:4433"]);

    const restartedRealm = createRealm(storage);
    const response = await restartedRealm.fetch(request("POST", `/v1/${REALM_ID}`, REALM_TOKEN, {
      addresses: ["203.0.113.11:4433"],
    }));

    expect(response.status).toBe(200);
  });
});
