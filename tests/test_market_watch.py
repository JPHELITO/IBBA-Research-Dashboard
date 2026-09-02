# -*- coding: utf-8 -*-
"""Testes dos parsers do Market Watch (_shared/market_watch.py).

Todas as fixtures são DADO REAL baixado em 2026-09-02 e recortado para as empresas da
cobertura: JSON da API do BDI (01/09/2026), texto do PDF do BDI (03/08/2026), CSVs da
CVM (recompra, VLMO, FRE) e a lista + uma página de detalhe do Plantão da B3.
Nenhum teste toca a rede.

Rodar:  python -m pytest tests/test_market_watch.py -q
"""
import json
import os
import sys

import pytest

BASE = os.path.dirname(os.path.abspath(__file__))
FIX = os.path.join(BASE, "fixtures")
sys.path.insert(0, os.path.join(BASE, "..", "_shared"))
import market_watch as mw  # noqa: E402


def _fx(name, mode="r", enc="utf-8"):
    p = os.path.join(FIX, name)
    if not os.path.exists(p):
        pytest.skip(f"fixture ausente: {p}")
    with open(p, mode, encoding=None if "b" in mode else enc) as f:
        return f.read()


def _csv(name):
    return mw._read_csv_bytes(_fx(name, "rb"))


# ───────────────────────── utilidades ────────────────────────────────────────

def test_num_br():
    assert mw._num_br("589.134.108,94") == 589134108.94
    assert mw._num_br("7.720.274") == 7720274
    assert mw._num_br("0,48%") == 0.48
    assert mw._num_br("-") is None and mw._num_br("") is None


def test_date_iso():
    assert mw._date_iso("2026-09-01T00:00:00") == "2026-09-01"
    assert mw._date_iso("03/08/2026") == "2026-08-03"
    assert mw._date_iso("") is None


def test_mapa_das_empresas_e_consistente():
    assert mw.LENDING_TO_COMPANY["KLBN4"] == "KLBN11"
    assert mw.LENDING_TO_COMPANY["GGBR3"] == "GGBR4"
    assert mw.B3CODE_TO_COMPANY["CSNA"] == "CSNA3"
    assert mw.CNPJ_TO_COMPANY["33.592.510/0001-54"] == "VALE3"
    assert len(mw.COMPANIES) == 11


# ───────────────────────── 1. aluguel — API do BDI ───────────────────────────

@pytest.fixture(scope="module")
def short_api():
    op = mw.bdi_rows(json.loads(_fx("mw_bdi_open_20260901.json")))
    lb = mw.bdi_rows(json.loads(_fx("mw_bdi_loans_20260901.json")))
    return {r["ticker"]: r for r in mw.build_short_rows(op, lb)}


def test_api_so_papeis_da_cobertura(short_api):
    assert set(short_api) <= set(mw.LENDING_TO_COMPANY)
    assert "VALE3" not in short_api or short_api["VALE3"]["company"] == "VALE3"
    assert short_api["KLBN4"]["company"] == "KLBN11"
    assert short_api["GGBR3"]["company"] == "GGBR4"


def test_api_total_e_a_soma_das_modalidades(short_api):
    # Total = Registro + Neg. Eletrônica D+0 + D+1 (medido na B3: CMIN3 116.126.635)
    r = short_api["CMIN3"]
    assert r["ref_date"] == "2026-09-01"
    assert r["qty_total"] == 116126635
    assert r["qty_total"] == (r.get("qty_registro") or 0) + (r.get("qty_d0") or 0) + (r.get("qty_d1") or 0)
    for r in short_api.values():
        parts = (r.get("qty_registro") or 0) + (r.get("qty_d0") or 0) + (r.get("qty_d1") or 0)
        assert r["qty_total"] == parts, r["ticker"]


def test_api_valor_e_preco_medio(short_api):
    r = short_api["GGBR4"]
    assert r["qty_total"] == 56572048
    assert round(r["value_brl"], 2) == 1343566092.82
    assert abs(r["avg_price"] - 1343566092.82 / 56572048) < 1e-3


