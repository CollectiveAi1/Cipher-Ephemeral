# Product Requirements Document — Cipher

| Field | Value |
| --- | --- |
| **Project** | Cipher — End-to-End Encrypted Ephemeral Messenger |
| **Document version** | 2.1.0 (adds calls and communities to the 2.0.0 overhaul) |
| **Status** | Implemented — full stack, functional |
| **Codename** | Project Phoenix |
| **Repository artifact** | `/PRD.md` |

---

## 0. What changed from v1.0.0, and why

v1.0.0 described a single-screen prototype with a nice composer and called it an
enterprise zero-trust product. The gap between those two things was the entire product.
This revision closes it. Every item below was a defect in v1, not a missing nice-to-have.

| # | v1.0.0 defect | v2.0.0 resolution |
| --- | --- | --- |
| 1 | **No identity.** No accounts, no login, no authorization. `Message.sender` was a client-side object anyone could forge. | Account registration, scrypt password hashing, HMAC-signed session tokens, per-request authorization, per-connection WebSocket authentication (§5, §7). |
| 2 | **No server.** "Peer RAM", "memory purge", and "cryptographic shredding" described a React `useState` array. Nothing was transmitted anywhere. | Real transport: HTTP API + WebSocket gateway, SQLite persistence, server-authoritative expiry and hard deletion (§6, §7). |
| 3 | **Claimed E2EE as Phase 2 while claiming "zero data retention debt" in Phase 1.** Those are contradictory: plaintext on a server is retention debt. | E2EE is **Phase 1, shipped**. ECDH P-256 + HKDF + AES-256-GCM. The server stores ciphertext and never holds a decryption key (§4). |
| 4 | **Ephemerality was a visual effect.** Expiry only unmounted a DOM node. The message was still in client memory, in any screenshot, and (had a server existed) in the database forever. | Three enforced layers: client purge, server-side expiry filter on read, and a reaper that hard-deletes ciphertext rows. Expired content is unrecoverable because the ciphertext is gone (§4.4, §6.4). |
| 5 | **"Monotonic time prevents clock tampering"** — asserted, never specified. A client-side countdown is authored by the attacker. | Expiry is computed from **server** timestamps. The client clock is used only for sub-second countdown animation and is continuously corrected by a measured server-time offset (§4.5). |
| 6 | **One hardcoded channel** (`#Project-Phoenix`), 12 fake members. | Direct messages and group conversations, membership management, conversation list with unread counts (§3.3). |
| 7 | **No threat model.** Marketed GDPR/HIPAA compliance with no stated adversary, so the claims were unfalsifiable. | Explicit threat model stating what Cipher defeats and what it provably cannot (§4.6). Compliance language removed; Cipher is not certified and the PRD no longer implies it. |
| 8 | **Spec was unbuildable.** The dial section had empty formulas and dangling variables (`θ`, "(`...`)"), so the central feature had no definition. | Burn scale is a single specified piecewise-logarithmic function, implemented once in `shared/burn-scale.ts`, used by client and server, covered by unit tests (§3.1). |
| 9 | **No messenger table stakes.** No presence, typing, receipts, reactions, replies, media, or search — table stakes for a WhatsApp rival. | All shipped (§3.3–§3.7). |
| 10 | **No abuse or integrity controls.** | Rate limiting, payload caps, request validation, workspace-level maximum-TTL enforcement (§7.4, §8). |
| 11 | **`expiresInSeconds` on the message meant "burn starts at send".** For a credential handoff the recipient may not be looking; a 15s message is already gone. | Two burn modes: **absolute** (from send) and **on-read** (timer starts at first recipient decryption), selectable on the dial (§3.2). |
| 12 | **Design system was a color list.** | Tokenized palette, decay engine as a pure function of remaining fraction, specified motion and reduced-motion fallback (§3.2, §9). |

---

## 1. Executive summary

### 1.1 Problem

Professional communication tooling is built for indefinite archival. Persistence is
genuinely valuable for decisions and documentation, and genuinely a liability for a
specific, narrow class of content: credentials in flight, incident response detail,
unresolved negotiation positions, personal information with no reason to outlive its use.

That content is routinely sent through channels that keep it forever, because the
alternative is friction — out-of-band tools, manual cleanup, "delete this after you read
it" asked in prose and never honoured.

