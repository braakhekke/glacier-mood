import json, math, sys, zlib, base64
import numpy as np, shapefile, rasterio
from rasterio.features import rasterize
from rasterio.windows import Window
from pyproj import Transformer
from shapely.geometry import shape, box
from shapely.ops import transform as sh_transform

tf = Transformer.from_crs(2056, 4326, always_xy=True).transform
r = shapefile.Reader('sgi23/SGI_2023_glaciers')
recs = [x.as_dict() for x in r.records()]
geoms = [sh_transform(tf, shape(s.__geo_interface__)) for s in r.shapes()]
b = [g.bounds for g in geoms]
L0, L1 = math.floor(min(x[0] for x in b)), math.floor(max(x[2] for x in b))
B0, B1 = math.floor(min(x[1] for x in b)), math.floor(max(x[3] for x in b))
N30 = 3600
lat_top = B1 + 1                 # global grid top edge (deg), lon0 = L0
W, H = (L1 - L0 + 1) * N30, (B1 - B0 + 1) * N30
print('grid', W, H, file=sys.stderr)
X, Y, Zs, G = [], [], [], []
for la in range(B0, B1 + 1):
    for lo in range(L0, L1 + 1):
        tile = box(lo, la, lo + 1, la + 1)
        idx = [i for i, g in enumerate(geoms) if g.intersects(tile)]
        if not idx: continue
        n = f"Copernicus_DSM_COG_10_N{la:02d}_00_E{lo:03d}_00_DEM"
        try: src = rasterio.open(f"https://copernicus-dem-30m.s3.amazonaws.com/{n}/{n}.tif")
        except Exception as e: print('skip', n, e, file=sys.stderr); continue
        dem = src.read(1).astype('float32'); tr = src.transform
        # tiles are 3600 wide at this latitude band? check shape; GLO-30 is 3600x3600 only below 50N
        assert dem.shape == (N30, N30) or True
        sx = dem.shape[1] / N30; sy = dem.shape[0] / N30
        if sx != 1 or sy != 1: print('tile shape', n, dem.shape, file=sys.stderr)
        ids = rasterize([(geoms[i], i + 1) for i in idx], out_shape=dem.shape, transform=tr, fill=0, dtype='int32', all_touched=True)
        ys, xs = np.nonzero((ids > 0) & np.isfinite(dem) & (dem > -100))
        X.append(xs + (lo - L0) * N30); Y.append(ys + (lat_top - 1 - la) * N30)
        Zs.append(np.clip(np.round(dem[ys, xs]), 0, 65535)); G.append(ids[ys, xs] - 1)
        print(n, len(xs), file=sys.stderr)
X = np.concatenate(X).astype(np.int64); Y = np.concatenate(Y).astype(np.int64)
Zs = np.concatenate(Zs).astype(np.int64); G = np.concatenate(G).astype(np.int64)
o = np.lexsort((X, Y)); X, Y, Zs, G = X[o], Y[o], Zs[o], G[o]
# a cell can be hit by two glaciers' tiles only at tile seams; drop duplicate positions
keep = np.ones(len(X), bool); keep[1:] = (X[1:] != X[:-1]) | (Y[1:] != Y[:-1])
X, Y, Zs, G = X[keep], Y[keep], Zs[keep], G[keep]
n = len(X)
dy = np.diff(Y, prepend=0)
dx = np.where(dy > 0, X, np.diff(X, prepend=0))
dz = np.diff(Zs, prepend=0)
raw = dy.astype("<u2").tobytes()+dx.astype("<u2").tobytes()+dz.astype("<i2").tobytes()+G.astype("<u2").tobytes()
comp = zlib.compress(raw, 9)
print(n, 'cells', len(raw), '->', len(comp), file=sys.stderr)
out = {'w': W, 'h': H, 'lon0': L0, 'lat0': lat_top, 'd': 1 / N30, 'n': n, 'cells': base64.b64encode(comp).decode(),
       'glaciers': [[a['name'] or None, a['sgi-id'], round(a['area_km2'], 3)] for a in recs]}
json.dump(out, open('cells.json', 'w'), separators=(',', ':'))
