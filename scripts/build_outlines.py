"""Writes ../outlines.json: thin glacier outlines (SGI 2023) for the zoomed-in map.
Usage: python build_outlines.py [shapefile prefix] [output]   (defaults: sgi23/SGI_2023_glaciers  ../outlines.json)
Each ring is [x0, y0, dx1, dy1, ...] in units of 1e-5 degrees (lon, lat), deltas after the first point."""
import json, sys
import shapefile
from pyproj import Transformer
from shapely.geometry import shape
from shapely.ops import transform
src = sys.argv[1] if len(sys.argv) > 1 else 'sgi23/SGI_2023_glaciers'
out = sys.argv[2] if len(sys.argv) > 2 else '../outlines.json'
tf = Transformer.from_crs(2056, 4326, always_xy=True).transform
U = 100000
rings = []
for s in shapefile.Reader(src).shapes():
    g = transform(tf, shape(s.__geo_interface__)).simplify(0.00004, preserve_topology=True)
    for p in (g.geoms if g.geom_type == 'MultiPolygon' else [g]):
        for r in [p.exterior, *p.interiors]:
            pts = [(round(x * U), round(y * U)) for x, y in r.coords]
            if len(pts) < 4: continue
            flat = [pts[0][0], pts[0][1]]
            for (x0, y0), (x1, y1) in zip(pts, pts[1:]): flat += [x1 - x0, y1 - y0]
            rings.append(flat)
json.dump({'u': U, 'rings': rings}, open(out, 'w'), separators=(',', ':'))
print(len(rings), 'rings,', sum(len(r) // 2 for r in rings), 'points')
