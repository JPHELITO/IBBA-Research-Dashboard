# -*- coding: utf-8 -*-
"""Robô dos EUA (Steel › US market): as contas e leituras que não dependem de rede.

Rodar:  python -m pytest tests/test_us_steel.py -q
"""
import datetime as dt
import json
import os
import sys

import pandas as pd
import pytest

AQUI = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(AQUI, "..", "Steel and Mining"))

import update_us_steel as U  # noqa: E402
import us_steel_fontes as F  # noqa: E402


def test_meses_ate_atravessa_o_ano():
    assert U._meses_ate("2026-02", 3) == ["2025-12", "2026-01", "2026-02"]
    assert U._mes_passado(dt.date(2026, 1, 15)) == "2025-12"
    assert U._mes_passado(dt.date(2026, 11, 25)) == "2026-10"


def test_numero_estavel_no_arquivo():
    assert U._r(7500.0) == 7500 and isinstance(U._r(7500.0), int)
    assert U._r(1509331.0144) == 1509331.0
    assert U._r(79.80024, 4) == 79.8002


def _ft900a(linhas):
    return pd.DataFrame(linhas, columns=["pais_norm", "grupo_cod", "tipo_aco", "metric_tons", "valor_usd", "is_agregado"])


def test_importacao_soma_os_tipos_de_aco_e_traduz_o_pais():
    df = _ft900a([
        ["Korea, South", "31", "C", 100.0, 70000.0, False],
        ["Korea, South", "31", "A", 20.5, 30000.0, False],
        ["Brazil", "1B", "C", 5000.0, 2.5e6, False],
        ["Brazil", "", "C", 1.0, 900.0, False],          # produto em branco → "ND"
        ["Canada", "32", "S", 0.0, 0.0, False],          # linha zerada some
        ["Total", "31", "C", 99999.0, 1.0, True],        # agregado nunca entra
    ])
    rows = U.linhas_importacao(df)
    assert ["South Korea", "31", 120.5, 100000] in rows
    assert ["Brazil", "1B", 5000, 2500000] in rows
    assert ["Brazil", "ND", 1, 900] in rows
    assert not [r for r in rows if r[0] in ("Canada", "Total")]


def test_todo_grupo_tem_familia_conhecida():
    fams = {v[1] for v in U.GRUPOS.values()}
    assert fams <= {"semi", "flat", "long", "pipe", "other"}
    assert U.GRUPOS["1A"][1] == U.GRUPOS["1B"][1] == "semi"


def test_arquivo_sempre_igual_para_o_mesmo_dado(tmp_path, monkeypatch):
    monkeypatch.setattr(U, "ARQ", str(tmp_path / "us_steel.json"))
    J = U.vazio()
    J["imp"]["2026-09"] = [["Mexico", "31", 10, 5], ["Brazil", "1B", 20, 8]]
    J["m"]["crude"]["2026-10"] = 7500
    J["w"] = [["2026-11-21", 1886000, 81.7]]
    assert U.escrever(J) is True
    assert U.escrever(json.loads(open(U.ARQ, encoding="utf-8").read())) is False   # nada mudou = nada a commitar
    lido = json.load(open(U.ARQ, encoding="utf-8"))
    assert lido["imp"]["2026-09"][0][0] == "Brazil"                              # linhas em ordem fixa
    assert lido["asof"] == {"crude": "2026-10", "exports": None, "imports": "2026-09", "ipraw": None,
                            "shipments": None, "util": None, "weekly": "2026-11-21"}


def test_embarques_vale_a_publicacao_mais_recente():
    def post(data, texto):
        return {"date": data + "T10:00:00", "content": {"rendered": "<p>" + texto + "</p>"}}
    posts = [
        post("2026-10-07", "For the month of August 2026, U.S. steel mills shipped 7,457,561 net tons, a 2.1 percent increase "
                           "from the 7,300,000 net tons shipped in the previous month, July 2026, and a 3.0 percent increase "
                           "from the 7,240,000 net tons shipped in August 2025."),
        post("2026-11-05", "For the month of September 2026, U.S. steel mills shipped 7,300,666 net tons, a 2.1 percent decrease "
                           "from the 7,460,000 net tons shipped in the previous month, August 2026, and a 0.2 percent increase "
                           "from the 7,286,994 net tons shipped in September 2025."),
    ]
    e = F.embarques(posts)
    assert e["2026-09"] == (7300666.0, "2026-11-05")
    assert e["2026-08"] == (7460000.0, "2026-11-05")      # revisado pelo release seguinte
    assert e["2026-07"] == (7300000.0, "2026-10-07")


@pytest.mark.parametrize("frase,mt", [
    ("The United States is estimated to have produced 7.5 Mt, up 8.4%.", 7.5),
    ("The United States produced 6.9 Mt, up 2.1%.", 6.9),
    ("The US produced 6.7 Mt, down 1.0%.", 6.7),
])
def test_frase_da_worldsteel(frase, mt):
    m = F.RE_WS_EUA.search(frase)
    assert m and float(m.group(1)) == mt


def test_tonelada_da_linha_da_api():
    cab = ["E_COMMODITY", "ALL_VAL_MO", "QTY_1_MO", "UNIT_QY1", "time"]
    assert F._toneladas(["7208390030", "100", "2500", "KG", "2026-09"], cab) == 2.5
    assert F._toneladas(["7204490000", "100", "12", "T", "2026-09"], cab) == 12.0
    assert F._toneladas(["7311000030", "100", "40", "NO", "2026-09"], cab) is None


def test_resumo_do_commit_junta_meses_da_mesma_serie():
    assert U._compactar(["importação 2026-08", "importação 2026-09", "aço bruto 2026-10"]) == \
        ["importação 2026-08..2026-09 (2)", "aço bruto 2026-10"]
