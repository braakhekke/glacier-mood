/* 3D view: Mapterhorn terrain (open terrain tiles, read from a PMTiles archive), the chosen picture draped on it, glacier colours on top,
   and the freezing line as a translucent sheet. It shows the same area as the 2D map had on screen when 3D was switched on.
   Uses globals from index.html (view, W, H, D, wx, wy, cz, Zc, station, dayZ, sel, offset, packed, colors, OUT, BORDERW, ...) only when functions run. */

const V3 = { on: false, looping: false, libs: null, pm: null, region: null, gen: 0, timer: 0, exag: 1.5 };
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
  let q = rng(z); while ((q.x1 - q.x0 + 1) * (q.y1 - q.y0 + 1) > 60 && z > 5) q = rng(--z);
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
  if (sel.kind === "day") return Math.max(dayZ[sel.k], 0) + offset;
  const f = station.field, fi = (lat - LAT0) / STEP, fj = (lon - LON0) / STEP, i0 = Math.min(Math.max(Math.floor(fi), 0), NLA - 2), j0 = Math.min(Math.max(Math.floor(fj), 0), NLO - 2), a = Math.min(Math.max(fj - j0, 0), 1), b = Math.min(Math.max(fi - i0, 0), 1), k = i0 * NLO + j0;
  return Math.max(0, (f[k] * (1 - a) + f[k + 1] * a) * (1 - b) + (f[k + NLO] * (1 - a) + f[k + NLO + 1] * a) * b + offset);
}

