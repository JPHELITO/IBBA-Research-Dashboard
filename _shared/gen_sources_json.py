# -*- coding: utf-8 -*-
"""gen_sources_json.py — gera admin/sources_registry.json a partir do registry.py.

POR QUÊ: a aba "Status das fontes" do admin tinha o inventário HARDCODED no HTML —
ficava desatualizado (classificava IBÁ/Empapel/INDA/GACC/Coreia como "manual" quando
já são automáticos) e os timestamps não apareciam porque o nome procurado no
`update_log` era case-sensitive e diferia do que os workflows gravam.

Agora o admin lê ESTE JSON (gerado do registro, que é a fonte da verdade) e casa o
frescor por uma LISTA de aliases, sem diferenciar maiúsculas/minúsculas.

Uso:  python _shared/gen_sources_json.py     (rode quando mexer no registry.py)
"""
from __future__ import annotations
import json, os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import registry  # noqa: E402

OUT = os.path.join(HERE, "..", "admin", "sources_registry.json")

# Nomes que cada fonte pode ter gravado no update_log (workflows/scripts diferentes
# usaram grafias diferentes ao longo do tempo). A busca no admin é case-insensitive.
LOG_ALIASES = {
    "secex_steel":       ["SECEX"],
    "iron_ore":          ["Minério", "Minerio"],
    "iabr":              ["IABr"],
    "pulp_secex":        ["Celulose"],
    "iba_paper":         ["iba_paper", "IBÁ papel", "IBA papel"],
    "empapel":           ["empapel"],
    "inda":              ["inda_distribution", "INDA"],
    "gacc":              ["gacc", "gacc_woodchips", "GACC"],
    "pred_korea":        ["pred_korea", "Korea", "Coreia", "pred_exports"],
    "pred_china":        ["pred_china", "China", "pred_exports"],
    "import_prediction": ["import_prediction", "Modelo"],
    "quotes":            ["quotes"],
    "commodities":       ["commodities"],
    "macro":             ["macro"],
    "news":              ["news"],
}

# Janela esperada de publicação (dia do mês) — o que o robô/humano espera.
WINDOW = {
    "secex_steel": "dias 1–10", "iron_ore": "dias 1–10", "pulp_secex": "dias 1–12",
    "iabr": "2ª/3ª semana", "iba_paper": "dias 7–13 (lag ~2m)", "inda": "meio do mês (lag ~2m)",
    "empapel": "~dia 15 (prelim.) / mês seguinte (oficial)", "gacc": "~dia 18–20 do mês seguinte",
    "pred_korea": "após o fechamento do mês", "pred_china": "após o fechamento do mês",
    "import_prediction": "junto com o SECEX",
}


def build():
    out = []
    for s in registry.all_sources():
        key = s["key"]
        aliases = list(dict.fromkeys(          # dedup preservando ordem
            LOG_ALIASES.get(key, []) + [key, s["label"]]
        ))
        out.append({
            "key": key,
            "label": s["label"],
            "sector": s["sector"],
            "cadence": s["cadence"],
            "auto": bool(s.get("auto")),
            "how_pulled": s.get("how_pulled"),
            "how_pulled_txt": registry.COMO_PUXA.get(s.get("how_pulled"), s.get("how_pulled")),
            "confidence": s.get("confidence"),
            "overdue_days": s.get("overdue_days"),
            "stale_min": s.get("stale_min"),
            "window": WINDOW.get(key),
            "note": s.get("note"),
            "log_keys": aliases,
        })
    return out


if __name__ == "__main__":
    data = build()
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump({"generated_from": "_shared/registry.py", "sources": data}, f,
                  ensure_ascii=False, indent=2)
    auto = sum(1 for d in data if d["auto"])
    print(f"OK -> {os.path.normpath(OUT)}")
    print(f"{len(data)} fontes ({auto} automáticas, {len(data)-auto} dependem de humano)")
