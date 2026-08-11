# -*- coding: utf-8 -*-
"""Testes do gerador de .ics — TODOS medindo BYTES, nunca texto.

Essa é a lição que o .eml do clipping cobrou caro: decodificar em Python, abrir num
editor ou renderizar no navegador MASCARA o defeito. Quebra de linha errada, BOM e
contagem de octetos só aparecem no byte cru — e é lá que o Outlook olha.

Rodar:  python -m pytest tests/test_ics_bytes.py -q
"""
import datetime as dt
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "_shared"))
from ics import Event, build_calendar, esc_text, fold, safe_uid   # noqa: E402

NOW = dt.datetime(2026, 8, 10, 12, 0, 0, tzinfo=dt.timezone.utc)


def _cal(events):
    return build_calendar(events, name="IBBA — Earnings", now=NOW)


@pytest.fixture
def ics():
    return _cal([
        Event(uid="b3:VALE:2026:ITR3", summary="VALE | 3Q26 Earnings Release (B3)",
              start=dt.date(2026, 10, 29), status="TENTATIVE",
              description="Previsão de entrega do ITR à CVM; não é a data do RI."),
        # acento + vírgula + ponto-e-vírgula + título comprido: o caso que quebra
        # implementações que contam caracteres em vez de octetos
        Event(uid="manual-suzano", start=dt.date(2026, 11, 5),
              summary="SUZB3 | 4Q26 Divulgação de resultados, conferência com "
                      "investidores; análise de produção de celulose e ações"),
        Event(uid="b3:GGBR4.SA:2026:ITR2", summary="GGBR4 | 2Q26 Earnings",
              start=dt.date(2026, 8, 4), status="CANCELLED", sequence=3),
        Event(uid="call-klabin", summary="KLBN11 | 3Q26 Conference Call",
              start=dt.datetime(2026, 10, 28, 8, 0), end=dt.datetime(2026, 10, 28, 9, 0)),
    ])


# ───────────────────────── bytes crus ────────────────────────────────────────

def test_e_bytes(ics):
    assert isinstance(ics, bytes)


def test_sem_lf_solto(ics):
    """Todo \\n tem que estar precedido de \\r. É EXATAMENTE o bug do .eml."""
    assert ics.count(b"\n") == ics.count(b"\r\n")
    assert b"\r" not in ics.replace(b"\r\n", b"")


def test_termina_com_crlf(ics):
    assert ics.endswith(b"END:VCALENDAR\r\n")


def test_sem_bom(ics):
    assert not ics.startswith(b"\xef\xbb\xbf")
    assert ics.startswith(b"BEGIN:VCALENDAR\r\n")


def test_toda_linha_cabe_em_75_octetos(ics):
    for ln in ics.split(b"\r\n"):
        assert len(ln) <= 75, f"linha de {len(ln)} octetos: {ln[:90]!r}"


def test_utf8_valido_apos_dobra(ics):
    """Dobrar no meio de um 'ç' produziria byte solto e isto estouraria."""
    ics.decode("utf-8")


def test_desdobra_e_reconstroi(ics):
    """Desfazer a dobra (CRLF + espaço) tem que devolver as linhas lógicas."""
    logicas = ics.replace(b"\r\n ", b"").decode("utf-8").split("\r\n")
    assert any(l.startswith("SUMMARY:SUZB3 | 4Q26 Divulgação de resultados") for l in logicas)


# ───────────────────────── semântica do formato ──────────────────────────────

def test_campos_obrigatorios(ics):
    for campo in (b"VERSION:2.0", b"PRODID:", b"CALSCALE:GREGORIAN", b"METHOD:PUBLISH",
                  b"X-WR-CALNAME:", b"REFRESH-INTERVAL;VALUE=DURATION:", b"X-PUBLISHED-TTL:"):
        assert campo in ics
    assert ics.count(b"BEGIN:VEVENT") == ics.count(b"END:VEVENT") == 4
    assert ics.count(b"DTSTAMP:") == 4          # um por evento, obrigatório


