# Rummi 數字牌

A Rummikub-style number-tile game for phones: real-time online play (2–4 players), matchmaking, private rooms, chat and computer opponents.

## Run

```bash
npm install
npm start            # http://localhost:3000
```

Other phones on the same Wi-Fi can open `http://<this computer's IP>:3000`.
`PORT` and `HOST` environment variables override the defaults.

```bash
docker build -t rummi .
docker run -p 3000:3000 rummi
```

The WebSocket endpoint is `/ws` on the same host, so any host that supports WebSockets works (Render, Fly.io, Railway, a VPS behind nginx with `Upgrade` headers).
Serve it over HTTPS in production; the client switches to `wss://` automatically.

## Features

- **Quick match**: starts as soon as 4 players are queued, or after 12 seconds with 2–3.
- **Private rooms**: a 4-character code and an invite link (`/?room=CODE`). The host can add computer players and pick their strength.
- **vs computer**: 1–3 computer players, normal or expert.
- **Chat**: a lobby chat and a table chat, with quick phrases, rate limiting (5 messages per 5 s) and 200-character messages.
- **Smart play**: green outlines show which sets a selected tile fits. Double-tapping a tile places it. "智慧出牌" finds the play that uses the most tiles, including rearranging the table.
- **Sound effects**: synthesised with Web Audio, no audio files. They can be muted.
- **Reconnect**: a player token is kept in localStorage. A player who drops has 20 s before the server plays their turn for them; leaving a game hands the seat to the computer.

## Architecture

| Path | Role |
|---|---|
| `public/engine.js` | Rules, turn validation and solver. Shared by the browser and the server. |
| `src/table.js` | One table. The server is authoritative: it holds the hands and the pool, validates every turn, runs computer players and turn timers (90 s). |
| `src/lobby.js` | Players, matchmaking queue, rooms, chat and input sanitising. |
| `server.js` | Static files, the `/ws` WebSocket, heartbeats and a per-connection message budget. |
| `public/app.js`, `sound.js` | Client UI, drag and drop, and sound effects. |

Each client only receives its own hand; opponents' tiles and the pool order never leave the server.

## Test

```bash
npm test
```
