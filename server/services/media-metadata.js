/**
 * Service: Media-Metadaten-Anreicherung (TMDB / OpenLibrary)
 *
 * Alle externen Aufrufe sind OPTIONAL:
 *  - Timeout (8 s) und fangen Fehler ab -> fallen auf leer zurück
 *  - TMDB-Proxy ist optional; ist er leer, wird direkt auf api.themoviedb.org zugegriffen
 *  - Schlüssel/Proxy kommen aus der Datenbank, niemals aus dem Frontend
 *  - iTunes / Google Books brauchen keinen Key (öffentliche Suchendpunkte)
 */

const TMDB_BASE = 'https://api.themoviedb.org/3';
const TMDB_IMG = 'https://image.tmdb.org/t/p/w500';
const OL_BASE = 'https://openlibrary.org';
const ITUNES_BASE = 'https://itunes.apple.com';
const GB_BASE = 'https://www.googleapis.com/books/v1';

async function fetchJson(url, timeoutMs = 8000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function urlFor(base, proxyUrl) {
  if (proxyUrl && proxyUrl.trim()) {
    const p = proxyUrl.trim().replace(/\/$/, '');
    return (path) => `${p}${path}`;
  }
  return (path) => `${base}${path}`;
}

/**
 * 针对「无需 API Key 的第三方源」（OpenLibrary / iTunes / Google Books）的代理
 * 透传。Cloudflare Worker 暴露 `/px/<host><path>`，当本机直连不通时自动改走代理。
 * 返回两个构造器：直连 + 代理；调用方「先直连、失败再走代理」。
 */
function hostBuilders(host, proxyUrl) {
  const direct = (path) => `https://${host}${path}`;
  const useProxy = Boolean(proxyUrl && proxyUrl.trim());
  const proxy = useProxy
    ? (path) => `${proxyUrl.trim().replace(/\/$/, '')}/px/${host}${path}`
    : null;
  return { direct, proxy };
}

async function fetchJsonWithFallback(buildDirect, buildProxy, timeoutMs = 8000) {
  const direct = await fetchJson(buildDirect(), timeoutMs);
  if (direct) return direct;
  if (buildProxy) {
    const proxied = await fetchJson(buildProxy(), timeoutMs);
    if (proxied) return proxied;
  }
  return null;
}

export async function searchTmdb(query, { apiKey, proxyUrl } = {}) {
  if (!apiKey) return [];
  const build = urlFor(TMDB_BASE, proxyUrl);
  const enc = encodeURIComponent(query);
  const url = build(
    `/search/multi?api_key=${encodeURIComponent(apiKey)}&language=zh-CN&query=${enc}&include_adult=false`
  );
  const data = await fetchJson(url);
  if (!data || !Array.isArray(data.results)) return [];
  return data.results
    .filter((r) => r.media_type === 'movie' || r.media_type === 'tv')
    .map((r) => ({
      externalId: String(r.id),
      kind: r.media_type === 'tv' ? 'tv' : 'movie',
      title: r.title || r.name || '',
      originalTitle: r.original_title || r.original_name || '',
      releaseDate: r.release_date || r.first_air_date || '',
      overview: r.overview || '',
      posterUrl: r.poster_path ? `${TMDB_IMG}${r.poster_path}` : '',
      rating: typeof r.vote_average === 'number' ? r.vote_average : null,
    }));
}

export async function searchOpenLibrary(query, { isbn, proxyUrl } = {}) {
  if (isbn) {
    const { direct, proxy } = hostBuilders('openlibrary.org', proxyUrl);
    const doc = await fetchJsonWithFallback(
      () => `${direct(`/isbn/${encodeURIComponent(isbn)}.json`)}`,
      () => (proxy ? `${proxy(`/isbn/${encodeURIComponent(isbn)}.json`)}` : null)
    );
    if (!doc) return [];
    const authors = (doc.authors || []).map((a) => a.name).join(', ');
    return [
      {
        externalId: doc.key || '',
        kind: 'book',
        title: doc.title || '',
        authors,
        publishDate: doc.publish_date || '',
        coverUrl: doc.cover_i ? `${OL_BASE}/b/id/${doc.cover_i}-L.jpg` : '',
        overview: '',
      },
    ];
  }
  const { direct, proxy } = hostBuilders('openlibrary.org', proxyUrl);
  const data = await fetchJsonWithFallback(
    () => `${direct('/search.json?q=' + encodeURIComponent(query) + '&limit=10&fields=key,title,author_name,first_publish_year,cover_i')}`,
    () => proxy
      ? `${proxy('/search.json?q=' + encodeURIComponent(query) + '&limit=10&fields=key,title,author_name,first_publish_year,cover_i')}`
      : null
  );
  if (!data || !Array.isArray(data.docs)) return [];
  return data.docs.map((d) => ({
    externalId: d.key || '',
    kind: 'book',
    title: d.title || '',
    authors: (d.author_name || []).join(', '),
    publishDate: d.first_publish_year ? String(d.first_publish_year) : '',
    coverUrl: d.cover_i ? `${OL_BASE}/b/id/${d.cover_i}-L.jpg` : '',
    overview: '',
  }));
}

export async function searchItunes(query, { proxyUrl } = {}) {
  // iTunes Search API: ohne Key, Album-Suche. country=CN richtet die Results
  // auf den chinesischen Store aus (chinesische Titel, CNY-Preise irrelevant,
  // wir holen nur Metadaten + Cover).
  const q = `/search?term=${encodeURIComponent(query)}&media=music&entity=album&limit=10&country=CN`;
  const { direct, proxy } = hostBuilders('itunes.apple.com', proxyUrl);
  const data = await fetchJsonWithFallback(() => direct(q), () => (proxy ? proxy(q) : null));
  if (!data || !Array.isArray(data.results)) return [];
  return data.results
    .filter((r) => r.collectionName)
    .map((r) => ({
      externalId: String(r.collectionId || ''),
      kind: 'music',
      title: r.collectionName || '',
      authors: r.artistName || '',
      releaseDate: r.releaseDate ? String(r.releaseDate).slice(0, 10) : '',
      posterUrl: r.artworkUrl100 ? String(r.artworkUrl100).replace('100x100', '600x600') : '',
      overview: [r.primaryGenreName, r.trackCount ? `${r.trackCount} 曲目` : ''].filter(Boolean).join(' · '),
    }));
}

export async function searchGoogleBooks(query, { proxyUrl } = {}) {
  // Google Books API: ohne Key (Public-Endpunkt), maxResults<=10 zwingend.
  const q = `/books/v1/volumes?q=${encodeURIComponent(query)}&maxResults=10`;
  const { direct, proxy } = hostBuilders('www.googleapis.com', proxyUrl);
  const data = await fetchJsonWithFallback(() => direct(q), () => (proxy ? proxy(q) : null));
  if (!data || !Array.isArray(data.items)) return [];
  return data.items.map((it) => {
    const v = it.volumeInfo || {};
    let cover = (v.imageLinks && (v.imageLinks.thumbnail || v.imageLinks.smallThumbnail)) || '';
    cover = cover.replace(/^http:\/\//, 'https://');
    return {
      externalId: it.id || '',
      kind: 'book',
      title: v.title || '',
      authors: Array.isArray(v.authors) ? v.authors.join(', ') : '',
      publishDate: v.publishedDate || '',
      coverUrl: cover,
      overview: v.description || '',
    };
  });
}

/**
 * 按 TMDB externalId 拉取详情（简介 + 剧集完结状态）。
 * 需要 apiKey（详情接口强制鉴权）。proxyUrl 可选：本机直连不通时走代理。
 * 返回 { overview, status } —— status 为 'Returning Series' | 'Ended' | ...（TV 才有）。
 */
export async function fetchTmdbDetails(externalId, kind, apiKey, proxyUrl) {
  if (!apiKey || !externalId) return { overview: '', status: '' };
  const path = kind === 'tv' ? `/3/tv/${externalId}` : `/3/movie/${externalId}`;
  const build = urlFor(TMDB_BASE, proxyUrl);
  const url = `${build(path)}?api_key=${encodeURIComponent(apiKey)}&language=zh-CN`;
  const data = await fetchJson(url);
  if (!data) return { overview: '', status: '' };
  return {
    overview: data.overview || '',
    status: kind === 'tv' ? (data.status || '') : '',
  };
}

export default { searchTmdb, searchOpenLibrary, searchItunes, searchGoogleBooks, fetchTmdbDetails };
