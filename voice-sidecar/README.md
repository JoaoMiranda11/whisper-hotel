# voice-sidecar

Issues short-lived LiveKit tokens for proximity voice. See `../docs/voice.md`.

- `GET /health` → `{ "status": "ok" }`
- `GET /voice-token?room=<int>` with `Authorization: Bearer <voice pass>` → `{ token, url }`
  - 401: missing/invalid/expired pass (checked before the query)
  - 400: invalid `room`
- `npm test` · `npm run typecheck` · `npm run mint-link -- --user <id> [--days 30] [--sso <ticket>]`
