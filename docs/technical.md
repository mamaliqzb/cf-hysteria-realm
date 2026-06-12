# Technical Docs

Technical details for `cf-hysteria-realm`.

## Architecture

This is a Cloudflare Workers + Durable Object implementation of the Hysteria Realm rendezvous API. It intentionally supports one configured realm per deployment. Deploy another Worker instance when you need another realm.

The Worker only coordinates rendezvous and UDP hole punching metadata. It does not proxy or relay Hysteria traffic.

The Durable Object is configured with a SQLite-backed class via `new_sqlite_classes`.

## API

The Worker keeps the same path shape as `hysteria-realm-server`. `{id}` must match the configured `REALM_ID`.

- `POST /v1/{id}`
- `GET /v1/{id}/events`
- `POST /v1/{id}/heartbeat`
- `DELETE /v1/{id}`
- `POST /v1/{id}/connect`
- `POST /v1/{id}/connects/{nonce}`

Responses with bodies are JSON. Errors use this shape:

```json
{
  "error": "bad_request",
  "message": "invalid json"
}
```

## Authentication

There are two bearer tokens:

| Token | Used by |
| --- | --- |
| `REALM_TOKEN` | `POST /v1/{id}` and `POST /v1/{id}/connect` |
| `session_id` returned by registration | `GET /events`, `POST /heartbeat`, `DELETE /v1/{id}`, and `POST /connects/{nonce}` |

Send tokens with:

```http
Authorization: Bearer <token>
```

## Requests

Register the server:

```http
POST /v1/{id}
Authorization: Bearer <REALM_TOKEN>
Content-Type: application/json
```

```json
{
  "addresses": ["203.0.113.10:4433"]
}
```

Success:

```json
{
  "session_id": "generated-session-token",
  "ttl": 60
}
```

Heartbeat refreshes the current session. It may also replace cached server addresses:

```json
{
  "addresses": ["203.0.113.11:4433"]
}
```

Client connect requests require a nonce and obfs value:

```json
{
  "addresses": ["198.51.100.20:4433"],
  "nonce": "00112233445566778899aabbccddeeff",
  "obfs": "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff"
}
```

The Worker sends a `punch` event to the server event stream. The server can answer with:

```http
POST /v1/{id}/connects/{nonce}
Authorization: Bearer <session_id>
Content-Type: application/json
```

```json
{
  "addresses": ["198.51.100.1:9999"]
}
```

If no connect response arrives within 10 seconds, the connect request falls back to the last cached server addresses.

## Configuration

Set these values in Cloudflare Worker settings or with Wrangler:

| Name | Required | Description |
| --- | --- | --- |
| `REALM_ID` | Yes | The only realm ID this deployment accepts. |
| `REALM_TOKEN` | Yes | Shared bearer token used for registration and client connect requests. Store it as a Cloudflare dashboard secret or with `wrangler secret put REALM_TOKEN`. |
| `DEBUG` | No | Set to `true` for debug logs. Defaults to `false`. |

Address values must be IP address and port strings. IPv4 uses `host:port`; IPv6 uses `[host]:port`. Domain names are not accepted.

## Local Development

```bash
pnpm install
pnpm run dev
```

For local development, create `.dev.vars`:

```text
REALM_TOKEN=your-secret-token
REALM_ID=example
DEBUG=true
```

## Manual Deploy

```bash
pnpm run deploy
```

`wrangler.jsonc` declares `REALM_TOKEN` as a required secret:

```json
{
  "secrets": {
    "required": ["REALM_TOKEN"]
  }
}
```

## Test

```bash
pnpm run typecheck
pnpm run test
```

## Runtime Notes

- Only one server session can be active. A new successful registration replaces the previous session and cancels in-flight connect attempts.
- Session TTL is 60 seconds.
- `/connect` waits up to 10 seconds for `/connects/{nonce}` before returning cached server addresses.
- The event stream sends `punch` events and periodic keepalive comments.
- Sessions and SSE streams are runtime state. If the Durable Object restarts, clients should register and reconnect again.
- One deployment supports one realm. Use multiple deployments or routes for multiple realms.
