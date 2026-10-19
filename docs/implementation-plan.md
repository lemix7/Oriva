# Project management app — implementation plan

Prepared October 19, 2026. Status: proposed design; no application changes made.

## Outcome

Build a collaborative project management web app: an owner creates a workspace, invites teammates, creates a project, assigns work, discusses tasks, tracks deadlines and dependencies, and monitors progress.

Assumptions: one developer; existing Express/TypeScript/PostgreSQL backend stays; React/TypeScript is the proposed frontend; one deployable API plus a separately running worker. Estimates are focused workdays, not deadlines. Allow extra time for learning, UI design, and deployment issues. The current SQL schema was not available in the inspected files, so verify it before writing migrations.

## Release boundaries

**First usable release:** phases 0–3. Workspace membership, permissions, projects, task board/list, assignments, comments, and activity history. Deploy a preview early.

**Portfolio release:** phases 4–7. Notifications, dependencies, milestones, reports, measured caching, automated deployment, and a complete demo.

**Optional extension:** phase 8. Real-time updates. Defer sprints, time tracking, billing, AI features, and external integrations until the core release is finished.

## Phase 0 — trustworthy foundation (3–5 days)

- [ ] Fix task-list empty-result logic, login status codes, swallowed errors, and false success on missing updates/deletes.
- [ ] Make failed email jobs throw so BullMQ can retry them.
- [ ] Separate app construction from server startup; standardize errors and request validation.
- [ ] Inspect existing database; add versioned migrations and deterministic seed data.
- [ ] Add integration tests for login, CRUD, and cross-user access. Run build and tests in CI.
- [ ] Add environment validation, request IDs, structured logs, upload limits, and login rate limits.
- [ ] Add Docker development setup for API, worker, PostgreSQL, and Redis.

Exit check: a clean setup can migrate, seed, and run tests; known bugs have regression coverage; missing secrets fail startup clearly; email failure reaches the retry path.

## Phase 1 — workspaces and permissions (4–6 days)

Depends on phase 0.

- [ ] Create workspaces and owner/editor/viewer memberships.
- [ ] Add expiring email invitations; store token hashes; allow revocation and single-use acceptance.
- [ ] Check the authenticated account email matches the invitation before acceptance.
- [ ] Add member removal, role updates, and atomic ownership transfer.
- [ ] Move existing personal projects into one private workspace per existing owner.
- [ ] Centralize workspace authorization and apply it to every nested resource.
- [ ] Replace general user-directory access with a current-user profile and workspace member lists.

Exit check: two seeded workspaces cannot access each other's projects, tasks, files, comments, or reports. Viewers cannot mutate workspace content. The last owner cannot leave or be removed. Simultaneous invitation acceptance creates one membership.

## Phase 2 — task planning and first frontend (6–9 days)

Depends on phase 1. Build each API slice with its corresponding screen.

- [ ] Create app shell: login/register, workspace switcher, project list, members/settings.
- [ ] Support task title, description, priority, due date, one assignee, and project-specific status.
- [ ] Add project labels, one-level subtasks, and stable board ordering.
- [ ] Build task list, Kanban board, task detail panel, and My Tasks page.
- [ ] Add bounded pagination and filters for status, assignee, priority, label, overdue, and search.
- [ ] Protect updates with a task version to detect concurrent edits.
- [ ] Handle loading, empty, error, forbidden, and expired-session states in the UI.

Exit check: two accounts can share a project; an editor assigns a task, changes its status, and finds it through filters. Invalid cross-workspace assignees are rejected. A stale update returns a conflict and the UI offers a refresh.

## Phase 3 — discussion and change history (3–5 days)

Depends on phase 2. This completes the first usable release.

- [ ] Add paginated task comments, editing/deleting one's own comments, and owner moderation.
- [ ] Record task creation, assignment, status, deadline, and milestone changes.
- [ ] Commit task mutations and activity records in the same database transaction.
- [ ] Display discussion and activity in task details; show a project activity feed.
- [ ] Deploy a preview with seeded demo accounts and documented startup instructions.

Exit check: the activity feed attributes changes to the correct actor and shows old/new values; viewers can read but cannot comment; deleted tasks leave intelligible historical events without exposing inaccessible content.

## Phase 4 — notifications and reliable delivery (4–6 days)

Depends on phase 3.

