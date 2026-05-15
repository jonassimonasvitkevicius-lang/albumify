const express = require("express");
const path = require("path");
require("dotenv").config();

const app = express();
const PORT = 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ─────────────────────────────────────────────────────────────
// Spotify auth
// ─────────────────────────────────────────────────────────────

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

  const response = await fetch(
    "https://accounts.spotify.com/api/token",
    {
      method: "POST",
      headers: {
        "Content-Type":
          "application/x-www-form-urlencoded",
      },
      body: params.toString(),
    }
  );

  const data = await response.json();

  if (!response.ok) {
    throw new Error("Spotify auth failed");
  }

  cachedToken = data.access_token;

  tokenExpiry =
    Date.now() + (data.expires_in - 60) * 1000;

  return cachedToken;
}

// ─────────────────────────────────────────────────────────────
// Safe Spotify fetch with retry + timeout + rate limit handling
// ─────────────────────────────────────────────────────────────

async function spotifyFetch(
  url,
  token,
  retries = 3
) {
  for (let i = 0; i < retries; i++) {
    const controller = new AbortController();

    const timeout = setTimeout(() => {
      controller.abort();
    }, 8000);

    try {
      const response = await fetch(url, {
        headers: {
          Authorization: `Bearer ${token}`,
        },
        signal: controller.signal,
      });

      clearTimeout(timeout);

      // Spotify rate limit handling
      if (response.status === 429) {
        const retryAfter =
          parseInt(
            response.headers.get("Retry-After")
          ) || 1;

        console.log(
          `Spotify rate limited. Waiting ${retryAfter}s`
        );

        await new Promise((r) =>
          setTimeout(r, retryAfter * 1000)
        );

        continue;
      }

      return response;
    } catch (err) {
      clearTimeout(timeout);

      console.log("Spotify fetch retry...");

      if (i === retries - 1) {
        throw err;
      }

      await new Promise((r) =>
        setTimeout(r, 1000)
      );
    }
  }
}

// ─────────────────────────────────────────────────────────────
// Last.fm helpers
// ─────────────────────────────────────────────────────────────

const LASTFM_KEY = process.env.LASTFM_API_KEY;

const LASTFM_BASE =
  "https://ws.audioscrobbler.com/2.0/";

