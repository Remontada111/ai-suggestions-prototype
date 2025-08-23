#!/usr/bin/env python
# -*- coding: utf-8 -*-
import json, re, sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]

FO_PATH = REPO_ROOT / "ai-codegen-extension" / "ml_artifacts" / "feature_order.json"
POS_LIST = REPO_ROOT / "ml_artifacts" / "positives.txt"
NEG_LIST = REPO_ROOT / "ml_artifacts" / "negatives.txt"
OUT_JSONL = REPO_ROOT / "ml_artifacts" / "dataset_named.jsonl"

# ----------------- utils -----------------
def load_feature_order(fp: Path) -> list[str]:
    data = json.loads(fp.read_text(encoding="utf-8"))
    if isinstance(data, dict) and "feature_order" in data:
        data = data["feature_order"]
    elif isinstance(data, dict) and all(isinstance(v, int) for v in data.values()):
        data = [k for k,_ in sorted(data.items(), key=lambda kv: kv[1])]
    if not isinstance(data, list): raise SystemExit("feature_order.json: fel format.")
    return [f for f in data if isinstance(f, str) and f]

def read_lines(fp: Path) -> list[Path]:
    paths = []
    for line in fp.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#"): continue
        p = Path(line)
        if not p.exists() or not p.is_dir():
            print(f"[VARNING] Hoppar över (saknas/ej mapp): {line}")
            continue
        paths.append(p)
    return paths

def has_any(dir: Path, patterns: list[str]) -> bool:
    for pat in patterns:
        if list(dir.rglob(pat)):
            return True
    return False

def count_files(dir: Path, patterns: list[str], limit: int = 10_000) -> int:
    c = 0
    for pat in patterns:
        for _ in dir.rglob(pat):
            c += 1
            if c >= limit: return c
    return c

def load_package_json(dir: Path) -> dict | None:
    pj = dir / "package.json"
    if pj.exists():
        try:
            return json.loads(pj.read_text(encoding="utf-8"))
        except Exception:
            return None
    return None

def dep_has(pj: dict | None, names: list[str]) -> bool:
    if not pj: return False
    deps = {}
    for k in ("dependencies","devDependencies","peerDependencies","optionalDependencies"):
        d = pj.get(k) or {}
        if isinstance(d, dict): deps.update(d)
    keys = set(deps.keys())
    return any(name in keys for name in names)

def html_dom_signals(dir: Path) -> dict[str, float]:
    # Sök enkla DOM-signaler: id="app" / id="root" / framework-artefakter i HTML
    pat_html = list(dir.glob("*.html")) + list((dir / "public").glob("*.html")) if (dir / "public").exists() else list(dir.rglob("*.html"))
    txt = ""
    for p in pat_html[:50]:  # begränsa IO
        try:
            txt += "\n" + p.read_text(encoding="utf-8", errors="ignore")
        except Exception:
            pass
    s = txt.lower()
    return {
        "domSignalAppDiv": 1.0 if re.search(r'id=["\'](app|root)["\']', s) else 0.0,
        "domSignalReact": 1.0 if "react" in s else 0.0,
        "domSignalVue": 1.0 if "vue" in s else 0.0,
        "domSignalSvelte": 1.0 if "svelte" in s else 0.0,
        "domSignalAngular": 1.0 if "angular" in s else 0.0,
        "htmlLikelyHarness": 1.0 if re.search(r"(harness|sandbox|playground)", s) else 0.0,
    }

