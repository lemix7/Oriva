# Oriva API

A project and task management REST API built with Express, TypeScript, and PostgreSQL. Oriva supports user registration, JWT authentication, profile picture uploads to Amazon S3, and background registration notifications through BullMQ and Resend.

## Features

- User registration with bcrypt password hashing and optional profile pictures.
- JWT authentication with 15-minute access tokens and rotating seven-day refresh sessions.
- Create, read, update, and delete projects and tasks.
- Project and task access scoped to workspace membership and roles.
- Request body validation with VineJS.
- Profile uploads limited to 5 MB, stored in S3.
- Background registration notification emails using a Redis-backed queue.
- Repository functions for database access and a storage adapter for S3 operations.

## Requirements

- Node.js and npm. Node.js 22 or newer is recommended for this project's modern dependencies.
- PostgreSQL with an existing application schema.
- Redis available at `127.0.0.1:6379`.
- An AWS account, S3 bucket, and credentials with object upload and deletion permissions.
- A Resend API key and a sender allowed by your Resend account.

## Getting started

### 1. Install dependencies

```bash
git clone https://github.com/lemix7/Oriva.git
cd Oriva
npm ci
```

### 2. Configure the environment

Create a `.env` file in the project root:

```dotenv
PORT=4000
DATABASE_URL=postgresql://USERNAME:PASSWORD@localhost:5432/oriva
SECRET_KEY=replace-with-a-long-random-secret
APP_ORIGIN=http://localhost:5173
AWS_REGION=your-aws-region
AWS_ACCESS_KEY_ID=your-aws-access-key-id
AWS_SECRET_ACCESS_KEY=your-aws-secret-access-key
AWS_BUCKET_NAME=your-bucket-name
RESEND_API_KEY=your-resend-api-key
```

Replace these example values with your own configuration. `.env` is excluded from Git.

Redis settings are currently defined in `src/config/redis.ts`; they are not read from environment variables.

### 3. Prepare PostgreSQL

The schema is defined in `src/db/schema.ts`, with versioned migrations in
`drizzle/`. Create the target database, then configure its direct connection as
`MIGRATION_DATABASE_URL` or `DATABASE_URL_UNPOOLED` in `.env.neon` (or the process
environment) and apply the migrations:

```bash
npm run db:migrate
```

This includes workspaces, projects, tasks, project statuses, invitations, and
refresh sessions. Integration and HTTP tests use the separate local `oriva_test`
database configured by `TEST_DATABASE_URL` in `.env.test`.

### 4. Start Redis

If Redis is installed locally, run it in a separate terminal:

```bash
redis-server
```

Verify that it is reachable:

```bash
redis-cli ping
```

The expected response is `PONG`. A connection refusal at `127.0.0.1:6379` means the queue cannot reach Redis at its configured address.

### 5. Run the API

Development with automatic restarts:

```bash
npm run dev
```

Compile and run:

```bash
npm run build
npm start
```

The default base URL is `http://localhost:4000`.

Run the email worker in a separate terminal with `npm run dev:worker` during
development, or `npm run worker` after building. `src/index.ts` starts only the
HTTP API; `src/app.ts` exports the app for HTTP tests. Jobs wait in Redis while
the worker is stopped.

For Docker, run `docker compose up -d --build app worker`. Compose starts Redis
as their dependency. Both containers use the same image; the worker overrides
the startup command and has no HTTP port. Redis is exposed only on loopback
port 6379 for local development. Keep dollar-containing `.env` values such as
`SECRET_KEY` single-quoted so Compose preserves them literally.

## API endpoints

### Public endpoints

- `GET /` — returns a greeting.
- `POST /users` — registers a user; accepts JSON or multipart form data.
- `POST /login` — returns a 15-minute access JWT and sets an HttpOnly refresh cookie.
- `POST /auth/refresh` — rotates the refresh cookie and returns a new access JWT.
- `POST /auth/logout` — revokes the cookie's login family and clears the cookie.

Login, refresh, and logout require an `Origin` header matching `APP_ORIGIN`;
missing or untrusted origins return `403 UNTRUSTED_ORIGIN`. Configure this value
to the frontend origin (scheme, hostname, and port) in each environment.
Refresh/logout use the cookie and do not require a valid access JWT. Send access
tokens in the `Authorization: Bearer ...` header for other protected endpoints.

