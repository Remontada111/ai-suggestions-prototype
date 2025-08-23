// src/ml/classifier.ts
// Loader + wrapper runt GBDT-inferenz.
// - Försöker först läsa användarens uppdaterade modell i global storage.
// - Faller tillbaka till en bundlad modellfil om sådan finns.
// - Exponerar predictFrontendProb(FeatureVector): number | null.

import * as fs from "node:fs";
import * as path from "node:path";
import { toArray, type FeatureVector, FEATURE_ORDER } from "./features";
import { type GBDTModel, predictProba, assertCompatible } from "./gbdt";

let MODEL: GBDTModel | null = null;

export function loadModelIfAny(options: {
  globalStoragePath?: string;   // t.ex. context.globalStorageUri.fsPath
  bundledModelPath?: string;    // t.ex. path.resolve(__dirname, "../model/frontend-detector-gbdt.json")
} = {}) {
  const { globalStoragePath, bundledModelPath } = options;

  // 1) Försök läs användarspecifik modell
  if (globalStoragePath) {
    try {
      const userPath = path.join(globalStoragePath, "frontend-detector-gbdt.json");
      if (fs.existsSync(userPath)) {
        const m = JSON.parse(fs.readFileSync(userPath, "utf8"));
        assertCompatible(m);
        MODEL = m;
        return;
      }
    } catch (e) {
      console.warn("[classifier] kunde inte läsa användarmodell:", e);
    }
  }

  // 2) Fallback: bundlad modell
  if (bundledModelPath) {
    try {
      if (fs.existsSync(bundledModelPath)) {
        const m = JSON.parse(fs.readFileSync(bundledModelPath, "utf8"));
        assertCompatible(m);
        MODEL = m;
        return;
      }
    } catch (e) {
      console.warn("[classifier] kunde inte läsa bundlad modell:", e);
    }
  }

  // 3) Om inget hittades, lämna null (systemet faller tillbaka på heuristik)
  MODEL = null;
}

export function predictFrontendProb(fv: FeatureVector): number | null {
  if (!MODEL) return null;
  // Säkerställ att feature-order är densamma — assertCompatible gjordes vid load.
  const arr = toArray(fv);
  try {
    return predictProba(MODEL, arr);
  } catch (e) {
    console.warn("[classifier] inferens misslyckades:", e);
    return null;
  }
}

// Hjälpfunktion (valfri): enkel viktning för att kombinera heuristikscore + ML-prob
export function combineHeuristicAndML(heuristicScore: number, p: number | null, opts?: {weight?: number}): number {
  if (p == null) return heuristicScore;
  const w = opts?.weight ?? 10; // +/-5 poäng kring 0.5 om weight=10
  return heuristicScore + Math.round(w * (p - 0.5));
}
