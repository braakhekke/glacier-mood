"""Bakes daily mean temperatures (1993 -> end of last full year) of the 15 MeteoSwiss stations above 2000 m into history.json.
The page extends this live with MeteoSwiss' 'recent' daily files, so this only needs re-running once a year (January).
Run fetch_history_raw.py first (writes hist_T.npy / hist_meta.json), then this."""
import json, zlib, base64, numpy as np
from datetime import date, timedelta
T = np.load('hist_T.npy'); M = json.load(open('hist_meta.json')); start = date.fromisoformat(M['start'])
end = date(date.today().year - 1, 12, 31)
n = (end - start).days + 1
T = T[:, :n]
q = np.where(np.isnan(T), -32768, np.round(T * 10)).astype('<i2')
days = np.arange(n); months = np.array([(start + timedelta(days=int(k))).month for k in days])
z = np.array([s['z'] for s in M['stations']]); slope = np.full(n, np.nan)
for k in range(n):
    m = ~np.isnan(T[:, k])
    if m.sum() >= 8: slope[k] = -np.polyfit(z[m], T[m, k], 1)[0] * 1000
rates = [round(float(np.nanmedian(slope[months == m])), 2) for m in range(1, 13)]
out = dict(stations=M['stations'], start=start.isoformat(), days=n, monthRates=rates,
           t=base64.b64encode(zlib.compress(q.tobytes(), 9)).decode())
json.dump(out, open('../history.json', 'w'), separators=(',', ':'))
print(n, 'days to', end, 'monthly rates', rates)
