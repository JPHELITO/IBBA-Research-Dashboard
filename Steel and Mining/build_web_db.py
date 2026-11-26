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

O NÚCLEO: steel_sm_core.db.gz (2026-11-26)
------------------------------------------
Pedido do usuário: a página de M&M "está demorando um pouco para carregar". Das ~6,7 MB do banco web,
~6,1 MB são da `secex_country` (274 mil linhas por país), que só o "Who" por país, o quadro "<país> share"
e as séries de país do Builder usam. Então sai também um NÚCLEO = o mesmo banco web SEM a `secex_country`
(~0,6 MB comprimido): a página abre a mesa com ele e baixa o banco web logo depois, em segundo plano, só
para os países ("Loading countries…" nesses pontos até ele chegar).
O banco web segue COMPLETO e igual: o hub do Itaú (news-hunter `hub_export/sectors.py`), a tela de
Reports, o "⤓ Data" e as ferramentas locais leem dele — nada muda para eles.
Os dois arquivos levam o MESMO carimbo (`PRAGMA user_version`, sorteado a cada rodada). Se alguém publicar
só o banco web (robô ou ferramenta com o código antigo), o núcleo fica de outra rodada: a página percebe
pelo carimbo e passa a usar o banco web para tudo (nunca mostra dado velho por causa do núcleo).
⚠️ Quem publica o banco web tem de publicar o núcleo junto (`git add` dos dois) — os 6 workflows,
`atualizar_prediction.py` e `publicar_base.py`; `tests/test_web_db_core.py` confere isso.

USO
---
    python "Steel and Mining/build_web_db.py"

