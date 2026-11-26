# -*- coding: utf-8 -*-
"""O NÚCLEO do banco web de M&M (steel_sm_core.db.gz, 26/11/2026) — o porquê está na docstring de
`Steel and Mining/build_web_db.py`.

Pedido do usuário: a página de M&M demora a carregar. O banco web tem ~6,7 MB, dos quais ~6,1 MB são a
`secex_country` (por país). O build passa a gravar também um núcleo (~0,6 MB) = o banco web SEM ela; a
página abre com o núcleo e busca os países no banco web depois. O banco web segue completo e igual (o hub
do Itaú, o Reports e o "⤓ Data" leem dele).

O que estes testes travam:
  1. o build grava os DOIS arquivos: o banco web com todas as tabelas e o núcleo = o banco web sem a
     `secex_country`, com as outras tabelas IDÊNTICAS e o MESMO carimbo (PRAGMA user_version);
  2. cada rodada sorteia um carimbo novo (é ele que denuncia, na página, um núcleo de outra rodada);
  3. build que falha não mexe em NENHUM dos dois arquivos publicados, e não deixa .tmp para trás;
  4. todo workflow que roda o build faz `git add` dos dois arquivos — idem as duas ferramentas locais que
     publicam o banco (`atualizar_prediction.py`, `publicar_base.py`); senão o núcleo fica velho;
  5. a página de M&M abre com o núcleo e busca os países no banco web (os nomes batem com o build).

Rodar:  python -m pytest tests/test_web_db_core.py -q
"""
import gzip
import importlib.util
import os
import re
import sqlite3
import sys
from pathlib import Path

import pytest
import yaml

BASE = Path(__file__).resolve().parent
REPO = BASE.parent
SM = REPO / "Steel and Mining"
sys.path.insert(0, str(SM))
import build_web_db as B  # noqa: E402

WEB, CORE = "steel_sm_web.db.gz", B.CORE_NAME


def _banco(path, sem=()):
    """Banco-fonte mínimo com todas as tabelas da allowlist (+ uma que não vai para a web)."""
    c = sqlite3.connect(path)
    for t in B.WEB_TABLES:
        if t in sem:
            continue
        if t == "secex_country":
            c.execute("CREATE TABLE secex_country (period TEXT, direction TEXT, category TEXT, country TEXT, "
                      "volume_ktons REAL, revenue_usd_mn REAL, updated_at TEXT, "
                      "PRIMARY KEY (period, direction, category, country))")
            c.executemany("INSERT INTO secex_country VALUES (?,?,?,?,?,?,?)",
                          [("2026-0%d" % m, d, k, p, m * 1.5, m * 2.0, "x")
                           for m in (1, 2, 3) for d in ("imp", "exp") for k in ("flat", "hrc")
                           for p in ("China", "Coreia do Sul")])
        else:
            c.execute(f'CREATE TABLE "{t}" (period TEXT, v REAL)')
            c.executemany(f'INSERT INTO "{t}" VALUES (?,?)', [("2026-01", 1.0), ("2026-02", 2.5)])
    c.execute("CREATE TABLE secex_sh6_urf (period TEXT)")        # essa NÃO vai para a web
    c.commit()
    c.close()


def _abre(gz: Path, tmp: Path):
    db = tmp / (gz.name + ".lido.db")
    db.write_bytes(gzip.decompress(gz.read_bytes()))
    return sqlite3.connect(db)


def _tabelas(con):
    return sorted(r[0] for r in con.execute("SELECT name FROM sqlite_master WHERE type='table'"))


def _linhas(con, t):
    cols = [r[1] for r in con.execute(f'PRAGMA table_info("{t}")')]
    return con.execute(f'SELECT * FROM "{t}" ORDER BY ' + ",".join(f'"{x}"' for x in cols)).fetchall()


@pytest.fixture
def rodada(tmp_path, monkeypatch):
    src, out = tmp_path / "steel_sm.db", tmp_path / WEB
    _banco(src)
    monkeypatch.setattr(B, "SRC", src)
    monkeypatch.setattr(B, "OUT", out)
    return tmp_path


# ── 1. os dois arquivos ─────────────────────────────────────────────────────────
def test_build_grava_o_banco_web_completo_e_o_nucleo_sem_os_paises(rodada):
    assert B.build() == 0
    web, core = _abre(rodada / WEB, rodada), _abre(rodada / CORE, rodada)
    assert _tabelas(web) == sorted(B.WEB_TABLES)                     # o banco web segue com tudo
    assert "secex_country" not in _tabelas(core)
    assert _tabelas(core) == sorted(t for t in B.WEB_TABLES if t not in B.CORE_SKIP)
    for t in _tabelas(core):                                          # as outras tabelas: idênticas
        assert _linhas(core, t) == _linhas(web, t), t
    assert len(_linhas(web, "secex_country")) == 24
    s_web = web.execute("PRAGMA user_version").fetchone()[0]
    s_core = core.execute("PRAGMA user_version").fetchone()[0]
    assert s_web == s_core != 0                                       # o mesmo carimbo, nunca o 0 de antes
    # a secex_country do banco web continua na ordem da página (WITHOUT ROWID, direção e categoria na frente)
    sql = web.execute("SELECT sql FROM sqlite_master WHERE name='secex_country'").fetchone()[0]
    assert "WITHOUT ROWID" in sql and 'PRIMARY KEY ("direction", "category", "period", "country")' in sql