Refresh tokens are stored only as hashes in PostgreSQL. Rotation preserves the
original seven-day expiry. Reusing a rotated token revokes that login's entire
family and returns `401 REFRESH_TOKEN_REUSED`; other login families are unaffected.
The frontend must share one pending refresh request across concurrent API calls.
Logout revokes refresh sessions; already-issued access JWTs remain valid until
their normal expiry. Invalid or expired access JWTs return `401`.

Set `NODE_ENV=production` on the deployed server. Production refresh cookies use
the `__Host-oriva_refresh` name, `Secure`, `HttpOnly`, `SameSite=Lax`, and `Path=/`
without a Domain attribute; development uses `oriva_refresh` and permits HTTP.
Authentication responses are marked `Cache-Control: no-store`.

### Protected user endpoints

- `GET /me` — returns the authenticated user's ID, name, and email.
- `PATCH /me` — updates their name and/or email.

Emails are trimmed, lowercased, and unique after applying migration
`0006_unique-user-email`. Duplicate registration or email updates return
`409 EMAIL_ALREADY_EXISTS`.

Password and role changes are not supported by `PATCH /me`.
The former `/users` and `/users/:user_id` read/update/delete routes are retired.
`POST /users` remains available for registration.

### Workspace project endpoints

- `POST /workspaces/:wid/projects` — creates a project; requires owner/editor membership.
- `GET /workspaces/:wid/projects` — lists workspace projects with cursor pagination.
- `GET /workspaces/:wid/projects/:pid` — reads a project; requires workspace membership.
- `PATCH /workspaces/:wid/projects/:pid` — updates name, description, or status; requires owner/editor membership.
- `DELETE /workspaces/:wid/projects/:pid` — deletes an empty project; requires owner membership.

Project creation is available only through the workspace endpoint. The former
`POST /users/projects` endpoint is removed and returns 404. Migration
`0005_require-project-workspace` makes `projects.workspace_id` required.
Before applying it to an existing database, assign any projects with a null
`workspace_id` to an appropriate workspace.

### Retired project endpoints

All `/users/projects` routes are retired and return 404 for authenticated
requests. Read and modify projects only through `/workspaces/:wid/projects`.

Project creation accepts `name` (at least 3 characters), optional `description`, and `status`: `active`, `inactive`, `pending`, or `completed`.

### Project task statuses

- `GET /workspaces/:wid/projects/:pid/statuses` — lists statuses for members.
- `POST /workspaces/:wid/projects/:pid/statuses` — creates a status.
- `PATCH /workspaces/:wid/projects/:pid/statuses/:sid` — edits a status.
- `DELETE /workspaces/:wid/projects/:pid/statuses/:sid` — deletes an unused status.

Creation, editing, and deletion require owner/editor membership.
Duplicate names return `409 STATUS_ALREADY_EXISTS`.
Statuses referenced by tasks return `409 STATUS_IN_USE` on deletion.
Appending beyond the integer position range returns `409 STATUS_ORDER_LIMIT`.

New projects receive Backlog, In Progress, Review, and Done.
Tasks still use the legacy status text during this transition;
switching the task API to `statusId` is the next implementation slice.

### Workspace task endpoints

All task endpoints require workspace membership.

- `GET /workspaces/:wid/projects/:pid/tasks` — lists tasks with cursor pagination using `?afterId=TASK_ID`.
- `GET /workspaces/:wid/projects/:pid/tasks/:tid` — reads one task.
- `POST /workspaces/:wid/projects/:pid/tasks` — creates a task; requires owner/editor membership.
- `PATCH /workspaces/:wid/projects/:pid/tasks/:tid` — updates a task; requires owner/editor membership.
- `DELETE /workspaces/:wid/projects/:pid/tasks/:tid` — deletes a task; requires owner/editor membership.

Viewers can read tasks but cannot create, update, or delete them.

The legacy `/projects/:project_id/tasks` routes are retired and return 404 for
authenticated requests. Their creator-only authorization could bypass workspace
membership, including after member removal. Existing tasks remain stored.
The retired controllers, repository functions, and creator-only task cache have
been removed. Redis is still used for email jobs; database cache-version
triggers remain in place.

Send the token on protected requests:

```http
Authorization: Bearer YOUR_TOKEN
```

## Example workflow

Register a user:

```bash
curl -X POST http://localhost:4000/users \
  -H 'Content-Type: application/json' \
  -d '{"name":"Alex Morgan","email":"alex@example.com","password":"example-password"}'
```

To include a picture, send multipart form data using the file field `profilePic`:

```bash
curl -X POST http://localhost:4000/users \
  -F 'name=Alex Morgan' \
  -F 'email=alex@example.com' \
  -F 'password=example-password' \
  -F 'profilePic=@/absolute/path/to/profile.png'
```

