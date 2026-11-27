/* 3D view: Mapterhorn terrain (open terrain tiles, read from a PMTiles archive), the chosen picture draped on it, glacier colours on top,
   and the freezing line as a translucent sheet. It shows the same area as the 2D map had on screen when 3D was switched on.
   Uses globals from index.html (view, W, H, D, wx, wy, cz, Zc, station, dayZ, sel, packed, colors, iceMode, OUT, BORDERW, ...) only when functions run. */

const V3 = { on: false, looping: false, libs: null, pm: null, region: null, gen: 0, timer: 0, exag: 1 };
const MPD = 111319.49;   // metres per degree at the equator: scene units are web-mercator metres
const DEM_URL = "https://download.mapterhorn.com/planet.pmtiles";   // Terrarium-encoded WebP tiles, 512 px, zooms 0-12

function loadScript(src) { return new Promise((res, rej) => { const s = document.createElement("script"); s.src = src; s.onload = res; s.onerror = () => rej(new Error("could not load " + src)); document.head.append(s); }); }
function load3DLibs() {
  if (!V3.libs) V3.libs = (async () => {
    const THREE = await import("three"), { OrbitControls } = await import("three/addons/controls/OrbitControls.js");
    await loadScript("https://cdn.jsdelivr.net/npm/pmtiles@3.2.1/dist/pmtiles.js");
    return { THREE, OrbitControls };
  })();
  return V3.libs;
}
const sleep3 = ms => new Promise(r => setTimeout(r, ms));
function note3d(t) { const n = document.getElementById("note3d"); if (n) n.textContent = t; }

async function demTile(z, x, y) {
  const r = await V3.pm.getZxy(z, x, y); if (!r) return null;
  const bmp = await createImageBitmap(new Blob([r.data], { type: "image/webp" })), c = document.createElement("canvas"); c.width = bmp.width; c.height = bmp.height;
  const g = c.getContext("2d", { willReadFrequently: true }); g.drawImage(bmp, 0, 0); const d = g.getImageData(0, 0, c.width, c.height).data, h = new Float32Array(c.width * c.height);
  for (let i = 0; i < h.length; i++) h[i] = d[4 * i] * 256 + d[4 * i + 1] + d[4 * i + 2] / 256 - 32768;   // Terrarium
  return { h, size: c.width };
}
async function loadDem(reg, cols) {   // heights for the region: pick a zoom that is about as fine as the mesh, fetch the tiles it needs
  if (!V3.pm) V3.pm = new pmtiles.PMTiles(DEM_URL);
  let z = Math.max(5, Math.min(12, Math.ceil(Math.log2(cols * 1.5 * 360 / (512 * reg.lonSpan)))));
  const rng = zz => { const n = 2 ** zz, tx = l => Math.floor((l + 180) / 360 * n), ty = m => Math.floor((1 - m * RAD / Math.PI) / 2 * n); return { n, x0: tx(reg.lon0), x1: tx(reg.lon1), y0: ty(reg.mTop), y1: ty(reg.mBot) }; };
  let q = rng(z); while ((q.x1 - q.x0 + 1) * (q.y1 - q.y0 + 1) > 90 && z > 5) q = rng(--z);
  const tiles = new Map(), jobs = [];
  for (let y = q.y0; y <= q.y1; y++) for (let x = q.x0; x <= q.x1; x++) jobs.push(demTile(z, x, y).then(t => tiles.set(x + "," + y, t)));
  await Promise.all(jobs);
  return (lon, mer) => {
    const fx = (lon + 180) / 360 * q.n, fy = (1 - mer * RAD / Math.PI) / 2 * q.n, tx = Math.floor(fx), ty = Math.floor(fy), t = tiles.get(tx + "," + ty); if (!t) return 0;
    const S = t.size, px = Math.min(Math.max((fx - tx) * S - 0.5, 0), S - 1.001), py = Math.min(Math.max((fy - ty) * S - 0.5, 0), S - 1.001), x0 = Math.floor(px), y0 = Math.floor(py), a = px - x0, b = py - y0, i = y0 * S + x0;
    return Math.max(0, (t.h[i] * (1 - a) + t.h[i + 1] * a) * (1 - b) + (t.h[i + S] * (1 - a) + t.h[i + S + 1] * a) * b);
  };
}

