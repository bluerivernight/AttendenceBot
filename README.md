# AttendanceBot — Discord Bot

A complete employee time-tracking system with:
- **Discord Duty Panel** — interactive check-in/check-out/break with timezone-aware ephemeral responses
- **Voice Channel Attendance** — automated VC session logging with Ed25519 cryptographic signatures
- **Manager Override & Audit Trail** — protected session edits with immutable PostgreSQL audit logs
- **Local Timezones** — IANA timezone config per employee, all UTC storage
- **Next.js Web Dashboard** — admin portal, realtime reporting, CSV export, session corrections
- **Ed25519 Verification** — public signature challenge anyone can verify

---

## Quick Start

```bash
# 1. Clone & install
git clone https://github.com/bluerivernight/AttendenceBot
cd attendance-bot
npm install

# 2. Copy env vars
cp .env.example .env
# Fill in SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
# DISCORD_BOT_TOKEN, DISCORD_CLIENT_ID,
# ED25519_PRIVATE_KEY, ED25519_PUBLIC_KEY, VERIFIER_URL

# 3. Run Supabase migrations
supabase db reset # or: supabase migration up

# 4. Start bot
npm run dev  # starts Next.js dev server
# In another terminal:
node src/bot/index.ts  # starts Discord bot
```

---

## Architecture & State Machine

### Session FSM (`OFFLINE` → `WORKING` → `ON_BREAK` → `COMPLETED`)

| Current | Trigger | Next | Edge Cases |
|---------|---------|------|------------|
| OFFLINE | `Check in` | WORKING | No open session → new `work_sessions` row |
| WORKING | `Break / resume` | ON_BREAK | No active break → insert `break_logs`; resume → update `break_logs.end_iso` |
| WORKING | `Check out` | COMPLETED | Close open break first via `rpc_checkout_session()`, then finalize |
| ON_BREAK | `Check out` | COMPLETED | Same as above — close break before finalize |
| COMPLETED | N/A | COMPLETED | Immutable — reopen via `/session edit` (manager only) |

All state changes are **written to Supabase immediately**; zero in-memory state.

### Edge Cases Handled
- Bot restart mid-session: `check_in_at`/`status` in DB determines current state
- Double-click/button spamming: Supabase row-level locking via `updated_at` and RPC atomicity
- Voice channel leave with active duty session: break auto-closed, session finalized

---

## Supabase Schema & RLS

**Key Tables:**
- `profiles` — one row per auth.user; carries `tier`, `timezone`, `discord_user_id`
- `work_sessions` — check-in/check-out, gross/break/net ms, `manager_edited` flag
- `break_logs` — sub-rows of active sessions; `session_id FK`, `start_iso`, `end_iso`, `duration_ms`
- `voice_sessions` — signed VC attendance; `session_id UNIQUE`, `ed25519_signature`
- `session_audit_logs` — immutable audit trail of manager overrides; `modified_by_auth_id FK`, `signature`
- `guild_configs` — server-level settings

**RLS Policies (per table):**
- `profiles`: select/update own row; staff select via `current_tier()`
- `work_sessions`: employee own sessions; staff select/update all
- `break_logs`: employee own session rows; staff read
- `voice_sessions`: staff read only (signatures are public)
- `session_audit_logs`: staff read + insert

---

## Cryptographic Ed25519 Pipeline

### Canonical String
```
session_id|user_id|channel_id|start_iso|end_iso|duration_sec
```
All timestamps are ISO-8601 UTC (`2026-11-09T08:05:00.000Z`). No trailing whitespace.

### Functions (src/lib/crypto.ts)
- `canonicalString({session_id, user_id, channel_id, start_iso, end_iso, duration_sec})` → `string`
- `signPayload(payload, privateKeyPem)` → `base64url` signature
- `verifySignature(payload, signatureB64, publicKeyPem)` → `boolean`

### Usage in Voice Attendance (stage 2 embed)
```js
const payload = `${sessionId}|${userId}|${channelId}|${startIso}|${endIso}|${durationSec}`;
const signature = signPayload(canonicalString({session_id: sessionId, user_id: userId, channel_id: channelId, start_iso: startIso, end_iso: endIso, duration_sec: durationSec}), privateKey);
```

### Public Verifier (`/verifier?id=...`)
- Fetches the `voice_sessions` row by `session_id`
- Reconstructs the canonical payload
- Calls `verifySignature(payload, signature, publicKeyPem)`
- Displays ✅ Valid / ❌ Invalid

---

## Discord Bot Features

### Duty Panel (ClockyBot-Style)
- Persistent embed in a public channel showing live counts + `<t:UNIX:R>` timestamp
- Buttons: `My status` (primary), `Check in` (success), `Break / resume` (secondary), `Check out` (secondary)

### Interactive Replies (ephemeral)
- `Check in` → inserts new `work_sessions` row + updates panel counters
- `Break / resume` → toggles `break_logs` row; net-work calculation pauses during break
- `My status` → ephemeral embed with elapsed time, break time, total hours logged, converted to employee's local timezone
- `Check out` → closes open break, runs `rpc_checkout_session()`, updates panel, calculates net duration

