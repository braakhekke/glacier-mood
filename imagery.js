/* Background pictures for the 2D map and the 3D view: swisstopo grey map, SWISSIMAGE for a year, Sentinel-2 closest to a date.
   Everything draws into a canvas for a "view" {s, ox, oy}: world x = longitude, world y = -mercatorY(latitude), screen = world * s + offset.
   Globals from index.html (mercY, invMerc, RAD, BORDERW, ...) are only used when functions run, never while this file loads. */

const BG = { mode: "grey" };   // "grey" | "sat" | "aerial"
const TILE_CACHE = new Map();
const TILE_URL = {
  grey: (z, x, y) => `https://wmts.geo.admin.ch/1.0.0/ch.swisstopo.pixelkarte-grau/default/current/3857/${z}/${x}/${y}.jpeg`,
  aerial: (z, x, y, t) => `https://wmts.geo.admin.ch/1.0.0/ch.swisstopo.swissimage-product/default/${t}/3857/${z}/${x}/${y}.jpeg`,
};

function aerialYear(targetMs) {   // SWISSIMAGE exists as a layer per year; this year's and later ones are "current"
  const y = new Date(targetMs).getUTCFullYear();
  return y >= 2025 ? "current" : String(Math.max(y, 1997));
}
function tileImg(kind, t, z, x, y, onLoad) {
  const k = `${kind}/${t}/${z}/${x}/${y}`; let e = TILE_CACHE.get(k);
  if (!e) {
    e = { img: new Image(), ok: false, done: false, cbs: [] }; e.img.crossOrigin = "anonymous";
    e.img.onload = () => { e.ok = true; e.done = true; e.cbs.forEach(f => f()); };
    e.img.onerror = () => { e.done = true; e.cbs.forEach(f => f()); };
    e.img.src = TILE_URL[kind](z, x, y, t);
    TILE_CACHE.set(k, e); if (TILE_CACHE.size > 700) TILE_CACHE.delete(TILE_CACHE.keys().next().value);
  }
  if (onLoad && !e.done) e.cbs.push(onLoad);
  return e;
}
function tileGrid(v, w, h, px) {   // which web-mercator tiles cover a w x h canvas drawn with view v (px = device pixels per drawing unit)
  const z = Math.max(5, Math.min(17, Math.round(Math.log2(v.s * px * 360 / 256)))), n = 2 ** z;
  const my = py => -(py - v.oy) / v.s, ty = m => Math.floor((1 - m * RAD / Math.PI) / 2 * n);
  const tx0 = Math.max(0, Math.floor(((0 - v.ox) / v.s + 180) / 360 * n)), tx1 = Math.min(n - 1, Math.floor(((w - v.ox) / v.s + 180) / 360 * n));
  const ty0 = Math.max(0, ty(my(0))), ty1 = Math.min(n - 1, ty(my(h))), list = [];
  for (let b = ty0; b <= ty1; b++) for (let a = tx0; a <= tx1; a++) list.push([a, b]);
  return { z, n, list };
}
function paintTiles(c, v, w, h, px, kind, t, onLoad) {   // draws what is loaded, asks for the rest; returns how many tiles are still on their way
  const { z, n, list } = tileGrid(v, w, h, px), size = 360 / n * v.s; let pending = 0;
  for (const [tx, ty] of list) {
    const e = tileImg(kind, t, z, tx, ty, onLoad); if (!e.done) pending++;
    if (!e.ok) continue;
    const x = (tx / n * 360 - 180) * v.s + v.ox, y = -(Math.PI * (1 - 2 * ty / n) / RAD) * v.s + v.oy;
    c.drawImage(e.img, x - .3, y - .3, size + .6, size + .6);
  }
  return pending;
}
function whenTilesLoaded(v, w, h, px, kind, t) {   // for the 3D texture: wait (up to 20 s) until every needed tile has arrived or failed
  const { list, z } = tileGrid(v, w, h, px);
  return Promise.race([Promise.all(list.map(([x, y]) => new Promise(res => { const e = tileImg(kind, t, z, x, y, res); if (e.done) res(); }))), new Promise(res => setTimeout(res, 20000))]);
}

/* ---------- Sentinel-2 closest to a date: swissEO S2-SR v200 through swisstopo's STAC, true-colour GeoTIFF read in pieces ---------- */
const SAT = { items: [], idx: 0, key: "", raster: null, busy: false, status: "", libs: null, files: new Map() };
const STAC = "https://data.geo.admin.ch/api/stac/v1/search?collections=ch.swisstopo.swisseo_s2-sr_v200";
const S2_FIRST = Date.UTC(2015, 6, 4);

