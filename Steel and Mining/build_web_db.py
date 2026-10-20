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

SECEX_COUNTRY NA ORDEM DA PÁGINA (2026-10-20)
--------------------------------------------
No banco completo a chave de `secex_country` é (period, direction, category,
country). A página faz 30 consultas `WHERE direction=? AND category=? ORDER BY
period,country` — com a data na frente da chave, NENHUMA delas usa o índice: cada
uma lê as 274 mil linhas e reordena numa árvore temporária. Medido no navegador:
2,8 a 2,9 s de 3,9 a 5,6 s de abertura (13 a 16 s num computador 4x mais lento).
Aqui, só na cópia web, a tabela é refeita como WITHOUT ROWID com a chave
(direction, category, period, country): as mesmas linhas, as mesmas colunas, na
mesma ordem de colunas; cada consulta vira uma leitura em sequência já ordenada,
e o arquivo comprimido cai de ~10,2 para ~6,4 MB (some a tabela-sombra do rowid).
O resultado de cada consulta é idêntico (ORDER BY period,country é ordem total
dentro de direção+categoria, porque a chave é única). O banco completo não muda.

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


# chave da cópia web de secex_country: direção e categoria NA FRENTE (é o WHERE da página)
COUNTRY_KEY = ("direction", "category", "period", "country")


def rebuild_secex_country(db) -> int:
    """Refaz secex_country como WITHOUT ROWID com a chave COUNTRY_KEY. Copia as colunas
    que existirem (na mesma ordem e com o mesmo tipo), confere a contagem e devolve as linhas."""
    cols = db.execute('PRAGMA table_info("secex_country")').fetchall()   # cid, name, type, notnull, dflt, pk
    names = [c[1] for c in cols]
    missing = [k for k in COUNTRY_KEY if k not in names]
    if missing:
        raise SystemExit(f"ERRO: secex_country sem as colunas da chave: {missing}")
    before = db.execute("SELECT COUNT(*) FROM secex_country").fetchone()[0]
    defs = ", ".join(f'"{c[1]}" {c[2]}'.strip() for c in cols)
    key = ", ".join(f'"{k}"' for k in COUNTRY_KEY)
    lst = ", ".join(f'"{n}"' for n in names)
    db.execute(f'CREATE TABLE secex_country_web ({defs}, PRIMARY KEY ({key})) WITHOUT ROWID')
    db.execute(f'INSERT INTO secex_country_web ({lst}) SELECT {lst} FROM secex_country')
    after = db.execute("SELECT COUNT(*) FROM secex_country_web").fetchone()[0]
    if after != before:
        raise SystemExit(f"ERRO: secex_country refeita com {after} linhas, eram {before}")
    db.execute("DROP TABLE secex_country")
    db.execute("ALTER TABLE secex_country_web RENAME TO secex_country")
    return after


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
    n_country = rebuild_secex_country(db)   # na ordem das consultas da página (ver docstring)
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
    print(f"  secex_country refeita na ordem da página: {n_country} linhas, chave {COUNTRY_KEY}")
    return 0


if __name__ == "__main__":
    sys.exit(build())
