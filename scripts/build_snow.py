"""Writes ../snow.json: latest snow depth (HS, cm) and air temperature at the SLF IMIS snow stations.
SLF's public API (measurement-api.slf.ch) sends no CORS header, so the browser cannot call it directly;
the Pages workflow runs this every hour and ships the result with the site."""
import json, urllib.request
from concurrent.futures import ThreadPoolExecutor
API = "https://measurement-api.slf.ch/public/api/imis"
get = lambda u: json.load(urllib.request.urlopen(u, timeout=60))
stations = [s for s in get(f"{API}/stations") if "SNOW" in s["type"] and s["country_code"] == "CH"]
def latest(s):
    try:
        rows = get(f"{API}/station/{s['code']}/measurements")
        hs = [r for r in rows if r.get("HS") is not None]
        if not hs: return None
        r = hs[-1]
        return dict(c=s["code"], n=s["label"], lo=round(s["lon"], 4), la=round(s["lat"], 4), z=round(s["elevation"]), hs=round(r["HS"], 1),
                    ta=None if r.get("TA_30MIN_MEAN") is None else round(r["TA_30MIN_MEAN"], 1), t=r["measure_date"])
    except Exception:
        return None
with ThreadPoolExecutor(8) as ex: out = [r for r in ex.map(latest, stations) if r]
out.sort(key=lambda r: r["c"])
json.dump(dict(time=max(r["t"] for r in out), st=out), open("../snow.json", "w"), separators=(",", ":"))
print(len(out), "stations of", len(stations), "| median HS", sorted(r["hs"] for r in out)[len(out) // 2], "cm | newest", max(r["t"] for r in out))
