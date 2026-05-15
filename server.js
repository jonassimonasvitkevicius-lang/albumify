const express = require("express");
const path = require("path");
require("dotenv").config();

const app = express();
const PORT = 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));


// ─────────────────────────────────────────────────────────────────────────────
// SIMPLE CACHE
// ─────────────────────────────────────────────────────────────────────────────

const CACHE_TTL = 1000 * 60 * 60 * 6; // 6 hours
const cache = new Map();

function getCache(key) {
  const item = cache.get(key);

  if (!item) return null;

  if (Date.now() > item.expiry) {
    cache.delete(key);
    return null;
  }

  return item.value;
}

function setCache(key, value, ttl = CACHE_TTL) {
  cache.set(key, {
    value,
    expiry: Date.now() + ttl,
  });
}


// ─────────────────────────────────────────────────────────────────────────────
// SAFE FETCH
// ─────────────────────────────────────────────────────────────────────────────

async function safeFetch(url, options = {}, timeout = 10000) {
  try {
    const controller = new AbortController();

    const timer = setTimeout(() => {
      controller.abort();
    }, timeout);

    const res = await fetch(url, {
      ...options,
      signal: controller.signal,
    });

    clearTimeout(timer);

    return res;
  } catch {
    return null;
  }
}


// ─────────────────────────────────────────────────────────────────────────────
// SPOTIFY AUTH
// ─────────────────────────────────────────────────────────────────────────────

let cachedToken = null;
let tokenExpiry = 0;

async function getAccessToken() {
  if (cachedToken && Date.now() < tokenExpiry) {
    return cachedToken;
  }

  const params = new URLSearchParams();

  params.append("grant_type", "client_credentials");
  params.append("client_id", process.env.SPOTIFY_CLIENT_ID);
  params.append("client_secret", process.env.SPOTIFY_CLIENT_SECRET);

  const response = await safeFetch(
    "https://accounts.spotify.com/api/token",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params.toString(),
    }
  );

  if (!response) {
    throw new Error("Spotify auth failed");
  }

  const data = await response.json();

  cachedToken = data.access_token;
  tokenExpiry = Date.now() + (data.expires_in - 60) * 1000;

  return cachedToken;
}


// ─────────────────────────────────────────────────────────────────────────────
// LAST.FM
// ─────────────────────────────────────────────────────────────────────────────

const LASTFM_KEY = process.env.LASTFM_API_KEY;
const LASTFM_BASE = "https://ws.audioscrobbler.com/2.0/";

async function lfm(params) {
  const key = JSON.stringify(params);

  const cached = getCache(key);

  if (cached) return cached;

  const url =
    LASTFM_BASE +
    "?" +
    new URLSearchParams({
      ...params,
      api_key: LASTFM_KEY,
      format: "json",
    });

  const res = await safeFetch(url);

  if (!res) return null;

  const data = await res.json();

  if (data.error) return null;

  setCache(key, data);

  return data;
}


// ─────────────────────────────────────────────────────────────────────────────
// LAST.FM HELPERS
// ─────────────────────────────────────────────────────────────────────────────

async function getLastfmSimilarArtists(artistName, limit = 12) {
  const data = await lfm({
    method: "artist.getSimilar",
    artist: artistName,
    limit,
    autocorrect: 1,
  });

  if (!data?.similarartists?.artist) return [];

  const artists = Array.isArray(data.similarartists.artist)
    ? data.similarartists.artist
    : [data.similarartists.artist];

  return artists.map((a) => ({
    name: a.name,
    score: parseFloat(a.match) || 0,
  }));
}

async function getLastfmAlbumTags(artistName, albumName) {
  const data = await lfm({
    method: "album.getTopTags",
    artist: artistName,
    album: albumName,
    autocorrect: 1,
  });

  if (!data?.toptags?.tag) return new Set();

  const tags = Array.isArray(data.toptags.tag)
    ? data.toptags.tag
    : [data.toptags.tag];

  return new Set(
    tags
      .slice(0, 8)
      .map((t) => t.name.toLowerCase().trim())
  );
}

async function getLastfmArtistTags(artistName) {
  const data = await lfm({
    method: "artist.getTopTags",
    artist: artistName,
    autocorrect: 1,
  });

  if (!data?.toptags?.tag) return new Set();

  const tags = Array.isArray(data.toptags.tag)
    ? data.toptags.tag
    : [data.toptags.tag];

  return new Set(
    tags
      .slice(0, 8)
      .map((t) => t.name.toLowerCase().trim())
  );
}

async function getLastfmTopAlbums(artistName, limit = 2) {
  const data = await lfm({
    method: "artist.getTopAlbums",
    artist: artistName,
    limit,
    autocorrect: 1,
  });

  if (!data?.topalbums?.album) return [];

  const albums = Array.isArray(data.topalbums.album)
    ? data.topalbums.album
    : [data.topalbums.album];

  return albums
    .filter((a) => a.name && a.name !== "(null)")
    .map((a) => a.name);
}


// ─────────────────────────────────────────────────────────────────────────────
// SPOTIFY HELPERS
// ─────────────────────────────────────────────────────────────────────────────