Existing disappearing-message features are coarse: a per-conversation toggle with a few
fixed intervals, applied to everything or nothing, set in a settings submenu far from the
moment of composition.

### 1.2 Vision

Cipher makes message lifespan a **first-class composition parameter** — chosen per message,
at the moment of writing, with the same immediacy as choosing a recipient — and makes the
guarantee real by holding the keys on the client and deleting the ciphertext on the server.

Two mechanics carry the product:

- **The Burn Dial** — a radial, logarithmic control spanning 15 seconds to 7 days,
  scrubbable in a single gesture, with on-read and absolute modes.
- **Temporal Chromatic Decay** — a message's remaining lifespan is legible from its colour
  and motion, so expiry is ambient rather than something you audit in metadata.

### 1.3 What Cipher is not

Stated plainly, because v1 implied otherwise:

- Not a compliance product. No certification is claimed for GDPR, HIPAA, SOC 2, or any
  other regime. Data minimization is an architectural property here, not an attestation.
- Not an archive. There is no export, no admin retrieval, no message recovery. Expired
  means gone, including for the sender.
- Not protection against a recipient who chooses to keep a copy (§4.6).

---

## 2. Personas and use cases

| Persona | Role | Need | Cipher behaviour |
| --- | --- | --- | --- |
| Alistair | Platform engineering, SecOps | Hand a teammate temporary cloud credentials mid-incident without creating a permanent copy or doing post-incident cleanup. | Composes with the dial at 5m, **on-read** mode. The timer starts when the recipient actually decrypts, so a credential doesn't expire unread. Ciphertext is hard-deleted at expiry. |
| Sarah | Corporate strategy | Discuss bid positions that should not be sitting in a searchable archive two years from now. | Group conversation with a 12h default. Colour shift makes the remaining window visible without checking timestamps. |
| Marcus | Legal and governance | Reduce the volume of retained personal data to what is actually needed. | Workspace maximum-TTL cap (`CIPHER_MAX_TTL_SECONDS`) enforced server-side; no message can outlive policy regardless of client. |
| Priya | Journalism, high-risk source contact | Needs the server operator to be unable to read messages even under legal compulsion. | E2EE with client-held keys; the server has ciphertext and routing metadata only (§4.6 states the metadata it does have). |

---

## 3. Functional requirements

### 3.1 The Burn Dial — specification

A radial control in the composer dock. One pointer gesture selects any lifespan from 15
seconds to 7 days.

**Geometry.** A 280° sweep, gap centred at the bottom. Start angle 130°, end angle 410°
(clockwise, screen coordinates, 0° = positive x-axis). Track radius 52px, stroke 10px,
knob radius 13px.

**Input.** Angular projection from the pointer vector to the dial centre, `atan2`-derived,
normalized into the sweep. Movement across the bottom gap is clamped to the nearer
terminal rather than wrapping, so a fast drag cannot jump 15s → 7d. Pointer Events only
(`setPointerCapture`), so mouse, touch, and stylus take one code path. Keyboard: arrow keys
step one notch, Home/End jump to terminals, dial is a focusable `slider` role with
`aria-valuetext`.

**Scale.** Normalized dial position `t ∈ [0,1]` maps to seconds by a four-band piecewise
geometric interpolation. Within each band, `seconds = lo · (hi/lo)^u` where `u` is the
band-local position. This yields constant *proportional* resolution — a given arc length
is the same relative change anywhere on the dial.

| Band | `t` range | Range | Purpose |
| --- | --- | --- | --- |
| Flash | 0.00 – 0.25 | 15s → 5m | Credentials, one-time codes |
| Tactical | 0.25 – 0.50 | 5m → 1h | Live incident coordination |
| Working day | 0.50 – 0.75 | 1h → 24h | Normal sensitive conversation |
| Extended | 0.75 – 1.00 | 24h → 7d | Documents under negotiation |

Notch detents at 15s, 1m, 5m, 1h, 12h, 1d, 7d snap within 1.5° and are the keyboard step
targets. The function is bijective: `secondsToDialPosition` is its exact inverse, verified
by round-trip tests. Both live in `shared/burn-scale.ts` and are the single source of truth
for client rendering, keyboard stepping, and server validation.

