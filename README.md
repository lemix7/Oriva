# Oriva API

A project and task management REST API built with Express, TypeScript, and PostgreSQL. Oriva supports user registration, JWT authentication, profile picture uploads to Amazon S3, and background registration notifications through BullMQ and Resend.

## Features

- User registration with bcrypt password hashing and optional profile pictures.
- JWT authentication with tokens that expire after one hour.
- Create, read, update, and delete projects and tasks.
- Project and task queries scoped to the authenticated project owner.
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
AWS_REGION=your-aws-region
AWS_ACCESS_KEY_ID=your-aws-access-key-id
AWS_SECRET_ACCESS_KEY=your-aws-secret-access-key
AWS_BUCKET_NAME=your-bucket-name
RESEND_API_KEY=your-resend-api-key
```

Replace these example values with your own configuration. `.env` is excluded from Git.

Redis settings are currently defined in `src/config/redis.ts`; they are not read from environment variables.

### 3. Prepare PostgreSQL

The repository does not currently include database migrations or a schema setup script. Before running the API, provision the tables and relationships expected by the queries:

- `users`: `id`, `name`, `email`, `password`, `profile_pic_key`.
- `projects`: `id`, `name`, `description`, `status`, `user_id`, `created_at`.
- `tasks`: `id`, `title`, `description`, `status`, `project_id`.

`projects.user_id` references a user, and `tasks.project_id` references a project. The lists above describe the columns used by the application, not a complete schema definition. Configure types, constraints, defaults, and deletion behavior in your database.

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
- `POST /login` — returns a JWT for valid credentials.

### Protected user endpoints

- `GET /users` — lists users.
- `GET /users/:user_id` — retrieves matching user records.
- `PUT /users/:user_id` — updates a user's name and email.
- `DELETE /users/:user_id` — deletes a user.

These endpoints require authentication but currently do not enforce per-user ownership or administrator roles. User reads currently select all columns, including password hashes; review access control and response fields before exposing these endpoints publicly.

### Protected project endpoints

- `GET /users/projects` — lists the authenticated user's projects.
- `GET /users/projects/:project_id` — retrieves an owned project.
- `POST /users/projects` — creates a project.
- `PATCH /users/projects/:project_id` — marks an owned project as `completed`.
- `DELETE /users/projects/:project_id` — deletes an owned project.

Project creation accepts `name` (at least 3 characters), optional `description`, and `status`: `active`, `inactive`, `pending`, or `completed`.

### Protected task endpoints

- `GET /projects/:project_id/tasks` — lists tasks in an owned project.
- `GET /projects/:project_id/tasks/:task_id` — retrieves matching task records.
- `POST /projects/:project_id/tasks` — creates a task in an owned project.
- `PATCH /projects/:project_id/tasks/:task_id` — marks a task as `done`.
- `DELETE /projects/:project_id/tasks/:task_id` — deletes a task in an owned project.

Task creation accepts `title` (at least 3 characters), optional `description`, and `status`: `done`, `cancelled`, or `on progress`.

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

Log in and copy the `token` from the response:

```bash
curl -X POST http://localhost:4000/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"alex@example.com","password":"example-password"}'
```

Create a project:

```bash
curl -X POST http://localhost:4000/users/projects \
  -H 'Authorization: Bearer YOUR_TOKEN' \
  -H 'Content-Type: application/json' \
  -d '{"name":"Website launch","description":"Prepare the launch","status":"active"}'
```

Use the returned project ID to create a task, replacing `1` as needed:

```bash
curl -X POST http://localhost:4000/projects/1/tasks \
  -H 'Authorization: Bearer YOUR_TOKEN' \
  -H 'Content-Type: application/json' \
  -d '{"title":"Draft homepage","status":"on progress"}'
```

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
Database access requires `DATABASE_URL`; authentication requires `SECRET_KEY`;
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
project, or task rows. It does not include the future workspace blueprint.
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
`src/db/index.ts`, backed by the existing `pg` pool. Explicit projections retain
the API's snake_case fields, and cache versions are serialized as strings.
Task updates and deletes include the ownership check in the same SQL statement.
Task reads retain the previous flat join response, including project values
for column names shared by projects and tasks.

The schema's custom date mappings reuse `pg` parsers so existing timestamps
and date values keep their previous JavaScript types and timezone behavior.
The database schema and cache triggers are unchanged. Login uses the Drizzle-backed
`findUserByEmail` repository function; password checks and JWT behavior are unchanged.

## Local demo seed

After applying both Drizzle migrations to an empty local `oriva_migration_test`
database, run `npm run db:seed`. The script reads `TEST_DATABASE_URL` from
`.env.test` (an existing environment value takes priority), reuses its local
credentials, and always targets `oriva_migration_test`. It refuses remote hosts.
It does not create the database or run migrations.

The seed creates a Demo Owner (`demo.owner@example.com`, local demo password
`LocalDemo123!`), one active Demo Project, and two tasks: Plan the project (done)
and Build the first feature (on progress). The password is stored as a bcrypt
hash. New projects/tasks use January 1, 2026 as their creation date. IDs remain
database-generated.

All inserts commit together or roll back on failure. A transaction-scoped lock
serializes simultaneous seed runs. Reruns reuse demo records by email,
owner/project name, and project/task title, preserving edits and passwords;
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
