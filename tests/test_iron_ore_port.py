# -*- coding: utf-8 -*-
"""Testes do minério de ferro POR PORTO (update_iron_ore.py → secex_iron_ore_port) e da janela de
revisão que as duas tabelas de minério ganharam em 17/11/2026.

Contexto: o relatório da SECEX do analista quebra a exportação de minério por porto (São Luís,
Vitória, Itaguaí, Goytacazes/Açu, Others) e a base só tinha produto × país. E a tabela por país
congelava no 1º número divulgado pelo MDIC (3T26: 108.892 kt na base × 108.488 kt no MDIC).

O que estes testes travam:
  1. porto e país saem das MESMAS linhas e fecham no mesmo total (kg e US$ exatos), por mês e
     produto; importação não entra no porto; SH6 fora do minério e mês fora da janela rolante, não;
  2. a tabela nova tem exatamente as colunas pedidas, chave (period, product, port);
  3. a janela de revisão grava só o que MUDOU (reescrever igual faria o robô commitar todo dia),
     regrava a revisão do MDIC e tira linha que sumiu — mas CSV cortado (>10% sumindo) não apaga,
     e ano/direção que não baixou não é tocado;
  4. a conferência porto × país dá ZERO quando tudo vem do mesmo download e acusa quando não;
  5. o robô inteiro (main) faz a carga completa na 1ª rodada, não commita à toa na 2ª e pega a
     revisão na 3ª;
  6. o banco web leva a tabela, mas a falta dela não derruba o build dos OUTROS robôs;
  7. o alarme do dia 15 (update_secex.yml) confere o minério também;
  8. no banco de verdade do repositório, porto × país fecha com diferença zero em todo mês.

Rodar:  python -m pytest tests/test_iron_ore_port.py -q
"""
import gzip
import os
import sqlite3
import sys
from pathlib import Path

import pandas as pd
import pytest
import yaml

BASE = os.path.dirname(os.path.abspath(__file__))
SM = os.path.join(BASE, "..", "Steel and Mining")
sys.path.insert(0, SM)
import update_iron_ore as U  # noqa: E402
import build_web_db as B     # noqa: E402

PORTO = "secex_iron_ore_port"
PAIS = "secex_iron_ore"
ANO_FORA = int(U.RECENT_FROM[:4]) - 1          # ano que a janela rolante já não guarda


@pytest.fixture
def conn():
    c = sqlite3.connect(":memory:")
    U.ensure_tables(c)
    return c


def _df(rows):
    """Linhas no formato que mdic.download_mdic_year devolve."""
    return pd.DataFrame(rows, columns=["period", "ncm", "sh6", "country", "port", "kg", "usd"])


def _p(rows):
    """[(period, product, port, kt, usd_mn)] → live da tabela de porto."""
    return {(p, pr, po): (kt, usd) for p, pr, po, kt, usd in rows}


def _conta(c, tabela):
    return c.execute(f"SELECT COUNT(*) FROM {tabela}").fetchone()[0]


EXP_AGO = [
    ("2026-08", "26011100", "260111", "China", "São Luís", 4_000_000_123, 280_000_001),
    ("2026-08", "26011100", "260111", "China", "Itaguaí", 1_500_000_000, 100_000_000),
    ("2026-08", "26011100", "260111", "Malásia", "São Luís", 700_000_000, 49_000_000),
    ("2026-08", "26011210", "260112", "Japão", "Vitória", 300_000_457, 40_000_009),
    ("2026-08", "26011220", "260112", "Omã", "Campos Dos Goytacazes", 90_000_000, 11_000_000),
]


# ── 1. Um download, duas tabelas ────────────────────────────────────────────────
def test_porto_e_pais_saem_das_mesmas_linhas():
    df = _df(EXP_AGO + [
        ("2026-08", "72071100", "720711", "China", "Vitória", 9e8, 9e8),            # aço: fora
        (f"{ANO_FORA}-12", "26011100", "260111", "China", "São Luís", 1e9, 1e8),     # fora da janela
    ])
    c, p = U._aggregate(df, "exp")
    assert p[("2026-08", "Fines", "São Luís")] == [4_700_000_123, 329_000_001]
    assert p[("2026-08", "Pellets", "Campos Dos Goytacazes")] == [90_000_000, 11_000_000]
    assert c[("2026-08", "exp", "Fines", "China")] == [5_500_000_123, 380_000_001]
    assert {k[2] for k in c} == {k[1] for k in p} == {"Fines", "Pellets"}
    assert all(k[0] == "2026-08" for k in list(c) + list(p))
    for i in (0, 1):                                   # mesmo total em kg e em US$
        assert sum(v[i] for v in c.values()) == sum(v[i] for v in p.values())


