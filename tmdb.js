// TMDb source: picks a random well-known movie / TV show and its main cast.
// API docs: https://developer.themoviedb.org/reference
const IMAGE_BASE = 'https://image.tmdb.org/t/p/w342';

// Genres that make bad quiz rounds (voice casts, documentaries, talk/reality/news/kids TV).
const EXCLUDED_MOVIE_GENRES = '16,99';
const EXCLUDED_TV_GENRES = '16,99,10762,10763,10764,10767';

function createTmdbSource({
  apiKey,
  baseUrl = 'https://api.themoviedb.org/3',
  language = 'en-US',
  pages = 25,        // titles are drawn from the top `pages` x 20 most-voted titles
  tvRatio = 0.25,    // share of rounds that are TV shows
  maxActors = 6,
  minActors = 4,
}) {
  // A v4 "API Read Access Token" is a JWT (starts with eyJ); otherwise it is a v3 API key.
  const isBearer = apiKey.startsWith('eyJ');
  const used = new Set();
  let prefetched = null;

  async function get(pathname, params = {}) {
    const url = new URL(baseUrl + pathname);
    for (const [k, v] of Object.entries({ language, ...params })) url.searchParams.set(k, v);
    if (!isBearer) url.searchParams.set('api_key', apiKey);
    const res = await fetch(url, {
      headers: isBearer ? { Authorization: `Bearer ${apiKey}`, accept: 'application/json' } : { accept: 'application/json' },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`TMDb ${pathname} -> HTTP ${res.status}`);
    return res.json();
  }

  function aliasesFor(title, details, alternatives) {
    const original = details.original_title || details.original_name;
    const names = new Set([original, ...alternatives.map((a) => a.title)]);
    // "Pirates of the Caribbean: The Curse of the Black Pearl" -> also accept both halves.
    const parts = title.split(/\s*[:–]\s+|\s+-\s+/);
    if (parts.length > 1) parts.forEach((p) => names.add(p));
    names.delete(title);
    return [...names].filter((n) => n && n.trim().length >= 2);
  }

  async function fetchOne() {
    const type = Math.random() < tvRatio ? 'tv' : 'movie';
    const list = await get(`/discover/${type}`, {
      sort_by: 'vote_count.desc',
      include_adult: 'false',
      without_genres: type === 'tv' ? EXCLUDED_TV_GENRES : EXCLUDED_MOVIE_GENRES,
      page: 1 + Math.floor(Math.random() * pages),
    });
    const candidates = list.results.filter((r) => !used.has(`${type}:${r.id}`));
    if (candidates.length === 0) return null;
    const pick = candidates[Math.floor(Math.random() * candidates.length)];
    used.add(`${type}:${pick.id}`); // mark now, so a concurrent prefetch can't pick the same title

    const credits = type === 'tv' ? 'aggregate_credits' : 'credits';
    const details = await get(`/${type}/${pick.id}`, { append_to_response: `${credits},alternative_titles` });

    // Main cast in billing order, then reversed so the most obvious actor comes last.
    const seen = new Set();
    const cast = details[credits].cast
      .slice()
      .sort((a, b) => a.order - b.order)
      .filter((c) => !seen.has(c.name) && seen.add(c.name))
      .slice(0, maxActors)
      .map((c) => c.name)
      .reverse();
    if (cast.length < minActors) return null;

    const title = details.title || details.name;
    const date = details.release_date || details.first_air_date || '';
    const alt = details.alternative_titles;
    return {
      id: `${type}:${pick.id}`,
      title,
      aliases: aliasesFor(title, details, alt.titles || alt.results || []),
      type,
      year: date ? Number(date.slice(0, 4)) : null,
      poster: details.poster_path ? IMAGE_BASE + details.poster_path : null,
      actors: cast,
    };
  }

  async function fetchUsable() {
    for (let attempt = 0; attempt < 5; attempt++) {
      const movie = await fetchOne();
      if (movie) return movie;
    }
    throw new Error('TMDb: no usable title found after 5 attempts');
  }

  function prefetch() {
    prefetched = fetchUsable();
    prefetched.catch(() => {}); // errors are reported when the title is actually needed
  }

  return {
    // Returns the next title and immediately starts loading the one after, so rounds start without delay.
    async next() {
      if (!prefetched) prefetch();
      const current = prefetched;
      prefetch();
      return current;
    },
  };
}

module.exports = { createTmdbSource };
