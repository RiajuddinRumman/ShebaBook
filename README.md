# ShebaBook API

A service-booking backend: customers find local service providers (tutors, repair, home
maintenance), request appointments, and the system refuses anything that would double-book
someone. Built as a portfolio piece for backend / API roles, so the emphasis is on rules that
are *correct and tested*, not on the number of endpoints.

**Status:** booking creation is implemented end to end, with concurrency-safe overlap
prevention. 113 unit tests + 41 end-to-end tests, all passing.

| Route | Auth | Purpose |
| --- | --- | --- |
| `GET /` | none | liveness check |
| `POST /auth/register` | none | create a customer account |
| `POST /auth/login` | none | exchange credentials for a JWT |
| `POST /bookings` | customer JWT | request an appointment |

```bash
npm ci                        # npm only; there is exactly one lockfile
npx prisma generate           # npm may skip Prisma's postinstall; typecheck/tests need the client
cp .env.example .env          # then edit DATABASE_URL and JWT_SECRET
docker compose up -d          # or any Postgres 14+ the URL points at
npx prisma migrate dev        # creates tables + the hand-written constraints
npm run start:dev             # http://localhost:3000
npm test                      # unit tests, no database needed
npm run test:e2e              # needs a running Postgres (creates shebabook_e2e itself)
npm run typecheck && npm run lint && npm run build
```

---

## 1. How the code is laid out

```
prisma/schema.prisma                    the data model, the single source of truth
prisma/migrations/<ts>*/migration.sql   applied schema changes, incl. hand-written constraints
src/
  main.ts                               bootstrap only
  app.module.ts                         wires modules + the global ValidationPipe
  generated/prisma/                     Prisma client (generated, git-ignored)
  prisma/prisma.service.ts              PrismaClient + pg driver adapter, one instance
  auth/
    password.ts                         scrypt hashing and verification (pure, no framework)
    token.service.ts                    sign / verify JWT, reject malformed claims
    auth.service.ts                     register + login, timing equalisation
    jwt-auth.guard.ts                   Bearer token -> request.user
    roles.guard.ts                      role metadata -> 401 or 403
    current-user.decorator.ts           reads identity off the request only
    dto/                                register / login request shapes
  bookings/
    overlap.ts                          the interval maths (pure)
    dto/create-booking.dto.ts           what a legal request body looks like
    booking-errors.ts                   the typed 400/404/409 responses
    slot-constraint.ts                  reads Postgres exclusion violations back
    booking.service.ts                  the booking rules
    bookings.controller.ts              HTTP layer, guards, status codes
test/
  *.e2e-spec.ts                         real HTTP against a real database
  utils/test-app.ts                     app bootstrapping + fixtures
  global-setup.ts                       creates the test database, runs migrations
```

The pattern to notice: **pure logic lives in plain functions** (`overlap.ts`, `password.ts`),
**framework code is thin** (controllers), and **rules live in the service**. That is what makes
the interesting parts testable without a database or an HTTP server.

---

## 2. The domain model

```
User 1---1 ProviderProfile 1---* ServiceListing 1---* Booking *---1 User (customer)
```

- `User` holds credentials and a role (`CUSTOMER` | `PROVIDER`).
- `ProviderProfile` is the public business card (display name, city). `userId` is `@unique`,
  which is what makes the 1:1 relationship enforced by the database rather than by convention.
- `ServiceListing` is a bookable thing with a `durationMinutes` and a `priceCents`.
- `Booking` is a customer reserving a slice of a listing's time. It stores `startsAt` and
  `endsAt` rather than recomputing `endsAt` from the listing duration, so a later change to a
  listing's length cannot silently rewrite history.
- `Booking.providerId` is **copied from the listing**. That duplication looks wrong at first
  glance, and section 5 explains why it is there.

Money is integer cents, never floats. Dates are stored as naive UTC `TIMESTAMP(3)` because that
is Prisma's default for `DateTime` on Postgres; every comparison in the code is done with `Date`
objects or half-open ranges, so the missing offset never matters.

---

## 3. The booking rules

A `POST /bookings` request carries exactly two fields, `listingId` and `startsAt`. Everything
else is derived or rejected.

1. **The listing must exist and be active.** Missing and inactive produce the *same* 404
   (`LISTING_NOT_BOOKABLE`) so the API does not leak which listings exist but are switched off.