**Feedback.** Centre hub shows the formatted lifespan (`15s`, `5m`, `1h`, `7d`). The filled
arc is tinted along the same decay ramp, indexed by dial position rather than by elapsed
time: a 15s burn reads cool cyan, a 7d burn reads warm amber. The dial therefore shows the
retention cost of the choice while it is being made, reusing one colour language for both
"how long is left" and "how long did you ask for".

### 3.2 Burn modes and Temporal Chromatic Decay

**Modes.**

- **Absolute** — `expiresAt = sentAt + ttl`. Default. Predictable for everyone.
- **On-read** — `expiresAt` is null until the first non-author member decrypts and
  acknowledges, then `expiresAt = firstReadAt + ttl`, fixed thereafter. A hard ceiling of
  `ttl + 7d` prevents an unread message from persisting indefinitely.

Mode is chosen in the composer and is immutable once sent, since it is part of what the
recipient was promised.

**Decay.** `remaining = (expiresAt − now) / (expiresAt − sentAt)`, clamped to `[0,1]`, is
mapped by a pure function to one of four stages with an interpolated gradient:

```
remaining:  1.0 ──────────── 0.5 ──────────── 0.15 ──────────── 0.05 ──────── 0
stage:       FRESH            ACTIVE            AGING            EXPIRING
gradient:  cyan→violet      cyan→teal        teal→amber       amber→red
           #22D3EE #8B5CF6  #22D3EE #14B8A6  #14B8A6 #F59E0B  #F59E0B #DC2626
```

Rendered as a 2px gradient border on the bubble plus a monospace ticker
(`expires in 1d 12h`, `expires in 42s`). A 4s breathing pulse (scale delta 1.008) runs only
on `EXPIRING` messages, not all of them — v1 animated everything, which made the signal
meaningless. All motion is suppressed under `prefers-reduced-motion`, where stage is carried
by the border gradient and ticker alone.

Countdown updates on a single shared 1Hz interval for the whole message list, not a timer
per bubble.

### 3.3 Conversations

- **Direct messages** — created by selecting a user; idempotent, so opening a DM twice
  yields one conversation.
- **Groups** — named, member list, creator is admin, members can be added and removed.
- Conversation list shows last activity, unread count, and member presence for DMs.
- Per-conversation **default TTL** and **default burn mode**, pre-loading the dial so a
  conversation with an established norm doesn't require re-selection per message.

### 3.4 Messaging

Send, receive, and real-time delivery over WebSocket with HTTP fallback for history.
Replies quote a parent message (and degrade to "original message expired" when the parent
burns first). Emoji reactions, which inherit the parent's expiry. Optimistic local echo with
a pending state, reconciled on server acknowledgement. Ordered, gapless history pagination
by `(sentAt, id)` cursor.

### 3.5 Presence, typing, receipts

- Presence: `online` / `offline` with `lastSeenAt`, derived from live socket count per user,
  broadcast to conversation peers only.
- Typing: ephemeral, 4s server-side expiry, never persisted.
- Receipts: `delivered` when any device of the recipient receives it; `read` when decrypted
  and displayed. Read is what starts an on-read burn, so it is acknowledged explicitly by
  the client rather than inferred.

### 3.6 Media

Attachments are encrypted client-side with a per-attachment AES-256-GCM key, which is
itself encrypted into the message body. The server stores an opaque blob with no filename
and no content type beyond a size. Media inherits the message's expiry and is deleted by the
same reaper, so a burned message cannot leave a retrievable image behind. Cap: 25 MB.

### 3.7 Search

Client-side only, over messages currently decrypted in the local session. Server-side search
is impossible by construction and is not offered — a search index would be the plaintext
archive the product exists to avoid.

---

### 3.8 Calls

One-to-one voice and video over WebRTC, reachable from the Calls section or from any
direct message.

**Media.** WebRTC encrypts media with DTLS-SRTP regardless of application. What Cipher
adds is that the **signalling** is sealed too: SDP offers and ICE candidates carry network
addresses, so they are encrypted under the conversation key before the server relays them.
The server forwards bytes it cannot read and learns no candidate addresses from the payload.

**Connectivity is opt-in.** `CIPHER_ICE_SERVERS` is empty by default, which keeps calls on
the local network. A STUN server learns the caller's address, so reaching past NAT is a
deliberate configuration choice rather than one made silently for the user.

**The call log burns.** A call record carries an expiry like a message —
`CALL_LOG_TTL_SECONDS`, one day — and the reaper deletes it. A missed call does not sit in
a list forever, and the Calls list shows each record's remaining lifespan next to it. There
is no archive behind the list: a record that has burned is gone, not hidden.

