import json
import math
from pathlib import Path

import geopandas as gpd


source_dir = Path("data/geography_files/split_parcels")
output_dir = Path("data/geography_files/parcel_address_tiles")
grid_degrees = 0.01
tiles = {}

for path in sorted(source_dir.glob("Parcel_Digest_2025_part*.geojson")):
    parcels = gpd.read_file(path).to_crs("EPSG:4326")
    points = parcels.geometry.representative_point()
    for (_, parcel), point in zip(parcels.iterrows(), points):
        address = str(parcel.get("PropAddress_Full") or "").strip()
        if not address or point.is_empty:
            continue
        city = str(parcel.get("PropAddress_City") or "").strip()
        state = str(parcel.get("PropAddress_State") or "GA").strip()
        postal_code = str(parcel.get("PropAddress_Zip") or "").strip()
        full_address = ", ".join(value for value in (address, city, f"{state} {postal_code}".strip()) if value)
        record = [round(point.x, 6), round(point.y, 6), full_address]
        column = math.floor((point.x + 180) / grid_degrees)
        row = math.floor((point.y + 90) / grid_degrees)
        tiles.setdefault(f"{column}_{row}", []).append(record)

output_dir.mkdir(parents=True, exist_ok=True)
for old_tile in output_dir.glob("*.json"):
    old_tile.unlink()

manifest = {"grid_degrees": grid_degrees, "tiles": {}}
record_count = 0
for key, records in tiles.items():
    filename = f"{key}.json"
    (output_dir / filename).write_text(json.dumps(records, separators=(",", ":")), encoding="utf-8")
    manifest["tiles"][key] = filename
    record_count += len(records)

(output_dir / "manifest.json").write_text(json.dumps(manifest, separators=(",", ":")), encoding="utf-8")
print(f"Wrote {record_count:,} parcel addresses across {len(tiles):,} geographic tiles")
