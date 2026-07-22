# -*- coding: utf-8 -*-
"""Atualização CIRÚRGICA da tabela `gacc_woodchips` (cavaco China, HW/SW por país).

Lê o Excel do GACC e substitui SÓ os meses presentes nele — preserva iba_paper, iba_pulp,
secex_pulp_port, empapel, company_q, calendar E o histórico antigo do próprio GACC (pré-2015).
Mata o rebuild completo perigoso do extractor_pp.

Prefere a aba BRUTA 'GACC INPUT' (o download direto do customs) e pivota em código
(dispensa o pivô manual do Excel). Se não houver, cai p/ a aba já pivotada 'WOODCHIP DATA'.

Uso:  python update_gacc.py ["caminho/GACC ....xlsx"]
      PULP_DB=<caminho> p/ testar em cópia."""
import os, sys, sqlite3
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from extractor_pp import extract_gacc, extract_gacc_raw

_DEFAULT = str(Path(os.path.expanduser("~")) / "Downloads"
               / "GACC - China_Woodchips_Imports_Database.xlsx")
NEW = sys.argv[1] if len(sys.argv) > 1 else _DEFAULT
DB = Path(os.environ.get("PULP_DB") or (HERE / "pulp_paper.db"))

# 1) extrai (bruto preferido; pivô manual como reserva)
rows = extract_gacc_raw(NEW)
via = "GACC INPUT (bruto, pivotado em código)"
if not rows:
    rows = extract_gacc(NEW); via = "WOODCHIP DATA (pivô manual do Excel)"
if not rows:
    sys.exit("  ✗ Não extraí nenhuma linha do GACC (nem 'GACC INPUT' nem 'WOODCHIP DATA').")

cols = ["period", "year", "month", "fibre", "country", "volume_bdmt", "revenue_usd_mn"]
periods = sorted({r["period"] for r in rows})

con = sqlite3.connect(str(DB)); cur = con.cursor()
before = {t: cur.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0]
          for (t,) in cur.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()}
gacc_before = cur.execute("SELECT COUNT(*), MIN(period), MAX(period) FROM gacc_woodchips").fetchone()

# 2) substitui SÓ os períodos extraídos (preserva o resto da série)
cur.executemany("DELETE FROM gacc_woodchips WHERE period=?", [(p,) for p in periods])
cur.executemany(f"INSERT INTO gacc_woodchips ({','.join(cols)}) VALUES ({','.join('?'*len(cols))})",
                [[r.get(c) for c in cols] for r in rows])
con.commit()

gacc_after = cur.execute("SELECT COUNT(*), MIN(period), MAX(period) FROM gacc_woodchips").fetchone()
after = {t: cur.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0]
         for (t,) in cur.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()}
con.close()

print(f"Fonte: {via}")
print(f"gacc_woodchips: {gacc_before[0]} linhas ({gacc_before[1]}→{gacc_before[2]})  ->  "
      f"{gacc_after[0]} linhas ({gacc_after[1]}→{gacc_after[2]})")
print(f"  períodos atualizados: {periods[0]}→{periods[-1]} ({len(periods)} meses, {len(rows)} linhas)")
print("tabelas preservadas (antes -> depois):")
for t in sorted(after):
    if t != "gacc_woodchips":
        flag = "" if before.get(t) == after[t] else "  ⚠ MUDOU!"
        print(f"  {t:18s} {before.get(t, '?')} -> {after[t]}{flag}")
