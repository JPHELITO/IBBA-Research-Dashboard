# -*- coding: utf-8 -*-
"""Atualização CIRÚRGICA da tabela iba_paper na pulp_paper.db existente.
Re-extrai só o IBÁ (paper) da planilha nova e substitui iba_paper — preserva
secex_pulp_port, gacc_woodchips, empapel, company_q, iba_pulp, calendar.
Tissue já vem consolidado em "other" pelo extract_iba (Others (+Tissue))."""
import os, sys, sqlite3
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from extractor_pp import extract_iba

# Caminho da planilha IBÁ: argv[1] OU padrão em ~/Downloads.
# Uso: python update_iba.py ["caminho/IBÁ ....xlsx"]
_DEFAULT = str(Path(os.path.expanduser("~")) / "Downloads" / "IBÁ - Brazilian Pulp & Paper Association.xlsx")
NEW = sys.argv[1] if len(sys.argv) > 1 else _DEFAULT
DB = HERE / "pulp_paper.db"

paper, _pulp = extract_iba(NEW)

GR = ["total", "packaging", "pw", "newsprint", "cardboard", "other"]  # sem tissue (consolidado)
paper_cols = (["period TEXT", "year INT", "month INT"]
    + [f"{p}_{g} REAL" for p in ("prod", "dom", "exp", "imp") for g in GR]
    + ["app_cons REAL", "exprev_total REAL", "exprev_latam REAL", "exprev_europe REAL",
       "exprev_namerica REAL", "exprev_africa REAL", "exprev_asia REAL", "exprev_china REAL"])
keys = [c.split()[0] for c in paper_cols]

con = sqlite3.connect(str(DB)); cur = con.cursor()
# tabelas preservadas (sanity antes)
before = {t: cur.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0]
          for (t,) in cur.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()}
cur.execute("DROP TABLE IF EXISTS iba_paper")
cur.execute(f"CREATE TABLE iba_paper ({', '.join(paper_cols)})")
cur.executemany(f"INSERT INTO iba_paper VALUES ({','.join('?'*len(keys))})",
                [[r.get(k) for k in keys] for r in paper])
con.commit()

n = cur.execute("SELECT COUNT(*) FROM iba_paper").fetchone()[0]
last = cur.execute("SELECT period,prod_total,prod_cardboard,prod_other FROM iba_paper ORDER BY period DESC LIMIT 1").fetchone()
after = {t: cur.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0]
         for (t,) in cur.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()}
con.close()

print(f"iba_paper: {n} linhas | última={last}")
print("tabelas preservadas (linhas antes→depois):")
for t in sorted(after):
    if t != "iba_paper":
        print(f"  {t:18s} {before.get(t,'?')} -> {after[t]}")