def test_importacao_nao_entra_no_porto():
    c, p = U._aggregate(_df([("2026-08", "26011210", "260112", "Suécia", "Vitória", 5e7, 6e6)]), "imp")
    assert p == {}
    assert c == {("2026-08", "imp", "Pellets", "Suécia"): [5e7, 6e6]}


def test_kt_guardado_devolve_o_kg_e_o_dolar_exatos():
    kt, usd = U._em_kt({"k": [37_590_345_678.0, 2_395_028_123.0]})["k"]
    assert (round(kt * 1e6), round(usd * 1e6)) == (37_590_345_678, 2_395_028_123)


def test_mesmos_codigos_do_dicionario_nas_duas_tabelas():
    assert U.IRON_SH6 == {"260111", "260112"}
    assert (U._product("260111"), U._product("260112")) == ("Fines", "Pellets")


# ── 2. A tabela nova ────────────────────────────────────────────────────────────
def test_tabela_nova_tem_as_colunas_pedidas(conn):
    cols = conn.execute(f"PRAGMA table_info({PORTO})").fetchall()   # cid, nome, tipo, nn, dflt, pk
    assert [c[1] for c in cols] == ["period", "product", "port", "volume_ktons", "revenue_usd_mn"]
    assert [c[1] for c in sorted(cols, key=lambda c: c[5]) if c[5]] == ["period", "product", "port"]


# ── 3. Janela de revisão ────────────────────────────────────────────────────────
def test_janela_grava_so_o_que_mudou(conn):
    base = [("2026-07", "Fines", "São Luís", 13000.5, 800.25),
            ("2026-07", "Fines", "Itaguaí", 9000.0, 560.0)]
    assert U._sincroniza(conn, PORTO, _p(base), 2026)[:3] == (2, 0, 0)
    antes = conn.total_changes
    assert U._sincroniza(conn, PORTO, _p(base), 2026)[:3] == (0, 0, 0)
    assert conn.total_changes == antes            # igual: nem encosta (senão commit todo dia)
    rev = [("2026-07", "Fines", "São Luís", 12900.1, 795.0), base[1],
           ("2026-08", "Fines", "São Luís", 14000.0, 860.0)]
    n, r, s, meses = U._sincroniza(conn, PORTO, _p(rev), 2026)
    assert (n, r, s, meses) == (1, 1, 0, {"2026-07", "2026-08"})
    assert conn.execute(f"SELECT volume_ktons, revenue_usd_mn FROM {PORTO} WHERE period='2026-07' "
                        f"AND port='São Luís'").fetchone() == (12900.1, 795.0)
    assert _conta(conn, PORTO) == 3                # sem linha duplicada


def test_force_regrava_igual(conn):
    base = [("2026-07", "Fines", "Vitória", 8000.0, 500.0)]
    U._sincroniza(conn, PORTO, _p(base), 2026)
    antes = conn.total_changes
    U._sincroniza(conn, PORTO, _p(base), 2026, forcar=True)
    assert conn.total_changes > antes


def test_linha_que_sumiu_sai_mas_csv_cortado_nao_apaga(conn):
    rows = [("2026-07", "Fines", f"Porto{i}", 10.0, 1.0) for i in range(30)]
    U._sincroniza(conn, PORTO, _p(rows), 2026)
    assert U._sincroniza(conn, PORTO, _p(rows[1:]), 2026)[2] == 1      # 3% sumiu → sai
    assert U._sincroniza(conn, PORTO, _p(rows[1:15]), 2026)[2] == 0    # metade → CSV cortado
    assert _conta(conn, PORTO) == 29
    # na carga completa (--backfill) a fonte inteira é a verdade: aí apaga
    assert U._sincroniza(conn, PORTO, _p(rows[1:15]), 2026, apagar_em_massa=True)[2] == 15