2. **`endsAt = startsAt + listing.durationMinutes`, computed server-side.** A client-supplied
   `endsAt` is rejected outright by the validation pipe.
3. **The slot must be inside the bookable window:** strictly in the future, at least one hour
   ahead, no more than ninety days ahead. One hour of lead time means a provider is never
   surprised by an immediate booking; ninety days bounds how far the calendar can be filled.
4. **Neither the provider nor the customer may already be busy.** A booking occupies the
   calendar only while its status is `PENDING` or `CONFIRMED`. `CANCELLED` and `COMPLETED` free
   the slot.

Overlap is a **half-open interval** test:

```ts
a.startsAt < b.endsAt && b.startsAt < a.endsAt   // [startsAt, endsAt)
```

Strict `<` is the whole point. With `<=`, a booking ending at 11:00 would block a booking
starting at 11:00, and a provider could never work back-to-back. Because the interval is
half-open, a zero-length range is the empty set and must overlap nothing — which is why
`overlaps()` rejects invalid ranges before comparing them.

Two more rules are not about time at all:

5. **Identity comes from the token, never the body.** A `customerId` in the request body is a
   validation error, not an override.
6. **A customer cannot book a provider's role.** `POST /bookings` is guarded with
   `@Roles(UserRole.CUSTOMER)`, and `POST /auth/register` can never hand out `PROVIDER`.

### Where each rule is enforced

| Layer | Enforces | Fails with |
| --- | --- | --- |
| DTO + `ValidationPipe` | types, formats, unknown fields | 400 |
| Guards | authentication, role | 401 / 403 |
| `BookingService` | window, duration, both overlap checks | 400 / 404 / 409 |
| Postgres | `CHECK` and `EXCLUDE` constraints | constraint violation |

Each layer assumes nothing about the one above it. The service is written so it stays correct if
a DTO check is removed, and the database stays correct if the service is bypassed — there is an
e2e test that proves the latter by inserting an overlapping row with `prisma.booking.create`
directly, skipping the service entirely.

---

## 4. Concepts you should be able to explain

Not a reading list — the questions an interviewer will actually ask about this code.

**Dependency injection and modules.** `PrismaModule` is `@Global()` because one connection pool
per process is the goal; `AuthModule` *exports* its guards so `BookingsModule` can use them
without importing the whole auth layer. Why does a guard exported from another module resolve at
all? Because Nest resolves provider tokens from the module's *context*, and an export makes a
provider visible to importers.

**Pipes vs guards vs interceptors.** Guards decide *whether* to run the handler (401/403). Pipes
decide *whether the input is usable* (400). The service decides *whether the action is allowed by
the domain* (409). Putting a check in the wrong layer is the most common structural mistake in a
Nest codebase.

**`APP_PIPE` in the module, not `main.ts`.** `app.useGlobalPipes()` in `main.ts` is invisible to
tests that build the app from `AppModule`, so tests would pass while production rejected
different bodies. Registering the pipe as a provider means the tested app *is* the production
app.

**Mass assignment.** `{ whitelist: true, forbidNonWhitelisted: true }` means an undocumented
field is a 400 rather than a silent override. This is the defence against
`{ ..., status: 'CONFIRMED' }` and `{ ..., customerId: 'someone-else' }`.

**Prisma 7 specifics.** The datasource block has no `url`; it lives in `prisma7.config.ts`. A
driver adapter (`@prisma/adapter-pg`) is mandatory, so Prisma no longer owns the connection
string. The generator emits TypeScript into `src/generated/prisma` *because* `rootDir` is
`./src` — outside it, `nest build` fails with TS6059. `prisma generate` must be re-run after
every schema edit, and the CLI major version must match `@prisma/client`.

**Migrations Prisma cannot generate.** `CHECK` and `EXCLUDE` constraints have no Prisma
representation, so they live in hand-written SQL inside a migration folder. Verified: Prisma's
differ does not drop them on later `migrate dev` runs, because it only compares what the schema
file describes.

**Why a transaction is not enough.** `$transaction` at the default isolation level gives you
atomicity, not mutual exclusion. Two requests can both run "is anyone busy?" at the same instant,
both see nothing, and both insert. `READ COMMITTED` re-reads rows *one at a time* — it does not
re-run a completed `SELECT`. Only a unique or exclusion constraint makes the invalid state
unrepresentable, and that is the only check that cannot be bypassed by a bug in application code.

