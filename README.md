# Itaja SDKs

Every Itaja SDK, one package per language, in one repository. Each SDK offers the
same four gestures — **declare** your catalogue in code, **push** it, **mount** one
webhook route, **react** to typed events — as fixed by
[ADR 0015](https://github.com/itaja/itaja-services/blob/develop/backend/docs/adr/0015-les-sdk-declarer-pousser-monter-reagir.md).

| Package | Registry | Folder | Status |
|---|---|---|---|
| `@itaja/node` | npm | [`packages/node`](packages/node) | 0.1.2 |
| `itaja` | PyPI | [`packages/python`](packages/python) | 0.1.0 |
| `itaja` | pub.dev | `packages/dart` | planned |
| `itaja/itaja-laravel` | Packagist | [`packages/laravel`](packages/laravel) | 0.1.1 |

## Shared contracts — `spec/`

Written once, read by every SDK. Never edit a copy inside a package.

| File | What it is | Source |
|---|---|---|
| `openapi.json` | The developer API | `itaja-services` → `backend/apps/dev-api/openapi.json` |
| `catalog.schema.json` | The canonical catalogue `push` sends | `itaja-services` → `backend/apps/dev-api/catalog.schema.json` |
| `signature-vectors.json` | Webhook deliveries signed by the backend's own `signOutboundWebhook` | generated from `itaja-services` |

Every SDK must accept every vector, and build a catalogue document the schema
validates.

## CI / CD

- **CI** (`.github/workflows/ci-<lang>.yml`) runs only when its package or `spec/`
  changes. A change to `spec/` runs every SDK.
- **CD** (`.github/workflows/release-<lang>.yml`) publishes one package on a
  prefixed tag — `node-v0.1.0`, `python-v0.1.0` … — after its full test suite
  passes. Each SDK has its own semver. Nothing is ever published from a laptop.

## Layout

```
spec/              shared contracts
packages/<lang>/   one SDK, with its own native tooling (pnpm, uv, dart, composer)
.github/workflows/ ci-<lang>.yml, release-<lang>.yml
```
