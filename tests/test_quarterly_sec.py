# -*- coding: utf-8 -*-
"""Testes do robô da SEC (_shared/quarterly_sec.py) — Southern Copper.

Fixtures = dado REAL e público da SEC: o companyfacts da SCCO recortado nas contas que o robô lê (receita
desde 2016, o resto desde 2024) e o começo da lista de arquivamentos. Nenhum teste toca a rede.

Rodar:  python -m pytest tests/test_quarterly_sec.py -q
"""
import datetime as dt
import json
import os
import sys

import pytest

BASE = os.path.dirname(os.path.abspath(__file__))
FIX = os.path.join(BASE, "fixtures")
sys.path.insert(0, os.path.join(BASE, "..", "_shared"))
import quarterly_sec as s  # noqa: E402


def _json(nome: str) -> dict:
    p = os.path.join(FIX, nome)
    if not os.path.exists(p):
        pytest.skip(f"fixture ausente: {nome}")
    with open(p, encoding="utf-8") as f:
        return json.load(f)


@pytest.fixture(scope="module")
def facts():
    return _json("sec_scco_companyfacts.json")


@pytest.fixture(scope="module")
def linhas(facts):
    return {r["quarter"]: r for r in s.montar(facts, "SCCO")}


# ───────────────────────── o trimestre ───────────────────────────────────────

def test_trimestre_isolado_publicado(linhas):
    """2T26: o 10-Q de 31/07/2026 traz a janela de 3 meses — o número vem direto."""
    r = linhas["2026Q2"]
    assert r["company"] == "SCCO" and r["period_end"] == "2026-06-30" and r["source"] == "SEC"
    assert r["currency"] == "USD" and r["scale"] == "MIL"
    assert r["net_revenue"] == 4_289_000             # US$ 4.289,0 mi — a receita do release
    assert r["ebit"] == 2_623_200 and r["d_a"] == 226_000
    assert r["ebitda"] == 2_849_200                  # contábil: EBIT + D&A, como na CVM
    assert r["ocf"] == 1_988_500 and r["capex"] == 422_800


def test_lucro_e_o_do_acionista_da_scc(linhas):
    """No 10-Q só há o lucro com os minoritários e a parcela deles: 1.674,6 − 4,6."""
    assert linhas["2026Q2"]["net_income"] == pytest.approx(1_670_000)


def test_quarto_trimestre_e_o_ano_menos_nove_meses(linhas):
    """Não existe 10-Q do 4º trimestre: é o 10-K menos o acumulado do 3º 10-Q."""
    r = linhas["2025Q4"]
    assert r["net_revenue"] == pytest.approx(13_420_000 - 9_550_200)
    # o lucro do ano vem pronto (NetIncomeLoss do 10-K); o de nove meses é feito (ProfitLoss − minoritários)
    assert r["net_income"] == pytest.approx(4_334_900 - (3_036_700 - 9_700))
    assert r["ocf"] == pytest.approx(4_752_100 - 3_257_800)
    assert r["capex"] == pytest.approx(1_325_300 - 902_700)
    assert r["d_a"] == pytest.approx(868_400 - 637_700)


def test_caixa_e_divida(linhas):
    r = linhas["2026Q2"]
    assert r["cash"] == pytest.approx(5_665_000 + 1_664_900)    # caixa + aplicações (= 1.01.01 + 1.01.02 da CVM)
    assert r["debt"] == pytest.approx(7_994_400)                # sem parcela de curto prazo em jun/26
    assert r["net_debt"] == pytest.approx(7_994_400 - 7_329_900)
    # dez/24 tinha US$ 500 mi vencendo em 2025: longo + curto = o LongTermDebt total do 10-K (6.258,3)
    assert linhas["2024Q4"]["debt"] == pytest.approx(6_258_300)


def test_acoes(linhas):
    r = linhas["2026Q2"]
    assert r["shares_total"] == 884_600_000          # emitidas, no fim do trimestre
    assert r["shares_out"] == 834_331_706            # a capa do próprio 10-Q (30/07/2026)
    assert r["shares_treasury"] is None              # seria a conta de duas datas
    assert linhas["2025Q4"]["shares_out"] == 819_103_082    # a capa do 10-K


def test_custo_e_lucro_bruto_ficam_vazios(linhas):
    """O custo da SCCO exclui a depreciação e o 3.02 da CVM inclui: mesma coluna, definições diferentes."""
    assert all(r["cogs"] is None and r["gross_profit"] is None for r in linhas.values())