**Exclusion constraints.** `EXCLUDE USING gist (providerId WITH =, tsrange(startsAt, endsAt) WITH
&&) WHERE (status IN ('PENDING','CONFIRMED'))` reads as: *no two qualifying rows may share a
provider and overlapping time*. The partial `WHERE` is what lets cancelled bookings keep
history. `WITH =` on a text column needs the `btree_gist` extension; the range part is native.

**Auth choices.** `scrypt` from Node's own `crypto`, with a per-password salt and a scheme prefix
(`scrypt$salt$key`), so hashes stay verifiable after an algorithm change. `verifyPassword` uses
`timingSafeEqual`. Login hashes a placeholder when the email is unknown, so an unknown account
costs the same as a wrong password and timing does not reveal who is registered. Both failures
return the *same* body and status.

**JWT claim hygiene.** The user id travels as `sub`, and `verify()` refuses blank or non-string
`sub`/`email` and any role outside the issued set. A token that is cryptographically valid but
semantically nonsense is still invalid.

**Testing.** Vitest transpiles with esbuild and does **no typechecking**, which is why
`npm run typecheck` is a separate gate — it has caught real errors while the suite was green.
Unit fakes *throw* on unsupported `where` keys and operators, so rewriting `lt` to `lte` breaks
the suite instead of quietly changing semantics. Watch out for **vacuous assertions**:
`expect(fn).not.toThrow()` on a function that returns a promise can never fail, and
`expect(x?.y).toBeNaN()` on an optional chain that short-circuits to `undefined` proves nothing.
A test that cannot fail is worse than no test, because it advertises coverage.

---

## 5. Decisions and their cost

**`providerId` is denormalised onto `Booking`.** Postgres exclusion constraints can only
reference columns of the row being written, so "this provider is busy" is inexpressible while
`Booking` knows only its `listingId`. The alternatives were a trigger or an advisory lock. The
cost: two sources of truth for one fact. It is safe here because `providerId` is always derived
from the listing the service just loaded, and no code path changes a booking's `listingId`. The
cost of *not* doing it: the same rule for a customer booking two different providers had no
database-level defence at all. The bonus: the provider conflict query became a single flat
indexed scan instead of a subquery over `service_listings`.

**Concurrency is handled by constraints, not by locking the provider.** An advisory lock keyed on
`providerId` would need a second lock for the customer, and two locks acquired in inconsistent
order deadlock. The exclusion constraints are declarative, survive a rewrite of the service, and
are tested directly.

**No public provider signup.** `POST /auth/register` always creates a `CUSTOMER`. A provider is
seeded by the system. Handing out roles from an unauthenticated endpoint is a privilege
escalation, so the field simply does not exist. Tests assert that sending `role` is a 400.

**Table names are snake_case, column names are camelCase** (`"bookings"."startsAt"`). That is
Prisma's `@@map` default behaviour, and it is inconsistent. Renaming columns to snake_case is a
one-migration change but touches every raw SQL statement and index name; deliberately deferred.

**Errors carry a machine-readable `code`** (`PROVIDER_BUSY`, `EMAIL_IN_USE`) plus a human
message, and conflicts include the `conflict` window so a client can render "already booked
10:00–11:00". A single global exception filter is not built yet, so 500s and pipe-generated 400s
do not yet share the envelope — see gaps.

---

## 6. Bugs the tests earned

Worth retelling in an interview, because each was found by a test rather than by reading.

1. **A zero-length range overlapped everything.** `overlaps()` was written as the textbook
   formula, which returns true for a degenerate range inside another. The unit test that asserted
   "an empty range overlaps nothing" failed, the guard was added, and the assertion was *not*
   weakened. Left unfixed it would have accepted a booking whose computed `endsAt` equalled
   `startsAt`.
2. **`@IsISO8601({ strict: true })` accepted `2026-305` and `2026-11-01`.** Those parse to an
   invalid or midnight-normalised `Date`, every comparison becomes false, `overlaps()` returns
   false, and the double booking is accepted. Fixed with a regex that additionally requires a
   `Z` or `+hh:mm` offset, so a naive timestamp like `2026-11-01T10:00:00` is a 400 rather than a
   silently server-timezone-dependent booking.