def test_ano_fora_da_rodada_intocado(conn):
    U._sincroniza(conn, PORTO, _p([("2024-05", "Fines", "Vitória", 8000.0, 700.0)]), 2024)
    U._sincroniza(conn, PORTO, _p([("2026-05", "Fines", "Vitória", 9000.0, 650.0)]), 2026,
                  apagar_em_massa=True)
    assert _conta(conn, PORTO) == 2


def test_direcao_de_uma_rodada_nao_mexe_na_outra(conn):
    exp = {("2026-07", "exp", "Fines", "China"): (20000.0, 1300.0)}
    imp = {("2026-07", "imp", "Pellets", f"País{i}"): (5.0, 0.6) for i in range(20)}
    U._sincroniza(conn, PAIS, {**exp, **imp}, 2026, "exp")
    U._sincroniza(conn, PAIS, {**exp, **imp}, 2026, "imp")
    assert _conta(conn, PAIS) == 21
    # a rodada da exportação não olha (nem apaga) a importação
    assert U._sincroniza(conn, PAIS, exp, 2026, "exp")[:3] == (0, 0, 0)
    assert _conta(conn, PAIS) == 21
    # um país importador sumiu da fonte (5%) → sai só ele
    sem_um = dict(list(imp.items())[1:])
    assert U._sincroniza(conn, PAIS, sem_um, 2026, "imp")[2] == 1
    assert _conta(conn, PAIS) == 20


def test_reconcile_nao_grava(conn):
    n, r, s, _ = U._sincroniza(conn, PORTO, _p([("2026-07", "Fines", "Vitória", 1.0, 1.0)]), 2026,
                               dry_run=True)
    assert (n, r, s) == (1, 0, 0)
    assert _conta(conn, PORTO) == 0


def test_ano_que_nao_baixou_nao_e_apagado(conn):
    c25, p25 = U._aggregate(_df([("2025-03", "26011100", "260111", "China", "Vitória", 1e9, 1e8)]), "exp")
    U.sincroniza_tudo(conn, c25, p25, {(2025, "exp")})
    # rodada seguinte: só 2026 veio do MDIC — 2025 fica como estava, mesmo na carga completa
    c26, p26 = U._aggregate(_df(EXP_AGO), "exp")
    U.sincroniza_tudo(conn, c26, p26, {(2026, "exp")}, apagar_em_massa=True)
    assert conn.execute(f"SELECT COUNT(*) FROM {PORTO} WHERE period='2025-03'").fetchone()[0] == 1
    assert conn.execute(f"SELECT COUNT(*) FROM {PAIS} WHERE period='2025-03'").fetchone()[0] == 1


# ── 4. Conferência porto × país ─────────────────────────────────────────────────
def test_porto_x_pais_zero_do_mesmo_download_e_acusa_quando_nao(conn):
    c1, p1 = U._aggregate(_df(EXP_AGO), "exp")
    c2, _ = U._aggregate(_df([("2026-08", "26011210", "260112", "Suécia", "Vitória", 5e7, 6e6)]), "imp")
    resumo, meses = U.sincroniza_tudo(conn, {**c1, **c2}, p1, {(2026, "exp"), (2026, "imp")})
    assert meses == {PAIS: {"2026-08"}, PORTO: {"2026-08"}}
    # 4 células por país na exportação (China = São Luís + Itaguaí) + Suécia na importação;
    # 4 por porto (São Luís = China + Malásia)
    assert resumo == {PAIS: [5, 0, 0], PORTO: [4, 0, 0]}
    assert U.confere_porto_x_pais(conn) == (1, [])         # a importação não entra na conta
    conn.execute(f"UPDATE {PORTO} SET volume_ktons = volume_ktons + 0.001 WHERE port='Itaguaí'")
    n_meses, div = U.confere_porto_x_pais(conn)
    assert n_meses == 1 and len(div) == 1
    period, product, kg_porto, usd_porto, kg_pais, usd_pais = div[0]
    assert (period, product, kg_porto - kg_pais, usd_porto - usd_pais) == ("2026-08", "Fines", 1000, 0)