async function lfm(params) {
  const url =
    LASTFM_BASE +
    "?" +
    new URLSearchParams({
      ...params,
      api_key: LASTFM_KEY,
      format: "json",
    });

  try {
    const controller = new AbortController();

    const timeout = setTimeout(() => {
      controller.abort();
    }, 8000);

    const res = await fetch(url, {
      signal: controller.signal,
    });

    clearTimeout(timeout);

    const data = await res.json();

    if (data.error) {
      return null;
    }

    return data;
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────
// Last.fm data
// ─────────────────────────────────────────────────────────────

async function getLastfmSimilarArtists(
  artistName,
  limit = 8
) {
  const data = await lfm({
    method: "artist.getSimilar",
    artist: artistName,
    limit,
    autocorrect: 1,
  });

  if (!data?.similarartists?.artist) {
    return [];
  }

  const artists = data.similarartists.artist;

  return (
    Array.isArray(artists)
      ? artists
      : [artists]
  ).map((a) => ({
    name: a.name,
    score: parseFloat(a.match) || 0,
  }));
}

async function getLastfmAlbumTags(
  artistName,
  albumName
) {
  const data = await lfm({
    method: "album.getTopTags",
    artist: artistName,
    album: albumName,
    autocorrect: 1,
  });

  if (!data?.toptags?.tag) {
    return new Set();
  }

  const tags = data.toptags.tag;

  return new Set(
    (
      Array.isArray(tags)
        ? tags
        : [tags]
    )
      .slice(0, 10)
      .map((t) =>
        t.name.toLowerCase().trim()
      )
  );
}

async function getLastfmArtistTags(
  artistName
) {
  const data = await lfm({
    method: "artist.getTopTags",
    artist: artistName,
    autocorrect: 1,
  });

  if (!data?.toptags?.tag) {
    return new Set();
  }

  const tags = data.toptags.tag;

  return new Set(
    (
      Array.isArray(tags)
        ? tags
        : [tags]
    )
      .slice(0, 10)
      .map((t) =>
        t.name.toLowerCase().trim()
      )
  );
}

async function getLastfmTopAlbums(
  artistName,
  limit = 2
) {
  const data = await lfm({
    method: "artist.getTopAlbums",
    artist: artistName,
    limit,
    autocorrect: 1,
  });

  if (!data?.topalbums?.album) {
    return [];
  }

  const albums = data.topalbums.album;

  return (
    Array.isArray(albums)
      ? albums
      : [albums]
  )
    .filter(
      (a) =>
        a.name &&
        a.name !== "(null)"
    )
    .map((a) => a.name);
}

// ─────────────────────────────────────────────────────────────
// Spotify helpers
// ─────────────────────────────────────────────────────────────

async function spotifyFindAlbum(
  token,
  artistName,
  albumName
) {
  const q = `artist:${artistName} album:${albumName}`;

  const res = await spotifyFetch(
    `https://api.spotify.com/v1/search?q=${encodeURIComponent(
      q
    )}&type=album&limit=1&market=US`,
    token
  );

  const data = await res.json();

  if (
    res.ok &&
    data.albums?.items?.length
  ) {
    return data.albums.items[0];
  }

  return null;
}

async function getAlbumsByArtist(
  token,
  artistName,
  limit = 1
) {
  const res = await spotifyFetch(
    `https://api.spotify.com/v1/search?q=artist:${encodeURIComponent(
      artistName
    )}&type=album&limit=${limit}&market=US`,
    token
  );

  const data = await res.json();

  if (
    res.ok &&
    data.albums?.items
  ) {
    return data.albums.items;
  }

  return [];
}

// ─────────────────────────────────────────────────────────────
// Utils
// ─────────────────────────────────────────────────────────────

function formatAlbum(a) {
  return {
    id: a.id,
    name: a.name,
    artist: a.artists
      .map((x) => x.name)
      .join(", "),
    artistId:
      a.artists[0]?.id ?? null,
    year:
      a.release_date?.split("-")[0] ??
      "?",
    releaseDate:
      a.release_date ?? null,
    image:
      a.images?.[0]?.url ?? null,
    totalTracks: a.total_tracks,
    spotifyUrl:
      a.external_urls?.spotify ??
      null,
  };
}

function tagOverlap(setA, setB) {
  let n = 0;

  for (const t of setA) {
    if (setB.has(t)) {
      n++;
    }
  }

  return n;
}

async function batchedMap(
  items,
  fn,
  batchSize = 2,
  delayMs = 500
) {
  const results = [];

  for (
    let i = 0;
    i < items.length;
    i += batchSize
  ) {
    const batch = items.slice(
      i,
      i + batchSize
    );

    const batchResults =
      await Promise.all(batch.map(fn));

    results.push(...batchResults);

    if (
      i + batchSize <
      items.length
    ) {
      await new Promise((r) =>
        setTimeout(r, delayMs)
      );
    }
  }

  return results;
}

// ─────────────────────────────────────────────────────────────
// Search
// ─────────────────────────────────────────────────────────────

app.get("/api/search", async (req, res) => {
  const { q } = req.query;

  if (!q) {
    return res
      .status(400)
      .json({
        error: "Missing query",
      });
  }

  try {
    const token =
      await getAccessToken();

    const response =
      await spotifyFetch(
        `https://api.spotify.com/v1/search?q=${encodeURIComponent(
          q
        )}&type=album&limit=20&market=US`,
        token
      );

    const data =
      await response.json();

    if (
      !response.ok ||
      !data.albums
    ) {
      return res.json([]);
    }

    const unique = {};
    data.albums.items.forEach(
      (a) => {
        unique[a.id] = a;
      }
    );

    res.json(
      Object.values(unique).map(
        formatAlbum
      )
    );
  } catch (err) {
    console.error(
      "Search error:",
      err
    );

    res.status(500).json({
      error: "Search failed",
    });
  }
});

// ─────────────────────────────────────────────────────────────
// Album page
// ─────────────────────────────────────────────────────────────

app.get("/api/album/:id", async (req, res) => {
  try {
    const token =
      await getAccessToken();

    const response =
      await spotifyFetch(
        `https://api.spotify.com/v1/albums/${req.params.id}`,
        token
      );

    const data =
      await response.json();

    if (!response.ok) {
      throw new Error();
    }

    const artistName =
      data.artists[0]?.name ?? "";

    const albumName =
      data.name ?? "";

    const [
      albumTags,
      artistTags,
    ] = await Promise.all([
      getLastfmAlbumTags(
        artistName,
        albumName
      ),
      getLastfmArtistTags(
        artistName
      ),
    ]);

    const junk = new Set([
      "seen live",
      "albums i own",
      "favorites",
      "love",
      "awesome",
      "good",
      "great",
      "owned",
    ]);

    const merged = [];
    const seen = new Set();

    for (const tag of [
      ...albumTags,
      ...artistTags,
    ]) {
      const t = tag
        .toLowerCase()
        .trim();

      if (
        seen.has(t) ||
        t.length < 2 ||
        /^\d+$/.test(t) ||
        junk.has(t)
      ) {
        continue;
      }

      seen.add(t);
      merged.push(tag);

      if (merged.length >= 8) {
        break;
      }
    }

    res.json({
      ...formatAlbum(data),
      tags: merged,
      tracks:
        data.tracks.items.map(
          (t) => ({
            track_number:
              t.track_number,
            name: t.name,
            duration_ms:
              t.duration_ms,
          })
        ),
    });
  } catch (err) {
    console.error(
      "Album error:",
      err
    );

    res.status(500).json({
      error:
        "Failed to load album",
    });
  }
});

// ─────────────────────────────────────────────────────────────
// Similar albums
// ─────────────────────────────────────────────────────────────

app.get(
  "/api/similar/:albumId",
  async (req, res) => {
    try {
      const token =
        await getAccessToken();

      const albumRes =
        await spotifyFetch(
          `https://api.spotify.com/v1/albums/${req.params.albumId}`,
          token
        );

      if (!albumRes.ok) {
        return res
          .status(500)
          .json({
            error:
              "Could not fetch album",
          });
      }

      const album =
        await albumRes.json();

      const sourceArtistName =
        album.artists[0]?.name ??
        "";

      const sourceArtistId =
        album.artists[0]?.id ??
        null;

      const sourceAlbumName =
        album.name ?? "";

      const sourceYear =
        parseInt(
          album.release_date?.split(
            "-"
          )[0]
        ) || null;

      if (!sourceArtistName) {
        return res.json([]);
      }

      const [
        sourceAlbumTags,
        sourceArtistTags,
        similarArtists,
      ] = await Promise.all([
        getLastfmAlbumTags(
          sourceArtistName,
          sourceAlbumName
        ),

        getLastfmArtistTags(
          sourceArtistName
        ),

        getLastfmSimilarArtists(
          sourceArtistName,
          8
        ),
      ]);

      if (
        similarArtists.length ===
        0
      ) {
        return res.json([]);
      }

      const artistDetails =
        await batchedMap(
          similarArtists,
          async ({
            name,
            score,
          }) => {
            const [
              artistTags,
              topAlbumNames,
            ] = await Promise.all([
              getLastfmArtistTags(
                name
              ),

              getLastfmTopAlbums(
                name,
                2
              ),
            ]);

            return {
              name,
              lastfmScore:
                score,
              artistTags,
              topAlbumNames,
            };
          },
          2,
          500
        );

      const scored =
        artistDetails
          .map((artist) => {
            const albumTagScore =
              tagOverlap(
                sourceAlbumTags,
                artist.artistTags
              ) * 4;

            const artistTagScore =
              tagOverlap(
                sourceArtistTags,
                artist.artistTags
              );

            const finalScore =
              artist.lastfmScore *
                10 +
              albumTagScore +
              artistTagScore;

            return {
              ...artist,
              finalScore,
            };
          })
          .sort(
            (a, b) =>
              b.finalScore -
              a.finalScore
          );

      const seen = new Set();

      const candidates = [];

      for (const {
        name,
        finalScore,
        topAlbumNames,
      } of scored) {
        let foundAlbums = [];

        if (
          topAlbumNames.length > 0
        ) {
          const found =
            await spotifyFindAlbum(
              token,
              name,
              topAlbumNames[0]
            );

          if (found) {
            foundAlbums.push(
              found
            );
          }
        }

        if (
          foundAlbums.length === 0
        ) {
          foundAlbums =
            await getAlbumsByArtist(
              token,
              name,
              1
            );
        }

        for (const a of foundAlbums) {
          if (!a) continue;

          if (seen.has(a.id))
            continue;

          if (!a.images?.length)
            continue;

          if (
            a.artists[0]?.id ===
            sourceArtistId
          ) {
            continue;
          }

          seen.add(a.id);

          candidates.push({
            album: a,
            finalScore,
          });
        }

        if (
          candidates.length >= 12
        ) {
          break;
        }

        await new Promise((r) =>
          setTimeout(r, 150)
        );
      }

      candidates.sort(
        (a, b) => {
          if (
            Math.abs(
              b.finalScore -
                a.finalScore
            ) > 0.01
          ) {
            return (
              b.finalScore -
              a.finalScore
            );
          }

          if (sourceYear) {
            const yA =
              parseInt(
                a.album.release_date?.split(
                  "-"
                )[0]
              ) || 0;

            const yB =
              parseInt(
                b.album.release_date?.split(
                  "-"
                )[0]
              ) || 0;

            return (
              Math.abs(
                yA -
                  sourceYear
              ) -
              Math.abs(
                yB -
                  sourceYear
              )
            );
          }

          return 0;
        }
      );

      res.json(
        candidates
          .slice(0, 12)
          .map((c) =>
            formatAlbum(c.album)
          )
      );
    } catch (err) {
      console.error(
        "Similar error:",
        err
      );

      res.status(500).json({
        error:
          "Failed to load similar albums",
      });
    }
  }
);

// ─────────────────────────────────────────────────────────────
// Start server
// ─────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(
    `Server running at http://127.0.0.1:${PORT}`
  );
});