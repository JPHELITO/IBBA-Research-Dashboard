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
    ter, qua = "TERÇA, 27/10</b>", "QUARTA, 28/10</b>"        # a etiqueta de dia (o título diz "Quarta-feira, 28 de outubro")
    assert html.index(ter) < html.index("18:00–19:00") < html.index(qua)
    assert html.index(qua) < html.index("MADRUGADA · 20:00–07:00") < html.index("07:00–08:00")
    assert html.count(ter) == 1 and html.count(qua) == 1
    assert "Quarta-feira, 28 de outubro" in html
    assert "3 horas com notícia · 3 manchetes" in html


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
    assert "0 horas com notícia · 0 manchetes" in html


# ── 2026-11-03: a cara do Weekly + a tabela de ações das 20 ──────────────────────────────────────
def _ts(y, m, d, h, mi=0):
    """epoch de um instante em UTC (o `traded_at` que o robô grava)."""
    from datetime import timezone
    return int(datetime(y, m, d, h, mi, tzinfo=timezone.utc).timestamp())


def _q(ticker, exchange, price, pct, prev, traded_at, updated="2026-10-28T21:10:00+00:00"):
    return {"ticker": ticker, "exchange": exchange, "price": price, "change_pct": pct, "prev": prev,
            "traded_at": traded_at, "updated_at": updated}


# 28/10/2026 (quarta): B3 até 17h, NY até 18h de Brasília; Sydney fecha às 16h10 de lá = 05h10 UTC do MESMO dia.
QUOTES = [
    _q("VALE", "NYSE", 11.02, -2.8, 11.34, _ts(2026, 10, 28, 20, 59)),
    _q("RANI3.SA", "B3", 8.36, 10.14, 7.59, _ts(2026, 10, 28, 19, 55)),
    _q("VMM.AX", "ASX", 3.37, -5.34, 3.56, _ts(2026, 10, 28, 5, 11)),
    _q("COPEC.SN", "BCS", 6388.0, -0.36, 6411.0, _ts(2026, 10, 28, 18, 59)),
    _q("CMIN3.SA", "B3", 4.57, -5.97, 4.86, _ts(2026, 10, 27, 19, 55)),      # feriado na B3: último negócio é de ontem
]


def test_acoes_ordem_moeda_rotulo_e_feriado_local():
    tick = ["VALE", "RANI3.SA", "VMM.AX", "COPEC.SN", "CMIN3.SA", "HBM.TO"]   # HBM.TO: o robô não tem
    a = dm.linhas_acoes(D, tick, QUOTES)
    rot = [l["rotulo"] for l in a["linhas"]]
    assert rot == ["RANI3", "COPEC", "VALE", "VMM", "CMIN3", "HBM"]        # maior alta → maior queda; depois o resto
    por = {l["rotulo"]: l for l in a["linhas"]}
    assert por["VMM"]["estado"] == "hoje"              # Sydney de 28/10 fechou às 2h10 de Brasília do dia 28
    assert por["CMIN3"]["estado"] == "sem_pregao" and por["CMIN3"]["pct"] is None
    assert por["HBM"]["estado"] == "sem_cotacao"
    assert por["COPEC"]["prefixo"] == "CLP " and por["COPEC"]["casas"] == 0     # ≥ 1.000 → sem casas (weekly)
    assert por["RANI3"]["prefixo"] == "R$ " and por["VALE"]["prefixo"] == "US$ "
    assert a["hora"] == datetime(2026, 10, 28, 18, 10, tzinfo=BRT)


def test_dia_do_negocio_no_calendario_da_bolsa():
    """Papel pouco líquido de Sydney: último negócio às 10h30 de lá do dia 28 = 20h30 de Brasília do
    dia 27. No relógio de Brasília pareceria "sem pregão"; no da bolsa, é o pregão de hoje."""
    q = [_q("VMM.AX", "ASX", 3.37, -5.34, 3.56, _ts(2026, 10, 27, 23, 30))]
    assert dm.linhas_acoes(D, ["VMM.AX"], q)["linhas"][0]["estado"] == "hoje"


def test_acoes_sem_prev_usa_a_conta_da_home():
    q = [_q("TX", "NYSE", 52.0, 4.0, None, _ts(2026, 10, 28, 20, 59))]
    l = dm.linhas_acoes(D, ["TX"], q)["linhas"][0]
    assert abs(l["ant"] - 50.0) < 1e-9                  # 52 / 1,04