# ── 5. O robô inteiro (main), sem rede ──────────────────────────────────────────
@pytest.fixture
def robo(tmp_path, monkeypatch):
    """main() com o MDIC de mentira: `fonte[(ano, direção)]` = linhas do CSV daquele arquivo."""
    fonte = {}
    db, env = tmp_path / "steel_sm.db", tmp_path / "github_env"
    monkeypatch.setattr(U, "DB_PATH", db)
    monkeypatch.setenv("GITHUB_ENV", str(env))
    monkeypatch.setattr(U.time, "sleep", lambda s: None)
    monkeypatch.setattr(U.mdic, "fetch_pais_lookup", lambda: {})
    monkeypatch.setattr(U.mdic, "fetch_urf_lookup", lambda: {})
    monkeypatch.setattr(U.mdic, "download_mdic_year",
                        lambda ano, d, sh6, pais_map=None, port_map=None:
                        _df(fonte.get((ano, d), [])))

    def roda(*argv):
        env.write_text("")
        monkeypatch.setattr(sys, "argv", ["update_iron_ore.py", *argv])
        U.main()
        return dict(l.split("=", 1) for l in env.read_text().splitlines() if l)

    return roda, fonte, db


def test_robo_carga_completa_depois_so_o_que_muda(robo):
    roda, fonte, db = robo
    ano = int(U.RECENT_FROM[:4])
    fonte[(ano, "exp")] = [(f"{ano}-02", "26011100", "260111", "China", "Vitória", 2e9, 1.5e8)]
    fonte[(2026, "exp")] = EXP_AGO
    fonte[(2026, "imp")] = [("2026-08", "26011210", "260112", "Suécia", "Vitória", 5e7, 6e6)]

    # 1ª rodada: tabela de porto vazia → carga completa (histórico inteiro), não só a janela
    assert roda("--update")["IRON_NEW_DATA"] == "true"
    c = sqlite3.connect(db)
    assert c.execute(f"SELECT MIN(period), MAX(period) FROM {PORTO}").fetchone() == (f"{ano}-02", "2026-08")
    assert U.confere_porto_x_pais(c) == (2, [])
    c.close()

    # 2ª rodada, fonte igual: nada muda → o workflow não commita
    assert roda("--update")["IRON_NEW_DATA"] == "false"

    # 3ª rodada: o MDIC revisou agosto (Itaguaí −0,5 Mt) → regrava porto E país
    fonte[(2026, "exp")] = [r if r[4] != "Itaguaí" else (*r[:5], 1_000_000_000, 70_000_000)
                            for r in EXP_AGO]
    assert roda("--update")["IRON_NEW_DATA"] == "true"
    c = sqlite3.connect(db)
    assert c.execute(f"SELECT volume_ktons FROM {PORTO} WHERE port='Itaguaí'").fetchone()[0] == 1000.0
    assert c.execute(f"SELECT volume_ktons FROM {PAIS} WHERE direction='exp' AND period='2026-08' "
                     f"AND country='China'").fetchone()[0] == 5000.000123
    assert U.confere_porto_x_pais(c) == (2, [])
    c.close()


def test_robo_porto_vazio_com_pais_cheio_recarrega_sem_chamar_de_revisao(robo, capsys):
    """O caso da publicação: banco com a tabela por país e SEM o porto. A carga do porto não é
    revisão do MDIC — o log e o e-mail não podem dizer que 80 meses foram revisados."""
    roda, fonte, db = robo
    fonte[(2026, "exp")] = EXP_AGO
    roda("--update")
    c = sqlite3.connect(db)
    c.execute(f"DELETE FROM {PORTO}")
    c.commit()
    c.close()
    capsys.readouterr()
    assert roda("--update")["IRON_NEW_DATA"] == "true"
    log = capsys.readouterr().out
    assert "tabela nova, carregada de 2026-08 a 2026-08" in log
    assert "revisão do MDIC): —" in log
    c = sqlite3.connect(db)
    assert U.confere_porto_x_pais(c) == (1, [])
    c.close()


def test_robo_reconcile_sai_1_se_divergir_e_0_se_bate(robo):
    roda, fonte, db = robo
    fonte[(2026, "exp")] = EXP_AGO
    fonte[(2025, "exp")] = fonte[(2025, "imp")] = fonte[(2026, "imp")] = []
    roda("--backfill")
    with pytest.raises(SystemExit) as e:
        roda("--reconcile")
    assert e.value.code == 0
    fonte[(2026, "exp")] = EXP_AGO[:-1]                    # a fonte mudou e a base não
    with pytest.raises(SystemExit) as e:
        roda("--reconcile")
    assert e.value.code == 1