- [ ] Notify on assignments, mentions, and deadlines; do not notify the actor about their own action.
- [ ] Add notification inbox, read state, and per-user email preferences.
- [ ] Add a transactional outbox and a dispatcher into BullMQ.
- [ ] Add retries with backoff, delivery deduplication, failed-job visibility, and worker shutdown handling.
- [ ] Schedule reminders using UTC timestamps; honor user timezone preferences in display.
- [ ] Recheck membership and task state before sending delayed notifications.

Exit check: a Redis outage does not lose a committed assignment event; queued work is delivered after recovery; repeated dispatch does not duplicate in-app notifications; moved deadlines do not trigger outdated reminders. Document the residual duplicate-email risk if the email provider lacks idempotency support.

## Phase 5 — dependencies and milestones (4–6 days)

Depends on phases 2–3; can precede phase 4 if scheduling is the preferred showcase feature.

- [ ] Link tasks as prerequisites within the same project.
- [ ] Reject self-dependencies and cycles, including concurrent requests that would jointly create a cycle.
- [ ] Block completion while prerequisites remain incomplete; show the reason in task details.
- [ ] Add milestones with deadlines and task grouping; add a milestone progress screen.
- [ ] Keep reopen behavior explicit: reopening a prerequisite flags completed dependents for attention without silently reopening them.

Exit check: A → B → C cannot become C → A. Concurrent opposite-edge creation cannot bypass validation. Completing B fails while A remains incomplete. Milestone progress updates as tasks move into a done status.

## Phase 6 — reports and measured caching (3–5 days)

Depends on phases 4–5.

- [ ] Add project completion, overdue work, blocked work, milestone progress, and open tasks by assignee.
- [ ] Index measured slow queries and inspect query plans before adding caches.
- [ ] Cache project summaries using workspace/project-scoped keys and bounded TTLs.
- [ ] Invalidate on relevant writes; authorize before serving cached content; fall back to PostgreSQL when cache access fails.
- [ ] Record reproducible before/after results: p50/p95 latency, error rate, database query count, and cache hit rate.

Exit check: report totals agree with seeded task records; cache updates follow assignment/status/deadline edits; revoking membership immediately denies cached requests. Benchmark report identifies dataset size, hardware, concurrency, duration, and warm/cold runs. No invented performance claims.

## Phase 7 — release and portfolio evidence (3–5 days)

Depends on phases 0–6.

- [ ] Produce production images and deploy API/frontend plus a separate worker process.
- [ ] Add readiness/liveness checks, graceful shutdown, database backups, and a restore exercise.
- [ ] CI runs type checks and tests, builds images, and deploys through a controlled release workflow.
- [ ] Apply migrations once per deployment; document rollback and forward-repair steps.
- [ ] Publish OpenAPI documentation, architecture/ER diagrams, demo instructions, and a short walkthrough.
- [ ] Run end-to-end tests for the complete demo journey and failure cases.

Exit check: a fresh deployment can reproduce the demo, a backup can be restored, and another developer can run the project using only the README and example environment file.

## Phase 8 — optional real-time collaboration (3–5 days)

Depends on phase 7. Keep REST writes and add server-sent events for task changes and notifications. A WebSocket transport can replace this if bidirectional interactions later need it.

- [ ] Authenticate streams, scope subscriptions, and disconnect or reauthorize revoked members.
- [ ] Publish events only after commits; use Redis pub/sub for multiple API replicas.
- [ ] On reconnect or missed events, refetch authoritative REST data.
- [ ] Test two-browser updates and permission revocation during an active stream.

Exit check: one member's committed change appears in a second browser; reconnect restores current data; removed members stop receiving events.

## Effort and working method

Phases 0–7 total approximately 30–47 focused workdays. At 10 focused hours/week and 6 hours per focused day, budget roughly 18–28 weeks, plus learning and contingency. Phases 0–3 alone are approximately 16–25 days. Adjust after the first phase using actual throughput.

For each feature: define permission rules and API contract → migration → service logic → integration tests → screen → demo. Keep each slice reviewable. Update this checklist only after its exit checks pass.

## Final demo script

1. Owner creates a workspace and invites an editor and viewer.
2. Editor creates a project and milestone, then assigns a task with a deadline.
3. Editor adds a prerequisite, discusses the task, and mentions the owner.
4. Owner receives a notification; viewer can inspect progress but cannot edit.
5. Attempted premature completion is rejected; prerequisite completion unblocks work.
6. Complete the task and show the corresponding history and report changes.
7. Show automated tests, deployment setup, and measured caching results.

Technical details and resource contracts: [Product and system blueprint](project-management-blueprint.md).
