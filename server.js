// Cast Quiz — guess the movie / TV show from its actors.
// Zero dependencies: plain Node HTTP + Server-Sent Events.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createTmdbSource } = require('./tmdb');

const PORT = Number(process.env.PORT) || 3000;
const HINT_MS = Number(process.env.HINT_MS) || 10_000;   // delay between actor hints
const REVEAL_MS = Number(process.env.REVEAL_MS) || 6_000; // time the solution stays on screen
const MAX_FINDERS = 10;                                   // 10, 9, ... 1 points

// Command-line options (--mode=tv --from=1995) take precedence over environment variables.
const args = Object.fromEntries(
  process.argv.slice(2).map((a) => a.match(/^--([\w-]+)=(.*)$/)).filter(Boolean).map((m) => [m[1], m[2]]),
);

// Game mode: mixed (movies + TV shows), tv (TV shows only) or movies (movies only).
const MODE = (args.mode ?? process.env.MODE ?? 'mixed').toLowerCase();
if (!['mixed', 'tv', 'movies'].includes(MODE)) {
  console.error(`Unknown mode "${MODE}" — use mixed, tv or movies.`);
  process.exit(1);
}
// Oldest release year allowed; TV-only mode defaults to 1990, the other modes to no limit.
const FROM_YEAR = Number(args.from ?? process.env.FROM_YEAR ?? (MODE === 'tv' ? 1990 : 0)) || null;
const TV_RATIO = { tv: 1, movies: 0, mixed: process.env.TMDB_TV_RATIO != null ? Number(process.env.TMDB_TV_RATIO) : 0.25 }[MODE];
const MODE_LABEL = { mixed: 'Movies & TV shows', tv: 'TV shows only', movies: 'Movies only' }[MODE]
  + (FROM_YEAR ? ` · from ${FROM_YEAR}` : '');

const ALL_MOVIES = JSON.parse(fs.readFileSync(path.join(__dirname, 'movies.json'), 'utf8'));
const MOVIES = ALL_MOVIES.filter((m) =>
  (MODE === 'mixed' || (MODE === 'tv') === (m.type === 'tv')) && (!FROM_YEAR || m.year >= FROM_YEAR));
if (MOVIES.length === 0) {
  console.error(`movies.json has no titles for "${MODE_LABEL}".`);
  process.exit(1);
}

// Titles come from TMDb when TMDB_API_KEY is set, otherwise (or if TMDb fails) from movies.json.
const tmdb = process.env.TMDB_API_KEY
  ? createTmdbSource({
      apiKey: process.env.TMDB_API_KEY,
      language: process.env.TMDB_LANGUAGE || 'en-US',
      answerLanguages: (process.env.TMDB_ANSWER_LANGUAGES ?? 'fr').split(',').map((l) => l.trim()).filter(Boolean),
      pages: Number(process.env.TMDB_PAGES) || 25,
      tvRatio: TV_RATIO,
      fromYear: FROM_YEAR,
      baseUrl: process.env.TMDB_BASE_URL || undefined,
      imageBaseUrl: process.env.TMDB_IMAGE_BASE || undefined,
    })
  : null;

// ---------------------------------------------------------------- state
const players = new Map(); // id -> { id, name, score, stream, foundRank }
const game = {
  phase: 'waiting',   // waiting | loading | playing | reveal
  round: 0,
  movie: null,
  revealed: [],       // actors shown so far
  finders: [],        // [{ id, name, points }]
  nextAt: null,       // timestamp of the next hint / next round
  timer: null,
  deck: [],
};

// ---------------------------------------------------------------- answer matching
function normalize(s) {
  return s
    .normalize('NFD').replace(/[̀-ͯ]/g, '') // strip accents
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/^(the|a|an|le|la|les|l) /, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function levenshtein(a, b) {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length];
}

function isCorrect(guess, movie) {
  const g = normalize(guess);
  if (!g) return false;
  return [movie.title, ...(movie.otherTitles || []), ...(movie.aliases || [])].some((answer) => {
    const a = normalize(answer);
    const tolerance = a.length >= 10 ? 2 : a.length >= 5 ? 1 : 0; // allow small typos
    return levenshtein(g, a) <= tolerance;
  });
}

// ---------------------------------------------------------------- broadcasting
function onlinePlayers() {
  return [...players.values()].filter((p) => p.stream);
}

function publicState() {
  return {
    phase: game.phase,
    round: game.round,
    type: game.movie?.type ?? null,
    year: game.movie?.year ?? null,
    source: game.movie?.source ?? null,
    mode: MODE_LABEL,
    actors: game.revealed.map((name, i) => ({
      name,
      photo: game.movie.photos?.[i] ?? null,
    })),
    totalActors: game.movie?.actors.length ?? 0,
    finders: game.finders.map(({ name, points }) => ({ name, points })),
    solution: game.phase === 'reveal' ? game.movie.title : null,
    otherTitles: game.phase === 'reveal' ? game.movie.otherTitles ?? [] : [],
    poster: game.phase === 'reveal' ? game.movie.poster ?? null : null,
    nextAt: game.nextAt,
    hintMs: HINT_MS,
    serverNow: Date.now(),
    players: [...players.values()]
      .map((p) => ({ name: p.name, score: p.score, online: !!p.stream, found: p.foundRank != null }))
      .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name)),
  };
}