function cellsCanvas(v, PW, PH) {   // every glacier cell in its melt / frozen colour, painted for this view
  const cvs = document.createElement("canvas"); cvs.width = PW; cvs.height = PH; const c = cvs.getContext("2d"), img = c.createImageData(PW, PH), u = new Uint32Array(img.data.buffer);
  const cw = D.d * v.s, ch = D.d * MC * v.s, M = packed.melt, I = packed.ice, off = offset;
  for (let i = 0; i < N; i++) {
    const x = wx[i] * v.s + v.ox, y = wy[i] * v.s + v.oy; if (x < -cw || y < -ch || x >= PW || y >= PH) continue;
    const melt = cz[i] < Zc[i] + off, col = melt ? M : I, px0 = Math.max(Math.floor(x), 0), py0 = Math.max(Math.floor(y), 0), px1 = Math.min(Math.max(px0 + 1, Math.ceil(x + cw)), PW), py1 = Math.min(Math.max(py0 + 1, Math.ceil(y + ch)), PH);
    for (let py = py0; py < py1; py++) for (let p = py * PW + px0, e = py * PW + px1; p < e; p++) if (melt || u[p] !== M) u[p] = col;
  }
  c.putImageData(img, 0, 0); return cvs;
}
async function paintTexture(reg, gen) {   // picture + glacier colours, in the same mercator frame as the mesh
  const TW = Math.min(4096, V3.maxTex), TH = Math.round(TW * reg.mSpan / reg.lonSpan), v = { s: TW / reg.lonSpan, ox: -reg.lon0 * TW / reg.lonSpan, oy: reg.mTop * TW / reg.lonSpan };
  const cvs = document.createElement("canvas"); cvs.width = TW; cvs.height = TH; const c = cvs.getContext("2d");
  c.fillStyle = colors.map; c.fillRect(0, 0, TW, TH);
  c.beginPath(); BORDERW.forEach(([lo, la], i) => { const x = lo * v.s + v.ox, y = la * v.s + v.oy; i ? c.lineTo(x, y) : c.moveTo(x, y); }); c.closePath(); c.fillStyle = colors.panel; c.fill();
  const t = targetMs(), info = { dark: false, targetMs: t };
  if (BG.mode === "sat") {
    note3d("Fetching the Sentinel-2 image…");
    for (let i = 0; i < 300 && SAT.busy; i++) await sleep3(100);
    await satEnsure(t, v, TW, TH, 1, () => {}); for (let i = 0; i < 600 && SAT.busy; i++) await sleep3(100);
  } else if (BG.mode === "aerial" || BG.mode === "grey") {
    note3d("Fetching the map pictures…"); await whenTilesLoaded(v, TW, TH, 1, BG.mode === "aerial" ? "aerial" : "grey", BG.mode === "aerial" ? aerialYear(t) : "current");
  }
  if (gen !== V3.gen) return null;
  paintBackground(c, v, TW, TH, 1, info);
  c.globalAlpha = 0.68; c.drawImage(cellsCanvas(v, TW, TH), 0, 0); c.globalAlpha = 1;
  if (OUT) { c.beginPath(); for (const r of OUT) { const p = r.p; c.moveTo(p[0] * v.s + v.ox, p[1] * v.s + v.oy); for (let i = 2; i < p.length; i += 2) c.lineTo(p[i] * v.s + v.ox, p[i + 1] * v.s + v.oy); } c.lineWidth = Math.max(1, TW / 1800); c.strokeStyle = colors.ink; c.globalAlpha = 0.7; c.stroke(); c.globalAlpha = 1; }
  return cvs;
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
function placePlane() {
  const g = V3.plane.geometry, pos = g.attributes.position, reg = V3.region, VS = vScale(), nx = V3.pnx, ny = V3.pny; let lo = 1e9, hi = -1e9;
  for (let j = 0; j <= ny; j++) for (let i = 0; i <= nx; i++) { const lon = reg.lon0 + reg.lonSpan * i / nx, lat = invMerc(reg.mTop - reg.mSpan * j / ny), z = planeZ(lon, lat), k = j * (nx + 1) + i; pos.array[3 * k + 1] = z * VS; if (z < lo) lo = z; if (z > hi) hi = z; }
  pos.needsUpdate = true; g.computeBoundingSphere(); V3.planeRange = [lo, hi];
  V3.grid.geometry.dispose(); V3.grid.geometry = new V3.THREE.WireframeGeometry(g);
}
function noteFor3d() {
  const [lo, hi] = V3.planeRange || [0, 0], t = BG.mode === "sat" ? SAT.status : BG.mode === "aerial" ? `SWISSIMAGE ${aerialYear(targetMs()) === "current" ? "(latest)" : aerialYear(targetMs())}` : "swisstopo grey map";
  note3d(`Blue sheet: the freezing line, ${Math.abs(hi - lo) < 30 ? fmt((lo + hi) / 2) : `${fmt(lo)}–${fmt(hi)}`} m. Ground: Mapterhorn terrain, ${t}.`);
}

async function build3D(full) {
  const gen = ++V3.gen, { THREE, OrbitControls } = await load3DLibs();
  if (!V3.renderer) {
    const host = document.getElementById("view3d"), r = new THREE.WebGLRenderer({ antialias: true }); r.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2)); host.prepend(r.domElement); r.domElement.style.cssText = "position:absolute;inset:0;width:100%;height:100%;display:block";
    V3.renderer = r; V3.THREE = THREE; V3.maxTex = r.capabilities.maxTextureSize; V3.scene = new THREE.Scene(); V3.scene.background = new THREE.Color(colors.map);
    V3.scene.add(new THREE.AmbientLight(0xffffff, 0.9)); const sun = new THREE.DirectionalLight(0xffffff, 1.0); sun.position.set(-1, 1.1, 0.7); V3.scene.add(sun);
    V3.camera = new THREE.PerspectiveCamera(40, 1, 100, 1e7); V3.controls = new OrbitControls(V3.camera, r.domElement); V3.controls.enableDamping = true; V3.controls.maxPolarAngle = Math.PI * 0.49; V3.controls.screenSpacePanning = true;
    V3.planeMat = new THREE.MeshBasicMaterial({ color: 0x35b8ff, transparent: true, opacity: 0.24, side: THREE.DoubleSide, depthWrite: false });
    V3.gridMat = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.16 });
    resize3D();
  }
  if (full) {
    note3d("Loading Mapterhorn terrain…");
    const reg = V3.region = regionFromView(), NX = 640, NY = Math.max(40, Math.round(NX * reg.mSpan / reg.lonSpan)), sample = await loadDem(reg, NX);
    if (gen !== V3.gen) return;
    if (V3.terrain) { V3.scene.remove(V3.terrain); V3.terrain.geometry.dispose(); V3.scene.remove(V3.plane); V3.plane.geometry.dispose(); V3.scene.remove(V3.grid); V3.grid.geometry.dispose(); }
    const n = (NX + 1) * (NY + 1), pos = new Float32Array(n * 3), uv = new Float32Array(n * 2), idx = new Uint32Array(NX * NY * 6); V3.h = new Float32Array(n);
    for (let j = 0, k = 0; j <= NY; j++) { const mer = reg.mTop - reg.mSpan * j / NY; for (let i = 0; i <= NX; i++, k++) { const lon = reg.lon0 + reg.lonSpan * i / NX; V3.h[k] = sample(lon, mer); pos[3 * k] = (lon - reg.lonC) * MPD; pos[3 * k + 2] = -(mer - reg.mC) * MPD; uv[2 * k] = i / NX; uv[2 * k + 1] = 1 - j / NY; } }
    for (let j = 0, t = 0; j < NY; j++) for (let i = 0; i < NX; i++) { const a = j * (NX + 1) + i, b = a + 1, c = a + NX + 1, d = c + 1; idx.set([a, c, b, b, c, d], t); t += 6; }
    const geo = new THREE.BufferGeometry(); geo.setAttribute("position", new THREE.BufferAttribute(pos, 3)); geo.setAttribute("uv", new THREE.BufferAttribute(uv, 2)); geo.setIndex(new THREE.BufferAttribute(idx, 1));
    V3.terrain = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1, metalness: 0 })); V3.scene.add(V3.terrain);
    // the freezing-line sheet: a coarse grid, heights from the 0 °C field
    const pnx = 56, pny = Math.max(10, Math.round(pnx * reg.mSpan / reg.lonSpan)), pp = new Float32Array((pnx + 1) * (pny + 1) * 3), pi = new Uint32Array(pnx * pny * 6);
    for (let j = 0, k = 0; j <= pny; j++) for (let i = 0; i <= pnx; i++, k++) { pp[3 * k] = (reg.lon0 + reg.lonSpan * i / pnx - reg.lonC) * MPD; pp[3 * k + 2] = -(reg.mTop - reg.mSpan * j / pny - reg.mC) * MPD; }
    for (let j = 0, t = 0; j < pny; j++) for (let i = 0; i < pnx; i++) { const a = j * (pnx + 1) + i, b = a + 1, c = a + pnx + 1, d = c + 1; pi.set([a, c, b, b, c, d], t); t += 6; }
    const pg = new THREE.BufferGeometry(); pg.setAttribute("position", new THREE.BufferAttribute(pp, 3)); pg.setIndex(new THREE.BufferAttribute(pi, 1)); V3.pnx = pnx; V3.pny = pny;
    V3.plane = new THREE.Mesh(pg, V3.planeMat); V3.plane.renderOrder = 2; V3.scene.add(V3.plane);
    V3.grid = new THREE.LineSegments(new THREE.BufferGeometry(), V3.gridMat); V3.grid.renderOrder = 3; V3.scene.add(V3.grid);
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
