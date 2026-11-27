# Zero Melt

**Is the ice having a good day?** A static website that maps the freezing line (0 °C) over every Swiss glacier and says how much ice is currently below it, with a strip of every day since 1993 next to GLAMOS's yearly ice volume change.

- The 0 °C line comes from live temperatures at the 15 MeteoSwiss SwissMetNet stations above 2,000 m (height + temperature ÷ a cooling rate fitted to those stations each time).
- Glaciers: Swiss Glacier Inventory 2023 (GLAMOS, doi 10.18750/inventory.sgi2023.r2026) on the Copernicus GLO-30 terrain model, 1.45 million 30 m cells.
- Optional comparison with four well-known weather models (ECMWF IFS, GFS, ICON-EU, ICON-CH2) and, for past days, ERA5 reanalysis (all via Open-Meteo), loaded on demand.
- History: daily mean temperatures 1993 to today. A baked `history.json` runs to the end of last year; the page adds this year live from MeteoSwiss.

No server and no build step. Everything runs in the browser and reads CORS-open data from `data.geo.admin.ch` (MeteoSwiss) and `api.open-meteo.com`.

## Run locally

```
python3 -m http.server 8000
```
then open http://localhost:8000 (a plain `file://` open will not work, the page fetches its data files).

## Data files

| File | What | How to rebuild |
|---|---|---|
| `cells.json` | glacier cells (position, height, glacier id), deflated | `scripts/make_cells.py`, needs the SGI 2023 shapefiles in `scripts/sgi23/` and network access to the DEM on AWS. Only when a new inventory is published. |
| `history.json` | daily temperatures 1993 → end of last year, 15 stations | `scripts/fetch_history_raw.py` then `scripts/build_history.py`. The yearly workflow does this in January. |
| `glamos.json` | yearly Swiss glacier volume change (GLAMOS Swisswide Glacier Mass Balance) | `scripts/build_glamos.py`. The yearly workflow does this too. |
| `snapshot.json` | fallback readings used only if live MeteoSwiss data cannot be reached | any recent `t_now` reading |

Python scripts need `numpy`; `make_cells.py` also needs `pyshp`, `shapely`, `pyproj`, `rasterio`.

## Deploy

`.github/workflows/pages.yml` publishes the static files to GitHub Pages on every push to `main` (Settings → Pages → Source: GitHub Actions).

## Caveats

Air above 0 °C does not mean ice is melting right then: snow cover, cold ice, shade and wind hold melt back. The page shows exposure to melt, not measured melt. Glaciers are held at their 2023 outlines for every year, so past exposure is understated. In hot summer spells the 0 °C line rises above the highest station (3,571 m) and is extended from the fitted cooling rate.

Data licences: SGI 2023 CC BY 4.0 (GLAMOS); MeteoSwiss open data CC BY; Copernicus DEM per its licence; Open-Meteo for non-commercial use.
