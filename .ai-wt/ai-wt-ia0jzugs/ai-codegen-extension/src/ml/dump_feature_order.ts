// src/ml/dump_feature_order.ts
import * as fs from "node:fs";
import * as path from "node:path";
import { FEATURE_ORDER } from "./features";

function main() {
  const outDir = path.resolve(process.cwd(), "ml_artifacts");
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, "feature_order.json");
  fs.writeFileSync(outPath, JSON.stringify(FEATURE_ORDER, null, 2), "utf8");
  console.log("[dump_feature_order] wrote:", outPath);
}

main();
