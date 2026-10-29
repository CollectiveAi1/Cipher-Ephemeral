# Cipher

End-to-end encrypted messaging where **every message carries its own lifespan**, chosen on
a radial dial at the moment of writing. When a message expires, its ciphertext is deleted
from the server — not hidden, not flagged, deleted.

The product specification lives in [PRD.md](./PRD.md).

```
┌─────────────┬──────────────────────────────────────┐
│ Chats    +  │  Sarah Okonjo     📞 🎥 [ Security ] │
│             ├──────────────────────────────────────┤
│ ● Sarah  2  │   ╭──────────────────────────────╮   │
│   @sarah    │   │ Bid ceiling is 240.          │   │  ← gradient border
│             │   │ expires in 54m 22s           │   │    shows decay stage
│   incident- │   ╰──────────────────────────────╯   │
│   4821      │                                      │
│             ├──────────────────────────────────────┤
│             │   ╭───╮  [From send][From first read]│
│             │   │1h │  ┌────────────────────────┐  │
│             │   ╰───╯  │ Message securely…   ▶ │  │
├─────────────┤          └────────────────────────┘  │
│💬  📞  👥  ⚙│            Burn Dial — 15s to 7 days │
│Chat Call Com│                                      │
└─────────────┴──────────────────────────────────────┘
```

## Quick start

```bash
npm install
cp .env.example .env   # then set CIPHER_TOKEN_SECRET
npm run dev
```

`npm run dev` runs the API on `:8787` and Vite on `:5173`, with `/api` and `/ws` proxied —
open http://localhost:5173. Create two accounts in separate browser profiles to see
real-time delivery, presence, and burn-down from both sides.

For a single-process build:

```bash
npm run build && CIPHER_SERVE_STATIC=true npm start
```

## The four sections

| Section | What it is |
| --- | --- |
| **Chats** | Direct messages and groups. Every message picks its own lifespan on the dial. |
| **Calls** | One-to-one voice and video over WebRTC — and a call log that **burns like a message**. |
| **Communities** | Channels grouped under one **retention ceiling** that clamps every dial inside it. |
| **Settings** | Who you are, connection state, what the encryption does and does not protect. |

### Calls

Media is encrypted by WebRTC's DTLS-SRTP. Cipher adds that the **signalling** is sealed
too — SDP and ICE candidates carry network addresses, so they are encrypted under the
conversation key and the server relays bytes it cannot read.

Connectivity is opt-in: `CIPHER_ICE_SERVERS` is empty by default, which keeps calls on the
local network. A STUN server learns the caller's address, so reaching past NAT is a choice
you make rather than one made for you.

Call records expire after a day and the reaper deletes them, so the Calls list empties
itself — each entry shows how long it has left. Calls are one-to-one for now; a mesh group
call needs per-peer connections this signalling path does not model yet.

### Communities

Where other products' communities only group conversations, a Cipher community also
governs how long anything inside it may live. The community sets a **retention ceiling**;
every channel's Burn Dial is clamped to it — visibly, with the barred span drawn on the
dial — and the server clamps again on every message, so the policy holds no matter which
client sent it.

Lowering the ceiling binds new messages only. Messages already sent keep the lifespan
their sender was promised. Announcement channels let admins post and everyone read.

## How it works

**Keys.** Registration generates an ECDH P-256 identity keypair in the browser. The private
key is encrypted with AES-256-GCM under PBKDF2-SHA256 (310,000 iterations) of the password
and only then uploaded. The server stores a private key it cannot open, so reopening the app
asks for the password to rebuild the key in memory — it is never written to disk unsealed.

**Conversations.** Each conversation has an AES-256-GCM key, wrapped per member via
ECDH + HKDF against that member's public key. The membership row records who did the
wrapping, so a member added later derives against the right public key.

**Messages.** AES-256-GCM with a fresh IV. The conversation id, sender id, and **TTL** are
bound in as additional authenticated data — so a server that tampers with a message's
lifespan causes decryption to fail rather than silently extending it.

**Expiry.** Three layers: the client drops expired messages and releases their plaintext;
every server read filters on expiry, so an expired message is unreachable immediately; and a
reaper deletes the rows every 15 seconds. Attachments go with their message.

Two burn modes: **absolute** (from send) and **on-read**, where the countdown starts when a
recipient first decrypts — so a credential handed over mid-incident does not expire unread.
An unread on-read message still has a hard ceiling, so nothing lives forever.

## What it does not protect against

Stated plainly, because the opposite is usually implied:

- A recipient can screenshot, photograph, or retype anything they can read.
- A compromised device sees plaintext while it is on screen.
- The server knows **who messaged whom, when, and how big** — it just cannot read content.
- Conversation keys are long-lived, so there is no forward secrecy yet (Phase 2).
- The server sees call metadata — who called whom, when, how long — and each party's
  connecting IP, even though the signalling payload is sealed.

Full threat model in [PRD.md §4.6](./PRD.md).

## Layout

```
shared/     burn-scale.ts   the dial's piecewise-logarithmic scale and its exact inverse
            decay.ts        remaining lifespan -> colour, stage, and motion
            protocol.ts     the HTTP and WebSocket contract
server/     core/           ids, time, passwords, tokens, burn policy, reaper
            repos/          users, conversations, messages, media, communities, calls
            http/           app composition, middleware, validation, routes
            realtime/       WebSocket gateway: auth, presence, typing, fan-out
web/        lib/            crypto, api client, socket, WebRTC peer, state reducer, provider
            components/     nav rail, chats, calls, communities, settings, Burn Dial
test/       server/ web/ shared/   split by runtime so each gets the right type libs
```

The server runs TypeScript directly on Node 24 — no build step — and uses the built-in
`node:sqlite`, so there are no native dependencies.

## Scripts

| Script | Purpose |
| --- | --- |
| `npm run dev` | API and web dev server together |
| `npm run build` | Typecheck, then bundle to `dist/` |
| `npm start` | Run the API (serves `dist/` when `CIPHER_SERVE_STATIC=true`) |
| `npm test` | Vitest: unit + integration |
| `npm run verify` | typecheck → lint → test → dead-code check |

## Configuration

See [.env.example](./.env.example). `CIPHER_TOKEN_SECRET` is required in production.
`CIPHER_MAX_TTL_SECONDS` caps every message lifespan workspace-wide, and
`CIPHER_TRUST_PROXY` should be enabled only behind a proxy that overwrites
`X-Forwarded-For` — the rate limiter keys on that address. `CIPHER_ICE_SERVERS` takes
comma-separated STUN/TURN URLs for calls; leaving it empty keeps calls on the local
network rather than disclosing your address to a third-party STUN server.