def test_mesmas_colunas_do_robo_da_cvm(linhas):
    colunas = {"company", "quarter", "period_end", "net_revenue", "cogs", "gross_profit", "ebit", "d_a", "ebitda",
               "net_income", "ocf", "capex", "cash", "debt", "net_debt", "currency", "scale", "source",
               "shares_total", "shares_treasury", "shares_out"}
    assert linhas and all(set(r) == colunas for r in linhas.values())


def test_receita_atravessa_a_troca_de_nome_da_conta(linhas):
    """Até 2017 a SCCO usou Revenues e RevenueMineralSales (do 3T15 ao 4T16, só a segunda); depois,
    RevenueFromContract… — a série não pode ter buraco em nenhuma das trocas."""
    for tri in ("2016Q1", "2016Q2", "2016Q4", "2017Q1", "2017Q4", "2018Q1", "2020Q2"):
        assert (linhas.get(tri) or {}).get("net_revenue", 0) > 0, tri
    assert linhas["2016Q3"]["net_revenue"] == pytest.approx(1_400_700)


def test_arquivamento_de_anos_depois_nao_vence(linhas):
    """⚠️ Medido: um 10-Q de 2020 traz o 3T18 com receita de 1.753,4; o original e três arquivamentos
    seguintes dizem 1.723,7 (= 5.402,1 − 3.678,4). "O mais recente vence" puro publicaria o errado."""
    assert linhas["2018Q3"]["net_revenue"] == pytest.approx(1_723_700)


# ───────────────────────── as regras, isoladas ───────────────────────────────

def test_ultimo_arquivamento_vence_na_mesma_janela():
    fatos = {"facts": {"us-gaap": {"OperatingIncomeLoss": {"units": {"USD": [
        {"start": "2025-04-01", "end": "2025-06-30", "val": 100, "form": "10-Q", "filed": "2025-07-31"},
        {"start": "2025-04-01", "end": "2025-06-30", "val": 90, "form": "10-Q", "filed": "2026-07-31"},  # reapresentado
        {"start": "2025-04-01", "end": "2025-06-30", "val": 999, "form": "8-K", "filed": "2026-08-01"},  # pro forma
    ]}}}}}
    assert s._janelas(s._fatos(fatos, "OperatingIncomeLoss"))[("2025-04-01", "2025-06-30")] == 90


def test_arquivamento_do_ano_seguinte_vence_o_de_anos_depois():
    fatos = {"facts": {"us-gaap": {"OperatingIncomeLoss": {"units": {"USD": [
        {"start": "2018-07-01", "end": "2018-09-30", "val": 10, "form": "10-Q", "fy": 2018, "filed": "2018-10-31"},
        {"start": "2018-07-01", "end": "2018-09-30", "val": 11, "form": "10-K", "fy": 2019, "filed": "2020-02-28"},
        {"start": "2018-07-01", "end": "2018-09-30", "val": 99, "form": "10-Q", "fy": 2020, "filed": "2020-05-04"},
        {"start": "2016-01-01", "end": "2016-12-31", "val": 7, "form": "10-K", "fy": 2018, "filed": "2019-03-01"},
    ]}}}}}
    jan = s._janelas(s._fatos(fatos, "OperatingIncomeLoss"))
    assert jan[("2018-07-01", "2018-09-30")] == 11          # a comparação do ano seguinte, sim; a de 2020, não
    assert jan[("2016-01-01", "2016-12-31")] == 7           # sem outro arquivamento, o de anos depois serve


def test_trimestre_sem_as_duas_janelas_nao_e_inventado():
    jan = {("2026-01-01", "2026-06-30"): 500.0}
    assert s.fluxo(jan, 2026, 2) is None             # semestre sem o 1º trimestre: fica vazio
    jan[("2026-01-01", "2026-03-31")] = 200.0
    assert s.fluxo(jan, 2026, 2) == 300.0 and s.fluxo(jan, 2026, 1) == 200.0
    jan[("2026-04-01", "2026-06-30")] = 310.0        # a janela de 3 meses publicada vence a conta
    assert s.fluxo(jan, 2026, 2) == 310.0


