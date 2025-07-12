# backend/rules/layer1_benchmarks.py
"""
Lager 1 – Benchmark-nivåer
--------------------------
• Används *en gång* varje gång vi skapar en ny kvart-rad.
• Drar slump­värden kring bransch-medel som står i benchmarks.yaml.
• Returnerar ett dict som de andra lagren kan fortsätta att modifiera.
"""

import random
from datetime import datetime
from typing import Dict

# ------------- Hjälpfunktioner ------------- #
def _rand_near(base: float, spread: float = 0.2) -> float:
    """
    Ger ett värde runt 'base'.
    spread=0.2 betyder ±20 % avvikelse.
    """
    low  = base * (1 - spread)
    high = base * (1 + spread)
    return random.uniform(low, high)


# ------------- Publik API ------------- #
def new_quarter_state(
    adset_id: str,
    ts_start: datetime,
    cfg: Dict,
    budget: float,
) -> Dict:
    """
    Skapar ett *state-dict* med realistiska utgångsvärden.

    Parametrar
    ----------
    adset_id : str
        Vem raden hör till.
    ts_start : datetime
        Starttid för 15-minuters­fönstret (UTC).
    cfg : dict
        Läst direkt från benchmarks.yaml.
    budget : float
        Gällande dagsbudget för ad-setet.  Används för att uppskatta impressions.

    Returnerar
    ----------
    dict
        Nycklar matchar fälten i Insight-modellen.
    """

    # 1. Plocka fram branschmedel från konfig-filen
    ctr_base = cfg["benchmarks"]["ctr_base"]        # t.ex. 0.015 (=1,5 %)
    cpc_base = cfg["benchmarks"]["cpc_base"]        # t.ex. 0.78 USD
    cpm_base = cfg["benchmarks"]["cpm_base"]        # t.ex. 12 USD
    roas_base = cfg["benchmarks"]["roas_base"]      # t.ex. 3.1×

    # 2. Lägg på lite slump runt medelvärdena
    ctr  = _rand_near(ctr_base, 0.3)                # ±30 % variation
    cpm  = _rand_near(cpm_base, 0.25)
    roas = _rand_near(roas_base, 0.3)

    # 3. Skatta impressions från budget & CPM  (≈ budget/dygn → kvart)
    #    Antag 96 kvartar per dygn ⇒ dela med 96.
    impressions = int(budget / 96 / cpm * 1000)

    # 4. Härleder övriga KPI:er
    clicks = max(int(impressions * ctr), 1)         # minst 1 klick
    spend  = round(impressions / 1000 * cpm, 2)
    cpc    = round(spend / clicks, 2)

    # 5. Bygg state-dict som andra lager kan modifiera
    return {
        "adset_id": adset_id,
        "ts_start": ts_start,
        "impressions": impressions,
        "clicks": clicks,
        "spend": spend,
        "ctr": round(ctr * 100, 2),                 # procent, 2 decimaler
        "cpc": cpc,
        "cpm": round(cpm, 2),
        "roas": round(roas, 2),
        "budget": budget,
        "base_budget": budget                       # sparas för budget-decay-lagret
    }