def test_dtend_e_exclusivo(ics):
    """Evento de 29/10 termina em 30/10. Repetir a data some com o evento em alguns clientes."""
    assert b"DTSTART;VALUE=DATE:20261029\r\nDTEND;VALUE=DATE:20261030" in ics
    assert b"DTSTART;VALUE=DATE:20261105\r\nDTEND;VALUE=DATE:20261106" in ics


def test_evento_com_hora_vira_utc(ics):
    """08:00 de Brasília = 11:00Z. Assim não precisa de bloco VTIMEZONE."""
    assert b"DTSTART:20261028T110000Z" in ics
    assert b"DTEND:20261028T120000Z" in ics


def test_escaping_nos_bytes(ics):
    # Desdobra primeiro (ainda em bytes): a linha longa do teste é dobrada bem no meio
    # da sequência procurada — que é justamente o comportamento correto do fold.
    plano = ics.replace(b"\r\n ", b"")
    assert b"resultados\\, confer" in plano
    assert b"investidores\\; an" in plano
    assert b"\\:" not in plano                  # ':' NÃO se escapa em TEXT


def test_status_e_transparencia(ics):
    assert b"STATUS:TENTATIVE" in ics           # previsão da B3
    assert b"STATUS:CANCELLED" in ics           # o que sumiu continua, marcado
    assert b"STATUS:CONFIRMED" in ics           # curadoria manual
    assert b"TRANSP:TRANSPARENT" in ics         # não marca quem assinou como ocupado


def test_uid_estavel_e_unico(ics):
    uids = [l for l in ics.replace(b"\r\n ", b"").split(b"\r\n") if l.startswith(b"UID:")]
    assert len(uids) == len(set(uids)) == 4
    assert b"UID:b3:VALE:2026:ITR3@ibba-dashboard" in ics
    # mesma entrada, duas gerações → mesmos UIDs (é o que faz atualizar em vez de duplicar)
    outra = _cal([Event(uid="b3:VALE:2026:ITR3", summary="x", start=dt.date(2026, 10, 29))])
    assert b"UID:b3:VALE:2026:ITR3@ibba-dashboard" in outra


def test_sequence_presente_e_preservado(ics):
    assert b"SEQUENCE:0" in ics
    assert b"SEQUENCE:3" in ics                 # o cancelado veio com 3


def test_sequence_precisa_subir_para_o_outlook_aceitar():
    """Mesmo UID + mesmo SEQUENCE = o Outlook ignora a mudança e mantém a data velha."""
    v1 = _cal([Event(uid="u", summary="s", start=dt.date(2026, 10, 29), sequence=0)])
    v2 = _cal([Event(uid="u", summary="s", start=dt.date(2026, 11, 5), sequence=1)])
    assert b"SEQUENCE:0" in v1 and b"DTSTART;VALUE=DATE:20261029" in v1
    assert b"SEQUENCE:1" in v2 and b"DTSTART;VALUE=DATE:20261105" in v2


# ───────────────────────── unidades ──────────────────────────────────────────

def test_fold_conta_octetos_nao_caracteres():
    linha = "SUMMARY:" + "ção" * 40             # 120 caracteres, 200 octetos
    for parte in fold(linha).split(b"\r\n"):
        assert len(parte) <= 75
    assert fold(linha).replace(b"\r\n ", b"").decode("utf-8") == linha


def test_fold_nao_parte_caractere_utf8():
    """Corte na fronteira exata de um caractere de 2 bytes."""
    for n in range(60, 110):
        linha = "X" * n + "çççç"
        fold(linha).replace(b"\r\n ", b"").decode("utf-8")


def test_fold_curto_nao_dobra():
    assert fold("SUMMARY:curto") == b"SUMMARY:curto"


def test_esc_text_ordem_da_contrabarra():
    """A contrabarra tem que ser escapada PRIMEIRO, senão escapa as escapadas."""
    assert esc_text("a\\b") == "a\\\\b"
    assert esc_text("a;b,c") == "a\\;b\\,c"
    assert esc_text("l1\nl2") == "l1\\nl2"
    assert esc_text("http://x/y") == "http://x/y"


def test_safe_uid():
    assert safe_uid("b3:VALE:2026:ITR3") == "b3:VALE:2026:ITR3@ibba-dashboard"
    assert " " not in safe_uid("com espaço")