function planeZ(lon, lat) {   // freezing-line height at a spot: the smooth station field for now, one number for a past day
  if (sel.kind === "day") return Math.max(dayZ[sel.k], 0);
  const f = station.field, fi = (lat - LAT0) / STEP, fj = (lon - LON0) / STEP, i0 = Math.min(Math.max(Math.floor(fi), 0), NLA - 2), j0 = Math.min(Math.max(Math.floor(fj), 0), NLO - 2), a = Math.min(Math.max(fj - j0, 0), 1), b = Math.min(Math.max(fi - i0, 0), 1), k = i0 * NLO + j0;
  return Math.max(0, (f[k] * (1 - a) + f[k + 1] * a) * (1 - b) + (f[k + NLO] * (1 - a) + f[k + NLO + 1] * a) * b);
}

function cellsLayer(v, PW, PH) {   // every glacier cell in its colour, plus a raster saying which glacier each pixel belongs to
  const cvs = document.createElement("canvas"); cvs.width = PW; cvs.height = PH; const c = cvs.getContext("2d"), img = c.createImageData(PW, PH), u = new Uint32Array(img.data.buffer), ids = new Uint16Array(PW * PH);
  const cw = D.d * v.s, ch = D.d * MC * v.s, M = packed.melt, I = packed.ice, surf = iceMode === "surface", pal = [0, packed.snow, packed.bare, packed.debris, packed.cloudc];
  for (let i = 0; i < N; i++) {
    const x = wx[i] * v.s + v.ox, y = wy[i] * v.s + v.oy; if (x < -cw || y < -ch || x >= PW || y >= PH) continue;
    let melt, col; if (surf) { const q = SURF.cls ? SURF.cls[i] : 0; if (!q) continue; col = pal[q]; melt = true; } else { melt = cz[i] < Zc[i]; col = melt ? M : I; }
    const px0 = Math.max(Math.floor(x), 0), py0 = Math.max(Math.floor(y), 0), px1 = Math.min(Math.max(px0 + 1, Math.ceil(x + cw)), PW), py1 = Math.min(Math.max(py0 + 1, Math.ceil(y + ch)), PH), id = cg[i] + 1;
    for (let py = py0; py < py1; py++) for (let p = py * PW + px0, e = py * PW + px1; p < e; p++) if (melt || u[p] !== M) { u[p] = col; ids[p] = id; }
  }
  c.putImageData(img, 0, 0); return { cvs, img, u32: u, ids };
}
function outlinesCanvas(v, PW, PH) {
  const cvs = document.createElement("canvas"); cvs.width = PW; cvs.height = PH; const c = cvs.getContext("2d"); c.beginPath();
  for (const r of OUT) { const p = r.p; c.moveTo(p[0] * v.s + v.ox, p[1] * v.s + v.oy); for (let i = 2; i < p.length; i += 2) c.lineTo(p[i] * v.s + v.ox, p[i + 1] * v.s + v.oy); }
  c.lineWidth = Math.max(iceMode === "outline" ? 1.8 : 1, PW / (iceMode === "outline" ? 1100 : 1800)); c.strokeStyle = colors.ink; c.globalAlpha = iceMode === "outline" ? 0.95 : 0.7; c.stroke(); return cvs;
}
function compose(L, hg) {   // picture, then glaciers, then outlines, then a bold outline round the glacier under the pointer
  const c = L.comp.getContext("2d"); c.clearRect(0, 0, L.TW, L.TH); c.drawImage(L.base, 0, 0);
  if (L.lay) { c.globalAlpha = L.alpha; c.drawImage(L.lay.cvs, 0, 0); c.globalAlpha = 1; }
  if (L.lines) c.drawImage(L.lines, 0, 0);
  if (hg >= 0 && OUT) {
    c.beginPath(); for (const r of OUT) { if (r.g !== hg) continue; const p = r.p; c.moveTo(p[0] * L.v.s + L.v.ox, p[1] * L.v.s + L.v.oy); for (let i = 2; i < p.length; i += 2) c.lineTo(p[i] * L.v.s + L.v.ox, p[i + 1] * L.v.s + L.v.oy); }
    c.lineJoin = "round"; c.lineWidth = Math.max(4, L.TW / 600); c.strokeStyle = "rgba(10,25,38,.85)"; c.stroke(); c.lineWidth = Math.max(2, L.TW / 1200); c.strokeStyle = "#ffffff"; c.stroke();
  }
}
async function paintTexture(reg, gen) {   // picture + glacier colours, in the same mercator frame as the mesh
  const TW = Math.min(4096, V3.maxTex), TH = Math.round(TW * reg.mSpan / reg.lonSpan), v = { s: TW / reg.lonSpan, ox: -reg.lon0 * TW / reg.lonSpan, oy: reg.mTop * TW / reg.lonSpan };
  const base = document.createElement("canvas"); base.width = TW; base.height = TH; const c = base.getContext("2d");
  c.fillStyle = colors.map; c.fillRect(0, 0, TW, TH);
  c.beginPath(); BORDERW.forEach(([lo, la], i) => { const x = lo * v.s + v.ox, y = la * v.s + v.oy; i ? c.lineTo(x, y) : c.moveTo(x, y); }); c.closePath(); c.fillStyle = colors.panel; c.fill();
  const t = targetMs(), info = { dark: false, targetMs: t };
  if (BG.mode === "sat" || iceMode === "surface") {
    note3d("Fetching the Sentinel-2 image…");
    for (let i = 0; i < 300 && SAT.busy; i++) await sleep3(100);
    await satEnsure(t, v, TW, TH, 1, () => {}); for (let i = 0; i < 600 && SAT.busy; i++) await sleep3(100);
  } else if (BG.mode === "aerial" || BG.mode === "grey") {
    note3d("Fetching the map pictures…"); await whenTilesLoaded(v, TW, TH, 1, BG.mode === "aerial" ? "aerial" : "grey", BG.mode === "aerial" ? aerialYear(t) : "current");
  }
  if (gen !== V3.gen) return null;
  paintBackground(c, v, TW, TH, 1, info);
  const L = { TW, TH, v, base };
  if (iceMode === "fill" || iceMode === "surface") { L.lay = cellsLayer(v, TW, TH); L.alpha = iceMode === "surface" ? 0.9 : 0.68; if (BG.mode === "aerial" || BG.mode === "sat") L.orig = L.lay.u32.slice(); }   // the copy lets one glacier be cleared and put back
  if (OUT && iceMode !== "off") L.lines = outlinesCanvas(v, TW, TH);
  L.comp = document.createElement("canvas"); L.comp.width = TW; L.comp.height = TH; compose(L, -1);
  V3.layers = L; V3.hoverGi = -1; return L.comp;
}
// the glacier under the pointer: march a ray along the terrain, then look the spot up in the glacier raster
function pickTerrain(ray) {
  const reg = V3.region, VS = vScale(), NX = V3.NX, NY = V3.NY, h = V3.h, o = ray.origin, d = ray.direction, W1 = NX + 1;
  const hgt = (x, z) => {
    const gx = ((x / MPD + reg.lonC - reg.lon0) / reg.lonSpan) * NX, gy = ((reg.mTop - (reg.mC - z / MPD)) / reg.mSpan) * NY; if (gx < 0 || gy < 0 || gx >= NX || gy >= NY) return null;
    const i = Math.floor(gx), j = Math.floor(gy), a = gx - i, b = gy - j, k = j * W1 + i;
    return ((h[k] * (1 - a) + h[k + 1] * a) * (1 - b) + (h[k + W1] * (1 - a) + h[k + W1 + 1] * a) * b) * VS;
  };
  const step = Math.max(reg.lonSpan * MPD / NX * 0.8, 8), tMax = reg.lonSpan * MPD * 3; let tPrev = 0;
  for (let t = 0; t < tMax; t += step) {
    const x = o.x + d.x * t, y = o.y + d.y * t, z = o.z + d.z * t, g = hgt(x, z);
    if (g != null && y <= g) {
      let lo = tPrev, hi = t; for (let n = 0; n < 8; n++) { const m = (lo + hi) / 2, gm = hgt(o.x + d.x * m, o.z + d.z * m); if (gm != null && o.y + d.y * m <= gm) hi = m; else lo = m; }
      const px = o.x + d.x * hi, pz = o.z + d.z * hi; return { lon: reg.lonC + px / MPD, mer: reg.mC - pz / MPD };
    }
    if (y < -500 && d.y < 0) break; tPrev = t;
  }
  return null;
}
function glacierAt(hit) {
  const L = V3.layers; if (!hit || !L || !L.lay) return -1; const reg = V3.region;
  const x = Math.floor((hit.lon - reg.lon0) / reg.lonSpan * L.TW), y = Math.floor((reg.mTop - hit.mer) / reg.mSpan * L.TH); if (x < 0 || y < 0 || x >= L.TW || y >= L.TH) return -1;
  return L.lay.ids[y * L.TW + x] - 1;
}
function setHover3D(gi) {   // over aerial and satellite pictures the glacier under the pointer is cleared, so the ground shows through
  const L = V3.layers; if (!L || !L.orig || gi === V3.hoverGi) return;
  const prev = V3.hoverGi; V3.hoverGi = gi; const u = L.lay.u32, ids = L.lay.ids, orig = L.orig, TW = L.TW; let x0 = TW, x1 = -1, y0 = L.TH, y1 = -1;
  for (let p = 0; p < u.length; p++) {
    const id = ids[p] - 1; let hit = false;
    if (id === prev && prev >= 0) { u[p] = orig[p]; hit = true; } else if (id === gi && gi >= 0) { u[p] = 0; hit = true; }
    if (hit) { const y = (p / TW) | 0, x = p - y * TW; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  }
  if (x1 >= 0) L.lay.cvs.getContext("2d").putImageData(L.lay.img, 0, 0, x0, y0, x1 - x0 + 1, y1 - y0 + 1);
  compose(L, gi); V3.texture.needsUpdate = true;
}
function hover3D(pt) {
  const r = V3.renderer.domElement, ndc = new V3.THREE.Vector2(pt.x / r.clientWidth * 2 - 1, -(pt.y / r.clientHeight) * 2 + 1);
  V3.raycaster.setFromCamera(ndc, V3.camera); setHover3D(glacierAt(pickTerrain(V3.raycaster.ray)));
}

function regionFromView() {
  const lon0 = (0 - view.ox) / view.s, lon1 = (W - view.ox) / view.s, mTop = -(0 - view.oy) / view.s, mBot = -(H - view.oy) / view.s, padX = (lon1 - lon0) * 0.06, padY = (mTop - mBot) * 0.06;
  const r = { lon0: lon0 - padX, lon1: lon1 + padX, mTop: mTop + padY, mBot: mBot - padY }; r.lonSpan = r.lon1 - r.lon0; r.mSpan = r.mTop - r.mBot; r.lonC = (r.lon0 + r.lon1) / 2; r.mC = (r.mTop + r.mBot) / 2; return r;
}
const vScale = () => MC * V3.exag;   // heights are stretched by the mercator factor (so slopes look right) and the exaggeration

function placeTerrain() {
  const g = V3.terrain.geometry, pos = g.attributes.position, reg = V3.region, VS = vScale();
  for (let i = 0; i < V3.h.length; i++) pos.array[3 * i + 1] = V3.h[i] * VS;
  pos.needsUpdate = true; g.computeVertexNormals(); g.computeBoundingSphere();
}
function tintTerrain() {   // ground under the freezing line: a faint red at the line, darker the further below it
  if (!V3.terrain || !V3.pz) return;
  const { NX, NY, pnx, pny, pz, h } = V3, col = V3.terrain.geometry.attributes.color.array, W1 = pnx + 1;
  for (let j = 0, k = 0; j <= NY; j++) {
    const v = j / NY * pny, j0 = Math.min(Math.floor(v), pny - 1), fv = v - j0;
    for (let i = 0; i <= NX; i++, k++) {
      const u = i / NX * pnx, i0 = Math.min(Math.floor(u), pnx - 1), fu = u - i0, a = j0 * W1 + i0;
      const z = (pz[a] * (1 - fu) + pz[a + 1] * fu) * (1 - fv) + (pz[a + W1] * (1 - fu) + pz[a + W1 + 1] * fu) * fv, d = z - h[k];
      if (d <= 0) { col[3 * k] = col[3 * k + 1] = col[3 * k + 2] = 1; continue; }
      const t = Math.min(d / 1400, 1), q = Math.pow(t, 0.7);
      col[3 * k] = 1 - 0.22 * t; col[3 * k + 1] = 1 - 0.62 * q; col[3 * k + 2] = 1 - 0.7 * q;
    }
  }
  V3.terrain.geometry.attributes.color.needsUpdate = true;
}
function placePlane() {
  const g = V3.plane.geometry, pos = g.attributes.position, reg = V3.region, VS = vScale(), nx = V3.pnx, ny = V3.pny; let lo = 1e9, hi = -1e9;
  for (let j = 0; j <= ny; j++) for (let i = 0; i <= nx; i++) { const lon = reg.lon0 + reg.lonSpan * i / nx, lat = invMerc(reg.mTop - reg.mSpan * j / ny), z = planeZ(lon, lat), k = j * (nx + 1) + i; pos.array[3 * k + 1] = z * VS; if (z < lo) lo = z; if (z > hi) hi = z; }
  pos.needsUpdate = true; g.computeBoundingSphere(); V3.planeRange = [lo, hi];
  V3.pz = new Float32Array((nx + 1) * (ny + 1)); for (let k = 0; k < V3.pz.length; k++) V3.pz[k] = pos.array[3 * k + 1] / VS;
  tintTerrain();
}
function makeCrystalTexture(THREE) {   // a frosty tile: faint blue wash, speckle and branching six-armed crystals
  const S = 512, cv = document.createElement("canvas"); cv.width = cv.height = S; const c = cv.getContext("2d");
  c.fillStyle = "rgba(70,175,255,0.20)"; c.fillRect(0, 0, S, S);
  let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;   // same pattern every time
  for (let i = 0; i < 700; i++) { c.fillStyle = `rgba(255,255,255,${0.05 + rnd() * 0.12})`; c.fillRect(rnd() * S, rnd() * S, 1 + rnd() * 2, 1 + rnd() * 2); }
  const flake = (x, y, r) => {
    c.save(); c.translate(x, y); c.lineCap = "round";
    for (let k = 0; k < 6; k++) {
      c.save(); c.rotate(k * Math.PI / 3); c.beginPath(); c.moveTo(0, 0); c.lineTo(r, 0);
      for (const [f, len] of [[.3, .32], [.52, .26], [.72, .17]]) for (const sgn of [1, -1]) { c.moveTo(r * f, 0); c.lineTo(r * f + len * r * Math.cos(Math.PI / 3), sgn * len * r * Math.sin(Math.PI / 3)); }
      c.stroke(); c.restore();
    }
    c.beginPath(); for (let k = 0; k < 6; k++) { const a = k * Math.PI / 3; c.lineTo(r * .16 * Math.cos(a), r * .16 * Math.sin(a)); } c.closePath(); c.stroke(); c.restore();
  };
  c.strokeStyle = "rgba(235,248,255,.92)"; c.shadowColor = "rgba(150,215,255,.95)"; c.shadowBlur = 5;
  for (const [x, y, r] of [[90, 80, 70], [300, 60, 52], [450, 150, 64], [170, 250, 60], [380, 300, 78], [60, 400, 50], [250, 450, 66], [470, 440, 46], [120, 160, 34], [420, 30, 30], [330, 180, 30], [200, 360, 28]]) {
    c.lineWidth = Math.max(1.4, r / 28); for (const dx of [-S, 0, S]) for (const dy of [-S, 0, S]) flake(x + dx, y + dy, r);   // also drawn past the edges, so the tile repeats without a seam
  }
  const t = new THREE.CanvasTexture(cv); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8; return t;
}
function noteFor3d() {
  const [lo, hi] = V3.planeRange || [0, 0], t = BG.mode === "sat" ? SAT.status : BG.mode === "aerial" ? `SWISSIMAGE ${aerialYear(targetMs()) === "current" ? "(latest)" : aerialYear(targetMs())}` : "swisstopo grey map";
  note3d(`Blue sheet: the freezing line, ${Math.abs(hi - lo) < 30 ? fmt((lo + hi) / 2) : `${fmt(lo)}–${fmt(hi)}`} m. Red ground lies below it, darker the further down. Terrain: Mapterhorn terrain (30 m model, a point every ${Math.max(30, Math.round(V3.spacing))} m), ${t}.${V3.spacing > 45 ? " Zoom the map in before switching to 3D for the full 30 m detail." : ""}`);
}

async function build3D(full) {
  const gen = ++V3.gen, { THREE, OrbitControls } = await load3DLibs();
  if (!V3.renderer) {
    const host = document.getElementById("view3d"), r = new THREE.WebGLRenderer({ antialias: true }); r.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2)); host.prepend(r.domElement); r.domElement.style.cssText = "position:absolute;inset:0;width:100%;height:100%;display:block";
    V3.renderer = r; V3.THREE = THREE; V3.maxTex = r.capabilities.maxTextureSize; V3.scene = new THREE.Scene(); V3.scene.background = new THREE.Color(colors.map);
    V3.scene.add(new THREE.AmbientLight(0xffffff, 0.9)); const sun = new THREE.DirectionalLight(0xffffff, 1.0); sun.position.set(-1, 1.1, 0.7); V3.scene.add(sun);
    V3.camera = new THREE.PerspectiveCamera(40, 1, 100, 1e7); V3.controls = new OrbitControls(V3.camera, r.domElement); V3.controls.enableDamping = true; V3.controls.maxPolarAngle = Math.PI * 0.49; V3.controls.screenSpacePanning = true;
    V3.planeMat = new THREE.MeshBasicMaterial({ map: makeCrystalTexture(THREE), transparent: true, side: THREE.DoubleSide, depthWrite: false });
    V3.raycaster = new THREE.Raycaster();
    r.domElement.addEventListener("pointermove", e => { if (e.buttons || !V3.layers || !V3.layers.orig) return; V3.pt = { x: e.offsetX, y: e.offsetY }; if (!V3.pickRaf) V3.pickRaf = requestAnimationFrame(() => { V3.pickRaf = 0; if (V3.on) hover3D(V3.pt); }); });
    r.domElement.addEventListener("pointerleave", () => setHover3D(-1));
    resize3D();
  }
  if (full) {
    note3d("Loading Mapterhorn terrain…");
    const reg = V3.region = regionFromView(), spacing = reg.lonSpan * 111320 * Math.cos(46.4 * RAD) / 1500;   // metres between mesh points
    V3.spacing = spacing; const NX = 1500, NY = Math.max(40, Math.round(NX * reg.mSpan / reg.lonSpan)), sample = await loadDem(reg, NX);
    if (gen !== V3.gen) return;
    if (V3.terrain) { V3.scene.remove(V3.terrain); V3.terrain.geometry.dispose(); V3.scene.remove(V3.plane); V3.plane.geometry.dispose(); }
    const n = (NX + 1) * (NY + 1), pos = new Float32Array(n * 3), uv = new Float32Array(n * 2), idx = new Uint32Array(NX * NY * 6); V3.h = new Float32Array(n);
    for (let j = 0, k = 0; j <= NY; j++) { const mer = reg.mTop - reg.mSpan * j / NY; for (let i = 0; i <= NX; i++, k++) { const lon = reg.lon0 + reg.lonSpan * i / NX; V3.h[k] = sample(lon, mer); pos[3 * k] = (lon - reg.lonC) * MPD; pos[3 * k + 2] = -(mer - reg.mC) * MPD; uv[2 * k] = i / NX; uv[2 * k + 1] = 1 - j / NY; } }
    for (let j = 0, t = 0; j < NY; j++) for (let i = 0; i < NX; i++) { const a = j * (NX + 1) + i, b = a + 1, c = a + NX + 1, d = c + 1; idx.set([a, c, b, b, c, d], t); t += 6; }
    const geo = new THREE.BufferGeometry(); geo.setAttribute("position", new THREE.BufferAttribute(pos, 3)); geo.setAttribute("uv", new THREE.BufferAttribute(uv, 2)); geo.setIndex(new THREE.BufferAttribute(idx, 1));
    geo.setAttribute("color", new THREE.BufferAttribute(new Float32Array(n * 3).fill(1), 3)); V3.NX = NX; V3.NY = NY;
    V3.terrain = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1, metalness: 0, vertexColors: true })); V3.scene.add(V3.terrain);
    // the freezing-line sheet: a coarse grid, heights from the 0 °C field
    const pnx = 56, pny = Math.max(10, Math.round(pnx * reg.mSpan / reg.lonSpan)), pp = new Float32Array((pnx + 1) * (pny + 1) * 3), pi = new Uint32Array(pnx * pny * 6);
    for (let j = 0, k = 0; j <= pny; j++) for (let i = 0; i <= pnx; i++, k++) { pp[3 * k] = (reg.lon0 + reg.lonSpan * i / pnx - reg.lonC) * MPD; pp[3 * k + 2] = -(reg.mTop - reg.mSpan * j / pny - reg.mC) * MPD; }
    for (let j = 0, t = 0; j < pny; j++) for (let i = 0; i < pnx; i++) { const a = j * (pnx + 1) + i, b = a + 1, c = a + pnx + 1, d = c + 1; pi.set([a, c, b, b, c, d], t); t += 6; }
    const pu = new Float32Array((pnx + 1) * (pny + 1) * 2), asp = reg.mSpan / reg.lonSpan; for (let j = 0, k = 0; j <= pny; j++) for (let i = 0; i <= pnx; i++, k++) { pu[2 * k] = i / pnx * 14; pu[2 * k + 1] = j / pny * 14 * asp; }   // about 14 crystals across
    const pg = new THREE.BufferGeometry(); pg.setAttribute("position", new THREE.BufferAttribute(pp, 3)); pg.setAttribute("uv", new THREE.BufferAttribute(pu, 2)); pg.setIndex(new THREE.BufferAttribute(pi, 1)); V3.pnx = pnx; V3.pny = pny;
    V3.plane = new THREE.Mesh(pg, V3.planeMat); V3.plane.renderOrder = 2; V3.scene.add(V3.plane);
    placeTerrain(); placePlane(); startLoop3D();
    const span = reg.lonSpan * MPD; V3.camera.near = span / 2000; V3.camera.far = span * 12; V3.camera.updateProjectionMatrix();
    V3.controls.target.set(0, 1800 * vScale(), 0); V3.camera.position.set(0, span * 0.36, span * 0.46); V3.controls.minDistance = span * 0.01; V3.controls.maxDistance = span * 3; V3.controls.update();
  } else { placePlane(); }
  const tex = await paintTexture(V3.region, gen); if (!tex || gen !== V3.gen) return;
  if (V3.texture) V3.texture.dispose();
  V3.texture = new V3.THREE.CanvasTexture(tex); V3.texture.colorSpace = V3.THREE.SRGBColorSpace; V3.texture.anisotropy = V3.renderer.capabilities.getMaxAnisotropy(); V3.texture.needsUpdate = true;
  V3.terrain.material.map = V3.texture; V3.terrain.material.needsUpdate = true; noteFor3d();
}
function resize3D() { if (!V3.renderer) return; const h = document.getElementById("view3d"), w = h.clientWidth, ht = h.clientHeight; V3.renderer.setSize(w, ht, false); V3.camera.aspect = w / ht; V3.camera.updateProjectionMatrix(); }
function loop3D() { if (!V3.on) { V3.looping = false; return; } V3.controls.update(); V3.renderer.render(V3.scene, V3.camera); requestAnimationFrame(loop3D); }
function startLoop3D() { if (V3.looping) return; V3.looping = true; resize3D(); loop3D(); }
function schedule3D() { if (!V3.on || !V3.terrain) return; clearTimeout(V3.timer); V3.timer = setTimeout(() => build3D(false).catch(e => note3d("3D update failed: " + e.message)), 250); }
async function set3D(on) {
  V3.on = on; document.getElementById("mapbox").classList.toggle("is3d", on); document.getElementById("view3d").hidden = !on; document.getElementById("b3d").setAttribute("aria-pressed", on);
  if (on) { note3d("Starting 3D…"); try { await build3D(true); } catch (e) { console.error(e); note3d("3D could not start: " + e.message); } }
  else { V3.gen++; schedule(); }
}
