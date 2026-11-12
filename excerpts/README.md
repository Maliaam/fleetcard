# Code samples

Unchanged files from the private Fleetcard repository. Code and identifiers are in English; comments are in Polish, as written for the production project. This guide says what to look at in each file.

## `offline-sync/` — online-first editing with an offline safety net

**[`useCardEditor.ts`](offline-sync/useCardEditor.ts)** — the React hook behind the card form.
- `apply()` — every change updates state, is written to IndexedDB straight away (`dirty = true`) and schedules a debounced save.
- Loading a card — the server is the source of truth, but an unsynced local draft wins and is pushed up; with no network, the form opens from the local buffer.
- `doFlush()` — handles each failure class differently: expired session, card locked in the meantime (reload and switch to read-only), offline.
- `online` listener — drains the retry queue as soon as connectivity returns.

**[`cardSync.ts`](offline-sync/cardSync.ts)** — the replaceable sync layer.
- `markSynced(cardId, flushedAt)` — clears the dirty flag only if no newer edit arrived while the request was in flight, so killing the app inside the debounce window never loses data.
- `isAuthError` / `isCardLockedError` / `isPermanentSaveError` — classify failures by PostgREST / SQLSTATE codes.
- `flushPending()` — a permanently rejected draft must not block the queue for other cards.
- `fetchCard()` — if any child-row query fails, the whole load fails; otherwise the next save would delete rows on the server.
- `normalizeDraft()` — migrates drafts stored by older app versions (single trailer → list).

**[`db.ts`](offline-sync/db.ts)** — the Dexie (IndexedDB) schema: one draft per card plus a dirty flag that doubles as the retry queue.

## `database/` — logic and security in Postgres

**[`save_card.sql`](database/save_card.sql)** — the atomic save RPC.
- `security invoker` — runs with the caller's rights, so RLS still applies; a locked or foreign card simply isn't found and the RPC raises.
- Upserts the header, then for each child table: upsert by client-generated UUID, then delete rows missing from the payload — all in one transaction.
- `p_trailers default null` — distinguishes an older client that doesn't send trailers ("don't touch") from an intentionally empty list ("delete all").
- Takes before/after snapshots and writes a field-level diff to the audit log, translating UUIDs to plate numbers so the log stays readable.

**[`guard_card_driver_columns.sql`](database/guard_card_driver_columns.sql)** — defence in depth.
- Tightens the RLS policies: a driver can only create `draft` cards and only move them `draft → submitted`.
- A `BEFORE` trigger silently overwrites office-owned columns for non-admins, so the existing frontend keeps working while a crafted request can't change anything it shouldn't.
- The trigger function has `EXECUTE` revoked, so it can't be called over the REST API.
