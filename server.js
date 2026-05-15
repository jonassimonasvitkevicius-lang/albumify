const express = require("express");
const path = require("path");
require("dotenv").config();

const app = express();
const PORT = 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ─── Spotify auth ─────────────────────────────────────────────────────────────

let cachedToken = null;
let tokenExpiry = 0;

async function getAccessToken() {
  if (cachedToken && Date.now() < tokenExpiry) return cachedToken;
  const params = new URLSearchParams();
  params.append("grant_type", "client_credentials");
  params.append("client_id", process.env.SPOTIFY_CLIENT_ID);
  params.append("client_secret", process.env.SPOTIFY_CLIENT_SECRET);
  const response = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });
  const data = await response.json();
  if (!response.ok) throw new Error("Spotify auth failed");
  cachedToken = data.access_token;
  tokenExpiry = Date.now() + (data.expires_in - 60) * 1000;
  return cachedToken;
}

// ─── Last.fm helpers ──────────────────────────────────────────────────────────

const LASTFM_KEY = process.env.LASTFM_API_KEY;
const LASTFM_BASE = "https://ws.audioscrobbler.com/2.0/";

async function lfm(params) {
  const url = LASTFM_BASE + "?" + new URLSearchParams({
    ...params,
    api_key: LASTFM_KEY,
    format: "json",
  });
  try {
    const res = await fetch(url);
    const data = await res.json();
    if (data.error) return null;
    return data;
  } catch {
    return null;
  }
}

// Similar artists with their match score (0–1)
async function getLastfmSimilarArtists(artistName, limit = 20) {
  const data = await lfm({ method: "artist.getSimilar", artist: artistName, limit, autocorrect: 1 });
  if (!data?.similarartists?.artist) return [];
  const artists = data.similarartists.artist;
  return (Array.isArray(artists) ? artists : [artists]).map(a => ({
    name: a.name,
    score: parseFloat(a.match) || 0,
  }));
}

// Top tags for a specific album — these reflect the actual sound of that record
async function getLastfmAlbumTags(artistName, albumName) {
  const data = await lfm({ method: "album.getTopTags", artist: artistName, album: albumName, autocorrect: 1 });
  if (!data?.toptags?.tag) return new Set();
  const tags = data.toptags.tag;
  return new Set(
    (Array.isArray(tags) ? tags : [tags])
      .slice(0, 12)
      .map(t => t.name.toLowerCase().trim())
  );
}

// Top tags for an artist — broader genre-level tags
async function getLastfmArtistTags(artistName) {
  const data = await lfm({ method: "artist.getTopTags", artist: artistName, autocorrect: 1 });
  if (!data?.toptags?.tag) return new Set();
  const tags = data.toptags.tag;
  return new Set(
    (Array.isArray(tags) ? tags : [tags])
      .slice(0, 12)
      .map(t => t.name.toLowerCase().trim())
  );
}

// Top album names for an artist from Last.fm
// We use these for precise Spotify lookups later
async function getLastfmTopAlbums(artistName, limit = 5) {
  const data = await lfm({ method: "artist.getTopAlbums", artist: artistName, limit, autocorrect: 1 });
  if (!data?.topalbums?.album) return [];
  const albums = data.topalbums.album;
  return (Array.isArray(albums) ? albums : [albums])
    .filter(a => a.name && a.name !== "(null)")
    .map(a => a.name);
}

// ─── Spotify helpers ──────────────────────────────────────────────────────────

