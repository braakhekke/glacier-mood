"""Writes ../glamos.json: yearly Swiss-wide glacier volume change (GLAMOS 'Swisswide Glacier Mass Balance').
Tries the newest release first (release year = data year), e.g. massbalance_swisswide_2026_r2026.zip.
Years are hydrological years (October of the previous year to September of that year)."""
import csv, io, json, urllib.request, zipfile
from datetime import date
for rel in range(date.today().year, 2022, -1):
    url = f"https://doi.glamos.ch/data/massbalance_swisswide/massbalance_swisswide_{rel}_r{rel}.zip"
    try: z = zipfile.ZipFile(io.BytesIO(urllib.request.urlopen(url, timeout=120).read())); break
    except Exception: continue
else: raise SystemExit("no GLAMOS swisswide release found")
name = [n for n in z.namelist() if n.endswith(".csv")][0]
rows = [r for r in csv.reader(io.StringIO(z.read(name).decode("utf8"))) if r and r[0] == "Switzerland"]
f = lambda x: None if x in ("None", "") else float(x)
years = {int(r[1]): dict(dv=f(r[5]), vol=f(r[4]), mb=f(r[3]), area=f(r[2])) for r in rows if int(r[1]) >= 1993 and f(r[5]) is not None}
json.dump(dict(release=rel, doi=f"10.18750/massbalance.swisswide.{rel}.r{rel}", years=years), open("../glamos.json", "w"), separators=(",", ":"))
print(rel, len(years), "years", min(years), "-", max(years))
