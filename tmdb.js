// TMDb source: picks a random well-known movie / TV show and its main cast.
// API docs: https://developer.themoviedb.org/reference

// Genres that make bad quiz rounds (voice casts, documentaries, talk/reality/news/kids TV).
const EXCLUDED_MOVIE_GENRES = '16,99';
const EXCLUDED_TV_GENRES = '16,99,10762,10763,10764,10767';

function createTmdbSource({
  apiKey,
  baseUrl = 'https://api.themoviedb.org/3',
  imageBaseUrl = 'https://image.tmdb.org/t/p',
  language = 'en-US',
  answerLanguages = ['fr'], // official titles in these languages are accepted too (ISO 639-1)
  pages = 25,        // titles are drawn from the top `pages` x 20 most-voted titles
  tvRatio = 0.25,    // share of rounds that are TV shows (1 = TV only, 0 = movies only)
  fromYear = null,   // only titles released / first aired from this year on
  maxActors = 6,
  minActors = 4,
}) {
  // A v4 "API Read Access Token" is a JWT (starts with eyJ); otherwise it is a v3 API key.
  const isBearer = apiKey.startsWith('eyJ');
  const used = new Set();
  const maxPages = { movie: pages, tv: pages }; // lowered once TMDb tells us how many pages exist
  const posterBase = `${imageBaseUrl}/w342`;
  const profileBase = `${imageBaseUrl}/h632`;
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

  // Official titles in answerLanguages (e.g. fr-FR before fr-CA), without duplicates of the main title.
  function translatedTitles(title, details) {
    const countryRank = (t) => (t.iso_3166_1 === t.iso_639_1.toUpperCase() ? 0 : 1);
    const titles = (details.translations?.translations || [])
      .filter((t) => answerLanguages.includes(t.iso_639_1))
      .sort((a, b) => answerLanguages.indexOf(a.iso_639_1) - answerLanguages.indexOf(b.iso_639_1)
        || countryRank(a) - countryRank(b))
      .map((t) => (t.data.title || t.data.name || '').trim())
      .filter(Boolean);
    const seen = new Set([title.toLowerCase()]);
    return titles.filter((t) => !seen.has(t.toLowerCase()) && seen.add(t.toLowerCase()));
  }

  function aliasesFor(title, details, alternatives, translated) {
    const original = details.original_title || details.original_name;
    const names = new Set([original, ...alternatives.map((a) => a.title), ...translated]);
    // "Pirates of the Caribbean: The Curse of the Black Pearl" -> also accept both halves.
    for (const t of [title, ...translated]) {
      const parts = t.split(/\s*[:–]\s+|\s+-\s+/);
      if (parts.length > 1) parts.forEach((p) => names.add(p));
    }
    names.delete(title);
    return [...names].filter((n) => n && n.trim().length >= 2);
  }

  async function fetchOne() {
    const type = Math.random() < tvRatio ? 'tv' : 'movie';
    const filters = {
      sort_by: 'vote_count.desc',
      include_adult: 'false',
      without_genres: type === 'tv' ? EXCLUDED_TV_GENRES : EXCLUDED_MOVIE_GENRES,
      page: 1 + Math.floor(Math.random() * maxPages[type]),
    };
    if (fromYear) filters[type === 'tv' ? 'first_air_date.gte' : 'primary_release_date.gte'] = `${fromYear}-01-01`;
    const list = await get(`/discover/${type}`, filters);
    if (list.total_pages) maxPages[type] = Math.max(1, Math.min(maxPages[type], list.total_pages));
    const candidates = list.results.filter((r) => !used.has(`${type}:${r.id}`));
    if (candidates.length === 0) return null;
    const pick = candidates[Math.floor(Math.random() * candidates.length)];
    used.add(`${type}:${pick.id}`); // mark now, so a concurrent prefetch can't pick the same title

    const credits = type === 'tv' ? 'aggregate_credits' : 'credits';
    const details = await get(`/${type}/${pick.id}`, { append_to_response: `${credits},alternative_titles,translations` });

    // Main cast in billing order, then reversed so the most obvious actor comes last.
    const seen = new Set();
    const cast = details[credits].cast
      .slice()
      .sort((a, b) => a.order - b.order)
      .filter((c) => !seen.has(c.name) && seen.add(c.name))
      .slice(0, maxActors)
      .reverse();
    if (cast.length < minActors) return null;

    const title = details.title || details.name;
    const date = details.release_date || details.first_air_date || '';
    const alt = details.alternative_titles;
    const translated = translatedTitles(title, details);
    return {
      id: `${type}:${pick.id}`,
      title,
      otherTitles: translated,
      aliases: aliasesFor(title, details, alt.titles || alt.results || [], translated),
      type,
      year: date ? Number(date.slice(0, 4)) : null,
      source: 'tmdb',
      poster: details.poster_path ? posterBase + details.poster_path : null,
      actors: cast.map((c) => c.name),
      photos: cast.map((c) => (c.profile_path ? profileBase + c.profile_path : null)),
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
    // Returns the next title, then starts loading the one after so the next round starts without delay.
    // Loads run one at a time, so two of them can never pick the same title.
    async next() {
      const current = prefetched ?? fetchUsable();
      prefetched = null;
      try {
        return await current;
      } finally {
        prefetch();
      }
    },
  };
}

module.exports = { createTmdbSource };