**Lifecycle.** `ringing → active → ended`, or `missed` / `declined`. A call nobody answers
within `CALL_RING_TIMEOUT_MS` (45s) is recorded as missed rather than left ringing. Losing
every socket ends any call that account was in, so a peer is never left listening to a
connection that is not coming back. A call that was answered records `ended`; one that was
not records `missed`, so history distinguishes "we spoke" from "you were not there".

**Scope.** One-to-one only. A mesh group call needs per-peer connections this signalling
path does not model, and a half-working group call is worse than an honest "not yet" — so
the call controls appear on direct messages and nowhere else.

### 3.9 Communities

A community groups channels under one **retention policy**. This is the distinguishing
mechanic: where other products' communities only group conversations, a Cipher community
also governs how long anything inside it may live.

- **Retention ceiling.** The community sets a maximum lifespan. Every channel's Burn Dial
  is clamped to it — visibly, with the barred span drawn on the dial — and the server
  clamps again on every message, so the policy holds no matter which client sent it.
- Lowering the ceiling binds **new** messages only. Messages already sent keep the lifespan
  their sender was promised, because retroactively shortening a promise is a different
  product than this one.
- **Channels** are group conversations with a `community_id`. Each carries its own
  conversation key wrapped per member, so community membership is what grants access
  rather than a separate invitation per channel.
- **Announcement channels** (`post_policy = 'admins'`) accept posts from community admins
  only; every member still reads them.
- Admins create channels, add and remove members, and set the ceiling. Non-members get
  `404` rather than `403`, so the API does not confirm a community id exists.

## 4. Security architecture

### 4.1 Identity and keys

On registration the client generates an **ECDH P-256** identity keypair in WebCrypto.

- Public key → uploaded, served to peers, used to wrap conversation keys.
- Private key → exported, encrypted with AES-256-GCM under a key derived from the user's
  password via **PBKDF2-SHA256, 310,000 iterations**, random 16-byte salt. Only the
  ciphertext is uploaded.

The server therefore stores an encrypted private key it cannot open: the password never
leaves the client in a form that can decrypt it (the authentication hash is a separate
scrypt derivation over a different input). Sign-in on a new device fetches the wrapped key
and unwraps it locally.

**Consequence, stated plainly:** password loss is key loss. There is no recovery, by design.
The UI says so at registration.

**Session model.** The session token and the *wrapped* private key persist locally; the
unwrapped key never does. Reopening the app therefore shows an unlock prompt for the
password alone — the key is rebuilt in memory and is gone again on close. Persisting an
unwrapped key to disk would hand it to anything that can read local storage, which is the
trade most web messengers make and this one does not.

### 4.2 Conversation keys

Each conversation has a 256-bit AES-GCM **conversation key**, generated by its creator.
For each member, the key is wrapped as:

```
shared   = ECDH(wrapper_private, member_public)
wrapKey  = HKDF-SHA256(shared, salt = random 16 bytes, info = "cipher/ckey/v1")
wrapped  = salt || iv || AES-256-GCM(wrapKey, conversationKey)
```

The HKDF salt is random per wrap and carried in the blob, so wrapping never depends on an
id the server has not assigned yet. A member unwraps with `ECDH(their_private,
wrapper_public)`, which yields the same shared secret.

Because an admin who adds a member does the wrapping — and is not necessarily the creator —
each membership row records **`wrapped_by`**, and the conversation payload carries that
user's public key so the client derives against the right one — even if the wrapper has
since left the conversation. Adding a member grants them history that has
not yet expired, which the UI states at the point of adding.

### 4.3 Message encryption

`AES-256-GCM` under the conversation key, fresh 12-byte IV per message, with the message's
`conversationId`, `senderId`, and `ttlSeconds` bound in as **additional authenticated
data**. Binding the TTL into the AAD means a server that tampers with a message's lifespan
causes authentication to fail, rather than silently extending it.

### 4.4 Expiry enforcement — three layers

1. **Client** — expired messages are dropped from state and their plaintext and keys are
   released. Decrypted plaintext is held in a non-persisted map, never in `localStorage`.
2. **Server read path** — every query filters `expires_at > now`, so an expired message is
   unreachable the moment it expires, before any sweep runs.
