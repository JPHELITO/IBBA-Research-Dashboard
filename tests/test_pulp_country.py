# -*- coding: utf-8 -*-
"""Testes da exportação de celulose POR PAÍS (update_pulp_secex.py → secex_pulp_country).

O que estes testes travam:
  1. os grupos de produto são os que o analista definiu (30/09/2026) e todo SH6 de celulose do
     dicionário cai em algum grupo — o que não tem botão vai para 'other', nunca some;
  2. a agregação por país e por porto sai do MESMO download e fecha no mesmo total;
  3. a janela de revisão grava só o que MUDOU (reescrever igual faria o robô commitar todo dia);
  4. linha que sumiu da fonte sai do banco — mas CSV cortado (>10% sumindo) não apaga nada.

Rodar:  python -m pytest tests/test_pulp_country.py -q
"""
import os
import sqlite3
import sys

import pandas as pd
import pytest

BASE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(BASE, "..", "Pulp and Paper"))
import update_pulp_secex as U  # noqa: E402


@pytest.fixture
def conn():
    c = sqlite3.connect(":memory:")
    c.execute("CREATE TABLE calendar (period TEXT, year INT, month INT, working_days INT)")
    U.ensure_country_table(c)
    return c


def _agg(rows):
    """[(period, country, product, kt, usd)] → formato de _aggregate (chave com ano/mês)."""
    return {(p, int(p[:4]), int(p[5:7]), c, pr): [kt, usd] for p, c, pr, kt, usd in rows}


def test_grupos_do_analista():
    assert U.PRODUCT_SH6["hardwood"] == {"470329", "470429"}
    assert U.PRODUCT_SH6["softwood"] == {"470321", "470421"}
    assert U.PRODUCT_SH6["ukp"] == {"470311", "470319", "470411", "470419"}
    assert U.PRODUCT_SH6["dissolving"] == {"470100", "470200"}
    assert U.product_of("470500") == "other"        # BCTMP saiu por decisão do analista
    assert U.product_of("470620") == "other"


def test_todo_sh6_do_dicionario_tem_grupo():
    grupos = {U.product_of(s) for s in U.PULP_SH6}
    assert grupos <= {"hardwood", "softwood", "ukp", "dissolving", "other"}
    # nenhum SH6 da lista do analista ficou fora do dicionário (senão o robô nem baixaria)
    for ss in U.PRODUCT_SH6.values():
        assert ss <= set(U.PULP_SH6)


def test_porto_e_pais_fecham_no_mesmo_total():
    df = pd.DataFrame([
        {"period": "2026-08", "sh6": "470329", "country": "China", "port": "Santos", "kg": 5e8, "usd": 2.5e8},
        {"period": "2026-08", "sh6": "470200", "country": "China", "port": "Vitoria", "kg": 1e8, "usd": 9e7},
        {"period": "2026-08", "sh6": "470500", "country": "Uruguay", "port": "Santos", "kg": 1e6, "usd": 5e5},
    ])
    by_port, by_country = U._aggregate(df)
    assert by_country[("2026-08", 2026, 8, "China", "hardwood")] == [500.0, 250.0]
    assert by_country[("2026-08", 2026, 8, "China", "dissolving")] == [100.0, 90.0]
    assert by_country[("2026-08", 2026, 8, "Uruguay", "other")] == [1.0, 0.5]
    assert sum(v[0] for v in by_port.values()) == sum(v[0] for v in by_country.values())


def test_janela_grava_so_o_que_mudou(conn):
    base = [("2026-07", "China", "hardwood", 900.0, 450.0), ("2026-07", "Italy", "hardwood", 150.0, 75.0)]
    assert U.sync_country(conn, _agg(base), {2026})[:3] == (2, 0, 0)
    # mesma fonte de novo → nada muda (o robô não pode commitar à toa)
    assert U.sync_country(conn, _agg(base), {2026})[:3] == (0, 0, 0)
    # revisão da China + mês novo
    rev = [("2026-07", "China", "hardwood", 880.0, 440.0), ("2026-07", "Italy", "hardwood", 150.0, 75.0),
           ("2026-08", "China", "hardwood", 950.0, 470.0)]
    novas, revisadas, removidas, tocados = U.sync_country(conn, _agg(rev), {2026})
    assert (novas, revisadas, removidas) == (1, 1, 0)
    assert tocados == {"2026-07", "2026-08"}
    assert conn.execute("SELECT volume_ktons FROM secex_pulp_country WHERE period='2026-07' "
                        "AND country='China'").fetchone()[0] == 880.0


def test_ano_fora_da_janela_nao_e_tocado(conn):
    U.sync_country(conn, _agg([("2024-05", "China", "hardwood", 800.0, 400.0)]), {2024})
    U.sync_country(conn, _agg([("2026-05", "China", "hardwood", 900.0, 450.0)]), {2026})
    assert conn.execute("SELECT COUNT(*) FROM secex_pulp_country").fetchone()[0] == 2


def test_linha_que_sumiu_sai_mas_csv_cortado_nao_apaga(conn):
    rows = [("2026-07", f"Pais{i}", "hardwood", 10.0, 5.0) for i in range(30)]
    U.sync_country(conn, _agg(rows), {2026})
    # 1 país sumiu (3%) → sai
    assert U.sync_country(conn, _agg(rows[1:]), {2026})[2] == 1
    # metade sumiu → parece download cortado: não apaga nada
    assert U.sync_country(conn, _agg(rows[1:15]), {2026})[2] == 0
    assert conn.execute("SELECT COUNT(*) FROM secex_pulp_country").fetchone()[0] == 29
