# CLAUDE.md — engineering guide for this repository

Read this before changing anything. `README.md` covers setup, operations and the demo; this file covers
how the code is organised and the rules every change must respect.

## What this is

A cut-down DV platform for **key flow 1**: an owner creates a company, asks for verification, a
reviewer approves or rejects it, and the owner is notified.

| Service                          | Role                                                                                                                                                                                         | Owns (its own PostgreSQL schemas)            |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| `apps/core`                      | Main deliverable: companies, memberships, state machine, policy, outbox + relay, inbox                                                                                                       | `identity`, `profile`, `core` (outbox/inbox) |
| `apps/verification`              | Thin: one table, three endpoints, outbox + relay                                                                                                                                             | `compliance`                                 |
| `apps/notification`              | Thin: inbox, stores one notification per approval, logs instead of sending                                                                                                                   | `notification`                               |
| `packages/shared` (`@dv/shared`) | Technical infrastructure only: JWT verification, token provider, auth guard, transactions, event envelope + contracts, outbox publisher, relay, inbox, HTTP client, logging, tracing, config | —                                            |

Stack (required): Node.js 22, TypeScript (strict), NestJS 11, PostgreSQL 17, Keycloak 26, Nginx, PM2.
Libraries: `pg` (parameterised SQL), `zod`, `jose`, `opossum`, `pino`, `uuid` (v7), Jest. No Docker,
no message broker, no Redis, no ORM schema sync.

```
apps/<service>/src/
  domain/        entities, state machines, policies, domain errors — pure TypeScript
  application/   use cases: orchestration, transactions, authorization calls, ports (interfaces)
  adapters/      PostgreSQL repositories, outgoing HTTP, runtime (clock, ids)
  api/           Nest controllers, zod DTOs, error mapping, DI tokens
  config/        zod-validated environment
  app.module.ts  composition root (wires adapters into use cases)
  main.ts        HTTP entry point     relay.ts   outbox relay entry point (core, verification)
packages/shared/src/   auth, config, database, events, outbox, relay, inbox, http, idempotency, logging, tracing, nest
database/migrations/<service>/NNN_*.sql   database/roles/001_roles.sql
config/subscriptions/<producer>.json      keycloak/realm-jo.json      nginx/      openapi/      scripts/
tests/integration/*.int-spec.ts (real PostgreSQL)   apps/*/test, packages/shared/test, tests/*.spec.ts (unit)
```

## Architecture rules

- **Domain is pure.** `apps/*/src/domain/**` must not import NestJS, `pg`, `jose`, `opossum`, `pino`,
  `@dv/shared`, or any outer layer. ESLint enforces this (`no-restricted-imports`).
- **Controllers are thin**: validate with a zod pipe, call one use case, return its result.
- **Use cases own transactions** (`TransactionRunner.run`) and call the central policy. Pass the
  `Transaction` handle explicitly; never hide a transaction inside a repository method.
- **Ports and adapters**: repositories, `EventPublisher`, `VerificationGateway`, `Clock`, `IdGenerator`
  are interfaces; adapters implement them; `app.module.ts` wires them.
- **One synchronous call only**: core → verification (`POST /internal/v1/verifications`). Everything
  else crosses services as an event.
- **Schema ownership**: a service reads and writes only its own schemas, with its own DB role. No
  cross-service foreign keys, no cross-schema queries.
- `@dv/shared` holds technical infrastructure and integration contracts, never company business rules.

## Business rules

- Company states: `draft → pending → approved | rejected` (table in `domain/company/company-status.ts`).
  Any other move throws `InvalidCompanyTransitionError` → **409 `COMPANY_INVALID_STATE_TRANSITION`**.
- Company roles (`owner`, `representative`, `employee`) come from `profile.company_member`, **never**
  from tokens or request bodies. Platform roles (`reviewer`, `admin`) come from verified token claims.
- Only owners and representatives request verification. Only `reviewer` decides. Owning a company
  grants nothing in verification.
- Policy is deny-by-default (`domain/authorization/policy.ts`); a missing rule means denied.
- Requesting verification: claim (tx) → HTTP call (no tx open) → `pending` (tx). On failure the claim is
  released and the company **stays draft**; the caller gets 503. The idempotency key is stable per
  company submission so a lost response is recovered.
- Business change + outbox insert are one transaction. Inbox insert + consumer change (+ any outbox
  insert) are one transaction. Duplicates never repeat side effects.
- Stale results never reverse a final state (a late `rejected` after `approved` is ignored and
  acknowledged, not retried).

## Security rules

