// src/ml/gbdt.ts
// Enkel GBDT-inferenz (XGBoost/LightGBM-liknande) utan externa beroenden.
// - Modell läses från JSON (se typer nedan).
// - Varje träd består av noder; traversal görs med feature-threshold jämförelser.
// - Output är raw score (summa av blad + base_score) -> sigmoid -> p(frontend).

import { FEATURE_ORDER } from "./features";

// ===== Modelltyper =====

export type GBDTNode = {
  // Om leaf är definierad är noden ett blad och övriga fält ignoreras.
  leaf?: number;

  // För icke-blad:
  feature?: number;      // index i FEATURE_ORDER
  threshold?: number;    // jämför mot featurevärde: v <= threshold -> left, annars right
  left?: number;         // index till vänsterbarn
  right?: number;        // index till högerbarn
  default_left?: boolean; // vid NaN/missing: true = gå vänster, false = gå höger (default: true)
};

export type GBDTTree = {
  nodes: GBDTNode[];     // index 0 är root
};

export type GBDTModel = {
  version: number;                 // bumpa vid feature-order/formatändring
  type: "gbdt";                    // modelltyp
  objective: "binary:logistic";    // för närvarande endast binär klassning
  feature_order: string[];         // måste matcha FEATURE_ORDER exakt
  base_score?: number;             // rå bias (logit), ofta 0.0 eller logit(0.5)=0
  trees: GBDTTree[];               // skog av träd

  // valfritt: om du tränar med standardisering (ovanligt för träd, men stöds)
  scaler?: { mean: number[]; scale: number[]; eps?: number };
};

// ===== Utils =====

export function assertCompatible(model: GBDTModel) {
  if (model.type !== "gbdt") throw new Error(`Modelltyp stöttas ej: ${model.type}`);
  const same = JSON.stringify(model.feature_order) === JSON.stringify(FEATURE_ORDER);
  if (!same) {
    throw new Error("Feature order mismatch mellan modellen och koden. Träna om eller bumpa version.");
  }
}

function sigmoid(z: number): number {
  // numeriskt stabil
  if (z >= 0) {
    const ez = Math.exp(-z);
    return 1 / (1 + ez);
  } else {
    const ez = Math.exp(z);
    return ez / (1 + ez);
  }
}

function maybeScale(features: number[], scaler?: { mean: number[]; scale: number[]; eps?: number }): number[] {
  if (!scaler) return features;
  const { mean, scale, eps = 1e-9 } = scaler;
  if (!mean || !scale || mean.length !== features.length || scale.length !== features.length) return features;
  const out = new Array(features.length);
  for (let i = 0; i < features.length; i++) {
    out[i] = (features[i] - mean[i]) / (scale[i] + eps);
  }
  return out;
}

// ===== Träd-inferenz =====

function evalTree(tree: GBDTTree, x: number[]): number {
  // Traversera från root tills leaf hittas.
  let idx = 0;
  const nodes = tree.nodes;
  // säkerhetsvakt
  if (!nodes || nodes.length === 0) return 0;

  // fallback-skydd mot dåliga modeller: loop-brytare
  let guard = 0;
  while (guard++ < 4096) {
    const n = nodes[idx];
    if (!n) return 0; // defensivt

    if (typeof n.leaf === "number") {
      return n.leaf;
    }

    // inre nod
    const f = n.feature!;
    const thr = n.threshold!;
    const v = x[f];

    let goLeft: boolean;
    if (Number.isNaN(v) || v === undefined) {
      goLeft = n.default_left !== false; // default = true (vänster) om ej specificerat
    } else {
      goLeft = v <= thr;
    }

    idx = goLeft ? (n.left ?? idx) : (n.right ?? idx);
    if (idx < 0 || idx >= nodes.length) {
      // trasigt index -> stoppa
      return 0;
    }
  }
  // loop guard triggad
  return 0;
}

// ===== Modell-inferenz =====

export function predictRaw(model: GBDTModel, features: number[]): number {
  assertCompatible(model);
  // Träd behöver sällan scaling, men vi stöder det om träningspipen använt det.
  const x = maybeScale(features, model.scaler);

  let s = 0;
  for (const t of model.trees) {
    s += evalTree(t, x);
  }
  if (typeof model.base_score === "number") s += model.base_score;
  return s; // rå logit-poäng
}

export function predictProba(model: GBDTModel, features: number[]): number {
  const raw = predictRaw(model, features);
  return sigmoid(raw);
}