Log in and copy the access `token` from the response. Save the refresh cookie
in a temporary cookie jar outside the repository:

```bash
cookie_jar=$(mktemp)
curl -c "$cookie_jar" -X POST http://localhost:4000/login \
  -H 'Origin: http://localhost:5173' \
  -H 'Content-Type: application/json' \
  -d '{"email":"alex@example.com","password":"example-password"}'
```

Refresh without sending an access token, replacing the saved cookie:

```bash
curl -b "$cookie_jar" -c "$cookie_jar" -X POST http://localhost:4000/auth/refresh \
  -H 'Origin: http://localhost:5173'
```

To log out this session:

```bash
curl -b "$cookie_jar" -c "$cookie_jar" -X POST http://localhost:4000/auth/logout \
  -H 'Origin: http://localhost:5173'
rm "$cookie_jar"
```

Create a workspace first (use the returned workspace ID in the project URL):

```bash
curl -X POST http://localhost:4000/workspaces \
  -H 'Authorization: Bearer YOUR_TOKEN' \
  -H 'Content-Type: application/json' \
  -d '{"name":"My team"}'
```

Create a project in workspace `1`, replacing that ID with your own:

```bash
curl -X POST http://localhost:4000/workspaces/1/projects \
  -H 'Authorization: Bearer YOUR_TOKEN' \
  -H 'Content-Type: application/json' \
  -d '{"name":"Website launch","description":"Prepare the launch","status":"active"}'
```

Use the returned project ID to read or update it under
`/workspaces/1/projects/PROJECT_ID`, and manage its tasks under
`/workspaces/1/projects/PROJECT_ID/tasks`. Legacy task URLs are no longer supported.

## Project structure

```text
src/
├── adapters/      # S3 profile storage adapter
├── auth/          # Login and JWT verification
├── config/        # Redis connection settings
├── contollers/    # HTTP handlers (current folder spelling)
├── middleware/    # Validation, uploads, logging, and errors
├── pool/          # PostgreSQL connection pool
├── queue/         # BullMQ email queue
├── repositories/  # User, project, and task database queries
├── routes/        # Express routers
├── S3/            # Shared AWS S3 client
├── services/      # Resend notification delivery
├── typess/        # Express request type extensions
├── validators/    # VineJS schemas
├── workers/       # Email queue processor
├── app.ts         # Express app configuration and export
└── index.ts       # HTTP server startup
```

Controllers handle HTTP requests and responses. Repositories use Drizzle to build database queries. The profile storage adapter translates upload and deletion operations into AWS SDK commands.

## Email behavior

Registration notifications currently go to a fixed recipient configured in `src/services/email.service.ts`, rather than to the newly registered user. Update the recipient and sender there for your environment.

If saving a user fails after an upload succeeds, registration attempts to delete the uploaded picture. Once the user is saved, a rejected notification enqueue is logged and registration still succeeds. Failed enqueueing is not persisted for later retry; Redis connection retries can also delay the response.

New email jobs allow three total attempts with exponential backoff (1 second,
then 2 seconds). The service makes one provider request per attempt. Temporary
failures remain retryable; permanent provider errors use `UnrecoverableError`
to stop immediately. The worker reuses a queue/job/timestamp-based idempotency
key across attempts. Resend retains these keys for 24 hours, so this is not an
unlimited guarantee against duplicate delivery.

## Verification and development notes

