# -*- coding: utf-8 -*-
"""Atualizacao CIRURGICA da tabela `empapel` na pulp_paper.db existente.
Re-extrai SO o Empapel (corrugated shipments) da planilha nova e substitui a tabela —
preserva iba_paper, iba_pulp, secex_pulp_port, gacc_woodchips, company_q, calendar.
Espelho do update_iba.py.  Uso: python update_empapel.py ["caminho/Empapel ....xlsx"]"""
import os, sys, sqlite3
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from extractor_pp import extract_empapel

_DEFAULT = str(Path(os.path.expanduser("~")) / "Downloads"
               / "Empapel - Brazilian Association of Corrugated Paper.xlsx")
NEW = sys.argv[1] if len(sys.argv) > 1 else _DEFAULT
DB = HERE / "pulp_paper.db"

empapel = extract_empapel(NEW)

cols = ["period TEXT", "year INT", "month INT", "shipments_kton REAL",
        "working_days REAL", "exp_per_day REAL", "ltm_shipments REAL"]
keys = [c.split()[0] for c in cols]

con = sqlite3.connect(str(DB)); cur = con.cursor()
before = {t: cur.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0]
          for (t,) in cur.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()}
cur.execute("DROP TABLE IF EXISTS empapel")
cur.execute(f"CREATE TABLE empapel ({', '.join(cols)})")
cur.executemany(f"INSERT INTO empapel VALUES ({','.join('?' * len(keys))})",
                [[r.get(k) for k in keys] for r in empapel])
con.commit()

n = cur.execute("SELECT COUNT(*) FROM empapel").fetchone()[0]
last = cur.execute("SELECT period, shipments_kton, working_days FROM empapel "
                   "ORDER BY period DESC LIMIT 4").fetchall()
after = {t: cur.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0]
         for (t,) in cur.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()}
con.close()

print(f"empapel: {n} linhas | ultimas 4: {last}")
print("tabelas preservadas (antes -> depois):")
for t in sorted(after):
    if t != "empapel":
        print(f"  {t:18s} {before.get(t, '?')} -> {after[t]}")
