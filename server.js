const path = require("path");
const express = require("express");
const Parser = require("rss-parser");

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

// Site-id 9500 = Märsta pendeltågsstation. Alla pendeltåg härifrån (linje 41)
// går söderut via Citybanan och stannar vid Stockholms södra.
const MARSTA_SITE_ID = 9500;

app.get("/api/timetable/marsta-sodra", async (req, res) => {
  try {
    const data = await cached("timetable:marsta-sodra", 60 * 1000, async () => {
      const r = await fetch(`https://transport.integration.sl.se/v1/sites/${MARSTA_SITE_ID}/departures?transport=TRAIN&forecast=180`);
      if (!r.ok) throw new Error("SL Transport API svarade " + r.status);
      const json = await r.json();
      const departures = (json.departures || []).map(d => ({
        display: d.display,
        scheduled: d.scheduled,
        expected: d.expected,
        line: d.line?.designation,
        destination: d.destination,
        state: d.state,
        deviations: (d.deviations || []).map(dv => dv.message)
      }));
      return { departures };
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
  optimistdaily: { name: "Optimist Daily", url: "https://www.optimistdaily.com/feed/" },
  evt_uppsala_konsert: { name: "Konsert", url: "https://destinationuppsala.se/event-kategori/konsert/feed/" },
  evt_uppsala_festival: { name: "Festival", url: "https://destinationuppsala.se/event-kategori/festival/feed/" },
  evt_uppsala_marknad: { name: "Marknad", url: "https://destinationuppsala.se/event-kategori/marknad/feed/" },
  evt_uppsala_julmarknad: { name: "Julmarknad", url: "https://destinationuppsala.se/event-kategori/julmarknad/feed/" },
  evt_uppsala_teater: { name: "Teater", url: "https://destinationuppsala.se/event-kategori/teater/feed/" },
  evt_uppsala_utstallning: { name: "Utställning", url: "https://destinationuppsala.se/event-kategori/utstallning/feed/" },
  evt_uppsala_aktiviteter: { name: "Aktiviteter", url: "https://destinationuppsala.se/event-kategori/aktiviteter/feed/" },
  evt_uppsala_barnfamilj: { name: "Barn & familj", url: "https://destinationuppsala.se/event-kategori/barn-familj/feed/" },
  evt_uppsala_matdryck: { name: "Mat & dryck", url: "https://destinationuppsala.se/event-kategori/mat-dryck/feed/" },
  evt_knivsta_visit: { name: "Visit Knivsta", url: "https://www.visitknivsta.se/feed/" }
};

const EVENT_CITY_FEEDS = {
  uppsala: [
    "evt_uppsala_konsert", "evt_uppsala_festival", "evt_uppsala_marknad", "evt_uppsala_julmarknad",
    "evt_uppsala_teater", "evt_uppsala_utstallning", "evt_uppsala_aktiviteter", "evt_uppsala_barnfamilj",
    "evt_uppsala_matdryck"
  ],
  knivsta: ["evt_knivsta_visit"]
  // stockholm: ingen fungerande nyckelfri källa hittades (visitstockholm.com är en JS-app utan RSS/API)
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

app.get("/api/events", async (req, res) => {
  const cityKey = req.query.city;
  const feedKeys = EVENT_CITY_FEEDS[cityKey];
  if (!feedKeys) {
    // t.ex. Stockholm: ingen fungerande nyckelfri källa hittades, frontend visar länk-ut-läge
    return res.json({ city: cityKey, items: [], unsupported: true });
  }
  try {
    const agg = await aggregateFeeds(feedKeys);
    res.json({ city: cityKey, items: agg.items, errors: agg.errors });
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