async function spotifyFindAlbum(token, artistName, albumName) {
  const cacheKey = `spotify:${artistName}:${albumName}`;

  const cached = getCache(cacheKey);

  if (cached) return cached;

  const q = `artist:${artistName} album:${albumName}`;

  const res = await safeFetch(
    `https://api.spotify.com/v1/search?q=${encodeURIComponent(
      q
    )}&type=album&limit=1&market=US`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    }
  );

  if (!res) return null;

  const data = await res.json();

  const album =
    res.ok && data.albums?.items?.length
      ? data.albums.items[0]
      : null;

  setCache(cacheKey, album);

  return album;
}

function formatAlbum(a) {
  return {
    id: a.id,
    name: a.name,
    artist: a.artists.map((x) => x.name).join(", "),
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

  for (const t of setA) {
    if (setB.has(t)) n++;
  }

  return n;
}


// ─────────────────────────────────────────────────────────────────────────────
// SEARCH
// ─────────────────────────────────────────────────────────────────────────────

app.get("/api/search", async (req, res) => {
  const { q } = req.query;

  if (!q) {
    return res.status(400).json({
      error: "Missing query",
    });
  }

  try {
    const token = await getAccessToken();

    const response = await safeFetch(
      `https://api.spotify.com/v1/search?q=${encodeURIComponent(
        q
      )}&type=album&limit=20&market=US`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      }
    );

    if (!response) {
      throw new Error();
    }

    const data = await response.json();

    const items = data.albums?.items || [];

    const unique = {};

    items.forEach((a) => {
      unique[a.id] = a;
    });

    res.json(
      Object.values(unique)
        .map(formatAlbum)
        .slice(0, 20)
    );
  } catch (err) {
    console.error(err);

    res.status(500).json({
      error: "Search failed",
    });
  }
});


// ─────────────────────────────────────────────────────────────────────────────
// ALBUM
// ─────────────────────────────────────────────────────────────────────────────

app.get("/api/album/:id", async (req, res) => {
  try {
    const token = await getAccessToken();

    const response = await safeFetch(
      `https://api.spotify.com/v1/albums/${req.params.id}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      }
    );

    if (!response) {
      throw new Error();
    }

    const data = await response.json();

    const artistName = data.artists[0]?.name ?? "";
    const albumName = data.name ?? "";

    const [albumTags, artistTags] = await Promise.all([
      getLastfmAlbumTags(artistName, albumName),
      getLastfmArtistTags(artistName),
    ]);

    const merged = [
      ...new Set([
        ...albumTags,
        ...artistTags,
      ]),
    ].slice(0, 8);

    res.json({
      ...formatAlbum(data),
      tags: merged,
      tracks: data.tracks.items.map((t) => ({
        track_number: t.track_number,
        name: t.name,
        duration_ms: t.duration_ms,
      })),
    });
  } catch (err) {
    console.error(err);

    res.status(500).json({
      error: "Failed to load album",
    });
  }
});


// ─────────────────────────────────────────────────────────────────────────────
// SIMILAR
// ─────────────────────────────────────────────────────────────────────────────

app.get("/api/similar/:albumId", async (req, res) => {
  try {
    const token = await getAccessToken();

    const albumRes = await safeFetch(
      `https://api.spotify.com/v1/albums/${req.params.albumId}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      }
    );

    if (!albumRes) {
      throw new Error();
    }

    const album = await albumRes.json();

    const sourceArtistName = album.artists[0]?.name ?? "";
    const sourceArtistId = album.artists[0]?.id ?? null;
    const sourceAlbumName = album.name ?? "";

    const [sourceAlbumTags, sourceArtistTags, similarArtists] =
      await Promise.all([
        getLastfmAlbumTags(
          sourceArtistName,
          sourceAlbumName
        ),

        getLastfmArtistTags(sourceArtistName),

        getLastfmSimilarArtists(sourceArtistName, 12),
      ]);

    const candidates = [];
    const seenArtists = new Set();

    for (const artist of similarArtists) {
      if (seenArtists.has(artist.name)) {
        continue;
      }

      seenArtists.add(artist.name);

      const artistTags =
        await getLastfmArtistTags(artist.name);

      const topAlbums =
        await getLastfmTopAlbums(artist.name, 2);

      const score =
        artist.score * 10 +
        tagOverlap(
          sourceAlbumTags,
          artistTags
        ) *
          4 +
        tagOverlap(
          sourceArtistTags,
          artistTags
        );

      for (const albumName of topAlbums) {
        const found = await spotifyFindAlbum(
          token,
          artist.name,
          albumName
        );

        if (!found) continue;

        if (!found.images?.length) continue;

        if (found.artists[0]?.id === sourceArtistId) {
          continue;
        }

        candidates.push({
          album: found,
          score,
        });
      }
    }

    candidates.sort((a, b) => b.score - a.score);

    const unique = [];
    const seen = new Set();

    for (const c of candidates) {
      if (seen.has(c.album.id)) {
        continue;
      }

      seen.add(c.album.id);

      unique.push(formatAlbum(c.album));

      if (unique.length >= 20) {
        break;
      }
    }

    res.json(unique);
  } catch (err) {
    console.error(err);

    res.status(500).json({
      error: "Failed to load similar albums",
    });
  }
});


// ─────────────────────────────────────────────────────────────────────────────
// START
// ─────────────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(
    `Server running at http://127.0.0.1:${PORT}`
  );
});