function lv95(lon, lat) {   // swisstopo's approximate WGS84 -> LV95 formulas (about 1 m)
  const p = (lat * 3600 - 169028.66) / 10000, l = (lon * 3600 - 26782.5) / 10000;
  return [2600072.37 + 211455.93 * l - 10938.51 * l * p - 0.36 * l * p * p - 44.54 * l * l * l,
          1200147.07 + 308807.95 * p + 3745.25 * l * l + 76.63 * p * p - 194.56 * l * l * p + 119.79 * p * p * p];
}
function viewBoxLonLat(v, w, h) { return [(0 - v.ox) / v.s, invMerc(-(h - v.oy) / v.s), (w - v.ox) / v.s, invMerc(-(0 - v.oy) / v.s)]; }
function pointInPoly(x, y, ring) { let c = false; for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) { const [xi, yi] = ring[i], [xj, yj] = ring[j]; if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) c = !c; } return c; }

async function satLibs() {
  if (SAT.libs) return SAT.libs;
  SAT.libs = new Promise((res, rej) => { const s = document.createElement("script"); s.src = "https://cdn.jsdelivr.net/npm/geotiff@2.1.3/dist-browser/geotiff.js"; s.onload = () => res(window.GeoTIFF); s.onerror = rej; document.head.append(s); });
  return SAT.libs;
}
async function satFind(targetMs, bbox) {   // all mosaics near the date that cover the middle of the box, nearest first
  const [x0, y0, x1, y1] = bbox, cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  for (const days of [12, 45, 120]) {
    const a = new Date(targetMs - days * 864e5).toISOString().slice(0, 19) + "Z", b = new Date(targetMs + days * 864e5).toISOString().slice(0, 19) + "Z";
    const r = await fetch(`${STAC}&datetime=${a}/${b}&bbox=${cx - 0.01},${cy - 0.01},${cx + 0.01},${cy + 0.01}&limit=100`);
    if (!r.ok) continue;
    const feats = (await r.json()).features || [];
    const items = feats.filter(f => pointInPoly(cx, cy, f.geometry.coordinates[0])).map(f => ({ id: f.id, t: Date.parse(f.properties.datetime), url: Object.entries(f.assets).find(([k]) => k.endsWith("tci_10m.tif"))[1].href, scl: Object.entries(f.assets).find(([k]) => k.endsWith("scl_20m.tif"))[1].href }));
    if (items.length) return items.sort((p, q) => Math.abs(p.t - targetMs) - Math.abs(q.t - targetMs));
  }
  return [];
}
async function satFile(url) {   // opens the GeoTIFF once; its overviews are the other images in the file
  let f = SAT.files.get(url);
  if (!f) { f = (async () => { const G = await satLibs(), tiff = await G.fromUrl(url), n = await tiff.getImageCount(), imgs = []; for (let i = 0; i < n; i++) imgs.push(await tiff.getImage(i)); return imgs; })(); SAT.files.set(url, f); }
  return f;
}
async function satCloud(item, bbox) {   // % of the box covered by cloud, cloud shadow or cirrus; 100 when the image does not reach the box
  const imgs = await satFile(item.scl), full = imgs[0], [left, top] = full.getOrigin(), res0 = Math.abs(full.getResolution()[0]), W0 = full.getWidth();
  const cs = [[bbox[0], bbox[1]], [bbox[2], bbox[1]], [bbox[0], bbox[3]], [bbox[2], bbox[3]]].map(([lo, la]) => lv95(lo, la));
  const E0 = Math.min(...cs.map(c => c[0])), E1 = Math.max(...cs.map(c => c[0])), N0 = Math.min(...cs.map(c => c[1])), N1 = Math.max(...cs.map(c => c[1]));
  let k = 0; while (k < imgs.length - 1 && (E1 - E0) / (res0 * 2 ** k) > 220) k++;
  const img = imgs[k], w = img.getWidth(), h = img.getHeight(), res = res0 * W0 / w;
  const px0 = Math.max(0, Math.floor((E0 - left) / res)), px1 = Math.min(w, Math.ceil((E1 - left) / res)), py0 = Math.max(0, Math.floor((top - N1) / res)), py1 = Math.min(h, Math.ceil((top - N0) / res));
  if (px1 <= px0 || py1 <= py0) return 100;
  const a = (await img.readRasters({ window: [px0, py0, px1, py1], samples: [0] }))[0]; let valid = 0, cloud = 0;
  for (let i = 0; i < a.length; i++) { const c = a[i]; if (c === 0) continue; valid++; if (c === 3 || c === 8 || c === 9 || c === 10) cloud++; }
  const want = (Math.min(E1, left + w * res) - Math.max(E0, left)) / res * ((Math.min(N1, top) - Math.max(N0, top - h * res)) / res);   // share of the box the image really covers
  return valid < 0.5 * Math.max(want, 1) ? 100 : 100 * cloud / valid;
}
async function satRead(item, bbox, groundPerPx) {   // RGB for the box, at the coarsest overview that is still sharp enough
  const imgs = await satFile(item.url), full = imgs[0], W0 = full.getWidth();
  const [left, top] = full.getOrigin(), res0 = Math.abs(full.getResolution()[0]);   // every orbit's mosaic has its own corner (LV95)
  const cs = [[bbox[0], bbox[1]], [bbox[2], bbox[1]], [bbox[0], bbox[3]], [bbox[2], bbox[3]]].map(([lo, la]) => lv95(lo, la));
  const E0 = Math.min(...cs.map(c => c[0])), E1 = Math.max(...cs.map(c => c[0])), N0 = Math.min(...cs.map(c => c[1])), N1 = Math.max(...cs.map(c => c[1]));
  let k = 0; while (k < imgs.length - 1 && res0 * 2 ** (k + 1) <= groundPerPx) k++;
  for (;;) {   // never read more than about 2600 px on a side
    const f = 2 ** k; if ((E1 - E0) / (res0 * f) <= 2600 && (N1 - N0) / (res0 * f) <= 2600 || k >= imgs.length - 1) break; k++;
  }
  const img = imgs[k], w = img.getWidth(), h = img.getHeight(), res = res0 * W0 / w;
  const px0 = Math.max(0, Math.floor((E0 - left) / res)), px1 = Math.min(w, Math.ceil((E1 - left) / res)), py0 = Math.max(0, Math.floor((top - N1) / res)), py1 = Math.min(h, Math.ceil((top - N0) / res));
  if (px1 <= px0 || py1 <= py0) return null;
  const rgb = await img.readRGB({ window: [px0, py0, px1, py1], interleave: true });
  return { E0: left + px0 * res, N0: top - py0 * res, res, w: px1 - px0, h: py1 - py0, rgb };
}
function paintSat(c, v, w, h, px, R) {   // warps the LV95 raster onto the mercator view, pixel by pixel
  if (!R) return;
  const step = Math.max(1, Math.ceil(Math.sqrt(w * h * px * px / 1.4e6))), cw = Math.ceil(w / step), ch = Math.ceil(h / step);
  const o = c.canvas.__satTmp && c.canvas.__satTmp.w === cw && c.canvas.__satTmp.h === ch ? c.canvas.__satTmp : (c.canvas.__satTmp = (() => { const t = document.createElement("canvas"); t.width = cw; t.height = ch; return { w: cw, h: ch, cv: t, cx: t.getContext("2d") }; })());
  const img = o.cx.createImageData(cw, ch), d = img.data, rgb = R.rgb;
  for (let j = 0; j < ch; j++) {
    const lat = invMerc(-((j + .5) * step - v.oy) / v.s), p = (lat * 3600 - 169028.66) / 10000;
    for (let i = 0; i < cw; i++) {
      const lon = ((i + .5) * step - v.ox) / v.s, l = (lon * 3600 - 26782.5) / 10000;
      const E = 2600072.37 + 211455.93 * l - 10938.51 * l * p - 0.36 * l * p * p - 44.54 * l * l * l, N = 1200147.07 + 308807.95 * p + 3745.25 * l * l + 76.63 * p * p - 194.56 * l * l * p + 119.79 * p * p * p;
      const col = Math.floor((E - R.E0) / R.res), row = Math.floor((R.N0 - N) / R.res);
      if (col < 0 || row < 0 || col >= R.w || row >= R.h) continue;
      const s = (row * R.w + col) * 3, r = rgb[s], g = rgb[s + 1], b = rgb[s + 2]; if (!(r | g | b)) continue;
      const q = (j * cw + i) * 4; d[q] = r; d[q + 1] = g; d[q + 2] = b; d[q + 3] = 255;
    }
  }
  o.cx.putImageData(img, 0, 0); c.imageSmoothingEnabled = true; c.drawImage(o.cv, 0, 0, cw * step, ch * step);
}
async function satEnsure(targetMs, v, w, h, px, onReady) {   // finds the mosaic and loads the pixels for this view; calls onReady when there is something new to draw
  if (BG.mode !== "sat") return;
  if (targetMs < S2_FIRST) { SAT.status = "Sentinel-2 starts in July 2015"; SAT.raster = null; onReady(); return; }
  const bbox = viewBoxLonLat(v, w, h), tkey = Math.floor(targetMs / 864e5);
  const key = `${tkey}|${bbox.map(q => q.toFixed(2)).join(",")}`;
  if (SAT.busy) { SAT.pending = () => satEnsure(targetMs, v, w, h, px, onReady); return; }
  const ikey = `${tkey}|${Math.round((bbox[0] + bbox[2]) * 2)}|${Math.round((bbox[1] + bbox[3]) * 2)}|${Math.round(Math.log2(bbox[2] - bbox[0]))}`;
  if (SAT.itemsKey !== ikey) {
    SAT.busy = true; SAT.status = "Looking for the nearest Sentinel-2 image…"; onReady();
    try {
      const found = (await satFind(targetMs, bbox)).slice(0, 14);
      await Promise.all(found.map(it => satCloud(it, bbox).then(c => { it.cloud = c; }).catch(() => { it.cloud = null; })));
      const score = it => (it.cloud == null ? 100 : it.cloud) + 1.5 * Math.abs(it.t - targetMs) / 864e5;   // 1.5 points of cloud per day away
      const best = found.slice().sort((p, q) => score(p) - score(q))[0];
      SAT.items = found.sort((p, q) => p.t - q.t); SAT.idx = Math.max(0, SAT.items.indexOf(best)); SAT.itemsKey = ikey; SAT.key = ""; } catch (e) { SAT.items = []; console.warn("stac", e); }
    SAT.busy = false;
  }
  const it = SAT.items[SAT.idx];
  if (!it) { SAT.status = "No Sentinel-2 image found near this date"; SAT.raster = null; onReady(); return; }
  const gpp = 111320 * Math.cos(46.4 * RAD) / (v.s * px), rkey = `${it.id}|${bbox.map(q => q.toFixed(3)).join(",")}|${Math.round(Math.log2(gpp))}`;
  const days = Math.round((it.t - targetMs) / 864e5);
  SAT.status = `Sentinel-2${it.cloud != null ? `, ${Math.round(it.cloud)}% cloud` : ""}, ${new Date(it.t).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" })} (${days === 0 ? "same day" : Math.abs(days) + (Math.abs(days) === 1 ? " day " : " days ") + (days < 0 ? "before" : "after")})`;
  if (SAT.key === rkey) return;
  SAT.busy = true;
  try {
    // read a box 30% larger than the view so small pans do not need a new download
    const pad = 0.3, bw = (bbox[2] - bbox[0]) * pad, bh = (bbox[3] - bbox[1]) * pad;
    SAT.raster = await satRead(it, [bbox[0] - bw, bbox[1] - bh, bbox[2] + bw, bbox[3] + bh], gpp); SAT.key = rkey;
  } catch (e) { console.warn("s2", e); SAT.status = "Could not read the Sentinel-2 image"; SAT.raster = null; }
  SAT.busy = false; onReady();
  if (SAT.pending) { const f = SAT.pending; SAT.pending = null; f(); }
}
function satStep(dir) { if (!SAT.items.length) return false; const n = SAT.idx + dir; if (n < 0 || n >= SAT.items.length) return false; SAT.idx = n; SAT.key = ""; return true; }

function paintBackground(c, v, w, h, px, ctxInfo) {   // the caller has set the Swiss border as the current path; picture is clipped to it
  const kind = BG.mode, onLoad = ctxInfo && ctxInfo.onLoad;
  c.save(); c.clip();
  if (kind === "sat") { if (SAT.raster) paintSat(c, v, w, h, px, SAT.raster); else paintTiles(c, v, w, h, px, "grey", "current", onLoad); }
  else if (kind === "aerial") paintTiles(c, v, w, h, px, "aerial", aerialYear(ctxInfo.targetMs), onLoad);
  else { c.globalAlpha = ctxInfo && ctxInfo.dark ? 0.45 : 1; paintTiles(c, v, w, h, px, "grey", "current", onLoad); }
  c.restore();
}
