const path = require("path");
const fs = require("fs");
const express = require("express");
const Parser = require("rss-parser");

// Lätt .env-inläsning (ingen extra dependency). Filen är gitignorad —
// den är bara till för lokal utveckling; på Render sätts miljövariabler i dashboarden.
try {
  const envPath = path.join(__dirname, ".env");
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
      const m = line.match(/^\s*([^#=\s]+)\s*=\s*(.*)\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
    }
  }
} catch { /* ignore */ }

const app = express();
const parser = new Parser({ timeout: 10000 });
const PORT = process.env.PORT || 5175;

const cache = new Map();
async function cached(key, ttlMs, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.time < ttlMs) return hit.data;
  const data = await fn();
  cache.set(key, { time: Date.now(), data });
  return data;
}

const OPEN_METEO_ALLOWED_PARAMS = [
  "latitude", "longitude", "current", "hourly", "daily",
  "wind_speed_unit", "timezone", "forecast_days"
];

app.get("/api/weather", async (req, res) => {
  try {
    const params = new URLSearchParams();
    for (const key of OPEN_METEO_ALLOWED_PARAMS) {
      if (req.query[key] !== undefined) params.set(key, req.query[key]);
    }
    if (!params.has("latitude") || !params.has("longitude")) {
      return res.status(400).json({ error: "latitude och longitude krävs" });
    }
    const cacheKey = "weather:" + params.toString();
    const data = await cached(cacheKey, 5 * 60 * 1000, async () => {
      const url = `https://api.open-meteo.com/v1/forecast?${params.toString()}`;
      const r = await fetch(url);
      if (!r.ok) throw new Error("Open-Meteo svarade " + r.status);
      return r.json();
    });
    res.json(data);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

app.get("/api/nameday", async (req, res) => {
  try {
    const now = new Date();
    const dateKey = now.toISOString().slice(0, 10);
    const data = await cached("nameday:" + dateKey, 12 * 60 * 60 * 1000, async () => {
      const url = `https://api.dryg.net/dagar/v2.1/${now.getFullYear()}/${now.getMonth() + 1}/${now.getDate()}`;
      const r = await fetch(url);
      if (!r.ok) throw new Error("Namnsdag-API svarade " + r.status);
      const json = await r.json();
      return { names: json.dagar?.[0]?.namnsdag || [] };
    });
    res.json(data);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

app.get("/api/sl-deviations", async (req, res) => {
  try {
    const data = await cached("sl-deviations", 60 * 1000, async () => {
      const r = await fetch("https://deviations.integration.sl.se/v1/messages?future=true");
      if (!r.ok) throw new Error("SL Deviations svarade " + r.status);
      return r.json();
    });
    res.json(data);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

const NEWS_SOURCES = {
  svt: { name: "SVT Nyheter", url: "https://www.svt.se/nyheter/rss.xml" },
  bbc: { name: "BBC News", url: "https://feeds.bbci.co.uk/news/rss.xml" },
  dailymail: { name: "Daily Mail", url: "https://www.dailymail.co.uk/articles.rss" },
  sigtuna: { name: "Sigtuna/Märsta", url: "https://www.marsta.nu/feed/" },
  knivsta: { name: "Knivsta", url: "https://knivstadirekt.se/feed/" },
  ign: { name: "IGN", url: "https://feeds.ign.com/ign/all" },
  pcgamer: { name: "PC Gamer", url: "https://www.pcgamer.com/rss/" },
  eurogamer: { name: "Eurogamer", url: "https://www.eurogamer.net/feed" },
  techcrunch_ai: { name: "TechCrunch AI", url: "https://techcrunch.com/category/artificial-intelligence/feed/" },
  venturebeat_ai: { name: "VentureBeat AI", url: "https://venturebeat.com/category/ai/feed/" },
  verge_ai: { name: "The Verge AI", url: "https://www.theverge.com/rss/ai-artificial-intelligence/index.xml" },
  goodnews: { name: "Good News Network", url: "https://www.goodnewsnetwork.org/feed/" },
  optimistdaily: { name: "Optimist Daily", url: "https://www.optimistdaily.com/feed/" }
};

async function fetchFeed(key) {
  const src = NEWS_SOURCES[key];
  if (!src) throw new Error("Okänd källa: " + key);
  return cached("feed:" + key, 5 * 60 * 1000, async () => {
    const feed = await parser.parseURL(src.url);
    const items = (feed.items || []).slice(0, 15).map(it => ({
      title: (it.title || "").trim(),
      link: it.link,
      pubDate: it.isoDate || it.pubDate || null,
      snippet: (it.contentSnippet || "").slice(0, 220)
    }));
    return { source: key, name: src.name, updated: Date.now(), items };
  });
}

async function aggregateFeeds(keys) {
  const results = await Promise.allSettled(keys.map(fetchFeed));
  const combined = [];
  const errors = [];
  results.forEach((r, i) => {
    if (r.status === "fulfilled") {
      r.value.items.forEach(it => combined.push({ ...it, source: r.value.name }));
    } else {
      errors.push({ source: keys[i], error: r.reason.message });
    }
  });
  combined.sort((a, b) => new Date(b.pubDate || 0) - new Date(a.pubDate || 0));
  return { items: combined.slice(0, 30), errors, updated: Date.now() };
}

app.get("/api/news/gaming", async (req, res) => {
  try {
    res.json(await aggregateFeeds(["ign", "pcgamer", "eurogamer"]));
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

app.get("/api/news/ai", async (req, res) => {
  try {
    res.json(await aggregateFeeds(["techcrunch_ai", "venturebeat_ai", "verge_ai"]));
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

app.get("/api/news/positive", async (req, res) => {
  try {
    res.json(await aggregateFeeds(["goodnews", "optimistdaily"]));
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

const EVENT_CITIES = {
  knivsta: "Knivsta",
  uppsala: "Uppsala",
  stockholm: "Stockholm"
};

app.get("/api/events", async (req, res) => {
  const cityKey = req.query.city;
  const cityName = EVENT_CITIES[cityKey];
  if (!cityName) {
    return res.status(400).json({ error: "Ogiltig stad. Använd knivsta, uppsala eller stockholm." });
  }
  if (!process.env.TICKETMASTER_API_KEY) {
    return res.status(503).json({ error: "TICKETMASTER_API_KEY är inte konfigurerad på servern." });
  }
  try {
    const data = await cached("events:" + cityKey, 30 * 60 * 1000, async () => {
      const params = new URLSearchParams({
        apikey: process.env.TICKETMASTER_API_KEY,
        city: cityName,
        countryCode: "SE",
        sort: "date,asc",
        size: "50"
      });
      const r = await fetch(`https://app.ticketmaster.com/discovery/v2/events.json?${params.toString()}`);
      if (!r.ok) throw new Error("Ticketmaster svarade " + r.status);
      const json = await r.json();
      const events = (json._embedded?.events || []).map(e => ({
        name: e.name,
        url: e.url,
        start: e.dates?.start?.dateTime || e.dates?.start?.localDate || null,
        venue: e._embedded?.venues?.[0]?.name || "",
        classification: e.classifications?.[0]?.segment?.name || "",
        genre: e.classifications?.[0]?.genre?.name || ""
      }));
      return { city: cityName, events };
    });
    res.json(data);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

app.get("/api/news/:key", async (req, res) => {
  try {
    const data = await fetchFeed(req.params.key);
    res.json(data);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

app.use(express.static(path.join(__dirname, "public")));

app.listen(PORT, () => {
  console.log(`Dagliga uppdateringar körs på http://localhost:${PORT}`);
});