# ── 6. Banco web ────────────────────────────────────────────────────────────────
def _banco_minimo(path, com_porto=True, sem=()):
    c = sqlite3.connect(path)
    for t in B.WEB_TABLES:
        if t in sem or (t == PORTO and not com_porto):
            continue
        if t == "secex_country":
            c.execute("CREATE TABLE secex_country (period TEXT, direction TEXT, category TEXT, "
                      "country TEXT, volume_ktons REAL, revenue_usd_mn REAL, updated_at TEXT, "
                      "PRIMARY KEY (period, direction, category, country))")
            c.execute("INSERT INTO secex_country VALUES ('2026-01','imp','crc','China',1,1,'x')")
        else:
            c.execute(f'CREATE TABLE "{t}" (period TEXT, v REAL)')
    c.execute("CREATE TABLE secex_sh6_urf (period TEXT)")       # essa NÃO vai para a web
    c.commit()
    c.close()


def _tabelas_do_gz(gz):
    db = gz.with_name("lido.db")
    db.write_bytes(gzip.decompress(gz.read_bytes()))
    c = sqlite3.connect(db)
    nomes = {r[0] for r in c.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    c.close()
    return nomes


def test_porto_esta_na_lista_do_banco_web():
    assert PORTO in B.WEB_TABLES and PAIS in B.WEB_TABLES


@pytest.mark.parametrize("com_porto", [True, False])
def test_banco_web_leva_o_porto_e_nao_quebra_sem_ele(tmp_path, monkeypatch, com_porto):
    src, out = tmp_path / "steel_sm.db", tmp_path / "steel_sm_web.db.gz"
    _banco_minimo(src, com_porto=com_porto)
    monkeypatch.setattr(B, "SRC", src)
    monkeypatch.setattr(B, "OUT", out)
    assert B.build() == 0                     # sem o porto o IABr/INDA/Coreia seguem publicando
    nomes = _tabelas_do_gz(out)
    assert (PORTO in nomes) == com_porto
    assert PAIS in nomes and "secex_sh6_urf" not in nomes


def test_tabela_obrigatoria_faltando_ainda_barra(tmp_path, monkeypatch):
    src = tmp_path / "steel_sm.db"
    _banco_minimo(src, sem=("iabr_exports",))
    monkeypatch.setattr(B, "SRC", src)
    monkeypatch.setattr(B, "OUT", tmp_path / "web.db.gz")
    assert B.build() == 1


# ── 7. Workflow ─────────────────────────────────────────────────────────────────
def test_alarme_do_dia_15_confere_o_minerio_e_o_update_grava_os_dois():
    wf = yaml.safe_load(open(os.path.join(BASE, "..", ".github", "workflows", "update_secex.yml"),
                             encoding="utf-8"))
    passos = wf["jobs"]["reconcile"]["steps"]
    minerio = [s for s in passos if 'update_iron_ore.py" --reconcile' in str(s.get("run", ""))]
    assert len(minerio) == 1
    assert "!cancelled()" in str(minerio[0].get("if", ""))   # roda mesmo se a do aço acusar
    upd = " ".join(str(s.get("run", "")) for s in wf["jobs"]["update"]["steps"])
    assert 'update_iron_ore.py" --update' in upd


# ── 8. O banco de verdade ───────────────────────────────────────────────────────
def test_banco_real_porto_fecha_com_pais_em_todo_mes():
    real = Path(SM, "steel_sm.db").resolve()
    if not real.exists():
        pytest.skip("steel_sm.db não está no checkout")
    c = sqlite3.connect(real.as_uri() + "?mode=ro", uri=True)
    try:
        if not c.execute("SELECT 1 FROM sqlite_master WHERE name=?", (PORTO,)).fetchone():
            pytest.skip("banco sem a tabela de porto (o robô cria e preenche na próxima rodada)")
        meses, div = U.confere_porto_x_pais(c)
        assert meses >= 60, f"histórico curto: {meses} meses"          # ~5 anos ou mais
        assert div == [], f"porto × país não fecha: {div[:5]}"
    finally:
        c.close()
