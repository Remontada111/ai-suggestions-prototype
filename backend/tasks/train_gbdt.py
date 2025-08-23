#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
Träna en XGBoost-GBDT-modell för binär klassificering från JSONL-data.

Exempel (kör från repo-roten ELLER backend/ — båda funkar):
    python backend/tasks/train_gbdt.py \
      --dataset ml_artifacts/dataset.jsonl \
      --feature-order ai-codegen-extension/ml_artifacts/feature_order.json \
      --out ml_artifacts/frontend-detector-gbdt.json \
      --rounds 300 --early 30 --seed 42
"""

from __future__ import annotations

import argparse
import json
import math
import sys
import time
from pathlib import Path
from typing import Any, Dict, Iterable, List, Tuple

import numpy as np

try:
    import xgboost as xgb
except Exception as e:  # pragma: no cover
    print("Kunde inte importera xgboost. Installera med: pip install xgboost", file=sys.stderr)
    raise

# -----------------------------
# Sökvägshjälp
# -----------------------------
def guess_repo_root() -> Path:
    """
    Anta att denna fil ligger i backend/tasks/ och repo-roten är två nivåer upp.
    Faller tillbaka till nuvarande arbetskatalog om det inte stämmer.
    """
    here = Path(__file__).resolve()
    try:
        candidate = here.parents[2]  # repo-root om filen ligger i backend/tasks/
        return candidate
    except Exception:
        return Path.cwd().resolve()


REPO_ROOT = guess_repo_root()


def resolve_path(p: str | Path) -> Path:
    """
    För relativa sökvägar:
    1) Testa relativt nuvarande arbetskatalog
    2) Testa relativt repo-roten
    Annars returnera absolut/icke-befintlig kandidat (så att felmeddelande visar vart vi letade).
    """
    p = Path(p)
    if p.is_absolute():
        return p

    cwd_candidate = (Path.cwd() / p).resolve()
    if cwd_candidate.exists():
        return cwd_candidate

    repo_candidate = (REPO_ROOT / p).resolve()
    return repo_candidate


def ensure_parent_dir(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)


# -----------------------------
# IO-hjälp
# -----------------------------
def read_jsonl(fp: Path) -> List[Dict[str, Any]]:
    if not fp.exists():
        raise FileNotFoundError(
            f"Dataset saknas: '{fp}'.\n"
            f"- cwd: {Path.cwd()}\n- repo_root: {REPO_ROOT}\n"
            "Kontrollera att sökvägen är korrekt eller använd absolut sökväg."
        )
    rows: List[Dict[str, Any]] = []
    with fp.open("r", encoding="utf-8") as f:
        for line_no, line in enumerate(f, 1):
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            try:
                obj = json.loads(line)
            except json.JSONDecodeError as e:
                raise ValueError(f"Ogiltig JSON på rad {line_no} i {fp}: {e}") from e
            rows.append(obj)
    if not rows:
        raise ValueError(f"Inga dataposter hittades i {fp}.")
    return rows


def load_feature_order(fp: Path) -> List[str]:
    """
    Stöder:
      1) En ren lista: ["f1", "f2", ...]
      2) Ett objekt med nyckeln 'feature_order': {"feature_order": ["f1", ...]}
      3) En dict {feature_name: index} -> sorteras efter index
    """
    if not fp.exists():
        raise FileNotFoundError(
            f"feature_order saknas: '{fp}'.\n"
            f"- cwd: {Path.cwd()}\n- repo_root: {REPO_ROOT}\n"
        )
    with fp.open("r", encoding="utf-8") as f:
        data = json.load(f)

    if isinstance(data, list):
        order = data
    elif isinstance(data, dict) and "feature_order" in data and isinstance(data["feature_order"], list):
        order = data["feature_order"]
    elif isinstance(data, dict) and data and all(isinstance(v, int) for v in data.values()):
        # Dict med index; sortera
        order = [k for k, _ in sorted(data.items(), key=lambda kv: kv[1])]
    else:
        raise ValueError(
            "feature_order.json har okänt format. Stödjer lista, {'feature_order': lista} "
            "eller {feature: index}."
        )

    # Rensa dubbletter och tomma strängar
    cleaned = []
    seen = set()
    for f in order:
        if not isinstance(f, str) or not f:
            continue
        if f not in seen:
            cleaned.append(f)
            seen.add(f)

    if not cleaned:
        raise ValueError("feature_order är tom efter rensning.")
    return cleaned


# -----------------------------
# Vektorisering & label-hantering
# -----------------------------
def coerce_label_array(y_raw: Iterable[Any]) -> Tuple[np.ndarray, Dict[Any, int]]:
    """
    Konvertera etiketter till {0,1} och returnera (y, mapping).
    Stödjer {0,1}, {False,True}, två distinkta värden (mappas i sorterad ordning).
    """
    y_list = list(y_raw)
    uniques = sorted(set(y_list), key=lambda v: str(v))

    # Bool -> int
    if set(uniques) <= {False, True}:
        y = np.array([1 if v else 0 for v in y_list], dtype=np.float32)
        return y, {False: 0, True: 1}

    # Redan 0/1?
    if set(uniques) <= {0, 1}:
        y = np.array(y_list, dtype=np.float32)
        return y, {0: 0, 1: 1}

    # Två klasser -> mappa
    if len(uniques) == 2:
        mapping = {uniques[0]: 0, uniques[1]: 1}
        y = np.array([mapping[v] for v in y_list], dtype=np.float32)
        return y, mapping

    raise ValueError(
        f"Förväntade binära etiketter, men hittade {len(uniques)} distinkta värden: {uniques}. "
        "Mappa själv till {0,1} innan träning om du verkligen behöver fler klasser."
    )


def build_matrix(
    rows: List[Dict[str, Any]],
    feature_order: List[str],
    label_keys: Tuple[str, ...] = ("label", "target", "y"),
) -> Tuple[np.ndarray, np.ndarray]:
    """
    Bygg (X, y) från JSON-objekt.
    Stöder två layouter:
      - { "features": {...}, "label": 0/1 }
      - { <feature1>: val, ..., "label"/"target"/"y": 0/1 }
    Saknade features fylls med 0. Icke-numeriska värden ignoreras (-> 0) med varning första gången.
    """
    warn_non_numeric_once = True

    def extract_label(obj: Dict[str, Any]) -> Any:
        for k in label_keys:
            if k in obj:
                return obj[k]
        if "features" in obj and isinstance(obj["features"], dict):
            # label kan ligga separat
            for k in label_keys:
                if k in obj["features"]:
                    return obj["features"][k]
        raise KeyError(f"Hittar ingen label-nyckel i objektet. Testade: {label_keys}")

    def extract_features(obj: Dict[str, Any]) -> Dict[str, Any]:
        if "features" in obj and isinstance(obj["features"], dict):
            return obj["features"]
        # annars använd hela objektet utom label
        d = dict(obj)
        for k in label_keys:
            d.pop(k, None)
        return d

    y_raw = []
    X_list: List[List[float]] = []

    for i, obj in enumerate(rows):
        feat_map = extract_features(obj)
        try:
            label_val = extract_label(obj)
        except KeyError as e:
            raise KeyError(f"Rad {i}: {e}") from e
        y_raw.append(label_val)

        row_vec: List[float] = []
        for fname in feature_order:
            v = feat_map.get(fname, 0.0)
            if isinstance(v, (int, float, np.floating, np.integer, bool)):
                row_vec.append(float(v))
            else:
                # icke-numeriska features ignoreras -> 0.0
                if warn_non_numeric_once:
                    print(
                        f"[VARNING] Icke-numeriskt värde för feature '{fname}' upptäckt. "
                        f"Värden kommer att tolkas som 0.0 (endast första varningen visas).",
                        file=sys.stderr,
                    )
                    warn_non_numeric_once = False
                row_vec.append(0.0)
        X_list.append(row_vec)

    y, mapping = coerce_label_array(y_raw)
    X = np.array(X_list, dtype=np.float32)

    pos_rate = float(np.mean(y))
    print(f"[INFO] Samples: {len(rows)} | Features: {len(feature_order)} | Pos rate: {pos_rate:.6f}")
    if pos_rate in (0.0, 1.0):
        print(
            "[VARNING] Datasetet innehåller bara en klass totalt. Träningen blir meningslös. "
            "Säkerställ att datasetet innehåller både positiva och negativa exempel.",
            file=sys.stderr,
        )

    return X, y


# -----------------------------
# Split utan scikit-learn
# -----------------------------
def stratified_train_val_split(
    X: np.ndarray,
    y: np.ndarray,
    val_frac: float = 0.2,
    seed: int = 42,
) -> Tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    """
    Stratifierad split för binär klassificering utan sklearn.
    """
    assert 0.0 < val_frac < 1.0, "val_frac måste vara i (0,1)"
    rng = np.random.RandomState(seed)

    idx_pos = np.where(y == 1.0)[0]
    idx_neg = np.where(y == 0.0)[0]

    if len(idx_pos) == 0 or len(idx_neg) == 0:
        print(
            "[VARNING] Stratifiering omöjlig (bara en klass). Gör slumpmässig split utan stratifiering.",
            file=sys.stderr,
        )
        idx_all = np.arange(len(y))
        rng.shuffle(idx_all)
        cut = int(math.floor(len(y) * (1.0 - val_frac)))
        train_idx, val_idx = idx_all[:cut], idx_all[cut:]
    else:
        rng.shuffle(idx_pos)
        rng.shuffle(idx_neg)
        cut_pos = int(math.floor(len(idx_pos) * (1.0 - val_frac)))
        cut_neg = int(math.floor(len(idx_neg) * (1.0 - val_frac)))
        train_idx = np.concatenate([idx_pos[:cut_pos], idx_neg[:cut_neg]])
        val_idx = np.concatenate([idx_pos[cut_pos:], idx_neg[cut_neg:]])
        rng.shuffle(train_idx)
        rng.shuffle(val_idx)

    return X[train_idx], X[val_idx], y[train_idx], y[val_idx]


# -----------------------------
# Base score-säkring
# -----------------------------
def safe_base_score(y_train: np.ndarray, eps: float = 1e-6) -> float:
    """
    XGBoost kräver base_score i (0,1) för logistisk loss.
    Vi klampar klassandelen till (eps, 1-eps).
    """
    p = float(np.mean(y_train))
    bs = float(np.clip(p, eps, 1.0 - eps))
    return bs


# -----------------------------
# CLI & träning
# -----------------------------
def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Träna XGBoost GBDT för binär klassificering.")
    p.add_argument("--dataset", required=True, help="Sökväg till dataset.jsonl (relativ eller absolut).")
    p.add_argument("--feature-order", required=True, help="Sökväg till feature_order.json.")
    p.add_argument("--out", required=True, help="Sökväg till utfil för modellen (t.ex. *.json).")
    p.add_argument("--rounds", type=int, default=300, help="Antal boosting-rounds (default: 300).")
    p.add_argument("--early", type=int, default=30, help="Early stopping rounds (0=av, default: 30).")
    p.add_argument("--seed", type=int, default=42, help="Slumpfrö.")
    # valfria XGB-parametrar
    p.add_argument("--eta", type=float, default=0.1, help="Learning rate (eta).")
    p.add_argument("--max-depth", type=int, default=6, help="Max träd-djup.")
    p.add_argument("--min-child-weight", type=float, default=1.0, help="min_child_weight.")
    p.add_argument("--subsample", type=float, default=0.8, help="subsample.")
    p.add_argument("--colsample-bytree", type=float, default=0.8, help="colsample_bytree.")
    p.add_argument("--lambda_", type=float, default=1.0, help="L2-reg (lambda).")
    p.add_argument("--alpha", type=float, default=0.0, help="L1-reg (alpha).")
    p.add_argument("--val-frac", type=float, default=0.2, help="Valideringsandel (0-1).")
    return p.parse_args()


def main() -> None:
    args = parse_args()

    t0 = time.time()

    dataset_path = resolve_path(args.dataset)
    feature_order_path = resolve_path(args.feature_order)
    out_path = resolve_path(args.out)
    ensure_parent_dir(out_path)

    print(f"[INFO] REPO_ROOT: {REPO_ROOT}")
    print(f"[INFO] Dataset: {dataset_path}")
    print(f"[INFO] Feature order: {feature_order_path}")
    print(f"[INFO] Out: {out_path}")

    # Läs in
    rows = read_jsonl(dataset_path)
    feature_order = load_feature_order(feature_order_path)
    X, y = build_matrix(rows, feature_order)

    # Split
    X_tr, X_val, y_tr, y_val = stratified_train_val_split(X, y, val_frac=float(args.val_frac), seed=int(args.seed))
    pos_tr, pos_val = float(np.mean(y_tr)), float(np.mean(y_val))
    print(f"[INFO] Train samples: {len(y_tr)} (pos={pos_tr:.6f}) | Val samples: {len(y_val)} (pos={pos_val:.6f})")
    if pos_tr in (0.0, 1.0):
        print(
            "[VARNING] Träningssplit har bara en klass. Modellen lär sig inte bra. "
            "Överväg större dataset eller stratifierad split med båda klasserna.",
            file=sys.stderr,
        )
    if pos_val in (0.0, 1.0):
        print(
            "[VARNING] Valideringssplit har bara en klass. Early stopping/AUC kan bli konstiga.",
            file=sys.stderr,
        )

    # XGBoost DMatrix
    dtrain = xgb.DMatrix(X_tr, label=y_tr, feature_names=feature_order)
    dvalid = xgb.DMatrix(X_val, label=y_val, feature_names=feature_order)

    # XGBoost-parametrar
    params: Dict[str, Any] = {
        "objective": "binary:logistic",
        "eval_metric": ["logloss", "auc"],
        "eta": float(args.eta),
        "max_depth": int(args.max_depth),
        "min_child_weight": float(args.min_child_weight),
        "subsample": float(args.subsample),
        "colsample_bytree": float(args.colsample_bytree),
        "lambda": float(args.lambda_),
        "alpha": float(args.alpha),
        "seed": int(args.seed),
        # Robust fix: base_score i (0,1)
        "base_score": safe_base_score(y_tr),
    }

    print(f"[INFO] XGB params: {params}")

    # Träning
    evals_result: Dict[str, Dict[str, List[float]]] = {}
    watchlist = [(dtrain, "train"), (dvalid, "valid")]
    num_boost_round = int(args.rounds)
    early_stopping_rounds = int(args.early) if int(args.early) > 0 else None

    booster = xgb.train(
        params=params,
        dtrain=dtrain,
        num_boost_round=num_boost_round,
        evals=watchlist,
        early_stopping_rounds=early_stopping_rounds,
        evals_result=evals_result,
        verbose_eval=50,
    )

    # Spara modell
    booster.save_model(str(out_path))

    # Spara metadata/rapport
    report = {
        "created_at": time.strftime("%Y-%m-%d %H:%M:%S"),
        "xgboost_version": xgb.__version__,
        "params": params,
        "num_boost_round": num_boost_round,
        "early_stopping_rounds": early_stopping_rounds,
        "best_iteration": getattr(booster, "best_iteration", None),
        "best_score": getattr(booster, "best_score", None),
        "feature_order": feature_order,
        "train_pos_rate": float(pos_tr),
        "valid_pos_rate": float(pos_val),
        "evals_result": evals_result,
        "paths": {
            "dataset": str(dataset_path),
            "feature_order": str(feature_order_path),
            "model_out": str(out_path),
        },
    }

    report_path = out_path.with_suffix(out_path.suffix + ".training_summary.json")
    with report_path.open("w", encoding="utf-8") as f:
        json.dump(report, f, ensure_ascii=False, indent=2)

    # Spara features som egen fil (praktiskt för inference)
    features_path = out_path.with_suffix(out_path.suffix + ".features.json")
    with features_path.open("w", encoding="utf-8") as f:
        json.dump({"feature_order": feature_order}, f, ensure_ascii=False, indent=2)

    dt = time.time() - t0
    print(f"[KLART] Modell sparad till: {out_path}")
    print(f"[INFO] Träningsrapport: {report_path}")
    print(f"[INFO] Featurelista: {features_path}")
    print(f"[TID] {dt:.2f} s")


if __name__ == "__main__":
    main()
