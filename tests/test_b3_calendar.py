# -*- coding: utf-8 -*-
"""Testes do importador do cronograma da B3.

A fixture é a planilha REAL publicada em 05/08/2026 — inclusive com os dois erros de
digitação que a B3 cometeu ('31/09/2026' e o ano '226'). Testar contra o arquivo de
verdade é o que garante que o robô aguenta a fonte como ela é, não como gostaríamos.

Rodar:  python -m pytest tests/test_b3_calendar.py -q
"""
import datetime as dt
import os
import sys

import pytest

BASE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(BASE, "..", "_shared"))
import update_b3_calendar as b3   # noqa: E402

FIXTURE = os.path.join(BASE, "fixtures", "b3_cronograma_20260805.xlsx")
HOJE = dt.date(2026, 8, 10)


@pytest.fixture(scope="module")
def planilha():
    # Rede de segurança: se a fixture faltar (clone sem ela), pula em vez de estourar
    # com FileNotFoundError e derrubar o workflow inteiro antes de publicar o .ics.
    if not os.path.exists(FIXTURE):
        pytest.skip(f"fixture ausente: {FIXTURE}")
    with open(FIXTURE, "rb") as f:
        return b3.parse_xlsx(f.read())


# ───────────────────────── leitura da planilha ───────────────────────────────

def test_le_a_data_de_atualizacao(planilha):
    _dados, atualizado, _bad = planilha
    assert atualizado == dt.date(2026, 8, 5)


def test_le_todas_as_empresas(planilha):
    dados, _a, _b = planilha
    assert len(dados) == 223


def test_acha_as_sete_da_cobertura(planilha):
    dados, _a, _b = planilha
    for pregao in b3.PREGAO_TO_TICKER:
        assert b3._norm(pregao) in dados, f"{pregao} sumiu da planilha"


def test_datas_batem_com_a_fonte(planilha):
    """Conferido à mão contra o arquivo publicado em 05/08/2026."""
    dados, _a, _b = planilha
    assert dados[b3._norm("VALE")]["ITR3"] == dt.date(2026, 10, 29)
    assert dados[b3._norm("GERDAU")]["ITR3"] == dt.date(2026, 10, 26)
    assert dados[b3._norm("SUZANO S.A.")]["ITR2"] == dt.date(2026, 8, 12)
    assert dados[b3._norm("CSNMINERACAO")]["ITR2"] == dt.date(2026, 8, 5)


def test_descarta_a_data_impossivel_da_b3_sem_quebrar(planilha):
    """'31/09/2026' (31 de setembro) existe no arquivo real. Não pode derrubar o robô."""
    dados, _a, bad = planilha
    assert any("31/09/2026" in s for _quem, s in bad)
    assert len(dados) == 223          # o resto foi lido normalmente


def test_le_os_dois_formatos_de_data(planilha):
    """A mesma coluna traz 211 textos 'dd/mm/aaaa' e 12 datas de verdade do Excel."""
    dados, _a, _b = planilha
    # AUTOMOB veio como datetime real; BRISANET veio como texto — as duas viram date
    assert dados[b3._norm("AUTOMOB")]["ITR2"] == dt.date(2026, 8, 11)
    assert dados[b3._norm("BRISANET")]["ITR2"] == dt.date(2026, 8, 11)


# ───────────────────────── parser de data, unidade ───────────────────────────

@pytest.mark.parametrize("entrada,esperado", [
    ("05/08/2026", dt.date(2026, 8, 5)),
    ("5/8/2026", dt.date(2026, 8, 5)),
    ("'01/06/2026", dt.date(2026, 6, 1)),          # apóstrofo de texto do Excel
    (dt.datetime(2026, 8, 5), dt.date(2026, 8, 5)),
    (dt.date(2026, 8, 5), dt.date(2026, 8, 5)),
    ("2026-08-05", dt.date(2026, 8, 5)),
    (None, None), ("", None), ("-", None), ("N/A", None),
    ("31/09/2026", None),                          # 31 de setembro não existe
    ("01/06/226", None),                           # ano de 3 dígitos, typo da B3
    ("qualquer coisa", None),
])
def test_parse_date(entrada, esperado):
    assert b3.parse_date(entrada) == esperado


