# Cast Quiz

Multiplayer quiz: guess the movie / TV show from its cast. No dependencies — Node 24+ only.

```bash
npm start
```

Open http://localhost:3000 (other players: http://<your-ip>:3000).

## Rules
- Each round the server picks a title (its year and whether it is a movie or TV show are shown)
  and reveals one actor; another actor is added every 10 s.
  With TMDb, each actor's photo appears 5 s after their name.
- First correct answer scores 10, second 9, … tenth 1.
- The round ends when every connected player has found it, 10 players have found it,
  or 10 s after the last actor. Then the solution (with its poster) is shown and the next title starts.
- Answers ignore case, accents, punctuation and a leading "The" / "Le" / "La" / "Les" / "L'",
  and tolerate small typos. The French title is accepted too ("Le Parrain" for "The Godfather").

## Title source: TMDb
Titles and casts come from [The Movie Database (TMDb)](https://www.themoviedb.org) when `TMDB_API_KEY` is set.
Get a free key at https://www.themoviedb.org/settings/api — either the v3 "API Key" or the
v4 "API Read Access Token" works.

```bash
TMDB_API_KEY=your_key npm start
```

PowerShell: `$env:TMDB_API_KEY="your_key"; npm start`

Each round draws a random title among the most-voted movies / TV shows (animation, documentaries,
talk shows, reality and kids TV are excluded). Its top-billed cast is revealed in reverse order,
so the lead actor comes last. Besides the main title, the original title, TMDb's alternative titles and
the official titles in `TMDB_ANSWER_LANGUAGES` (French by default, from TMDb's translations) are accepted;
the French title is shown under the answer.

Without a key — or if TMDb can't be reached — the game uses the local `movies.json` instead.

`npm start` runs Node with `--use-env-proxy`, so `HTTPS_PROXY` / `HTTP_PROXY` are honoured
(needed behind a corporate proxy).

This product uses the TMDB API but is not endorsed or certified by TMDB.

## Config (env vars)
| Variable | Default | Meaning |
|---|---|---|
| `PORT` | 3000 | HTTP port |
| `HINT_MS` | 10000 | Delay between actors |
| `REVEAL_MS` | 6000 | Time the solution stays on screen |
| `PHOTO_MS` | 5000 | Delay between an actor's name and their photo |
| `TMDB_API_KEY` | – | Enables TMDb |
| `TMDB_LANGUAGE` | en-US | Language of the main title, e.g. `fr-FR` |
| `TMDB_ANSWER_LANGUAGES` | fr | Other languages whose titles are accepted, comma-separated (e.g. `fr,nl`; empty = none) |
| `TMDB_PAGES` | 25 | Pool size: top `pages × 20` most-voted titles (lower = more famous titles) |
| `TMDB_TV_RATIO` | 0.25 | Share of rounds that are TV shows (0 = movies only) |
| `TMDB_IMAGE_BASE` | https://image.tmdb.org/t/p | Where posters and actor photos are loaded from |

You can add titles to `movies.json` (used without TMDb); list the actors from least to most obvious.