function send(player, event, data) {
  if (player.stream) player.stream.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function broadcast(event, data) {
  for (const p of players.values()) send(p, event, data);
}

function broadcastState() {
  broadcast('state', publicState());
}

function feed(text) {
  broadcast('feed', { text, at: Date.now() });
}

// ---------------------------------------------------------------- game loop
function nextLocalMovie() {
  if (game.deck.length === 0) {
    game.deck = [...MOVIES].sort(() => Math.random() - 0.5);
  }
  return { ...game.deck.pop(), source: 'local' };
}

function schedule(ms, fn) {
  clearTimeout(game.timer);
  game.nextAt = Date.now() + ms;
  game.timer = setTimeout(fn, ms);
}

async function nextMovie() {
  if (tmdb) {
    try {
      return await tmdb.next();
    } catch (err) {
      console.error(`${err.message} — using movies.json for this round`);
    }
  }
  return nextLocalMovie();
}

async function startRound() {
  if (game.phase === 'loading') return;
  if (onlinePlayers().length === 0) {
    game.phase = 'waiting';
    game.nextAt = null;
    return broadcastState();
  }
  clearTimeout(game.timer);
  game.phase = 'loading';
  game.nextAt = null;
  game.revealed = [];
  game.finders = [];
  broadcastState();
  const movie = await nextMovie();
  game.round++;
  game.phase = 'playing';
  game.movie = movie;
  game.revealed = [];
  game.finders = [];
  for (const p of players.values()) p.foundRank = null;
  console.log(`[round ${game.round}] ${game.movie.title}`);
  feed(`Round ${game.round}: a new ${game.movie.type === 'tv' ? 'TV show' : 'movie'}!`);
  nextHint();
}

function nextHint() {
  if (game.revealed.length < game.movie.actors.length) {
    game.revealed.push(game.movie.actors[game.revealed.length]);
    schedule(HINT_MS, nextHint);
    broadcastState();
  } else {
    endRound('No more actors!');
  }
}

function endRound(reason) {
  game.phase = 'reveal';
  game.revealed = game.movie.actors;
  feed(`${reason} The answer was "${game.movie.title}".`);
  schedule(REVEAL_MS, startRound);
  broadcastState();
}

function checkRoundOver() {
  if (game.phase !== 'playing') return;
  const online = onlinePlayers();
  if (game.finders.length >= MAX_FINDERS) return endRound(`${MAX_FINDERS} players found it!`);
  if (online.length > 0 && online.every((p) => p.foundRank != null)) return endRound('Everybody found it!');
}

function handleGuess(player, text) {
  if (game.phase !== 'playing') return { status: 'closed' };
  if (player.foundRank != null) return { status: 'already' };
  if (!isCorrect(text, game.movie)) return { status: 'wrong' };

  const points = MAX_FINDERS - game.finders.length;
  player.foundRank = game.finders.length + 1;
  player.score += points;
  game.finders.push({ id: player.id, name: player.name, points });
  feed(`🎉 ${player.name} found it after ${game.revealed.length} actor(s): +${points}`);
  broadcastState();
  checkRoundOver();
  return { status: 'correct', points, title: game.movie.title };
}

// ---------------------------------------------------------------- HTTP
function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (c) => {
      body += c;
      if (body.length > 10_000) req.destroy();
    });
    req.on('end', () => {
      try { resolve(JSON.parse(body || '{}')); } catch (e) { reject(e); }
    });
  });
}

function json(res, code, data) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    // no-cache: browsers must re-check, so a reload always picks up the latest page.
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
    return fs.createReadStream(path.join(__dirname, 'public', 'index.html')).pipe(res);
  }

  if (req.method === 'POST' && url.pathname === '/join') {
    const body = await readJson(req).catch(() => ({}));
    const name = String(body.name || '').trim().slice(0, 20);
    if (!name) return json(res, 400, { error: 'Name required' });
    // Rejoin with an existing id keeps the score.
    const existing = body.id && players.get(body.id);
    if (existing) return json(res, 200, { id: existing.id, name: existing.name });
    const taken = [...players.values()].some((p) => p.name.toLowerCase() === name.toLowerCase());
    if (taken) return json(res, 409, { error: 'Name already taken' });
    const id = crypto.randomUUID();
    players.set(id, { id, name, score: 0, stream: null, foundRank: null });
    return json(res, 200, { id, name });
  }

  if (req.method === 'GET' && url.pathname === '/events') {
    const player = players.get(url.searchParams.get('id'));
    if (!player) return json(res, 404, { error: 'Unknown player' });
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    if (player.stream) player.stream.end(); // one connection per player
    player.stream = res;
    const ping = setInterval(() => res.write(': ping\n\n'), 20_000);
    req.on('close', () => {
      clearInterval(ping);
      if (player.stream === res) {
        player.stream = null;
        feed(`${player.name} left.`);
        broadcastState();
        checkRoundOver();
      }
    });
    feed(`${player.name} joined.`);
    if (game.phase === 'waiting') startRound();
    else broadcastState();
    return;
  }

  if (req.method === 'POST' && url.pathname === '/guess') {
    const body = await readJson(req).catch(() => ({}));
    const player = players.get(body.id);
    if (!player) return json(res, 404, { error: 'Unknown player' });
    return json(res, 200, handleGuess(player, String(body.text || '').slice(0, 100)));
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, () => {
  const source = tmdb ? `TMDb (${process.env.TMDB_LANGUAGE || 'en-US'})` : `movies.json (${MOVIES.length} titles)`;
  console.log(`Cast Quiz running on http://localhost:${PORT} — ${MODE_LABEL}, titles from ${source}, hint every ${HINT_MS / 1000}s`);
});