3. **Reaper** — a sweep every 15s issues `DELETE` for expired messages, their reactions,
   receipts, and media blobs. Deletion is a real row delete, not a tombstone flag;
   SQLite is `VACUUM`ed on a 24h cycle to release the pages.

Because the server only ever held ciphertext, and the ciphertext row is deleted, expiry is
not a policy — there is no longer anything to decrypt.

### 4.5 Time authority

`sentAt` and `expiresAt` are assigned by the server from `Date.now()` and are the only
values that determine expiry. The client measures a time offset at connect
(`serverTime − clientTime`, median of three samples) and applies it when rendering
countdowns, so a skewed or tampered client clock changes the animation and nothing else.
Server-side elapsed-time checks use `process.hrtime.bigint()` where a monotonic source
matters, so an operator adjusting the system clock cannot extend a lifespan.

### 4.6 Threat model

**Defeated:**

| Adversary | Why it fails |
| --- | --- |
| Server operator, or anyone who compels or compromises them | The server holds ciphertext, wrapped keys, and routing metadata. No plaintext, no unwrapping key. |
| Database exfiltration or stolen backup | Yields ciphertext. Expired messages are absent entirely. |
| Network observer | TLS in transit, and the payload is already independently encrypted. |
| Malicious client extending a lifespan | TTL is in the AAD and expiry is server-computed; tampering breaks authentication. |
| Another user in the workspace | Conversation keys are wrapped per member; non-members cannot derive them. |

**Not defeated — accepted limitations, by design:**

| Limitation | Note |
| --- | --- |
| A recipient screenshotting, photographing, or retyping a message | No software can prevent this. Screenshot blur is deterrence, not a control, and is not claimed as one. |
| A compromised endpoint (keylogger, malware, memory dump of a live session) | Plaintext exists on the device while displayed. Out of scope. |
| Metadata | The server knows **who messaged whom, when, how large, and when it expires**, and for calls **who called whom, when, and for how long**. It cannot read content, and call signalling is sealed so it does not learn network candidates from the payload — though it necessarily sees each party's connecting IP. Metadata-blind routing is a future phase, not a current claim. |
| Malicious peer modifying their own client to retain plaintext | Possible, and not detectable by Cipher. Ephemerality is a mutual agreement the product makes easy to honour, not one it can enforce on a determined peer. |
| Forward secrecy against future key compromise | Conversation keys are long-lived. A compromised identity key exposes unexpired messages in shared conversations. Double Ratchet with per-message keys is Phase 2. |

---

## 5. HTTP API

All routes under `/api`. JSON in, JSON out. Authenticated routes take
`Authorization: Bearer <token>`. Errors are `{ "error": { "code", "message" } }` with
appropriate status.

| Method | Route | Purpose |
| --- | --- | --- |
| `GET` | `/health` | Liveness, server time, retention policy. |
| `POST` | `/auth/register` | Create account; body includes public key and wrapped private key. |
| `POST` | `/auth/login` | Exchange credentials for a token plus the wrapped private key. |
| `POST` | `/auth/logout` | Revoke the current token. |
| `GET` | `/users/me` | Current account. |
| `GET` | `/users` | Directory for starting conversations (`?q=` prefix search). |
| `GET` | `/conversations` | List with unread counts and last activity. |
| `POST` | `/conversations` | Create a DM or group with per-member wrapped keys. |
| `GET` | `/conversations/:id` | Detail: members, public keys, wrapped key for caller. |
| `PATCH` | `/conversations/:id` | Update name or per-conversation burn defaults. |
| `POST` | `/conversations/:id/members` | Add a member with their wrapped key. |
| `DELETE` | `/conversations/:id/members/:userId` | Remove a member (admin, or self as leave). |
| `GET` | `/conversations/:id/messages` | Unexpired history, cursor-paginated. |
| `POST` | `/conversations/:id/messages` | Send ciphertext with `ttlSeconds` and `burnMode`. |
| `POST` | `/messages/:id/read` | Acknowledge read; starts an on-read burn. |
| `POST` | `/messages/:id/reactions` | Add or toggle a reaction. |
| `DELETE` | `/messages/:id` | Sender burns their own message immediately. |
| `GET` | `/communities` | Communities the caller belongs to, with their channels. |
| `POST` | `/communities` | Create a community and its retention ceiling. |
| `GET` | `/communities/:id` | Detail: members, channels, ceiling. |
| `PATCH` | `/communities/:id` | Rename, re-describe, or change the ceiling (admin). |
| `POST` | `/communities/:id/members` | Add a member (admin). |
| `DELETE` | `/communities/:id/members/:userId` | Remove a member, or leave. |
| `POST` | `/communities/:id/channels` | Create a channel with per-member wrapped keys (admin). |
| `GET` | `/calls` | Recent call records. Burned records are absent, not hidden. |
| `POST` | `/media` | Upload an encrypted attachment blob. |
| `GET` | `/media/:id` | Download it, if the owning message is alive and the caller is a member. |