// Precise lookup: find a specific album by artist + album name
async function spotifyFindAlbum(token, artistName, albumName) {
  const q = `artist:${artistName} album:${albumName}`;
  const res = await fetch(
    `https://api.spotify.com/v1/search?q=${encodeURIComponent(q)}&type=album&limit=3&market=US`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const data = await res.json();
  return res.ok && data.albums?.items?.length ? data.albums.items[0] : null;
}

// Fallback: get top albums for an artist from Spotify search
async function getAlbumsByArtist(token, artistName, limit = 3) {
  const res = await fetch(
    `https://api.spotify.com/v1/search?q=artist:${encodeURIComponent(artistName)}&type=album&limit=${limit}&market=US`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const data = await res.json();
  return res.ok && data.albums?.items ? data.albums.items : [];
}

function formatAlbum(a) {
  return {
    id: a.id,
    name: a.name,
    artist: a.artists.map(x => x.name).join(", "),
    artistId: a.artists[0]?.id ?? null,
    year: a.release_date?.split("-")[0] ?? "?",
    releaseDate: a.release_date ?? null,
    image: a.images?.[0]?.url ?? null,
    totalTracks: a.total_tracks,
    spotifyUrl: a.external_urls?.spotify ?? null,
  };
}

function tagOverlap(setA, setB) {
  let n = 0;
  for (const t of setA) if (setB.has(t)) n++;
  return n;
}

// ─── Routes ───────────────────────────────────────────────────────────────────

app.get("/api/search", async (req, res) => {
  const { q } = req.query;
  if (!q) return res.status(400).json({ error: "Missing query" });
  try {
    const token = await getAccessToken();
    const [res1, res2] = await Promise.all([
      fetch(`https://api.spotify.com/v1/search?q=artist:${encodeURIComponent(q)}&type=album&limit=10&offset=0&market=US`, { headers: { Authorization: `Bearer ${token}` } }),
      fetch(`https://api.spotify.com/v1/search?q=artist:${encodeURIComponent(q)}&type=album&limit=10&offset=10&market=US`, { headers: { Authorization: `Bearer ${token}` } }),
    ]);
    const [data1, data2] = await Promise.all([res1.json(), res2.json()]);
    let items = [];
    if (res1.ok && data1.albums) items.push(...data1.albums.items);
    if (res2.ok && data2.albums) items.push(...data2.albums.items);
    if (items.length === 0) {
      const fb = await fetch(`https://api.spotify.com/v1/search?q=${encodeURIComponent(q)}&type=album&limit=10&market=US`, { headers: { Authorization: `Bearer ${token}` } });
      const fbData = await fb.json();
      if (fb.ok && fbData.albums) items.push(...fbData.albums.items);
    }
    const unique = {};
    items.forEach(a => { unique[a.id] = a; });
    res.json(Object.values(unique).map(formatAlbum).slice(0, 20));
  } catch (err) {
    console.error("Search error:", err);
    res.status(500).json({ error: "Search failed" });
  }
});

app.get("/api/album/:id", async (req, res) => {
  try {
    const token = await getAccessToken();
    const response = await fetch(`https://api.spotify.com/v1/albums/${req.params.id}`, { headers: { Authorization: `Bearer ${token}` } });
    const data = await response.json();
    if (!response.ok) throw new Error();

    const artistName = data.artists[0]?.name ?? "";
    const albumName  = data.name ?? "";

    // Fetch album tags and artist tags from Last.fm in parallel.
    // Album tags are specific to this record (e.g. "lo-fi", "shoegaze").
    // Artist tags are broader genre labels (e.g. "indie rock", "alternative").
    // We merge them, deduplicate, and cap at 8 so the UI stays tidy.
    const [albumTags, artistTags] = await Promise.all([
      getLastfmAlbumTags(artistName, albumName),
      getLastfmArtistTags(artistName),
    ]);

    // Merge: album tags first (more specific), then artist tags as fill.
    // Filter out pure numbers, very short tags, and obvious junk.
    const junk = new Set(["seen live", "albums i own", "favourite albums", "favorites", "love", "awesome", "good", "great", "owned"]);
    const merged = [];
    const seen = new Set();
    for (const tag of [...albumTags, ...artistTags]) {
      const t = tag.toLowerCase().trim();
      if (seen.has(t) || t.length < 2 || /^\d+$/.test(t) || junk.has(t)) continue;
      seen.add(t);
      merged.push(tag);
      if (merged.length >= 8) break;
    }

    res.json({
      ...formatAlbum(data),
      tags: merged,
      tracks: data.tracks.items.map(t => ({
        track_number: t.track_number,
        name: t.name,
        duration_ms: t.duration_ms,
      })),
    });
  } catch {
    res.status(500).json({ error: "Failed to load album" });
  }
});

app.get("/api/similar/:albumId", async (req, res) => {
  try {
    const token = await getAccessToken();

    // ── 1. Fetch source album from Spotify ────────────────────────────────────
    const albumRes = await fetch(
      `https://api.spotify.com/v1/albums/${req.params.albumId}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const album = await albumRes.json();
    if (!albumRes.ok) throw new Error("Could not fetch album");

    const sourceArtistName = album.artists[0]?.name ?? "";
    const sourceArtistId   = album.artists[0]?.id ?? null;
    const sourceAlbumName  = album.name ?? "";
    const sourceYear       = parseInt(album.release_date?.split("-")[0]) || null;

    if (!sourceArtistName) return res.json([]);

    // ── 2. Fetch source album + artist tags from Last.fm in parallel ──────────
    // Album tags: the specific vibe of this record (e.g. "lo-fi", "experimental")
    // Artist tags: broader genre (e.g. "alternative rock")
    // Having both lets us match at two levels of specificity.
    const [sourceAlbumTags, sourceArtistTags, similarArtists] = await Promise.all([
      getLastfmAlbumTags(sourceArtistName, sourceAlbumName),
      getLastfmArtistTags(sourceArtistName),
      getLastfmSimilarArtists(sourceArtistName, 25),
    ]);

    if (similarArtists.length === 0) return res.json([]);

    // ── 3. For each similar artist, fetch their tags + top album names ─────────
    // Batched 4 at a time to avoid Last.fm rate limiting.
    const artistDetails = await batchedMap(similarArtists, async ({ name, score }) => {
      const [artistTags, topAlbumNames] = await Promise.all([
        getLastfmArtistTags(name),
        getLastfmTopAlbums(name, 5),
      ]);
      return { name, lastfmScore: score, artistTags, topAlbumNames };
    }, 4, 250);

    // ── 4. Score each candidate artist ────────────────────────────────────────
    // We combine three signals:
    //
    // (a) Last.fm similarity score — artist-level, 0–1
    //     Tells us how similar audiences/listening patterns are overall.
    //
    // (b) Album tag overlap — how many of the source ALBUM's tags the
    //     candidate artist shares. This is the key album-specificity signal.
    //     e.g. if Niandra Lades is tagged "lo-fi" and "avant-garde", only
    //     artists who are also tagged those things score highly here.
    //     Weight: 4× per matching tag (highest weight — most specific signal)
    //
    // (c) Artist tag overlap — how many of the source ARTIST's broader tags
    //     the candidate shares. Catches genre-level similarity.
    //     Weight: 1× per matching tag (lowest weight — least specific)
    //
    // Final formula: (lastfmScore × 10) + (albumTagOverlap × 4) + (artistTagOverlap × 1)
    // The ×10 on lastfmScore normalises it relative to tag counts (tags are integers,
    // lastfmScore is 0–1 so without scaling it would barely matter).

    const scored = artistDetails
      .map(artist => {
        const albumTagScore  = tagOverlap(sourceAlbumTags, artist.artistTags) * 4;
        const artistTagScore = tagOverlap(sourceArtistTags, artist.artistTags) * 1;
        const finalScore = (artist.lastfmScore * 10) + albumTagScore + artistTagScore;
        return { ...artist, finalScore };
      })
      .sort((a, b) => b.finalScore - a.finalScore);

    // ── 5. Fetch albums from Spotify ──────────────────────────────────────────
    // For each similar artist we try:
    //   (a) Precise lookup: search artist + specific album name from Last.fm top albums
    //       This tends to surface the artist's most beloved/representative work.
    //   (b) Fallback: generic artist search on Spotify if precise lookup fails.
    //
    // Both approaches exclude albums by the source artist.

    const seen = new Set();
    const candidates = [];

    await Promise.all(
      scored.map(async ({ name, finalScore, topAlbumNames }) => {
        let foundAlbums = [];

        if (topAlbumNames.length > 0) {
          // Precise lookups in parallel for the top 3 albums
          const precise = await Promise.all(
            topAlbumNames.slice(0, 3).map(albumName => spotifyFindAlbum(token, name, albumName))
          );
          foundAlbums = precise.filter(Boolean);
        }

        // Fall back to generic artist search if nothing found
        if (foundAlbums.length === 0) {
          foundAlbums = await getAlbumsByArtist(token, name, 3);
        }

        for (const a of foundAlbums) {
          if (!a || seen.has(a.id)) continue;
          if (!a.images?.length) continue;
          if (a.artists[0]?.id === sourceArtistId) continue;
          seen.add(a.id);
          candidates.push({ album: a, finalScore });
        }
      })
    );

    // ── 6. Sort and return ────────────────────────────────────────────────────
    // Primary sort: finalScore descending
    // Tiebreak: prefer albums from a similar era to the source album
    candidates.sort((a, b) => {
      if (Math.abs(b.finalScore - a.finalScore) > 0.01) return b.finalScore - a.finalScore;
      if (sourceYear) {
        const yA = parseInt(a.album.release_date?.split("-")[0]) || 0;
        const yB = parseInt(b.album.release_date?.split("-")[0]) || 0;
        return Math.abs(yA - sourceYear) - Math.abs(yB - sourceYear);
      }
      return 0;
    });

    res.json(candidates.slice(0, 20).map(c => formatAlbum(c.album)));
  } catch (err) {
    console.error("Similar error:", err);
    res.status(500).json({ error: "Failed to load similar albums" });
  }
});

// ─── Genre albums ─────────────────────────────────────────────────────────────
// Uses Last.fm tag.getTopAlbums → Spotify for art. Returns up to 20 albums.
app.get("/api/genre-albums", async (req, res) => {
  const genre = req.query.genre?.trim();
  if (!genre) return res.status(400).json({ error: "Missing genre" });
  try {
    const token = await getAccessToken();
    const data = await lfm({ method: "tag.getTopAlbums", tag: genre, limit: 50, page: 1 });
    if (!data?.albums?.album) return res.json([]);
    const raw = Array.isArray(data.albums.album) ? data.albums.album : [data.albums.album];
    const candidates = raw.filter(a => a.name && a.name !== "(null)" && a.artist?.name);

    const results = [];
    const seen = new Set();
    for (const c of candidates) {
      if (results.length >= 20) break;
      const found = await spotifyFindAlbum(token, c.artist.name, c.name);
      if (found && !seen.has(found.id)) {
        seen.add(found.id);
        results.push(formatAlbum(found));
      }
    }
    res.json(results);
  } catch (err) {
    console.error("Genre albums error:", err);
    res.status(500).json({ error: "Failed to load genre albums" });
  }
});

// ─── Album of the day ─────────────────────────────────────────────────────────
// Deterministic: uses today's date as a seed so everyone gets the same album.
// Picks from Last.fm's global top albums list at a date-derived offset.
app.get("/api/album-of-the-day", async (req, res) => {
  try {
    const token = await getAccessToken();
    const today = new Date();
    // Seed: days since epoch — changes every day, same for everyone
    const seed = Math.floor(today.getTime() / 86400000);
    const page = (seed % 10) + 1;
    const offset = seed % 50;

    const data = await lfm({ method: "chart.getTopArtists", limit: 50, page });
    if (!data?.artists?.artist) throw new Error();
    const artists = Array.isArray(data.artists.artist) ? data.artists.artist : [data.artists.artist];

    // Deterministic pick from the list
    const artist = artists[offset % artists.length];
    const topAlbums = await getLastfmTopAlbums(artist.name, 10);
    if (!topAlbums.length) throw new Error();

    const albumName = topAlbums[seed % topAlbums.length];
    const found = await spotifyFindAlbum(token, artist.name, albumName);
    if (!found) throw new Error();

    res.json({ ...formatAlbum(found), date: today.toISOString().split("T")[0] });
  } catch (err) {
    console.error("Album of the day error:", err);
    res.status(500).json({ error: "Failed to load album of the day" });
  }
});

// ─── Rate-limit helper ────────────────────────────────────────────────────────
// Run async tasks in sequential batches with a small delay between each
// to avoid hammering Last.fm's rate limit (5 req/s).
async function batchedMap(items, fn, batchSize = 4, delayMs = 250) {
  const results = [];
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    const batchResults = await Promise.all(batch.map(fn));
    results.push(...batchResults);
    if (i + batchSize < items.length) {
      await new Promise(r => setTimeout(r, delayMs));
    }
  }
  return results;
}

// ─── Shared helper: Last.fm album list → Spotify enriched albums ─────────────
async function enrichAlbumsFromSpotify(token, lfmAlbums) {
  const results = await Promise.all(
    lfmAlbums.map(({ artist, name }) => spotifyFindAlbum(token, artist, name))
  );
  return results.filter(Boolean);
}

// ─── Popular right now via Last.fm chart.getTopArtists ───────────────────────
// Uses batched requests (4 at a time, 250ms apart) to stay under rate limit.
app.get("/api/new-releases", async (req, res) => {
  try {
    const token = await getAccessToken();

    // One call to get the top 20 charting artists
    const chartData = await lfm({ method: "chart.getTopArtists", limit: 20 });
    if (!chartData?.artists?.artist) throw new Error("No chart data");

    const artists = Array.isArray(chartData.artists.artist)
      ? chartData.artists.artist
      : [chartData.artists.artist];

    // Batched: get top album name for each artist (4 at a time)
    const latestAlbums = await batchedMap(artists, async (a) => {
      const topAlbums = await getLastfmTopAlbums(a.name, 1);
      if (!topAlbums.length) return null;
      return { artist: a.name, name: topAlbums[0] };
    }, 4, 250);

    const validAlbums = latestAlbums.filter(Boolean);

    // Spotify lookups can all be parallel (Spotify has a much higher rate limit)
    const enriched = await enrichAlbumsFromSpotify(token, validAlbums);

    const seen = new Set();
    const unique = enriched.filter(a => {
      if (seen.has(a.id)) return false;
      seen.add(a.id);
      return true;
    });

    res.json(unique.slice(0, 20).map(formatAlbum));
  } catch (err) {
    console.error("New releases error:", err);
    res.status(500).json({ error: "Failed to load new releases" });
  }
});

// ─── Random album by genre via Last.fm tag.getTopAlbums ───────────────────────
// Last.fm's tag system is massive and reliable — every genre/tag has a
// curated list of top albums. We fetch the top 100 for a tag and pick randomly.
app.get("/api/random-album", async (req, res) => {
  try {
    const token = await getAccessToken();
    const genre = req.query.genre?.toLowerCase().trim() || null;

    let lfmAlbums = [];

    if (genre) {
      // Fetch top albums for this tag from Last.fm (up to 4 pages for variety)
      const page = Math.floor(Math.random() * 4) + 1;
      const data = await lfm({ method: "tag.getTopAlbums", tag: genre, limit: 50, page });
      if (data?.albums?.album) {
        const raw = Array.isArray(data.albums.album) ? data.albums.album : [data.albums.album];
        lfmAlbums = raw
          .filter(a => a.name && a.name !== "(null)" && a.artist?.name)
          .map(a => ({ artist: a.artist.name, name: a.name }));
      }
    } else {
      // No genre — pick from Last.fm's global top albums with a random page
      const page = Math.floor(Math.random() * 10) + 1;
      const data = await lfm({ method: "chart.getTopArtists", limit: 50, page });
      if (data?.artists?.artist) {
        const artists = Array.isArray(data.artists.artist)
          ? data.artists.artist
          : [data.artists.artist];
        // Pick a random artist and get one of their albums
        const randomArtist = artists[Math.floor(Math.random() * artists.length)];
        const topAlbums = await getLastfmTopAlbums(randomArtist.name, 10);
        if (topAlbums.length) {
          const randomAlbum = topAlbums[Math.floor(Math.random() * topAlbums.length)];
          lfmAlbums = [{ artist: randomArtist.name, name: randomAlbum }];
        }
      }
    }

    if (!lfmAlbums.length) return res.status(404).json({ error: "No albums found" });

    // Shuffle and try up to 5 picks until we find one Spotify knows about
    const shuffled = lfmAlbums.sort(() => Math.random() - 0.5);
    for (const candidate of shuffled.slice(0, 5)) {
      const album = await spotifyFindAlbum(token, candidate.artist, candidate.name);
      if (album && album.images?.length) {
        return res.json(formatAlbum(album));
      }
    }

    return res.status(404).json({ error: "No albums found" });
  } catch (err) {
    console.error("Random album error:", err);
    res.status(500).json({ error: "Failed to get random album" });
  }
});

app.listen(PORT, () => {
  console.log(`Server running at http://127.0.0.1:${PORT}`);
});