def test_tabela_de_acoes_no_email():
    a = dm.linhas_acoes(D, ["VALE", "RANI3.SA", "COPEC.SN", "CMIN3.SA"], QUOTES)
    _, html = dm.build(D, [_row(7, 8)], a)
    assert "AÇÕES EM COBERTURA" in html and "cotações das 18h10" in html
    assert html.index(">RANI3<") < html.index(">COPEC<") < html.index(">VALE<") < html.index(">CMIN3<")
    assert "+10,14%" in html and "−2,80%" in html and "CLP&nbsp;6.388" in html and "R$&nbsp;8,36" in html
    assert "sem pregão" in html
    assert html.index("AÇÕES EM COBERTURA") < html.index("NOTÍCIAS, HORA A HORA")   # a ordem do weekly


def test_sem_pregao_nenhum_a_secao_nao_aparece():
    fds = [_q("VALE", "NYSE", 11.0, -1.0, 11.1, _ts(2026, 10, 30, 20, 59))]     # sexta; o e-mail é de sábado
    a = dm.linhas_acoes(date(2026, 10, 31), ["VALE"], fds)
    _, html = dm.build(date(2026, 10, 31), [_row(7, 8, 31, 31)], a)
    assert "AÇÕES EM COBERTURA" not in html
    _, html = dm.build(D, [_row(7, 8)], None)
    assert "AÇÕES EM COBERTURA" not in html


def test_cobertura_do_heatmap():
    assert dm.cobertura(lambda path: []) == dm.COBERTURA_PADRAO and len(dm.COBERTURA_PADRAO) == 20
    marcados = [{"symbol": "VALE", "in_coverage": True, "is_hidden": False, "sort_order": 1},
                {"symbol": "SCCO", "in_coverage": True, "is_hidden": True, "sort_order": 2},
                {"symbol": "TX", "in_coverage": False, "is_hidden": False, "sort_order": 0}]
    assert dm.cobertura(lambda path: marcados) == ["VALE"]
    so_esconde = [{"symbol": "ERO", "in_coverage": False, "is_hidden": True, "sort_order": 0}]
    assert "ERO" not in dm.cobertura(lambda path: so_esconde) and len(dm.cobertura(lambda path: so_esconde)) == 19


def test_reenvio_de_dia_antigo_sai_sem_a_tabela():
    assert dm.acoes_do_dia(date(2020, 1, 2)) is None    # nem chega a ir ao banco


def test_html_no_molde_do_outlook():
    a = dm.linhas_acoes(D, ["VALE", "RANI3.SA"], QUOTES)
    _, html = dm.build(D, [_row(7, 8)], a)
    assert 'width="640"' in html and "#F7F5F0" in html and "Georgia" in html    # tokens do weekly
    for proibido in ("class=", "display:flex", "display:grid", "rem;", "var(--"):
        assert proibido not in html, proibido


def _main(monkeypatch, argv):
    """Roda o main() sem rede: banco, tabela de ações e e-mail falsos; devolve os destinatários."""
    enviados = []
    monkeypatch.setattr(sys, "argv", ["daily_digest_mail.py"] + argv)
    monkeypatch.setattr(dm, "fetch_rows", lambda d: [_row(7, 8)])
    monkeypatch.setattr(dm, "acoes_do_dia", lambda d: None)
    monkeypatch.setattr(dm.notify, "_already_sent", lambda *a: False)
    monkeypatch.setattr(dm.notify, "once", lambda s, p, k, subj, body, to, html: enviados.append(to) or True)
    monkeypatch.setattr(dm.notify, "send", lambda subj, body, to, html: enviados.append(to) or True)
    assert dm.main() == 0
    return enviados


def test_o_resumo_do_dia_vai_para_o_time_inteiro(monkeypatch):
    assert _main(monkeypatch, ["--send", "--date", "2026-10-28"]) == [dm.notify.TEAM_RECIPIENTS]
    assert len(dm.notify.TEAM_RECIPIENTS) == 4


def test_o_teste_vai_so_para_quem_foi_pedido(monkeypatch):
    assert _main(monkeypatch, ["--send", "--date", "2026-10-28", "--to", "joao.helito@itaubba.com",
                               "--test"]) == [["joao.helito@itaubba.com"]]