def test_api_taxas_em_percentual_ao_ano(short_api):
    # JSON traz fração (0.3965) → gravamos % a.a. (39.65). CMIN3 era o papel "caro" do dia.
    assert abs(short_api["CMIN3"]["rate_taker_avg"] - 39.65) < 0.01
    assert abs(short_api["AURA33"]["rate_taker_avg"] - 0.12) < 0.01
    for r in short_api.values():
        if r.get("rate_taker_avg") is not None:
            assert 0 <= r["rate_taker_avg"] <= 100
            assert r["rate_taker_min"] <= r["rate_taker_avg"] + 1e-9
            assert r["rate_taker_max"] >= r["rate_taker_avg"] - 1e-9


def test_api_contratos_e_volume_do_dia(short_api):
    r = short_api["VALE3"]
    assert r["contracts_day"] > 0 and r["qty_day"] > 0 and r["value_day"] > 0
    assert r["source"] == "bdi_api"


# ───────────────────────── 1b. aluguel — PDF do BDI ──────────────────────────

@pytest.fixture(scope="module")
def short_pdf():
    op, lb = mw.parse_bdi_pdf_text(_fx("mw_bdi_pdf_20260803.txt"))
    return op, lb, {r["ticker"]: r for r in mw.build_short_rows(op, lb, source="bdi_pdf")}


def test_pdf_le_as_duas_secoes(short_pdf):
    op, lb, _ = short_pdf
    assert any(r["TckrSymb"] == "VALE3" and r["Market"] == "Total" for r in op)
    assert any(r["TckrSymb"] == "VALE3" and r["Market"] == "Registro" for r in lb)
    # unidade dos negócios eletrônicos: mercado partido em duas células no PDF é remontado
    assert any(r["Market"] == "Neg. Eletrônica D+1" for r in lb)


def test_pdf_registrados_vale_batem_com_o_boletim(short_pdf):
    _, lb, _ = short_pdf
    reg = [r for r in lb if r["TckrSymb"] == "VALE3" and r["Market"] == "Registro"][0]
    assert reg["QtyCtrctsDay"] == 947 and reg["ValCtrctsDay"] == 7720274
    assert round(reg["BRLValue"], 2) == 589134108.94
    assert abs(reg["TkrAvrgRate"] - 0.0048) < 1e-9        # 0,48% no PDF → fração como na API
    assert abs(reg["TkrMaxRate"] - 0.03) < 1e-9


def test_pdf_linhas_finais(short_pdf):
    _, _, rows = short_pdf
    v = rows["VALE3"]
    assert v["ref_date"] == "2026-08-03" and v["source"] == "bdi_pdf"
    assert v["qty_total"] == (v.get("qty_registro") or 0) + (v.get("qty_d0") or 0) + (v.get("qty_d1") or 0)
    assert abs(v["rate_taker_avg"] - 0.48) < 0.01
    assert v["value_brl"] > 0 and v["avg_price"] > 0
    assert rows["KLBN11"]["company"] == "KLBN11"


# ───────────────────────── 2. recompras (CVM) ────────────────────────────────

@pytest.fixture(scope="module")
def buybacks():
    rows = mw.build_buyback_rows(_csv("mw_cvm_recompra_acoes.csv"),
                                 _csv("mw_cvm_recompra_acoes_quantidades.csv"),
                                 _csv("mw_cvm_recompra_acoes_intermediarios.csv"))
    return {r["program_id"]: r for r in rows}


def test_recompra_programa_vigente_da_vale(buybacks):
    p = buybacks[1973]
    assert p["company"] == "VALE3" and p["status"] == "Em Andamento" and p["operation"] == "Compra"
    assert p["decided_on"] == "2026-07-30" and p["expires_on"] == "2028-01-29"
    assert p["qty_on"] == 100000000 and p["qty_pn"] is None


def test_recompra_quantidades_e_corretoras(buybacks):
    p = buybacks[1774]                       # Suzano 2024-2026 (encerrado)
    assert p["company"] == "SUZB3" and p["status"] == "Encerrado"
    assert p["qty_circ_on"] == 633598784
    assert "BTG PACTUAL CTVM S/A" in p["brokers"] and p["brokers"] == sorted(set(p["brokers"]))
    g = buybacks[1912]                       # Gerdau: ON e PN no mesmo programa
    assert g["qty_on"] == 1441120 and g["qty_pn"] == 55000
    assert g["qty_circ_on"] == 14411204 and g["qty_circ_pn"] == 1257577671


def test_recompra_so_cobertura(buybacks):
    assert all(r["company"] in mw.COMPANIES for r in buybacks.values())
    assert len(buybacks) > 100                # histórico desde 1997


# ───────────────────────── 3. insiders (CVM VLMO) ────────────────────────────

