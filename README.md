# Cast Quiz

Multiplayer quiz: guess the movie / TV show from its cast. No dependencies — Node 18+ only.

```bash
node server.js
```

Open http://localhost:3000 (other players: http://<your-ip>:3000).

## Rules
- Each round the server picks a title and reveals one actor; another actor is added every 10 s.
- First correct answer scores 10, second 9, … tenth 1.
- The round ends when every connected player has found it, 10 players have found it,
  or 10 s after the last actor. Then the solution is shown and the next title starts.
- Answers ignore case, accents, punctuation and a leading "The", and tolerate small typos.

## Config (env vars)
`PORT` (3000), `HINT_MS` (10000), `REVEAL_MS` (6000).

Add titles in `movies.json` — list actors from least to most obvious.