Roda nos workflows logo depois dos robôs, antes do commit. Grava os dois arquivos só no fim, depois de
conferir os dois (tabelas, linhas, carimbo); qualquer falha = sai com erro e nenhum arquivo muda.
"""
import gzip
import os
import secrets
import shutil
import sqlite3
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).parent
SRC = HERE / "steel_sm.db"
OUT = HERE / "steel_sm_web.db.gz"
CORE_NAME = "steel_sm_core.db.gz"     # o núcleo mora ao lado do banco web (OUT.with_name), também nos testes
CORE_SKIP = ("secex_country",)        # o que o núcleo NÃO leva (os países descem depois, do banco web)

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
    # Reports (/reports.html, relatório HTML da SECEX): minério por produto e destino.
    # Pequena (~3 mil linhas); sem ela a tela de Reports baixa o banco completo (~42 MB).
    "secex_iron_ore",
    # Reports: minério exportado por PORTO (URF do MDIC), mesmo download do de cima. ~2 mil linhas.
    "secex_iron_ore_port",
]

# Da allowlist, as que PODEM faltar no banco sem derrubar o build. A tabela de porto nasce do
# robô do minério (update_iron_ore.py, só no update_secex.yml), mas este build roda também no
# IABr, INDA, Coreia, customs e uploads: se um banco sem ela chegasse a um desses (ex.: conflito
# de merge resolvido com o banco da main), o dado DELES deixaria de ser publicado por causa do
# minério. Faltando, a cópia web sai sem ela (aviso no log) e a tela de Reports cai no completo;
# o robô do minério recria e preenche a tabela na rodada seguinte.
OPCIONAIS = {"secex_iron_ore_port"}


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

    missing = [t for t in WEB_TABLES if t not in existing and t not in OPCIONAIS]
    if missing:
        print(f"ERRO: tabelas da allowlist não existem no banco: {missing}")
        return 1
    keep = [t for t in WEB_TABLES if t in existing]
    for t in WEB_TABLES:
        if t not in existing:
            print(f"::warning::{t} não existe no banco — a cópia web sai sem ela "
                  f"(o robô dela recria na próxima rodada)")

    work = Path(tempfile.mkdtemp(prefix="steel_sm_web_build_"))
    try:
        return _build_in(work, existing, keep)
    finally:
        shutil.rmtree(work, ignore_errors=True)


def _tables_and_rows(path):
    """{tabela: linhas} + carimbo (user_version) de um banco SQLite."""
    con = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    try:
        names = [r[0] for r in con.execute("SELECT name FROM sqlite_master WHERE type='table'")]
        rows = {t: con.execute(f'SELECT COUNT(*) FROM "{t}"').fetchone()[0] for t in names}
        stamp = con.execute("PRAGMA user_version").fetchone()[0]
    finally:
        con.close()
    return rows, stamp


def _build_in(work: Path, existing: set, keep: list) -> int:
    web_db, core_db = work / "web.db", work / "core.db"
    shutil.copy(SRC, web_db)

    db = sqlite3.connect(web_db)
    dropped = sorted(existing - set(keep))
    for t in dropped:
        db.execute(f'DROP TABLE IF EXISTS "{t}"')
    n_country = rebuild_secex_country(db)   # na ordem das consultas da página (ver docstring)
    db.commit()
    db.execute("VACUUM")          # devolve o espaço das tabelas removidas
    stamp = secrets.randbits(31) or 1       # carimbo desta rodada, igual nos dois arquivos (ver docstring)
    db.execute(f"PRAGMA user_version = {stamp}")
    db.commit()
    db.close()

    # o núcleo = o banco web sem os países (a mesma cópia, então as outras tabelas saem idênticas)
    shutil.copy(web_db, core_db)
    db = sqlite3.connect(core_db)
    for t in CORE_SKIP:
        db.execute(f'DROP TABLE IF EXISTS "{t}"')
    db.commit()
    db.execute("VACUUM")
    db.close()

    # a trava: os dois arquivos conferidos ANTES de substituir os publicados
    web_rows, web_stamp = _tables_and_rows(web_db)
    core_rows, core_stamp = _tables_and_rows(core_db)
    want_core = {t: n for t, n in web_rows.items() if t not in CORE_SKIP}
    problems = []
    if set(web_rows) != set(keep):
        problems.append(f"banco web com as tabelas {sorted(web_rows)}, esperadas {sorted(keep)}")
    if web_rows.get("secex_country") != n_country:
        problems.append(f"banco web com {web_rows.get('secex_country')} linhas em secex_country, eram {n_country}")
    if core_rows != want_core:
        problems.append(f"núcleo {core_rows} ≠ banco web sem os países {want_core}")
    if not (web_stamp == core_stamp == stamp):
        problems.append(f"carimbos diferentes: web {web_stamp}, núcleo {core_stamp}, rodada {stamp}")
    if problems:
        for p in problems:
            print(f"ERRO: {p}")
        return 1

    raw_web, raw_core = web_db.read_bytes(), core_db.read_bytes()
    out_core = OUT.with_name(CORE_NAME)
    # .tmp na MESMA pasta dos publicados: a troca final é um os.replace (atômico; nunca um arquivo pela metade)
    tmp_web, tmp_core = OUT.with_name(OUT.name + ".tmp"), out_core.with_name(CORE_NAME + ".tmp")
    try:
        tmp_web.write_bytes(gzip.compress(raw_web, 6))
        tmp_core.write_bytes(gzip.compress(raw_core, 6))
        for gz, raw in ((tmp_web, raw_web), (tmp_core, raw_core)):   # o .gz descomprime de volta no mesmo banco
            if gzip.decompress(gz.read_bytes()) != raw:
                print(f"ERRO: {gz.name} não descomprime de volta no banco gerado")
                return 1
        # banco web primeiro: se algo parar entre as duas trocas, fica web novo + núcleo velho, e a página
        # percebe pelo carimbo e usa o banco web (o contrário mostraria o núcleo novo com países velhos)
        os.replace(tmp_web, OUT)
        os.replace(tmp_core, out_core)
    finally:
        tmp_web.unlink(missing_ok=True)
        tmp_core.unlink(missing_ok=True)

    mb = lambda n: n / 1e6
    print(f"  completo   : {mb(SRC.stat().st_size):6.1f} MB  ({len(existing)} tabelas)")
    print(f"  só web     : {mb(len(raw_web)):6.1f} MB  ({len(keep)} tabelas)")
    print(f"  comprimido : {mb(OUT.stat().st_size):6.1f} MB  -> {OUT.name}")
    print(f"  núcleo     : {mb(out_core.stat().st_size):6.2f} MB  -> {out_core.name} (sem {', '.join(CORE_SKIP)})")
    print(f"  carimbo    : {stamp} (user_version, igual nos dois)")
    print(f"  removidas  : {', '.join(dropped) or '(nenhuma)'}")
    print(f"  secex_country refeita na ordem da página: {n_country} linhas, chave {COUNTRY_KEY}")
    return 0


if __name__ == "__main__":
    sys.exit(build())