def test_parse_date_registra_o_que_descartou():
    bad = []
    b3.parse_date("31/09/2026", "AGROGALAXY", bad)
    assert bad == [("AGROGALAXY", "31/09/2026")]


def test_norm_ignora_acento_e_caixa():
    assert b3._norm("Suzano S.A. ") == b3._norm("SUZANO S.A.")
    assert b3._norm("CSNMineração") == "CSNMINERACAO"


def test_period_label():
    assert b3.period_label("ITR3", 2026) == "3Q26"
    assert b3.period_label("ITR1", 2026) == "1Q26"
    # DFP é o resultado ANUAL, e refere-se ao exercício ANTERIOR ao do arquivo
    assert b3.period_label("DFP", 2026) == "4Q25"


# ───────────────────────── montagem dos eventos ──────────────────────────────

def _existente(**kw):
    base = dict(id="uuid-x", title="", company="", start_date="", source=None,
                external_id=None, is_visible=True, ics_seq=0)
    base.update(kw)
    return base


def test_cria_o_trimestre_que_falta(planilha):
    dados, atualizado, _b = planilha
    ups, div, canc, aus = b3.build_events(dados, 2026, "cat-1", [], atualizado,
                                          b3.PREGAO_TO_TICKER, today=HOJE)
    por_titulo = {u["title"]: u["start_date"] for u in ups}
    assert por_titulo["VALE | 3Q26 Earnings Release (B3)"] == "2026-10-29"
    assert por_titulo["GGBR4 | 3Q26 Earnings Release (B3)"] == "2026-10-26"
    assert por_titulo["KLBN11 | 3Q26 Earnings Release (B3)"] == "2026-10-28"
    assert not div and not canc and not aus


def test_nao_traz_datas_passadas(planilha):
    dados, atualizado, _b = planilha
    ups, _d, _c, _a = b3.build_events(dados, 2026, "cat-1", [], atualizado,
                                      b3.PREGAO_TO_TICKER, today=HOJE)
    assert all(u["start_date"] >= HOJE.isoformat() for u in ups)


def test_nunca_sobrescreve_o_cadastro_manual(planilha):
    """O caso CMIN3 real: a B3 prevê 05/08, o cadastro à mão diz 12/08."""
    dados, atualizado, _b = planilha
    existentes = [_existente(id="meu-1", company="CMIN3.SA",
                             title="CMIN3 | 2Q26 Earnings Release", start_date="2026-08-12")]
    ups, div, _c, _a = b3.build_events(dados, 2026, "cat-1", existentes, atualizado,
                                       b3.PREGAO_TO_TICKER, today=dt.date(2026, 8, 1))
    assert all(u["company"] != "CMIN3.SA" or "2Q26" not in u["title"] for u in ups)
    assert ("CMIN3.SA", "2Q26", "2026-08-12", "2026-08-05") in div


def test_concordancia_com_o_manual_nao_vira_divergencia(planilha):
    """Suzano: a B3 e o cadastro dizem 12/08. Não cria nada e não reclama."""
    dados, atualizado, _b = planilha
    existentes = [_existente(id="meu-2", company="SUZB3.SA",
                             title="SUZB3 | 2Q26 Earnings Release", start_date="2026-08-12")]
    ups, div, _c, _a = b3.build_events(dados, 2026, "cat-1", existentes, atualizado,
                                       b3.PREGAO_TO_TICKER, today=dt.date(2026, 8, 1))
    assert not any("SUZB3" in u["title"] and "2Q26" in u["title"] for u in ups)
    assert div == []


def test_atualiza_o_que_e_do_robo(planilha):
    """Evento marcado como 'b3' pode ser corrigido — o upsert casa pela chave natural."""
    dados, atualizado, _b = planilha
    existentes = [_existente(id="rob-1", company="VALE", source="b3",
                             external_id="b3:VALE:2026:ITR3",
                             title="VALE | 3Q26 Earnings Release (B3)",
                             start_date="2026-11-30")]
    ups, div, canc, _a = b3.build_events(dados, 2026, "cat-1", existentes, atualizado,
                                         b3.PREGAO_TO_TICKER, today=HOJE)
    vale = [u for u in ups if u["external_id"] == "b3:VALE:2026:ITR3"]
    assert vale and vale[0]["start_date"] == "2026-10-29"
    assert div == [] and canc == []


