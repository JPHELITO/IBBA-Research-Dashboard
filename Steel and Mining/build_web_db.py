# -*- coding: utf-8 -*-
"""Gera a versão WEB do banco de Steel & Mining: steel_sm_web.db.gz

POR QUÊ
-------
O `steel_sm.db` completo tem ~47 MB. Dois problemas para o cliente:

1. Metade do arquivo são tabelas que a dashboard NUNCA lê (as quebras finas
   `secex_sh6_country` / `secex_sh6_urf`, usadas só pelo `updater_sm.py` e pelo
   console SQL do admin).
2. Um arquivo de 47 MB **não cabe no cache do navegador** (o Chrome limita cada
   entrada a uma fração do cache total) → ele é rebaixado TODA vez que alguém
   abre a página, por mais que os cabeçalhos mandem cachear. Medido: todos os
   outros arquivos da página vêm do cache (0 byte na rede); só o .db baixa
   inteiro de novo, sempre.

A versão web tem só as 11 tabelas que a página consulta e vai comprimida:
cai para ~10 MB — baixa ~4,5x mais rápido E passa a caber no cache, então da
segunda visita em diante não trafega quase nada.

O `steel_sm.db` completo continua existindo e sendo commitado como está — ele é
a fonte da verdade do `updater_sm.py` e do admin. Este script só deriva a cópia.

USO
---
    python "Steel and Mining/build_web_db.py"

Roda no workflow `update_secex.yml` logo depois do updater, antes do commit.
"""
import gzip
import shutil
import sqlite3
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).parent
SRC = HERE / "steel_sm.db"
OUT = HERE / "steel_sm_web.db.gz"

# ── Tabelas que o steel_sm_dashboard.html realmente consulta (allowlist) ───────
# Conferir com:  grep -o "FROM [a-z_]*" "Steel and Mining/steel_sm_dashboard.html" | sort -u
# ⚠️ Se a página passar a ler uma tabela nova, ADICIONE aqui — senão o gráfico
#    novo funciona no admin (que lê o .db completo) e quebra para o cliente.
WEB_TABLES = [
    "iabr_consumption",
    "iabr_domestic_sales",
    "iabr_exports",
    "iabr_imports",
    "iabr_production",
    "import_prediction",
    "inda_distribution",
    "pred_exports",
    "secex_country",
    "secex_exports",
    "secex_imports",
]


def build() -> int:
    if not SRC.exists():
        print(f"ERRO: não achei {SRC}")
        return 1

    with sqlite3.connect(f"file:{SRC}?mode=ro", uri=True) as ro:
        existing = {r[0] for r in ro.execute(
            "SELECT name FROM sqlite_master WHERE type='table'")}

    missing = [t for t in WEB_TABLES if t not in existing]
    if missing:
        print(f"ERRO: tabelas da allowlist não existem no banco: {missing}")
        return 1

    tmp = Path(tempfile.gettempdir()) / "steel_sm_web.build.db"
    tmp.unlink(missing_ok=True)
    shutil.copy(SRC, tmp)

    db = sqlite3.connect(tmp)
    dropped = sorted(existing - set(WEB_TABLES))
    for t in dropped:
        db.execute(f'DROP TABLE IF EXISTS "{t}"')
    db.commit()
    db.execute("VACUUM")          # devolve o espaço das tabelas removidas
    db.close()

    raw = tmp.read_bytes()
    OUT.write_bytes(gzip.compress(raw, 6))
    tmp.unlink(missing_ok=True)

    mb = lambda n: n / 1e6
    print(f"  completo   : {mb(SRC.stat().st_size):6.1f} MB  ({len(existing)} tabelas)")
    print(f"  só web     : {mb(len(raw)):6.1f} MB  ({len(WEB_TABLES)} tabelas)")
    print(f"  comprimido : {mb(OUT.stat().st_size):6.1f} MB  -> {OUT.name}")
    print(f"  removidas  : {', '.join(dropped) or '(nenhuma)'}")
    return 0


if __name__ == "__main__":
    sys.exit(build())