`src/config/env.ts` loads environment settings once and provides `requiredEnv`.
Database access requires `DATABASE_URL`; authentication requires `SECRET_KEY`
and `APP_ORIGIN`;
the email worker requires `RESEND_API_KEY`; profile storage requires
`AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, and `AWS_BUCKET_NAME`.
Each component checks its settings when initialized. Missing or whitespace-only
values produce an error naming the setting without printing its value. Existing
defaults for `PORT`, `REDIS_HOST`, and `REDIS_PORT` remain available.

Check TypeScript without generating build output:

```bash
npx tsc --noEmit
```

Tests compile TypeScript before running Jest:

```bash
npm test                  # Unit tests; no external services required
npm run test:integration   # PostgreSQL repositories and isolated Redis email retries
npm run test:e2e           # Real HTTP login and project ownership flow
```

Database-backed tests require `.env.test` with `TEST_DATABASE_URL` pointing to the local `oriva_test` database and the application schema installed. This local file is ignored by Git. Tests refuse other database names and non-local hosts, create their own fixtures, and delete those fixtures afterward.

Email retry integration tests also require `redis-server` on PATH (or a
`REDIS_SERVER_BINARY` executable path). They start a temporary Redis process
with a private Unix socket, no network listener, and no persistence. The actual
queue, worker, and email service run against it, while Resend is mocked. Tests
check exhaustion after three attempts, exponential delays, immediate permanent
failure, successful recovery, and stable idempotency keys. They close all clients,
stop Redis, and remove their temporary files afterward. No real emails are sent.

The HTTP suite starts the app on an available loopback port and uses real password checks, JWTs, routes, controllers, and PostgreSQL. Email queuing, cloud uploads, and Redis are mocked; they are not covered by this flow. The HTTP server and database pool are closed when testing finishes.

The public `GET /error` route intentionally throws an error to exercise error handling. Remove or restrict it before deployment.

## Lakebase Postgres via Neon

Neon connection strings are stored in the git-ignored `.env.neon` file.
Keep the SSL parameters supplied by Neon. Do not commit or print connection strings.

`schema.sql` is a schema-only snapshot of the current local application database,
including tables, sequences, constraints, indexes, and cache functions/triggers.
It includes the changes from migrations 001–003; do not replay those on top of
this baseline. The snapshot was imported into Neon without existing user,
project, or task rows.
Express uses Neon's pooled connection through `DATABASE_URL` in `.env`.
Docker uses the same Neon connection through `DOCKER_DATABASE_URL`.
Previous local URLs are preserved as `LOCAL_DATABASE_URL` and
`LOCAL_DOCKER_DATABASE_URL`; integration and HTTP tests retain their separate
local test database. The Docker app requires Redis but no longer waits for
local PostgreSQL. Restart a running API process or recreate the app container
to load the new connection settings.

The Neon CLI was installed under the existing Node 22 installation. If your
shell cannot find it, first run `nvm use 22.23.2`.

## Drizzle repositories

Project, task, and user repositories use the shared Drizzle client in
`src/db/index.ts`, backed by the existing `pg` pool. Workspace project and task
responses use explicit camelCase fields. Membership permissions are enforced
in services, and mutations lock the workspace and check permissions inside the
same transaction. Workspace task reads currently query PostgreSQL directly.

The schema's custom date mappings reuse `pg` parsers so existing timestamps
and date values keep their previous JavaScript types and timezone behavior.
Login uses the Drizzle-backed `findUserByEmail` repository function and bcrypt
password verification. Refresh sessions are persisted in PostgreSQL and protected
by user/session row locks during rotation and revocation.

## Local demo seed

After applying all Drizzle migrations to an empty local `oriva_migration_test`
database, run `npm run db:seed`. The script reads `TEST_DATABASE_URL` from
`.env.test` (an existing environment value takes priority), reuses its local
credentials, and always targets `oriva_migration_test`. It refuses remote hosts.
It does not create the database or run migrations.

The seed creates a Demo Owner (`demo.owner@example.com`, local demo password
`LocalDemo123!`), one Demo Workspace with an owner membership, one active Demo
Project linked to that workspace, four default task statuses (Backlog, In Progress,
Review, Done), and two tasks: Plan the project (done)
and Build the first feature (on progress). The password is stored as a bcrypt
hash. New projects, statuses, and tasks use January 1, 2026 as their creation date. IDs remain
database-generated.

All inserts commit together or roll back on failure. A transaction-scoped lock
serializes simultaneous seed runs. Reruns reuse demo records by email,
creator/workspace name, workspace/creator/project name, and project/task title,
preserving edits, existing membership roles, passwords, and existing statuses
matched by project/name;
missing demo records are recreated. Renaming those identifying fields makes
the original demo record missing, so the next run recreates it. The script
does not delete records, send email, access Redis/S3, or connect to Neon.

Run `npm run typecheck:seed` to check the scripts and `npm run test:seed` for
regression coverage. Seed tests require the existing local `oriva_test` schema
and use connection-private temporary tables and sequences, removed on disconnect.

## Request tracing

Login requests are limited to 10 per IP address per 15 minutes, before login
validation and password checking. Further requests return 429 with a request ID
and `Retry-After` header. Counts use process memory: restarting the API resets
them, and multiple API processes do not share counts.

Every request receives a server-generated `X-Request-ID`. The request logger
records that ID, timestamp, method, full path without the query string, response
status, and duration as JSON after the response finishes. It does not log request
bodies or headers.

The central error handler includes `requestId` in malformed JSON (400), validation
(422), and unexpected error (500) responses. Unexpected errors produce a matching
JSON error log without exposing the error message to clients or logs.