@pytest.fixture(scope="module")
def insiders():
    rows, latest = mw.build_insider_rows(_csv("mw_cvm_vlmo_con_2026.csv"))
    return rows, latest


def test_insiders_so_a_versao_mais_alta(insiders):
    rows, latest = insiders
    assert latest[("VALE3", "2026-02-01")] == 2          # reapresentação espontânea em abril
    fev = [r for r in rows if r["company"] == "VALE3" and r["ref_month"] == "2026-02-01"]
    assert fev and all(r["doc_version"] == 2 for r in fev)


def test_insiders_movimentacao_real(insiders):
    rows, _ = insiders
    k = [r for r in rows if r["company"] == "KLBN11" and r["move_date"] == "2026-07-14" and r["qty"] == 36000]
    assert k, "compra à vista de 14/07 (Conselho) sumiu"
    r = k[0]
    assert r["move_type"] == "Compra à vista" and r["operation"] == "Crédito"
    assert r["broker"].startswith("Santander Corretora") and abs(r["unit_price"] - 3.51) < 1e-9
    assert abs(r["volume"] - 126360.0) < 1e-6 and r["is_balance"] is False


def test_insiders_saldos_marcados_e_ids_unicos(insiders):
    rows, _ = insiders
    assert any(r["is_balance"] for r in rows)
    ids = [r["id"] for r in rows]
    assert len(ids) == len(set(ids))


# ───────────────────────── 4. free float (CVM FRE) ───────────────────────────

@pytest.fixture(scope="module")
def capital():
    rows = mw.build_share_capital_rows(_csv("mw_cvm_fre_capital_social_2026.csv"),
                                       _csv("mw_cvm_fre_distribuicao_capital_2026.csv"),
                                       _csv("mw_cvm_fre_distribuicao_capital_classe_acao_2026.csv"))
    return {r["company"]: r for r in rows}


def test_float_cmin(capital):
    c = capital["CMIN3"]
    assert c["shares_total"] == 5432044538 and c["shares_on"] == 5432044538
    assert c["float_total"] == 1572292846 and abs(c["pct_float_total"] - 28.945) < 1e-6


def test_float_classes_pn(capital):
    u = capital["USIM5"]
    assert u["float_by_class"] == {"PNA": 518248757, "PNB": 66261}
    assert u["float_pn"] == 518315018 and u["float_on"] == 167748403


def test_float_todas_as_empresas(capital):
    assert set(capital) == set(mw.COMPANIES)
    assert capital["SUZB3"]["float_on"] == 608216821


# ───────────────────────── 5. comunicados (B3 Plantão) ───────────────────────

@pytest.mark.parametrize("head,code,cat,date,flag", [
    ("VALE (VALE-NM) - Outros Comunicados ao Mercado - 27/08/26 (R)", "VALE", "Outros Comunicados ao Mercado", "2026-08-27", "R"),
    ("AURA 360 (AURA) - Fato Relevante - 05/08/26 (N)", "AURA", "Fato Relevante", "2026-08-05", "N"),
    ("SID NACIONAL (CSNA) - Esclarecimentos de questionamentos CVM/B3- 12/08/26", "CSNA", "Esclarecimentos de questionamentos CVM/B3", "2026-08-12", None),
    ("SUZANO S.A. (SUZB-NM) - Dados Financeiros - Press-release - 30/06/26", "SUZB", "Dados Financeiros - Press-release", "2026-06-30", None),
    ("KLABIN S/A (KLBN-N2) - VM Posicao Individual (Cia,Controladas e Coligadas)", "KLBN", "VM Posicao Individual (Cia,Controladas e Coligadas)", None, None),
    ("HABITASEC (HBSC) CRI E:96 S:1 EDITAL AGE - 23/09/2026 12:00 (C)", "HBSC", "CRI E:96 S:1 EDITAL AGE", "2026-09-23", "C"),
])
def test_parse_headline(head, code, cat, date, flag):
    p = mw.parse_headline(head)
    assert p["code"] == code and p["category"] == cat and p["doc_date"] == date and p["flag"] == flag


def test_newsworthy():
    assert mw.is_newsworthy("Fato Relevante")
    assert mw.is_newsworthy("Outros Comunicados ao Mercado")
    assert mw.is_newsworthy("Aquisicao de Participacao Acionaria")
    assert not mw.is_newsworthy("Ata Reuniao do Conselho de Administracao")
    assert not mw.is_newsworthy("VM Posicao Individual (Cia,Controladas e Coligadas)")
    assert not mw.is_newsworthy("Demonstracoes Financeiras - ITR de 30/06/26")