# ----------------- feature extractor -----------------
def extract_features(dir: Path) -> dict[str, float]:
    pj = load_package_json(dir)
    scripts = (pj or {}).get("scripts") or {}
    has_dev = isinstance(scripts, dict) and any(k.lower() in ("dev","start","serve") for k in scripts.keys())
    # Config presence
    has_vite_cfg   = has_any(dir, ["vite.config.*"])
    has_next_cfg   = has_any(dir, ["next.config.*"])
    has_svelte_cfg = has_any(dir, ["svelte.config.*"])
    has_nuxt_cfg   = has_any(dir, ["nuxt.config.*"])
    has_remix_cfg  = has_any(dir, ["remix.config.*"])
    has_solid_cfg  = has_any(dir, ["solid.config.*"])
    has_astro_cfg  = has_any(dir, ["astro.config.*"])
    has_angular_json = has_any(dir, ["angular.json"])
    has_webpack_cfg  = has_any(dir, ["webpack.config.*"])
    # Deps
    has_react  = dep_has(pj, ["react"])
    has_vue    = dep_has(pj, ["vue"])
    has_ng     = dep_has(pj, ["@angular/core"])
    has_vite   = dep_has(pj, ["vite"])
    has_next   = dep_has(pj, ["next"])
    has_nuxt   = dep_has(pj, ["nuxt"])
    has_astro  = dep_has(pj, ["astro"])
    has_remix  = dep_has(pj, ["@remix-run/react","@remix-run/node"])
    has_solid  = dep_has(pj, ["solid-start"])
    # node_modules frontend hint
    node_modules = (dir / "node_modules").exists()
    has_frontend_deps = node_modules and (has_react or has_vue or has_ng or has_vite or has_next or has_nuxt or has_astro or has_remix or has_solid)

    # Files & HTML/TSX counts
    html_root = count_files(dir, ["*.html"], limit=500) > 0 and any(p.parent == dir for p in dir.glob("*.html"))
    html_public = (dir / "public").exists() and count_files(dir / "public", ["*.html"], limit=500) > 0
    n_html = count_files(dir, ["*.html"], limit=500)
    n_tsx_jsx = count_files(dir, ["*.tsx","*.jsx"], limit=2000)

    dom = html_dom_signals(dir)

    # Backend heuristics (enkelt men nyttigt)
    backend_pkgs = ["express","koa","fastify","@nestjs/core","django","flask","fastapi","hapi","rails"]
    backend_heavy = 1.0 if dep_has(pj, backend_pkgs) or has_any(dir, ["requirements.txt","manage.py","app.py","main.py"]) else 0.0

    # Kända dev-servrar (vite/next/nuxt/astro/remix/solid/webpack-dev-server/angular)
    has_known_dev = any([has_vite_cfg, has_next_cfg, has_svelte_cfg, has_nuxt_cfg, has_remix_cfg, has_solid_cfg, has_astro_cfg, has_webpack_cfg, has_angular_json]) or any([has_vite, has_next, has_nuxt, has_astro])

    # Sammanfattningsfeatures
    num_cfg_hints = float(sum([has_vite_cfg,has_next_cfg,has_svelte_cfg,has_nuxt_cfg,has_remix_cfg,has_solid_cfg,has_astro_cfg,has_angular_json,has_webpack_cfg]))
    dir_depth = float(len(dir.resolve().parts))
    html_intent = float(html_root) + float(html_public) + dom["htmlLikelyHarness"]
    dom_intent = dom["domSignalAppDiv"] + dom["domSignalReact"] + dom["domSignalVue"] + dom["domSignalSvelte"] + dom["domSignalAngular"]
    base_score = 10.0*float(has_dev) + 5.0*float(has_known_dev) + 2.0*min(n_html, 5) + 1.5*min(n_tsx_jsx, 5)

    feats = {
        "hasDevScript": float(has_dev),
        "hasKnownDevServer": float(has_known_dev),
        "hasViteConfig": float(has_vite_cfg),
        "hasNextConfig": float(has_next_cfg),
        "hasSvelteConfig": float(has_svelte_cfg),
        "hasNuxtConfig": float(has_nuxt_cfg),
        "hasRemixConfig": float(has_remix_cfg),
        "hasSolidConfig": float(has_solid_cfg),
        "hasAstroConfig": float(has_astro_cfg),
        "hasAngularJson": float(has_angular_json),
        "hasWebpackConfig": float(has_webpack_cfg),
        "hasReactDep": float(has_react),
        "hasVueDep": float(has_vue),
        "hasAngularDep": float(has_ng),
        "hasSvelteKitDep": float(dep_has(pj, ["@sveltejs/kit"])),
        "hasViteDep": float(has_vite),
        "hasNextDep": float(has_next),
        "hasNuxtDep": float(has_nuxt),
        "hasAstroDep": float(has_astro),
        "hasRemixDep": float(dep_has(pj, ["@remix-run/react","@remix-run/node"])),
        "hasSolidStartDep": float(has_solid),
        "hasNodeModulesWithFrontendDeps": float(has_frontend_deps),
        "htmlAtRoot": float(html_root),
        "htmlAtPublic": float(html_public),
        "htmlLikelyHarness": float(dom["htmlLikelyHarness"]),
        "domSignalReact": float(dom["domSignalReact"]),
        "domSignalVue": float(dom["domSignalVue"]),
        "domSignalSvelte": float(dom["domSignalSvelte"]),
        "domSignalAngular": float(dom["domSignalAngular"]),
        "domSignalAppDiv": float(dom["domSignalAppDiv"]),
        "projectNameIntent": 0.0,  # medvetet 0 för att undvika läckage från katalognamn
        "backendHeavy": float(backend_heavy),
        "numConfigHints": float(num_cfg_hints),
        "dirDepth": float(dir_depth),
        "numHtmlFiles": float(n_html),
        "numTsxJsxFiles": float(n_tsx_jsx),
        "heuristicBaseScore": float(base_score),
        "htmlIntentScore": float(html_intent),
        "domIntentScore": float(dom_intent),
    }
    return feats

def main():
    feature_order = load_feature_order(FO_PATH)
    pos_dirs = read_lines(POS_LIST)
    neg_dirs = read_lines(NEG_LIST)
    if not pos_dirs or not neg_dirs:
        raise SystemExit("FEL: Fyll i ml_artifacts/positives.txt och negatives.txt med riktiga kataloger.")

    OUT_JSONL.parent.mkdir(parents=True, exist_ok=True)
    n_pos = n_neg = 0
    with OUT_JSONL.open("w", encoding="utf-8") as fout:
        for label, dirs in [(1, pos_dirs), (0, neg_dirs)]:
            for d in dirs:
                feats = extract_features(d)
                # säkerställ exakt feature-uppsättning och ordning
                feats = {k: float(feats.get(k, 0.0)) for k in feature_order}
                obj = {"features": feats, "label": label, "meta": {"dir": str(d)}}
                fout.write(json.dumps(obj, ensure_ascii=False) + "\n")
                if label == 1: n_pos += 1
                else: n_neg += 1
    print(f"[KLART] Skrev {n_pos+n_neg} rader → {OUT_JSONL}")
    print(f"         Positiva: {n_pos} | Negativa: {n_neg}")

if __name__ == "__main__":
    main()