- Every service verifies JWTs itself (`JwtVerifier`): signature via cached JWKS (refetch on unknown
  `kid`), `iss`, `aud` (= the service's client id), `exp`, `nbf`, `typ=Bearer`, then `token_kind` + `azp`
  allowlists. No introspection calls.
- `AuthGuard` is global and **deny by default**: every route must declare `@UserEndpoint()`,
  `@InternalEndpoint('svc-…')` or `@AnonymousEndpoint()` (health/ready only).
- User tokens never reach internal endpoints (403); service tokens never reach public ones (403).
  Internal endpoints allow-list the exact calling client.
- Service tokens come from the client credentials grant via `ClientCredentialsTokenProvider` (cached,
  refreshed at 70% of lifetime, single-flight).
- Secrets only from validated environment variables. Never log tokens, secrets, passwords or
  `authorization` headers (pino `redact` covers the common paths; don't log raw payloads).
- Least-privilege DB roles; the migrator role is never used at runtime.

## Event rules

- Type format `dv.<country>.<service>.<event>.v<n>`; use the constants in `EventTypes`.
- Envelope (`events/envelope.ts`): `event_id` (UUID v7), `event_type`, `schema_version`,
  `occurred_at`, `country`, `aggregate_id`, `request_id`, `traceparent`, `data`. Payloads are IDs and
  codes only. Contracts live in `events/contracts.ts`, keyed by type + version, and are validated by
  the producer (`assertPublishable`) and the consumer (`parseIncomingEvent`).
- Publish only through `EventPublisher.publish(tx, …)` inside the business transaction. No HTTP inside
  a transaction, no fire-and-forget publishing.
- Relay: fan-out to one `outbox_delivery` row per subscriber; claim with `FOR UPDATE SKIP LOCKED` in a
  single short statement plus a lease; at most `RELAY_MAX_IN_FLIGHT_PER_SUBSCRIBER` deliveries in
  flight per subscriber, so a slow one cannot hold up the others; no lock held during network I/O;
  acknowledge only on 2xx; exponential backoff with jitter; **5 attempts total, including the first**, then `dead`.
- Inbox answers 2xx only after commit. Delivery is at-least-once; consumers must be idempotent.

## Coding standards

Strict TypeScript, no `any` (lint error), explicit types on public interfaces, small modules,
dependency injection, zod-validated DTOs and config, parameterised SQL (identifiers only through
`sqlIdentifier`), stable error codes, migrations instead of schema sync, ESLint + Prettier clean. No
placeholder methods, fake assertions, hardcoded secrets or swallowed exceptions.

## Commands (from the root `package.json`)

| Purpose                                                              | Command                                                    |
| -------------------------------------------------------------------- | ---------------------------------------------------------- |
| Install                                                              | `npm ci`                                                   |
| Build all workspaces (shared first)                                  | `npm run build`                                            |
| Type-check everything incl. tests                                    | `npm run typecheck`                                        |
| Lint / format                                                        | `npm run lint` · `npm run format` · `npm run format:check` |
| Unit tests                                                           | `npm run test:unit`                                        |
| Integration tests (real PostgreSQL; needs `PG_SUPERUSER*` in `.env`) | `npm run test:integration`                                 |
| All tests                                                            | `npm test`                                                 |
| Create roles + database (superuser)                                  | `npm run db:provision`                                     |
| Apply migrations / show status                                       | `npm run db:migrate` · `npm run db:status`                 |
| Start / stop under PM2                                               | `npm run start:pm2` · `npm run stop:pm2`                   |
| Check the host and dependencies                                      | `npm run check:env`                                        |
| Full setup on a prepared host                                        | `npm run setup`                                            |
| Run the 11 assessment scenarios                                      | `npm run demo` (or `bash scripts/demo.sh 1 9`)             |
| List / re-queue dead deliveries                                      | `npm run dead-letter:requeue -- --service core --list`     |

## Workflow

1. Read this file and the code you will touch before changing it.
2. Keep the build green while working; add a migration rather than editing an applied one (the runner
   rejects changed checksums).
3. After a change run `npm run typecheck && npm run lint && npm run test:unit`; run
   `npm run test:integration` when SQL, transactions, the relay or the inbox change; run the demo when
   routing, auth or process wiring changes.
4. Adding or changing a route means updating `openapi/<service>.yaml`; `tests/openapi-sync.spec.ts`
   fails until it matches.
5. Never claim tests passed unless they ran. Update this file when commands or architecture change.
6. Finish with a short summary: what changed, how it was verified, what remains.
