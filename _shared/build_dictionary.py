#!/usr/bin/env python3
"""
build_dictionary.py — achata o dicionário mestre (Standard_NCM_SH6_clmd.xlsx, 3 abas)
em um único CSV longo (dictionary_codes.csv), que vira a FONTE ÚNICA de códigos do
pipeline (SECEX steel/pulp/iron-ore + o subconjunto "Antidumping" usado na
comparação China/Coreia).

Passo de DEV (como o seed_llm_prompts.py): rode de novo após editar o .xlsx.
  python _shared/build_dictionary.py                 # lê _shared/Standard_NCM_SH6_clmd.xlsx
  python _shared/build_dictionary.py <caminho.xlsx>  # lê de outro caminho

Saída: _shared/dictionary_codes.csv com colunas:
  commodity, ncm, sh6, segment, subcategory, attr1, attr2, antidumping

Layout das abas (lido com header=None — NÃO há linha de cabeçalho na planilha):
  "NCM-SH6 - Steel": [Steel, segment(Semi/Flat/Long), subcategory, NCM(8), SH6(6), '-'|'Antidumping']
  "SH6 - Pulp":      [Pulp, fiber, UKP/BKP/..., Softwood/Hardwood, Sulphate/Sulphite, SH6(6)]
  "SH6 - Iron Ore":  [Iron Ore, Fines/Pellets, SH6(6)]
"""
import sys, csv
from collections import Counter
from pathlib import Path

import pandas as pd

HERE = Path(__file__).parent
DEFAULT_XLSX = HERE / "Standard_NCM_SH6_clmd.xlsx"
OUT_CSV = HERE / "dictionary_codes.csv"

STEEL_SHEET = "NCM-SH6 - Steel"
PULP_SHEET = "SH6 - Pulp"
IRON_SHEET = "SH6 - Iron Ore"

COLS = ["commodity", "ncm", "sh6", "segment", "subcategory", "attr1", "attr2", "antidumping"]


def _s(v) -> str:
    """Normaliza célula -> string limpa ('' para nan/none/'-')."""
    if v is None:
        return ""
    s = str(v).strip()
    if s.lower() in ("nan", "none", "-", ""):
        return ""
    return s


def _code(v, width: int) -> str:
    """Código numérico -> string zero-padded (trata floats tipo 720720.0)."""
    s = _s(v)
    if not s:
        return ""
    if s.endswith(".0"):
        s = s[:-2]
    s = s.split(".")[0]
    return s.zfill(width)


def build():
    xlsx = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_XLSX
    if not xlsx.exists():
        sys.exit(f"Dicionário não encontrado: {xlsx}")

    rows = []

    # ── STEEL ───────────────────────────────────────────────────────────────────
    steel = pd.read_excel(xlsx, sheet_name=STEEL_SHEET, header=None)
    for _, r in steel.iterrows():
        ncm = _code(r[3], 8)
        sh6 = _code(r[4], 6)
        if not ncm and not sh6:
            continue
        ad = 1 if _s(r[5]).lower().startswith("antidump") else 0
        rows.append(dict(commodity="steel", ncm=ncm, sh6=sh6,
                         segment=_s(r[1]), subcategory=_s(r[2]),
                         attr1="", attr2="", antidumping=ad))

    # ── PULP ────────────────────────────────────────────────────────────────────
    pulp = pd.read_excel(xlsx, sheet_name=PULP_SHEET, header=None)
    for _, r in pulp.iterrows():
        sh6 = _code(r[5], 6)
        if not sh6:
            continue
        rows.append(dict(commodity="pulp", ncm="", sh6=sh6,
                         segment=_s(r[1]), subcategory=_s(r[2]),
                         attr1=_s(r[3]), attr2=_s(r[4]), antidumping=0))

    # ── IRON ORE ──────────────────────────────────────────────────────────────────
    iron = pd.read_excel(xlsx, sheet_name=IRON_SHEET, header=None)
    for _, r in iron.iterrows():
        sh6 = _code(r[2], 6)
        if not sh6:
            continue
        rows.append(dict(commodity="iron_ore", ncm="", sh6=sh6,
                         segment="", subcategory=_s(r[1]),
                         attr1="", attr2="", antidumping=0))

    with open(OUT_CSV, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=COLS)
        w.writeheader()
        w.writerows(rows)

    by_c = Counter(r["commodity"] for r in rows)
    n_ad = sum(r["antidumping"] for r in rows)
    n_ad_sh6 = len({r["sh6"] for r in rows if r["antidumping"]})
    print(f"OK {OUT_CSV.name}: {len(rows)} linhas | por commodity={dict(by_c)}")
    print(f"   steel: NCM unicos={len({r['ncm'] for r in rows if r['commodity']=='steel'})} "
          f"| SH6 unicos={len({r['sh6'] for r in rows if r['commodity']=='steel'})}")
    print(f"   antidumping: {n_ad} linhas marcadas | {n_ad_sh6} SH6 distintos")


if __name__ == "__main__":
    build()
