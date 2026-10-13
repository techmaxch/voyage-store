"use strict";
/*
 * Voyage Store: минимальный сервер без зависимостей (Node 18+).
 *  - отдаёт статику из папки public/
 *  - /api/catalog: каталог из Google Таблицы (CSV) с кэшем и запасным вариантом data/products.json
 *  - /healthz: проверка для Railway
 */
const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3000;
const SHEET_CSV_URL = (process.env.SHEET_CSV_URL || "").trim();
const CACHE_SECONDS = Number(process.env.CACHE_SECONDS || 60);

const CONFIG = {
  rate: Number(process.env.USD_RATE || 3.65),
  whatsapp: (process.env.WHATSAPP || "971500000000").replace(/\D/g, ""),
  telegram: (process.env.TELEGRAM || "voyagestore").replace(/^@/, ""),
  instagram: (process.env.INSTAGRAM || "voyagestore").replace(/^@/, "")
};

const ROOT = path.join(__dirname, "public");
const FALLBACK_FILE = path.join(__dirname, "data", "products.json");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8"
};

/* ---------- CSV ---------- */
function parseCSV(text) {
  const rows = [];
  let row = [], cell = "", inQ = false;
  text = text.replace(/^﻿/, "");
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; } else inQ = false;
      } else cell += c;
    } else if (c === '"') inQ = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell); cell = "";
      if (row.some(x => x.trim() !== "")) rows.push(row);
      row = [];
    } else cell += c;
  }
  row.push(cell);
  if (row.some(x => x.trim() !== "")) rows.push(row);
  return rows;
}

const OUT_WORDS = new Set(["нет", "нет в наличии", "no", "0", "false", "-", "out", "out of stock", "закончился"]);
const ORDER_WORDS = new Set(["под заказ", "заказ", "доступен к заказу", "order", "to order", "to_order", "preorder"]);

function toNumber(v) {
  const s = String(v == null ? "" : v).replace(/[^\d.,-]/g, "").replace(",", ".");
  if (s === "") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function rowsToProducts(rows) {
  if (rows.length < 2) return [];
  const head = rows[0].map(h => h.trim().toLowerCase());
  const col = name => head.indexOf(name);
  const idx = {
    id: col("id"), brand: col("brand"), category: col("category"),
    name_ru: col("name_ru"), name_en: col("name_en"),
    spec_ru: col("spec_ru"), spec_en: col("spec_en"),
    price_aed: col("price_aed"), in_stock: col("in_stock"), image: col("image")
  };
  if (idx.id < 0 || (idx.name_ru < 0 && idx.name_en < 0)) {
    throw new Error("В таблице нет обязательных столбцов: id и name_ru или name_en");
  }
  const get = (r, i) => (i >= 0 && r[i] != null ? String(r[i]).trim() : "");
  const out = [];
  for (const r of rows.slice(1)) {
    const id = get(r, idx.id);
    const ru = get(r, idx.name_ru), en = get(r, idx.name_en);
    if (!id || (!ru && !en)) continue;
    const stockRaw = get(r, idx.in_stock).toLowerCase();
    const status = OUT_WORDS.has(stockRaw) ? "out" : (ORDER_WORDS.has(stockRaw) ? "to_order" : "in_stock");
    out.push({
      id,
      brand: get(r, idx.brand) || "Other",
      cat: (get(r, idx.category) || "other").toLowerCase(),
      aed: toNumber(get(r, idx.price_aed)),   // пусто = «Цена по запросу»
      status,
      image: get(r, idx.image),
      name: { ru: ru || en, en: en || ru },
      spec: {
        ru: get(r, idx.spec_ru) || get(r, idx.spec_en),
        en: get(r, idx.spec_en) || get(r, idx.spec_ru)
      }
    });
  }
  return out;
}

/* ---------- каталог ---------- */
let cache = { at: 0, products: null, source: "none" };

function loadFallback() {
  try {
    return JSON.parse(fs.readFileSync(FALLBACK_FILE, "utf8"));
  } catch (e) {
    console.error("Не удалось прочитать запасной каталог:", e.message);
    return [];
  }
}

async function getCatalog() {
  const fresh = Date.now() - cache.at < CACHE_SECONDS * 1000;
  if (cache.products && fresh) return cache;

  if (SHEET_CSV_URL) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 8000);
      const res = await fetch(SHEET_CSV_URL, { signal: ctrl.signal, redirect: "follow" });
      clearTimeout(timer);
      if (!res.ok) throw new Error("HTTP " + res.status);
      const products = rowsToProducts(parseCSV(await res.text()));
      if (!products.length) throw new Error("Таблица пуста или нет подходящих строк");
      cache = { at: Date.now(), products, source: "sheet" };
      return cache;
    } catch (e) {
      console.error("Google Таблица недоступна:", e.message);
      // используем последний удачный ответ, если он есть
      if (cache.products && cache.source === "sheet") {
        cache.at = Date.now() - (CACHE_SECONDS - 15) * 1000; // повторим через ~15 сек
        return cache;
      }
    }
  }
  cache = { at: Date.now() - (CACHE_SECONDS - 15) * 1000, products: loadFallback(), source: "fallback" };
  return cache;
}

/* ---------- HTTP ---------- */
function send(res, status, body, headers) {
  res.writeHead(status, Object.assign({
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin"
  }, headers || {}));
  res.end(body);
}

function serveStatic(req, res, pathname) {
  let rel;
  try { rel = decodeURIComponent(pathname); } catch (e) { return send(res, 400, "Bad request"); }
  if (rel.endsWith("/")) rel += "index.html";
  const file = path.normalize(path.join(ROOT, rel));
  if (file !== ROOT && !file.startsWith(ROOT + path.sep)) return send(res, 403, "Forbidden");
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return send(res, 404, "Not found", { "Content-Type": "text/plain; charset=utf-8" });
    const ext = path.extname(file).toLowerCase();
    const isImg = /\.(png|jpe?g|webp|gif|svg|ico)$/.test(ext);
    res.writeHead(200, {
      "Content-Type": MIME[ext] || "application/octet-stream",
      "Content-Length": st.size,
      "Cache-Control": isImg ? "public, max-age=3600" : "no-cache",
      "X-Content-Type-Options": "nosniff"
    });
    if (req.method === "HEAD") return res.end();
    fs.createReadStream(file).pipe(res);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, "Method not allowed");

  if (url.pathname === "/healthz") return send(res, 200, "ok", { "Content-Type": "text/plain" });

  if (url.pathname === "/api/catalog") {
    const c = await getCatalog();
    return send(res, 200, JSON.stringify({ config: CONFIG, source: c.source, products: c.products }), {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-cache"
    });
  }

  serveStatic(req, res, url.pathname);
});

server.listen(PORT, () => {
  console.log(`Voyage Store: http://localhost:${PORT} (${SHEET_CSV_URL ? "Google Таблица подключена" : "запасной каталог"})`);
});
