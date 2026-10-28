# -*- coding: utf-8 -*-
"""Testes do RESUMO DO DIA por e-mail (_shared/daily_digest_mail.py).

Sem rede e sem e-mail: relógio, sono e banco são falsos. O que importa travar:
  • a janela do e-mail (18h da véspera → 18h do dia) e o agrupamento por dia;
  • a espera do workflow (dorme até as 18h, pede job novo se começou cedo, desiste às 22h);
  • o HTML (escapa o título, só vira link o que é http(s), janela 'list' sem resumo).

Rodar:  python -m pytest tests/test_daily_digest_mail.py -q
"""
import os
import sys
from datetime import date, datetime, timedelta

BASE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(BASE, "..", "_shared"))
import daily_digest_mail as dm   # noqa: E402

BRT = dm.BRT
D = date(2026, 10, 28)


def _row(start_h, end_h, day_start=28, day_end=28, kind="hour", status="ok", summary="Resumo.", items=None):
    s = datetime(2026, 10, day_start, start_h, tzinfo=BRT)
    e = datetime(2026, 10, day_end, end_h, tzinfo=BRT)
    return {"slot_start": dm._iso(s), "slot_end": dm._iso(e), "kind": kind, "status": status,
            "summary": summary, "items": items if items is not None else
            [{"url": "https://x.com/a", "title": "Vale sobe", "source": "Valor", "take": "+", "tickers": ["VALE3"]}]}


class Relogio:
    """Relógio falso que anda quando alguém 'dorme'."""
    def __init__(self, inicio):
        self.agora = inicio
        self.sonos = []

    def __call__(self):
        return self.agora

    def sleep(self, s):
        self.sonos.append(s)
        self.agora += timedelta(seconds=s)


def test_janela_do_email_vai_das_18h_da_vespera_as_18h():
    ini, fim = dm.bounds(D)
    assert ini == datetime(2026, 10, 27, 18, tzinfo=BRT)
    assert fim == datetime(2026, 10, 28, 18, tzinfo=BRT)
    assert dm._iso(fim) == "2026-10-28T21:00:00Z"


def test_comecou_cedo_demais_dorme_o_que_cabe_e_pede_job_novo():
    r = Relogio(datetime(2026, 10, 28, 6, 30, tzinfo=BRT))
    assert dm.wait_until_ready(D, clock=r, sleep=r.sleep, ready=lambda d: True) == "rearm"
    assert r.sonos == [dm.MAX_SLEEP_S]
    # o job novo, 4h50 depois, ainda está longe: pede outro; o terceiro já cabe
    assert dm.wait_until_ready(D, clock=r, sleep=r.sleep, ready=lambda d: True) == "rearm"
    assert dm.wait_until_ready(D, clock=r, sleep=r.sleep, ready=lambda d: True) == "ready"
    assert r.agora == datetime(2026, 10, 28, 18, tzinfo=BRT)


def test_dentro_da_folga_dorme_ate_as_18h():
    r = Relogio(datetime(2026, 10, 28, 14, 0, tzinfo=BRT))
    assert dm.wait_until_ready(D, clock=r, sleep=r.sleep, ready=lambda d: True) == "ready"
    assert r.sonos == [4 * 3600]


def test_espera_a_janela_das_17_as_18h_ficar_pronta():
    r = Relogio(datetime(2026, 10, 28, 18, 5, tzinfo=BRT))
    pronta = lambda d: r.agora >= datetime(2026, 10, 28, 18, 12, tzinfo=BRT)   # noqa: E731
    assert dm.wait_until_ready(D, clock=r, sleep=r.sleep, ready=pronta) == "ready"
    assert datetime(2026, 10, 28, 18, 12, tzinfo=BRT) <= r.agora <= datetime(2026, 10, 28, 18, 13, tzinfo=BRT)


def test_janela_que_nao_sai_nao_segura_o_email_depois_das_18h45():
    r = Relogio(datetime(2026, 10, 28, 18, 30, tzinfo=BRT))
    assert dm.wait_until_ready(D, clock=r, sleep=r.sleep, ready=lambda d: False) == "ready"
    assert r.agora >= datetime(2026, 10, 28, 18, 45, tzinfo=BRT)
    assert r.agora < datetime(2026, 10, 28, 18, 47, tzinfo=BRT)


def test_banco_piscando_nao_derruba_a_espera():
    r = Relogio(datetime(2026, 10, 28, 18, 10, tzinfo=BRT))
    chamadas = []

    def falha_e_depois_pronta(d):
        chamadas.append(1)
        if len(chamadas) == 1:
            raise OSError("rede")
        return True
    assert dm.wait_until_ready(D, clock=r, sleep=r.sleep, ready=falha_e_depois_pronta) == "ready"
    assert len(chamadas) == 2


def test_depois_das_22h_nao_manda_mais():
    r = Relogio(datetime(2026, 10, 28, 22, 5, tzinfo=BRT))
    assert dm.wait_until_ready(D, clock=r, sleep=r.sleep, ready=lambda d: True) == "late"
    assert r.sonos == []


def test_quiet_e_janela_sem_manchete_ficam_de_fora():
    rows = [_row(7, 8), _row(8, 9, status="quiet", items=[]), _row(9, 10, items=[]),
            _row(10, 11, status="list", summary=None)]
    assert [dm._dt(r["slot_start"]).hour for r in dm.windows(rows)] == [7, 10]


def test_agrupa_por_dia_e_a_madrugada_conta_para_o_dia_em_que_termina():
    rows = [_row(18, 19, 27, 27), _row(20, 7, 27, 28, kind="overnight"), _row(7, 8)]
    assunto, html = dm.build(D, rows)
    assert assunto == "Resumo do dia — notícias S&M, P&P e NR — 28/10/2026"
    ter, qua = "Terça, 27/10</td>", "Quarta, 28/10</td>"      # o separador de dia (o cabeçalho diz 28/10/2026)
    assert html.index(ter) < html.index("18:00–19:00") < html.index(qua)
    assert html.index(qua) < html.index("Madrugada · 20:00–07:00") < html.index("07:00–08:00")
    assert html.count(ter) == 1 and html.count(qua) == 1
    assert "3 janelas · 3 manchetes" in html


def test_titulo_escapado_link_so_http_e_janela_list_sem_resumo():
    itens = [{"url": "javascript:alert(1)", "title": "<b>Klabin</b> & cia", "source": "InfoMoney",
              "take": "-", "tickers": ["KLBN11"]},
             {"url": "https://valor.globo.com/x?a=1&b=2", "title": "Gerdau", "source": None,
              "take": None, "tickers": []}]
    _, html = dm.build(D, [_row(13, 14, status="list", summary=None, items=itens)])
    assert "&lt;b&gt;Klabin&lt;/b&gt; &amp; cia" in html
    assert "javascript:" not in html
    assert 'href="https://valor.globo.com/x?a=1&amp;b=2"' in html
    assert "Sem resumo automático nesta hora" in html
    assert "(KLBN11)" in html and "(−)" in html


def test_dia_sem_nada_diz_que_nao_houve_noticia():
    _, html = dm.build(D, [_row(8, 9, status="quiet", items=[])])
    assert "Nenhuma notícia relevante no período." in html
    assert "0 janelas · 0 manchetes" in html
