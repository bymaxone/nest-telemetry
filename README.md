# @bymax-one/nest-telemetry

OpenTelemetry tracing for NestJS 11 — and for plain Node. It starts the SDK before your
application loads, redacts secrets from spans by default (URL queries, Redis payloads), filters
probe paths and flushes on shutdown. Every OpenTelemetry package is an optional peer, and a
disabled boot loads none of them.

> **Status: scaffold.** The library is under construction and nothing is published yet. This
> README is rewritten with the real API, quickstart and threat model before the first release.

## Entry points

| Subpath      | Purpose                                 | Imports `@nestjs/*` |
| ------------ | --------------------------------------- | ------------------- |
| `.`          | Programmatic start of the SDK           | no                  |
| `./register` | Zero-config preload for `node --import` | no                  |
| `./nest`     | NestJS module and shutdown flush        | yes                 |

```ts
import { startTelemetry } from '@bymax-one/nest-telemetry'

const telemetry = await startTelemetry({ serviceName: 'billing' })
await telemetry.shutdown()
```

## License

[MIT](./LICENSE)