def test_acoes_emitidas_em_milhares_no_xbrl_antigo():
    """Os 10-K de 2013 a 2015 declaram as ações emitidas em milhares (884.596). A escala sai contra a capa.
    (Números da capa e da receita aqui são ilustrativos.)"""
    fatos = {"facts": {
        "us-gaap": {
            "Revenues": {"units": {"USD": [
                {"start": "2013-10-01", "end": "2013-12-31", "val": 1_535_200_000, "form": "10-K", "fy": 2013,
                 "filed": "2014-02-27"}]}},
            "CommonStockSharesIssued": {"units": {"shares": [
                {"end": "2013-12-31", "val": 884_596, "form": "10-K", "fy": 2013, "filed": "2014-02-27"}]}}},
        "dei": {"EntityCommonStockSharesOutstanding": {"units": {"shares": [
            {"end": "2014-02-20", "val": 773_000_000, "form": "10-K", "fy": 2013, "fp": "FY", "filed": "2014-02-27"}]}}}}}
    r = {l["quarter"]: l for l in s.montar(fatos, "SCCO")}["2013Q4"]
    assert r["net_revenue"] == pytest.approx(1_535_200)
    assert r["shares_total"] == 884_596_000 and r["shares_out"] == 773_000_000


def test_conta_nova_vence_a_antiga_na_mesma_janela():
    def fato(ini, fim, val, filed):
        return {"start": ini, "end": fim, "val": val, "form": "10-K", "filed": filed}
    fatos = {"facts": {"us-gaap": {
        "Revenues": {"units": {"USD": [fato("2017-01-01", "2017-12-31", 10, "2018-03-01"),
                                       fato("2016-01-01", "2016-12-31", 7, "2017-03-01")]}},
        "RevenueFromContractWithCustomerExcludingAssessedTax": {"units": {"USD": [
            fato("2017-01-01", "2017-12-31", 11, "2019-03-01")]}}}}}
    jan = s._uniao(fatos, s.RECEITA)
    assert jan[("2017-01-01", "2017-12-31")] == 11 and jan[("2016-01-01", "2016-12-31")] == 7


# ───────────────────────── gatilho ───────────────────────────────────────────

def test_gatilho_e_o_ultimo_10q(monkeypatch):
    lista = s.arquivamentos(_json("sec_scco_submissions.json"))
    ult = lista[-1]
    assert ult["form"] == "10-Q" and ult["report"] == "2026-06-30" and ult["filed"] == "2026-07-31"
    assert s.recebidos(lista, "SCCO")[("SCCO", "2026Q2")] == dt.date(2026, 7, 31)
    monkeypatch.setattr(s, "rest_get", lambda path, params="": [{"updated_at": "2026-08-01T00:00:00+00:00"}])
    assert s.ha_novidade(ult, "SCCO") is False       # gravamos depois do 10-Q
    monkeypatch.setattr(s, "rest_get", lambda path, params="": [{"updated_at": "2026-07-30T00:00:00+00:00"}])
    assert s.ha_novidade(ult, "SCCO") is True
    monkeypatch.setattr(s, "rest_get", lambda path, params="": [])
    assert s.ha_novidade(ult, "SCCO") is True        # a SCCO ainda não está na tabela: primeira carga


def test_nao_grava_antes_de_o_companyfacts_ter_o_trimestre(linhas):
    """A lista de arquivamentos anda antes do companyfacts. Gravar sem o trimestre novo avançaria o
    updated_at, e o gatilho só voltaria a disparar no 10-Q seguinte — três meses depois."""
    rows = list(linhas.values())
    assert s.pronto(rows, {"form": "10-Q", "report": "2026-06-30"}) is True
    assert s.pronto(rows, {"form": "10-Q", "report": "2026-09-30"}) is False
    assert s.pronto(rows, None) is True


def test_emenda_nao_e_a_data_da_entrega():
    lista = [{"form": "10-Q", "filed": "2026-07-31", "report": "2026-06-30", "accepted": "a", "accession": "1"},
             {"form": "10-Q/A", "filed": "2026-08-20", "report": "2026-06-30", "accepted": "b", "accession": "2"}]
    assert s.recebidos(lista, "SCCO") == {("SCCO", "2026Q2"): dt.date(2026, 7, 31)}


def test_user_agent_vem_do_secret(monkeypatch):
    monkeypatch.setenv("SEC_USER_AGENT", "Equipe Research contato@empresa.com")
    assert s._cabecalho()["User-Agent"] == "Equipe Research contato@empresa.com"
    monkeypatch.delenv("SEC_USER_AGENT")
    assert s._cabecalho()["User-Agent"] == s.UA_PADRAO