### Voice Channel Attendance (AttendiBot-Style)
- `voiceStateUpdate` listener → on tracked VC leave:
  - Stage 1 embed (blue `#3498db`): `Voice leave`, member, channel, tracked duration
  - Stage 2 embed (green `#2ecc71`): `Session complete`, member, channel, duration, `session_id|sig`, footer `Signed · Ed25519`
  - Stage 3 embed (amber `#e67e22`): `Challenge this record` + `Verify · yourdomain.com/verifier?id={uuid}`

### Slash Commands
| Command | Subcommands |
|---------|-------------|
| `/timezone` | `set <iana>`, `view` |
| `/config` | `set key value` (staff only), `view` |
| `/session` | `edit`, `add`, `force-checkout` (staff only) |
| `/export csv` | Generate CSV via bot command or Dashboard endpoint |

---

## Next.js + Supabase Web Dashboard

### Protected Routes
- `/admin` — admin portal (invite/create managers, session edit modals, reporting table, CSV export)
- `/verifier` — public signature verification page
- `/export-csv` — dashboard export endpoint

### Admin Portal Features
- Realtime table of `work_sessions` (with Realtime subscription)
- Filter by status, employee, date range
- Session correction modal → writes to `work_sessions` + inserts `session_audit_logs` with Ed25519 signature
- CSV Export: RFC 4180 compliant, 12 columns including Employee Name, Discord ID, Check-In Local, Gross/Break/Net Duration, Manager Edited Boolean, Ed25519 Signature

### Signature Verifier Page (`/verifier?id=...`)
- Fetches the session from Supabase
- Reconstructs canonical payload, verifies Ed25519 signature
- Displays result with session details

### CSV Export Columns
```
Session UUID | Employee Name | Discord ID | Check-In (UTC) | Check-In (Local) | Check-Out (Local) | Employee Timezone | Gross Duration (mins) | Break Duration (mins) | Net Work Duration (mins) | Manager Edited (Boolean) | Ed25519 Signature
```

---

## Deployment & Environment

### Required `.env` variables

| Variable | Description | Secret? |
|----------|-------------|---------|
| `SUPABASE_URL` | Supabase project URL | Yes (not to client) |
| `SUPABASE_ANON_KEY` | Public anon key | Yes (embed in frontend, safe) |
| `SUPABASE_SERVICE_ROLE_KEY` | Admin key — **never ship to client** | **Critical** |
| `DISCORD_BOT_TOKEN` | Discord bot token | Yes |
| `DISCORD_CLIENT_ID` | Discord app client ID | Yes |
| `ED25519_PRIVATE_KEY` | Base64url private key for signing | **Critical** |
| `ED25519_PUBLIC_KEY` | Base64url public key for verification (NEXT_PUBLIC_ allowed) | Yes |
| `VERIFIER_URL` | Base URL for `/verifier?session_id=...` | Yes |
| `NEXTAUTH_URL` | NextAuth callback URL | Yes |
| `NEXTAUTH_SECRET` | Random secret for session signing | Yes |

### Supabase CLI Setup
```bash
supabase init
supabase db connect  # verify tables created
supabase migration up  # apply 001_init.sql
supabase functions new duty-panel  # optional: serverless duty panel updates
```

### Realtime Subscription
Supabase must have Realtime enabled on tables:
- `work_sessions` — for live duty panel sync
- `break_logs` — for break-state updates
- `voice_sessions` — for new VC attendance entries

---

## Code Organization

```
src/
├─ app/              # Next.js app router
│   ├─ admin/        # Admin portal
│   ├─ verifier/     # Public Ed25519 verifier
│   └─ api/session/edit/route.ts
├─ bot/              # Discord bot
│   ├─ duty-handlers.ts    # Check-in/break/checkout logic
│   ├─ voice-listener.ts   # voiceStateUpdate, 3-stage logging
│   ├─ embeds.ts           # Embed builders, formatting helpers
│   └─ index.ts            # Bot entry, command dispatch
├─ slashcommands/        # Discord slash commands
│   └─ index.ts
└─ lib/
  ├─ crypto.ts     # Ed25519 canonical signing/verification
  └─ supabase.ts   # Supabase client (shared)
```

---

## Security Constraints (strictly enforced)

- ❌ **No in-memory maps/arrays** for active sessions → all state persisted to Supabase
- ❌ **No local timestamps** in DB → all timestamp columns are `TIMESTAMPTZ` UTC
- ❌ **No placeholder `// TODO` comments** — every query and duration calc is complete
- ❌ **No client exposure** of `SUPABASE_SERVICE_ROLE_KEY` or `ED25519_PRIVATE_KEY`
- ✅ **All timestamps UTC**, converted to local only via Intl timezone API in client views
- ✅ **Per-user interaction locking** prevents double-click race conditions
- ✅ **RPC atomic checkout** ensures duration + audit log consistency
- ✅ **Ed25519 signatures** over canonical payloads enable public verification without admin privileges

---

## License

MIT — feel free to fork and adapt for your organization.