def test_build_filing_rows_filtra_a_cobertura():
    items = json.loads(_fx("mw_plantao_list.json"))
    rows = mw.build_filing_rows(items, detail_fn=lambda i, d: f"u{i}")
    assert rows and all(r["company"] in mw.COMPANIES for r in rows)
    assert all(r["published_at"].endswith("-03:00") for r in rows)
    vale = [r for r in rows if r["company"] == "VALE3"]
    assert vale and vale[0]["cvm_url"].startswith("u")
    # conhecidos são pulados (não refaz o detalhe)
    known = {rows[0]["id"]}
    assert all(r["id"] != rows[0]["id"] for r in mw.build_filing_rows(items, known, lambda i, d: None))


def test_protocolo_da_url():
    assert mw.cvm_protocol_from_url("https://www.rad.cvm.gov.br/ENETWEB/frmExibirArquivoIPEExterno.aspx?ID=1562150&flnk") == 1562150
    assert mw.cvm_protocol_from_url("https://x/y?flnk") is None and mw.cvm_protocol_from_url(None) is None


def test_titulo_e_trecho_do_documento():
    txt = ("VALE S.A.\nCNPJ 33.592.510/0001-54\nCompanhia Aberta\n\n"
           "Vale informa nova composição do Comitê de Auditoria e Riscos\n\n"
           "Rio de Janeiro, 27 de agosto de 2026 – A Vale S.A. (“Vale”) informa que seu Conselho de\n"
           "Administração aprovou, na presente data, a nova composição do Comitê.\n")
    t, x = mw.doc_title_excerpt(txt, "Vale")
    assert t == "Vale informa nova composição do Comitê de Auditoria e Riscos"
    assert x.startswith("Vale informa nova composição") and "Conselho de Administração aprovou" in x
    assert mw.doc_title_excerpt("", "Vale") == (None, None)
    # papel timbrado + tipo do documento seco NÃO viram título (casos reais de 31/08/2026)
    gerdau = ("METALÚRGICA GERDAU S.A.\nCNPJ nº 92.690.783/0001-09\nNIRE 35300520751\nCOMUNICADO AO MERCADO\n"
              "A GERDAU S.A. e a METALÚRGICA GERDAU S.A. comunicam aos seus acionistas que…\n")
    t, _ = mw.doc_title_excerpt(gerdau, "Metalúrgica Gerdau")
    assert t.startswith("A GERDAU S.A. e a METALÚRGICA GERDAU S.A. comunicam")
    # frase partida em linhas: o título é a frase inteira, não a 1ª linha
    gerdau2 = ("METALÚRGICA GERDAU S.A.\nCNPJ nº 92.690.783/0001-09\nCOMUNICADO AO MERCADO\n"
               "A GERDAU S.A. (“Companhia”) e a METALÚRGICA GERDAU S.A. vêm informar seus\n"
               "acionistas e ao mercado em geral que concluíram a venda.\nMais texto.\n")
    t, _ = mw.doc_title_excerpt(gerdau2, "Metalúrgica Gerdau")
    assert t == "A GERDAU S.A. (“Companhia”) e a METALÚRGICA GERDAU S.A. vêm informar seus acionistas e ao mercado em geral que concluíram a venda."
    # documento que começa direto no corpo ("Cidade, data – …"): sem título → cai no "{empresa} — {categoria}"
    suzano = ("COMUNICADO AO MERCADO\nSUZANO S.A.\nCompanhia Aberta de Capital Autorizado\nCNPJ/MF No. 16.404.287/0001-55\n"
              "São Paulo, 31 de agosto de 2026 – A Suzano S.A. (“Suzano”) informa que concluiu a emissão…\n")
    t, x = mw.doc_title_excerpt(suzano, "Suzano")
    assert t is None and x.startswith("São Paulo, 31 de agosto de 2026")


def test_extract_cvm_url():
    html = _fx("mw_plantao_detail.html")
    assert mw.extract_cvm_url(html) == "https://www.rad.cvm.gov.br/ENETWEB/frmExibirArquivoIPEExterno.aspx?ID=1562150&flnk"
    assert mw.extract_cvm_url("<p>nada</p>") is None
