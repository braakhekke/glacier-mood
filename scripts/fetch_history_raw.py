import csv, io, json, urllib.request, numpy as np
from datetime import date, timedelta
from concurrent.futures import ThreadPoolExecutor
B="https://data.geo.admin.ch/ch.meteoschweiz.ogd-smn"
A="att beh cma cov dia egh gor gsb gue jun nas pil pma tit wfj".split()
meta={r['station_abbr']:r for r in csv.DictReader(open('st.csv',encoding='latin-1'),delimiter=';')}
def get(a):
    out={}
    for kind in ('historical','recent'):
        t=urllib.request.urlopen(f"{B}/{a}/ogd-smn_{a}_d_{kind}.csv",timeout=90).read().decode('latin-1')
        for r in csv.DictReader(io.StringIO(t),delimiter=';'):
            v=r.get('tre200d0','')
            if v in ('','-'): continue
            d,m,y=r['reference_timestamp'][:10].split('.'); out[date(int(y),int(m),int(d))]=float(v)
    return a,out
with ThreadPoolExecutor(8) as ex: res=dict(ex.map(get,A))
start=date(1993,1,1); last=max(max(o) for o in res.values())
days=(last-start).days+1
T=np.full((len(A),days),np.nan)
for i,a in enumerate(A):
    for d,v in res[a].items():
        k=(d-start).days
        if 0<=k<days: T[i,k]=v
print('last day',last,'days',days)
st=[dict(a=a.upper(),n=meta[a.upper()]['station_name'],z=float(meta[a.upper()]['station_height_masl']),la=float(meta[a.upper()]['station_coordinates_wgs84_lat']),lo=float(meta[a.upper()]['station_coordinates_wgs84_lon'])) for a in A]
np.save('hist_T.npy',T); json.dump(dict(stations=st,start=start.isoformat(),last=last.isoformat()),open('hist_meta.json','w'))
n=(~np.isnan(T)).sum(0)
for y in (1993,1994,2000,2010,2020,2025,2026):
    k=[(date(y,1,1)-start).days,min(((date(y,12,31)-start).days),days-1)]
    print(y,'stations/day mean',round(n[k[0]:k[1]+1].mean(),1),'min',n[k[0]:k[1]+1].min(),'days<8:',int((n[k[0]:k[1]+1]<8).sum()))