def test_cancela_so_o_do_robo_e_so_no_futuro(planilha):
    dados, atualizado, _b = planilha
    existentes = [
        _existente(id="fantasma", source="b3", external_id="b3:XPTO3.SA:2026:ITR3",
                   company="XPTO3.SA", title="XPTO3 | 3Q26 Earnings Release (B3)",
                   start_date="2026-12-01"),
        _existente(id="passado", source="b3", external_id="b3:YYYY3.SA:2026:ITR1",
                   company="YYYY3.SA", title="YYYY3 | 1Q26 Earnings Release (B3)",
                   start_date="2026-05-01"),
        _existente(id="seu", company="CSNA3.SA",
                   title="CSNA3 | 3Q26 Earnings Release", start_date="2026-11-11"),
    ]
    _u, _d, canc, _a = b3.build_events(dados, 2026, "cat-1", existentes, atualizado,
                                       b3.PREGAO_TO_TICKER, today=HOJE)
    assert [c["id"] for c in canc] == ["fantasma"]


def test_avisa_quando_um_pregao_some(planilha):
    dados, atualizado, _b = planilha
    mapa = dict(b3.PREGAO_TO_TICKER, **{"SUZANO PAPEL E CELULOSE": "SUZB3.SA"})
    _u, _d, _c, aus = b3.build_events(dados, 2026, "cat-1", [], atualizado, mapa, today=HOJE)
    assert aus == ["SUZANO PAPEL E CELULOSE"]


def test_hidden_cria_oculto(planilha):
    dados, atualizado, _b = planilha
    ups, _d, _c, _a = b3.build_events(dados, 2026, "cat-1", [], atualizado,
                                      b3.PREGAO_TO_TICKER, hidden=True, today=HOJE)
    assert ups and all(u["is_visible"] is False for u in ups)


def test_chave_natural_e_estavel(planilha):
    """Rodar duas vezes tem que produzir as MESMAS chaves — é o que evita duplicar."""
    dados, atualizado, _b = planilha
    a = b3.build_events(dados, 2026, "c", [], atualizado, b3.PREGAO_TO_TICKER, today=HOJE)[0]
    b = b3.build_events(dados, 2026, "c", [], atualizado, b3.PREGAO_TO_TICKER, today=HOJE)[0]
    assert [x["external_id"] for x in a] == [x["external_id"] for x in b]
    assert len({x["external_id"] for x in a}) == len(a)


# ───────────────────────── achar o link na página ────────────────────────────

def test_acha_o_link_da_planilha():
    html = ('<a href="../../../../../../../data/files/06/02/65/3C/A73DF91094DCD8F9AC094EA8/'
            'Cronograma%20de%20Eventos%20Corporativos%2005_08_2026%20_%20_1_.xlsx">baixar</a>')
    url = b3.find_xlsx_link(html)
    assert url.startswith("https://www.b3.com.br/data/files/06/02/65/3C/")
    assert url.endswith(".xlsx")
    assert "%20" in url and "%2520" not in url      # não pode re-codificar


def test_link_ausente_nao_quebra(monkeypatch):
    monkeypatch.setattr(b3, "_mail", lambda *a, **k: None)
    assert b3.find_xlsx_link("<html>sem link</html>") is None


# ───────────────────────── trava de segurança ────────────────────────────────

def test_falha_de_leitura_devolve_none_e_nao_lista_vazia(monkeypatch):
    """Confundir "deu erro" com "não tem nada" faria o robô duplicar tudo e passar
    por cima da curadoria manual. Tem que dar para distinguir os dois casos."""
    class _Boom:
        def get(self, *a, **k):
            raise RuntimeError("rede caiu")
    monkeypatch.setattr(b3, "requests", _Boom())
    assert b3._get("exec_calendar_events", "select=id") is None