def test_cada_rodada_tem_um_carimbo_novo(rodada):
    vistos = set()
    for _ in range(3):
        assert B.build() == 0
        a = _abre(rodada / WEB, rodada).execute("PRAGMA user_version").fetchone()[0]
        b = _abre(rodada / CORE, rodada).execute("PRAGMA user_version").fetchone()[0]
        assert a == b
        vistos.add(a)
    assert len(vistos) == 3


# ── 2. falhou = nada muda ───────────────────────────────────────────────────────
def test_build_que_falha_nao_mexe_em_nenhum_dos_dois(tmp_path, monkeypatch):
    src = tmp_path / "steel_sm.db"
    _banco(src, sem=("iabr_exports",))                                # tabela obrigatória faltando
    out, core = tmp_path / WEB, tmp_path / CORE
    out.write_bytes(b"publicado-web")
    core.write_bytes(b"publicado-nucleo")
    monkeypatch.setattr(B, "SRC", src)
    monkeypatch.setattr(B, "OUT", out)
    assert B.build() == 1
    assert out.read_bytes() == b"publicado-web" and core.read_bytes() == b"publicado-nucleo"
    assert not list(tmp_path.glob("*.tmp"))


@pytest.mark.parametrize("defeito", ["tabela_a_menos", "linhas_a_menos", "carimbo_outro"])
def test_conferencia_final_barra_nucleo_diferente_do_banco_web(rodada, monkeypatch, defeito):
    """Se o núcleo saísse diferente do banco web (tabela, linhas ou carimbo), nada é publicado."""
    (rodada / WEB).write_bytes(b"publicado-web")
    real = B._tables_and_rows

    def nucleo_com_defeito(path):
        rows, stamp = real(path)
        if Path(path).name == "core.db":
            if defeito == "tabela_a_menos":
                rows.pop("iabr_exports")
            elif defeito == "linhas_a_menos":
                rows["iabr_exports"] -= 1
            else:
                stamp += 1
        return rows, stamp
    monkeypatch.setattr(B, "_tables_and_rows", nucleo_com_defeito)
    assert B.build() == 1
    assert (rodada / WEB).read_bytes() == b"publicado-web"
    assert not (rodada / CORE).exists()
    assert not list(rodada.glob("*.tmp"))


# ── 3. quem publica o banco web publica o núcleo junto ──────────────────────────
def _workflows():
    for p in sorted((REPO / ".github" / "workflows").glob("*.yml")):
        yield p, yaml.safe_load(p.read_text(encoding="utf-8"))


def _runs(wf):
    for job in (wf.get("jobs") or {}).values():
        for s in job.get("steps") or []:
            if s.get("run"):
                yield s["run"]


def test_todo_workflow_que_roda_o_build_commita_os_dois_arquivos():
    achados = 0
    for p, wf in _workflows():
        runs = list(_runs(wf))
        if not any("build_web_db.py" in r for r in runs):
            continue
        achados += 1
        adds = [r for r in runs if "git add" in r and WEB in r]
        assert adds, f"{p.name}: roda o build mas não faz git add do {WEB}"
        for r in adds:
            assert CORE in r, f"{p.name}: faz git add do banco web sem o núcleo ({CORE})"
    assert achados == 6                    # secex, iabr, inda, korea, customs, uploads


def test_ferramentas_locais_publicam_o_nucleo_junto():
    txt = (REPO / "atualizar_prediction.py").read_text(encoding="utf-8")
    arqs = re.search(r"arqs = \[(.*?)\]", txt, re.S).group(1)
    assert WEB in arqs and CORE in arqs
    spec = importlib.util.spec_from_file_location("publicar_base", REPO / "publicar_base.py")
    P = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(P)
    for nome, base in P.BASES.items():
        pub = base.get("publicar", [])
        if any(x.endswith(WEB) for x in pub):
            assert any(x.endswith(CORE) for x in pub), f"publicar_base.py ({nome}): banco web sem o núcleo"


# ── 4. a página usa os dois nomes ───────────────────────────────────────────────
def test_pagina_abre_com_o_nucleo_e_busca_os_paises_no_banco_web():
    html = (SM / "steel_sm_dashboard.html").read_text(encoding="utf-8")
    assert f"fetch('{CORE}'" in html and f"fetch('{WEB}'" in html
    assert "PRAGMA user_version" in html                             # a conferência do carimbo
