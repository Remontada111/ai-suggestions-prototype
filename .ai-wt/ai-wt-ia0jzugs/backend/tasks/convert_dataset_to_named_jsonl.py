# taska/convert_dataset_to_named_jsonl.py
import json, sys
from pathlib import Path

in_path = Path(sys.argv[1])
feature_order_path = Path(sys.argv[2])
out_path = Path(sys.argv[3])

feature_order = json.loads(feature_order_path.read_text(encoding="utf-8"))
if isinstance(feature_order, dict) and "feature_order" in feature_order:
    feature_order = feature_order["feature_order"]

with in_path.open("r", encoding="utf-8") as fin, out_path.open("w", encoding="utf-8") as fout:
    for i, line in enumerate(fin, 1):
        line = line.strip()
        if not line or line.startswith("#"): continue
        obj = json.loads(line)
        feats = obj.get("features")
        if not isinstance(feats, list):
            # redan dict? skriv igen
            fout.write(json.dumps(obj, ensure_ascii=False) + "\n")
            continue
        if len(feats) != len(feature_order):
            raise SystemExit(f"Rad {i}: features-längd {len(feats)} matchar inte feature_order {len(feature_order)}")
        obj["features"] = {feature_order[j]: float(feats[j]) for j in range(len(feats))}
        fout.write(json.dumps(obj, ensure_ascii=False) + "\n")
print(f"KLART → {out_path}")
