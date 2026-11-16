"""Build the local city index from GeoNames cities15000.zip (CC BY 4.0).
Usage: python3 scripts/build-weather-cities.py /path/to/cities15000.zip
Source: https://download.geonames.org/export/dump/  License: https://creativecommons.org/licenses/by/4.0/
"""
import json
import re
import sys
import zipfile
from pathlib import Path

cities = []
with zipfile.ZipFile(sys.argv[1]) as archive:
    for line in archive.read("cities15000.txt").decode().splitlines():
        fields = line.split("\t")
        if fields[7] in {"PPLX", "PPLH", "PPLQ"} or not fields[17]:
            continue
        # The city centre is sufficient for a city-level forecast.
        aliases = []
        if fields[8] in {"CN", "HK", "MO", "TW", "ID", "MY", "TH", "VN", "PH", "SG"}:
            aliases = list(dict.fromkeys(n for n in fields[3].split(",") if re.fullmatch(r"[一-鿿]{2,10}", n)))[:12]
        cities.append((int(fields[14] or 0), [fields[0], fields[1], fields[8], round(float(fields[4]), 2),
                                               round(float(fields[5]), 2), fields[17], " ".join(aliases)]))
cities.sort(key=lambda pair: (-pair[0], pair[1][0]))
dest = Path(__file__).resolve().parents[1] / "lib" / "weather-cities.json"
dest.write_text("[\n" + ",\n".join(json.dumps(city, ensure_ascii=False, separators=(",", ":"))
                                  for _, city in cities) + "\n]\n")