3. **A JWT with `"sub": ""` authenticated successfully.** `typeof '' === 'string'`, so the claim
   check passed and the request carried an empty user id into the booking write path. Now a
   string claim must also be non-blank, and there is an e2e test that signs such a token with the
   *real* secret and expects 401.

Number 3 is the one to highlight: it passed every check except one that was semantically
meaningful, and only a test written specifically to attack it found it.

---

## 7. Deliberately not built yet

- `PATCH /bookings/:id/cancel` and status transitions. The `CANCELLED` behaviour is tested by
  writing rows directly; once a real endpoint exists, that test should go through HTTP.
- Search and listing endpoints: filters, pagination, sorting, and a provider directory.
- A single exception filter so every error, including framework 400s, uses one envelope.
- Swagger/OpenAPI, containerising the API itself, deployment.
- Availability windows per provider (working hours), which would turn the booking window check
  into a listing-of-availability check.
- Idempotency keys, so a retried request does not collide with itself.

Order matters: **cancellation next**, because it is the only remaining way to reach the overlap
logic, and every path into it needs the same care.

---

## 8. Environment notes for this machine

- **One package manager: npm.** `package-lock.json` is the only lockfile and `node_modules` is
  npm-managed. The project briefly lived under pnpm before this was settled, which left three
  files (`pnpm-lock.yaml`, `pnpm-workspace.yaml`, a pnpm-shaped `node_modules`) that npm knows
  nothing about; they were removed and the tree rebuilt with `npm ci`. Mixed managers are silent
  corruption waiting to happen — if you add pnpm back, delete `package-lock.json` in the same
  commit.
- **Prisma's client is generated, not committed.** `src/generated/` is gitignored. `npm ci` may
  report *"install scripts not yet covered by allowScripts"* for `prisma` and `@prisma/engines`
  and skip the postinstall, so run `npx prisma generate` before `typecheck`, `test`, or `build`
  on a fresh clone.
- **Port 3000 may already be taken** by an unrelated `nest start --watch`. If `GET /` answers
  while your app logged `EADDRINUSE`, you are probing someone else's server. Verify the owner
  (`lsof -nP -iTCP:3000 -sTCP:LISTEN`, then check the process command and parent) or run on
  another port. `npm run test:e2e` is immune: supertest uses an ephemeral port.
- **Homebrew Postgres and locale.** `initdb`/`pg_ctl`/`psql` can fail with *"postmaster became
  multithreaded during startup / Set LC_ALL"*. `export LC_ALL=en_US.UTF-8` fixes it. Prisma and
  the e2e suite do not need it.
- **Prisma's shadow database needs `CREATEDB`.** `ALTER ROLE shebabook CREATEDB` — not
  superuser.
- **The e2e database.** `test/global-setup.ts` creates `shebabook_e2e` next to your dev database
  and runs `prisma migrate deploy` against it, so test data never lands in `shebabook`. It
  reuses your `DATABASE_URL` credentials; the URL it builds is
  `postgresql://<same creds>@<same host>/<port>/shebabook_e2e`.
- **`btree_gist` must be installable** on the server. It ships with Postgres and is a trusted
  extension, so a non-superuser can create it; the migration runs
  `CREATE EXTENSION IF NOT EXISTS btree_gist`.

---

## 9. Reading order for the code

1. `src/bookings/overlap.ts` and `overlap.spec.ts` — the maths, in isolation.
2. `src/bookings/dto/create-booking.dto.ts` and its spec — what the outside world may say.
3. `src/bookings/booking.service.ts` and `booking.service.spec.ts` — the rules.
4. `prisma/migrations/*booking_invariants*/migration.sql` and
   `*booking_slot_exclusivity*/migration.sql` — the rules the database enforces.
5. `src/auth/*` — how identity gets into `request.user` and no further.
6. `src/bookings/bookings.controller.ts` + `test/bookings.e2e-spec.ts` — the whole request path.
7. `test/booking-race.e2e-spec.ts` — the part that only breaks under load.

Then make a change and watch which tests fail: add a `maxAdvanceNotice` rule, or allow a
`CUSTOMER` to cancel. If nothing fails, the test was never testing the rule you think it was.