## 6. Data model

SQLite, foreign keys on, WAL. Full DDL in `server/db.ts`.

```
users            id, username, display_name, avatar_hue, password_hash, password_salt,
                 public_key, wrapped_private_key, key_salt, created_at, last_seen_at
sessions         token_hash (pk), user_id, created_at, expires_at
conversations    id, kind(dm|group), name, created_by, created_at, default_ttl_seconds,
                 default_burn_mode, dm_pair_key (unique), last_activity_at,
                 community_id (null unless a channel), post_policy(all|admins)
members          conversation_id, user_id, role(admin|member), wrapped_key, wrapped_by,
                 joined_at, last_read_at              (pk: conversation_id, user_id)
messages         id, conversation_id, sender_id, ciphertext, iv, media_id, reply_to_id,
                 ttl_seconds, burn_mode, sent_at, expires_at, hard_expires_at, first_read_at
receipts         message_id, user_id, delivered_at, read_at   (pk: message_id, user_id)
reactions        message_id, user_id, emoji                   (pk: message_id, user_id, emoji)
media            id, owner_id, byte_size, blob, created_at, expires_at
communities      id, name, description, created_by, created_at, avatar_hue, max_ttl_seconds
community_members community_id, user_id, role(admin|member), joined_at
                                                      (pk: community_id, user_id)
calls            id, conversation_id, initiator_id, kind(audio|video), started_at,
                 status(ringing|active|ended|missed|declined), answered_at, ended_at,
                 ttl_seconds, expires_at
call_participants call_id, user_id, state(invited|joined|left|declined),
                 joined_at, left_at                    (pk: call_id, user_id)
```

`expires_at` is null while an on-read timer has not started; `hard_expires_at` is the
always-present ceiling the reaper enforces, so an unopened message still has a death date.

Indices on `messages(conversation_id, sent_at)`, `messages(expires_at)`,
`messages(hard_expires_at)`, `members(user_id)`, `sessions(user_id)`, `media(expires_at)`.
Migrations are tracked by SQLite `user_version` and applied forward-only at startup.

### 6.4 Lifecycle

```
compose ──► dial selects ttlSeconds + burnMode
              │
              ▼
client encrypts under conversation key (TTL bound into AAD)
              │
              ▼
POST /messages ──► server assigns sentAt, computes expiresAt
              │                  (absolute: sentAt + ttl · on-read: null)
              ▼
WebSocket fan-out to members' live sockets ──► delivered receipt
              │
              ▼
recipient decrypts ──► read receipt ──► if on-read and first reader: expiresAt = now + ttl
              │
              ▼
reaper (15s) ──► DELETE message + receipts + reactions + media
              │
              ▼
message.expired broadcast ──► clients purge plaintext and unmount
```

## 7. Realtime protocol

Single WebSocket at `/ws`, token in the first frame (not the query string, which would land
in access logs). Frames are `{ type, ...payload }`.

**Client → server:** `auth`, `typing`, `ping`, `call.invite`, `call.accept`,
`call.decline`, `call.end`, `call.signal`.
**Server → client:** `ready`, `message.new`, `message.expired`, `message.read`,
`reaction.new`, `conversation.new`, `conversation.updated`, `community.updated`,
`presence`, `typing`, `pong`, `call.incoming`, `call.updated`, `call.signal`, `error`.

`call.signal` is an opaque relay: the payload is sealed under the conversation key, so the
server routes WebRTC negotiation it cannot read.

Delivery is at-least-once with client-side idempotency on message id. A socket that misses
frames while offline re-syncs through `GET /conversations/:id/messages`, which is the
authority. Heartbeat every 30s; a socket silent for 60s is terminated and its presence
released. Clients reconnect with exponential backoff and jitter, capped at 30s.

