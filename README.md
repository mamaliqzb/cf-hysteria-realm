# cf-hysteria-realm

Single-realm Cloudflare Workers rendezvous server for Hysteria Realms.

[中文说明](README.zh-CN.md) | [Technical docs](docs/technical.md)

This project deploys a lightweight Hysteria Realm rendezvous API on Cloudflare Workers. It coordinates rendezvous and UDP hole punching metadata only. 

Each deployment accepts one configured realm. Deploy another Worker instance if you need another realm.

Cloudflare's Durable Objects free quota per account is only enough to support one Worker deployment.

## Deploy

Click the button below to deploy this Worker with Cloudflare:

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/outlook84/cf-hysteria-realm)

The deploy page will clone the repository, create the Worker, ask for required secrets, and deploy to `workers.dev`.

## Configuration

| Name | Type | Required | Description |
| --- | --- | --- | --- |
| `REALM_ID` | Variable | Yes | The only realm ID accepted by this Worker. |
| `REALM_TOKEN` | Secret | Yes | Shared token used by your Hysteria realm server and clients. |
| `DEBUG` | Variable | No | Keep `false` for normal use. Set `true` only while troubleshooting. |

## Notes

- One Worker deployment supports one realm.
- The Worker requires Durable Objects, which are already configured in `wrangler.jsonc`.
- Copying only `src/index.ts` into the online editor is not enough unless you also recreate the Durable Object binding and migration.
- API behavior, local development, and runtime details are in [docs/technical.md](docs/technical.md).

## License

MIT
