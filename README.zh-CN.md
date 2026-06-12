# cf-hysteria-realm

用于 Hysteria Realms 的单 realm Cloudflare Workers rendezvous server。

[English](README.md) | [技术文档](docs/technical.md)

这个项目把 Hysteria Realm 的 rendezvous API 部署到 Cloudflare Workers 上。它只负责协调 rendezvous 和 UDP 打洞所需的元数据。

每个 Worker 部署只对应一个 `REALM_ID`。如果需要多个 realm，请部署多个 Worker。

Cloudflare 单个账户 Durable Objects 的免费配额只够支撑一个 Worker 部署。

## 部署

点击下面的按钮即可通过 Cloudflare 部署：

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/outlook84/cf-hysteria-realm)

点击后，Cloudflare 会克隆仓库、创建 Worker、要求填写必要的 secret，并部署到 `workers.dev`。

## 配置

| 名称 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `REALM_ID` | Variable | 是 | 这个 Worker 接受的唯一 realm ID。 |
| `REALM_TOKEN` | Secret | 是 | Hysteria realm server 和 client 共用的 token。 |
| `DEBUG` | Variable | 否 | 正常使用保持 `false`，排查问题时再改成 `true`。 |

## 注意

- 一个 Worker 部署只支持一个 realm。
- 这个 Worker 需要 Durable Objects，相关配置已经写在 `wrangler.jsonc`。
- 不建议只把 `src/index.ts` 复制到 Cloudflare 在线编辑器，因为还需要手动创建 Durable Object binding 和 migration。
- API 行为、本地开发和运行时细节见 [技术文档](docs/technical.md)。

## License

MIT