### 7.4 Abuse and integrity controls

Token-bucket rate limits: 30 messages / 10s per account, 120 API requests / 10s per
account. Authentication is throttled in two tiers — 10 attempts / 5min against a given
username, and 50 / 5min from a given address — so brute force against one account is
stopped without a shared NAT locking out a whole office. Payload caps: 16 KB ciphertext, 25 MB media. Every request body is
validated against an explicit schema; unknown fields are rejected rather than ignored.
`ttlSeconds` is clamped to `[15, min(604800, CIPHER_MAX_TTL_SECONDS)]` server-side.

## 8. Non-functional requirements

| Area | Requirement |
| --- | --- |
| Dial performance | 60 fps scrubbing. SVG `d` and transform updates only, no React state per pointer move, no layout-triggering properties. One `requestAnimationFrame` coalescer per gesture. |
| Message list | One shared 1Hz tick drives every countdown. Rendering 500 live messages must not drop frames. |
| Expiry latency | A message is unreadable within 1s of expiry (read-path filter) and physically deleted within 15s (reaper). |
| Crypto cost | Message encrypt/decrypt under 5ms on a mid-range laptop. Key unwrap on login under 500ms, dominated by PBKDF2 by design. |
| Responsive | Mobile-first. Under 640px the app is a single column — the conversation list is replaced by the open thread — and the composer stacks the input beneath the dial. From 640px up it is two panes with the dial beside the input. Primary controls (send, attach, back) are at least 44px on touch viewports. |
| Accessibility | WCAG 2.1 AA. Dial is a keyboard-operable slider with `aria-valuetext`; decay stage is conveyed by text as well as colour; `prefers-reduced-motion` honoured. |
| Durability | SQLite WAL. Expired data is intentionally non-durable. |
| Observability | Structured JSON request logs with duration and status; no message content, no ciphertext, no tokens in logs. |

## 9. Design system

Dark-first. Tokens in `web/app.css`.

| Token | Value | Use |
| --- | --- | --- |
| `--ink-900` | `#070B14` | App ground |
| `--ink-800` | `#0D1424` | Panels |
| `--ink-700` | `#151E33` | Raised surfaces, peer bubbles |
| `--edge` | `#1E2A44` | Hairlines |
| `--text-hi` | `#E8EEF9` | Primary text |
| `--text-lo` | `#8A9AB8` | Secondary text |
| `--cyan` | `#22D3EE` | Identity, self bubbles, focus |
| `--violet` | `#8B5CF6` | Fresh decay terminal |
| `--teal` | `#14B8A6` | Active decay |
| `--amber` | `#F59E0B` | Aging decay |
| `--red` | `#DC2626` | Expiring decay, destructive |

Type: system UI stack, tight tracking on numerics; countdown tickers in `ui-monospace` so
digits do not reflow as they tick.

## 10. Quality gates

`npm run verify` must pass clean, and is the definition of done:

1. `tsc --noEmit` on both the server and web projects, `strict` with
   `noUnusedLocals`, `noUnusedParameters`, `noUncheckedIndexedAccess`,
   `exactOptionalPropertyTypes`, `erasableSyntaxOnly`.
2. `eslint` with `typescript-eslint` recommended + `react-hooks`, zero warnings tolerated.
3. `vitest run` — unit coverage of the burn scale (including inverse round-trip), decay
   staging, token signing, password hashing, and the crypto envelope; integration coverage
   of the HTTP API and the realtime gateway against a live in-memory server.
4. `knip` — zero unused files, exports, dependencies, or types.

## 11. Roadmap

- **Phase 2 — Double Ratchet.** Per-message keys and forward secrecy, replacing long-lived
  conversation keys. Closes the last row of §4.6.
- **Phase 3 — Multi-device and verification.** Per-device keys, safety-number verification
  to defeat server-substituted public keys (currently trusted on first use), session list
  with remote revoke.
- **Phase 3.5 — Group calls.** Per-peer mesh (or an SFU) so a channel can hold a call,
  replacing today's one-to-one-only limit.
- **Phase 4 — Native clients.** iOS and Android with haptic detents on the dial notches,
  push notification that carries no content, Secure Enclave / Keystore key custody.
- **Phase 5 — Metadata reduction.** Sealed sender, padded ciphertext buckets to blunt
  size correlation, and encrypted group membership.
