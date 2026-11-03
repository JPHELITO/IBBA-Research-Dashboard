# -*- coding: utf-8 -*-
"""daily_digest_mail.py — RESUMO DO DIA por e-mail para o time (2026-10-28).

O QUE FAZ
  Junta os "resumos da última hora" da Home — a tabela `news_digest`, que o robô do
  news-hunter (hunter/digest.py) grava de hora em hora — num e-mail só, às 18h (Brasília),
  para os 4 do time (registry.TEAM_RECIPIENTS), pela camada única notify.py.
  O texto é o MESMO que a Home mostra: nenhuma IA é chamada aqui.

A CARA (2026-11-03, pedido do usuário: "deixar esteticamente mais bonito, com base no formato
do e-mail que enviamos no weekly" + "a performance das ações no dia… com todas da nossa
cobertura (as 20)")
  Os tokens, o cabeçalho, as seções e a tabela de ações com o gráfico de barras divergente são
  os do Weekly Recap (weekly-lib.js, objeto T — medidos no "Long Story Short"). São CÓPIAS:
  este script roda no Python do Actions e não carrega o JS. Mexer lá não muda aqui.
  A tabela de ações = as 20 do "Our coverage" do heatmap (`heatmap_tickers` do /admin; vazio =
  a lista padrão, espelho do G_COVERAGE do index.html), variação do dia de cada papel contra o
  fechamento anterior — a mesma conta do heatmap (`quotes.change_pct`). Papel cuja bolsa não
  abriu hoje (feriado local) sai como "sem pregão"; fim de semana / dia sem pregão nenhum, a
  seção não aparece. Só no e-mail do PRÓPRIO dia: reenviar um dia antigo (--date) não tem como
  saber o preço daquela tarde, então sai sem a tabela.

QUAIS HORAS ENTRAM
  Das 18h da véspera às 18h do dia. Assim nenhuma janela fica de fora: as de 18–19h e
  19–20h, que o robô grava depois do e-mail, saem no do dia seguinte, junto com a madrugada.
  Janela 'ok' = resumo + manchetes; 'list' (a IA não respondeu a tempo) = só as manchetes;
  'quiet' (nada relevante) não aparece.

QUANDO SAI (workflow .github/workflows/daily_digest_mail.yml)
  O agendador do GitHub atrasa 3 a 9 horas neste repo (medido em 28/10/2026: o cron das
  12:30 UTC do status_digest rodou entre 15:24 e 21:20 UTC no último mês). Por isso o workflow
  acorda CEDO por vários crons e este script DORME até as 18h; depois espera a janela das
  17–18h ficar pronta (o robô grava às 18:10, no máximo 18:40). Se o job começou cedo demais
  para caber nas 6 h que o GitHub dá, dorme o que cabe e pede um job novo ("rearm").
  Uma vez por dia: notify.once lembra no update_log (source=daily_digest, method=mail:daily,
  detail=AAAA-MM-DD). Depois das 22h não manda mais: o job fica vermelho e o GitHub avisa.
  Falha de envio: o motivo (porta e etapa) sai como aviso 'notify' do run, legível sem login
  (28/10/2026: o Gmail derrubava o LOGIN nas portas 587 e 465 — a senha de app do robô tinha
  caído; nenhum aviso saía desde 25/09. Senha nova no secret SMTP_PASS no mesmo dia).

USO
  python _shared/daily_digest_mail.py --html-out resumo.html [--date 2026-10-28]   (só monta)
  python _shared/daily_digest_mail.py --send --wait                                 (o workflow)
  python _shared/daily_digest_mail.py --send --date 2026-10-28                      (reenviar um dia)
  python _shared/daily_digest_mail.py --send --to a@x --test      (teste: não confere nem marca o dia)
"""
from __future__ import annotations

import argparse
import html
import json
import os
import sys
import time
import urllib.request
from datetime import date, datetime, timedelta, timezone
from urllib.parse import quote
from zoneinfo import ZoneInfo

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import notify  # noqa: E402  (camada única de e-mail)

BRT = timezone(timedelta(hours=-3))         # o Brasil não tem horário de verão desde 2019
CUT_HOUR = 18                               # o e-mail cobre até as 18h e sai às 18h
LAST_SLOT_WAIT_MIN = 45                     # espera a janela das 17–18h até 18:45 (o robô desiste às 18:40)
SEND_UNTIL_HOUR = 22                        # depois disso, não manda mais no dia
MAX_SLEEP_S = 4 * 3600 + 50 * 60            # 4h50: cabe no job de 6 h com a espera da última janela
SOURCE, KIND = "daily_digest", "daily"      # a marca do "já mandei hoje" no update_log
WD = ["Segunda", "Terça", "Quarta", "Quinta", "Sexta", "Sábado", "Domingo"]
WD_LONGO = ["Segunda-feira", "Terça-feira", "Quarta-feira", "Quinta-feira", "Sexta-feira", "Sábado", "Domingo"]
MES = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro",
       "outubro", "novembro", "dezembro"]

# ── TOKENS do Weekly Recap (weekly-lib.js, objeto T) ───────────────────────────────────────────
T = {
    "bg": "#F7F5F0", "card": "#FFFFFF", "ink": "#16191D", "body": "#22262B", "soft": "#5E6671",
    "mute": "#8B929B", "faint": "#A9AEB6", "accent": "#D94400", "green": "#0F8C57", "red": "#CF463A",
    "line": "#F0EEE8", "border": "#E8E6DF", "axis": "#D8D5CC",
    "serif": "'Georgia',serif", "sans": "'Arial',sans-serif", "W": 640, "PAD": "19.5pt",
}
# Larguras da tabela de ações (px). As do weekly (rótulo 70 · preços 62 · meia-barra 133) quebravam o
# preço em duas linhas no motor do Word ("US$" em cima, "30,66" embaixo) — com as 20, metade é US$/CLP/
# MX$. Os preços ganharam espaço e as barras cederam; o total segue dentro dos 544 px do cartão.
W_ROT, W_ANT, W_ULT, W_PCT = 70, 76, 82, 52
BAR_HALF, BAR_MAX = 104, 98                # metade do gráfico de barras / barra mais longa (px)
TAKE = {"+": ("(+)", T["green"]), "-": ("(−)", T["red"]), "=": ("(=)", T["ink"])}

# ── a cobertura do heatmap ─────────────────────────────────────────────────────────────────────
# Espelho do G_COVERAGE do index.html ("Our coverage", 2026-10-15). Vale quando o /admin não
# marcou cobertura nenhuma em `heatmap_tickers` — é o que a Home faz.
COBERTURA_PADRAO = ["AUGO", "SUZB3.SA", "VALE", "GMEXICOB.MX", "CMIN3.SA", "SCCO", "KLBN11.SA", "TX",
                    "CSNA3.SA", "CMPC.SN", "USIM5.SA", "RANI3.SA", "GGBR4.SA", "COPEC.SN",
                    "CS.TO", "ERO", "HBM.TO", "LUN.TO", "ARA.TO", "VMM.AX"]
# Moeda por bolsa — a do weekly.html (MOEDA); casas pelo tamanho do número, como lá (_casasDe).
MOEDA = {"B3": "R$ ", "NYSE": "US$ ", "NASDAQ": "US$ ", "US": "US$ ", "TSX": "C$ ", "BCS": "CLP ",
         "BMV": "MX$ ", "LSE": "GBp ", "HEL": "€ ", "ASX": "A$ "}
# Fuso de cada bolsa — o do index.html (EXCH_TZ): o dia do último negócio é lido no calendário
# DELA. Sydney fecha às 2h–3h de Brasília do mesmo dia; feriado local devolve o pregão anterior.
EXCH_TZ = {"B3": "America/Sao_Paulo", "NYSE": "America/New_York", "NASDAQ": "America/New_York",
           "US": "America/New_York", "TSX": "America/Toronto", "BCS": "America/Santiago",
           "BMV": "America/Mexico_City", "LSE": "Europe/London", "HEL": "Europe/Helsinki",
           "ASX": "Australia/Sydney"}


# ── banco ──────────────────────────────────────────────────────────────────────────────────────
def _get(path: str):
    url = os.environ.get("SUPABASE_URL", "").rstrip("/")
    key = os.environ.get("SUPABASE_SERVICE_KEY", "")
    if not (url and key):
        raise RuntimeError("SUPABASE_URL / SUPABASE_SERVICE_KEY ausentes")
    req = urllib.request.Request(f"{url}/rest/v1/{path}",
                                 headers={"apikey": key, "Authorization": "Bearer " + key})
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.loads(r.read() or b"[]")


def _iso(d: datetime) -> str:
    return d.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def bounds(d: date) -> tuple:
    """(início, fim) do e-mail do dia `d`: das 18h da véspera às 18h do dia (BRT)."""
    end = datetime(d.year, d.month, d.day, CUT_HOUR, tzinfo=BRT)
    return end - timedelta(days=1), end


def fetch_rows(d: date) -> list:
    start, end = bounds(d)
    return _get("news_digest?select=slot_start,slot_end,kind,status,summary,items"
                f"&slot_start=gte.{quote(_iso(start))}&slot_end=lte.{quote(_iso(end))}"
                "&order=slot_start.asc")


def last_slot_ready(d: date) -> bool:
    """A janela das 17–18h já foi gravada (com qualquer status)?"""
    _, end = bounds(d)
    return bool(_get(f"news_digest?select=slot_start&slot_start=eq.{quote(_iso(end - timedelta(hours=1)))}"))


def cobertura(get=_get) -> list:
    """Os papéis do "Our coverage": o que o /admin marcou em `heatmap_tickers`, na ordem dele e sem
    os escondidos — a mesma regra do applyHeatmapConfig da Home. Nada marcado = a lista padrão."""
    rows = get("heatmap_tickers?select=symbol,is_hidden,in_coverage,sort_order&order=sort_order,symbol")
    escondidos = {r.get("symbol") for r in rows if r.get("is_hidden")}
    cov = [r["symbol"] for r in rows if r.get("in_coverage") and r.get("symbol") not in escondidos]
    return cov or [t for t in COBERTURA_PADRAO if t not in escondidos]


def fetch_quotes(tickers: list, get=_get) -> list:
    """Só as colunas leves (sem `daily` nem a série do `intraday`): ~2 KB por e-mail."""
    cols = ("ticker,exchange,price,change_pct,updated_at,"
            "prev:intraday->prev,traded_at:intraday->traded_at")
    return get(f"quotes?select={cols}&ticker=in.({quote(','.join(tickers))})")


# ── espera (só no workflow) ────────────────────────────────────────────────────────────────────
def wait_until_ready(d: date, clock=lambda: datetime.now(BRT), sleep=time.sleep,
                     ready=last_slot_ready) -> str:
    """'ready' (pode montar) | 'rearm' (dormiu o que cabe; peça um job novo) | 'late' (passou das 22h)."""
    cut = datetime(d.year, d.month, d.day, CUT_HOUR, tzinfo=BRT)
    now = clock()
    if now >= cut.replace(hour=SEND_UNTIL_HOUR):
        return "late"
    if now < cut:
        falta = (cut - now).total_seconds()
        if falta > MAX_SLEEP_S:
            print(f"Cedo: faltam {falta / 3600:.1f} h para as {CUT_HOUR}h — durmo {MAX_SLEEP_S / 3600:.1f} h "
                  "e peço um job novo.", flush=True)
            sleep(MAX_SLEEP_S)
            return "rearm"
        print(f"Durmo até as {CUT_HOUR}h ({falta / 60:.0f} min).", flush=True)
        sleep(falta)
    limite = cut + timedelta(minutes=LAST_SLOT_WAIT_MIN)
    while True:
        try:
            if ready(d):
                return "ready"
        except Exception as e:                 # banco piscou: tenta de novo no próximo minuto
            print(f"Conferência da janela das 17–18h falhou ({type(e).__name__}).", flush=True)
        if clock() >= limite:
            print(f"A janela das 17–18h não saiu até {limite:%H:%M} — mando com o que há.", flush=True)
            return "ready"
        sleep(60)


# ── formatação (pt-BR, como o weekly) ─────────────────────────────────────────────────────────
def _dt(s) -> datetime:
    return datetime.fromisoformat(str(s).replace("Z", "+00:00")).astimezone(BRT)


def _e(s) -> str:
    return html.escape(str(s or ""), quote=True)


def _num(v, casas=2) -> str:
    if v is None:
        return "—"
    s = f"{abs(v):,.{casas}f}".replace(",", "§").replace(".", ",").replace("§", ".")
    return ("-" if v < 0 else "") + s


def _pct(v, casas=2) -> str:
    if v is None:
        return "—"
    return ("+" if v > 0 else "−" if v < 0 else "") + _num(abs(v), casas) + "%"


def _casas(v) -> int:
    return 0 if v is not None and abs(v) >= 1000 else 2


def _cor(v) -> str:
    return T["green"] if (v or 0) > 0 else T["red"] if (v or 0) < 0 else T["soft"]


def _f(tam, cor, extra="") -> str:
    """Estilo de letra inline (Arial). O Outlook ignora CSS de <head>: tudo vai no elemento."""
    return f"font-family:{T['sans']};font-size:{tam};color:{cor};{extra}"


# ── AÇÕES: a variação do dia das 20 ───────────────────────────────────────────────────────────
def _dia_do_negocio(q: dict):
    """Dia (no calendário da BOLSA) do último negócio — o _tradeDay do index.html."""
    try:
        t = float(q.get("traded_at"))
    except (TypeError, ValueError):
        return None
    if t <= 0:
        return None
    try:
        tz = ZoneInfo(EXCH_TZ.get(q.get("exchange"), "America/Sao_Paulo"))
    except Exception:                          # sem base de fusos: lê no de Brasília
        tz = BRT
    return datetime.fromtimestamp(t, tz).date()


def linhas_acoes(d: date, tickers: list, quotes: list) -> dict:
    """{'linhas': [...], 'hora': datetime|None} — uma linha por papel, na ordem do e-mail.

    Linha = {rotulo, prefixo, casas, ant, ult, pct, estado}, estado: 'hoje' (negociou em `d`),
    'sem_pregao' (a bolsa dele não abriu em `d`) ou 'sem_cotacao' (o robô não tem o papel).
    Ordem: quem negociou, da maior alta para a maior queda (como o weekly); depois o resto.
    """
    por = {q.get("ticker"): q for q in quotes or []}
    linhas, hora = [], None
    for t in tickers:
        q = por.get(t) or {}
        rotulo = t.split(".")[0] if "." in t else t          # USIM5.SA → USIM5, como no weekly
        if q.get("price") is None:
            linhas.append({"rotulo": rotulo, "prefixo": "", "casas": 2, "ant": None, "ult": None,
                           "pct": None, "estado": "sem_cotacao"})
            continue
        ult, pct = float(q["price"]), q.get("change_pct")
        ant = q.get("prev")
        if ant in (None, 0) and pct is not None:                # a mesma conta do _prevClose da Home
            ant = ult / (1 + float(pct) / 100)
        hoje = _dia_do_negocio(q) == d
        linhas.append({"rotulo": rotulo, "prefixo": MOEDA.get(q.get("exchange"), ""),
                       "casas": _casas(ult), "ant": float(ant) if ant is not None else None, "ult": ult,
                       "pct": float(pct) if (hoje and pct is not None) else None,
                       "estado": "hoje" if hoje else "sem_pregao"})
        if q.get("updated_at"):
            u = _dt(q["updated_at"])
            hora = u if hora is None or u > hora else hora
    ordem = {"hoje": 0, "sem_pregao": 1, "sem_cotacao": 2}
    linhas.sort(key=lambda l: (ordem[l["estado"]], -(l["pct"] if l["pct"] is not None else -1e9)))
    return {"linhas": linhas, "hora": hora}


# ── blocos de HTML (tabela + estilo inline: regra do Outlook, igual ao weekly-lib.js) ─────────
def _p(txt: str, est: str = "") -> str:
    return f'<p style="margin:0;{est}">{txt}</p>'


def _regua(cor: str, altura_pt: str, largura_px: int | None = None) -> str:
    larg = f' width="{largura_px}"' if largura_px else ' width="100%"'
    return (f'<table role="presentation" border="0" cellspacing="0" cellpadding="0"{larg}><tr>'
            f'<td style="background:{cor};font-size:1pt;line-height:{altura_pt};height:{altura_pt}">'
            '&nbsp;</td></tr></table>')


def _secao(titulo: str, legenda: str = "") -> str:
    """Tracinho laranja + TÍTULO ESPAÇADO + linha de legenda (o _secao do weekly)."""
    leg = (_p(f'<span style="{_f("9pt", T["mute"])}">{_e(legenda)}</span>', "margin:0 0 10.5pt 0")
           if legenda else "")
    return (f'<tr><td style="padding:25.5pt {T["PAD"]} 0 {T["PAD"]}">' + _regua(T["accent"], "1.5pt", 26) +
            _p(f'<b style="{_f("10pt", T["ink"], "letter-spacing:1.05pt")}">{_e(titulo)}</b>',
               "margin:8.5pt 0 3pt 0") + leg + "</td></tr>")


def _vao(pt: float) -> str:
    """Respiro vertical (o _vao do weekly)."""
    return f'<div style="height:{pt}pt;line-height:{pt}pt;font-size:1pt">&nbsp;</div>'


def _cartao(conteudo: str) -> str:
    return (f'<table role="presentation" border="0" cellspacing="0" cellpadding="0" width="100%" '
            f'style="width:100%;background:{T["card"]};border:1px solid {T["border"]};border-radius:12px">'
            f'<tr><td style="padding:13.5pt 16.5pt">{conteudo}</td></tr></table>')


def _etiqueta_dia(txt: str) -> str:
    """Rótulo do dia: tracinho laranja + dia em maiúsculas na tinta forte (o do weekly)."""
    return ('<table role="presentation" border="0" cellspacing="0" cellpadding="0"><tr>'
            '<td width="14" valign="middle" style="width:14px;padding:0 6pt 0 0">' +
            _regua(T["accent"], "1.5pt", 14) + '</td><td valign="middle">' +
            _p(f'<b style="{_f("9pt", T["ink"], "letter-spacing:1.15pt")}">{_e(txt.upper())}</b>') +
            "</td></tr></table>")


def _tabela_acoes(acoes: dict) -> str:
    """Fechamento anterior | último | barra divergente | variação — o _tabelaAcoes do weekly."""
    linhas = acoes["linhas"]
    max_abs = max([abs(l["pct"]) for l in linhas if l["pct"] is not None] + [0.01])
    s8 = f"font-family:{T['sans']};font-size:8.5pt;"
    s7 = _f("7pt", T["mute"], "letter-spacing:.3pt")

    def barra(v, lado):
        if v is None or not ((lado == "pos" and v > 0) or (lado == "neg" and v < 0)):
            return _p('<span style="font-size:1pt">&nbsp;</span>')
        w = max(1, round(BAR_MAX * abs(v) / max_abs))
        return (f'<table role="presentation" border="0" cellspacing="0" cellpadding="0" '
                f'align="{"left" if lado == "pos" else "right"}"><tr>'
                f'<td width="{w}" style="width:{w}px;height:6.75pt;background:{_cor(v)};'
                'font-size:1pt;line-height:6.75pt">&nbsp;</td></tr></table>')

    def preco(l, v):     # &nbsp; entre moeda e número: o Word quebrava a linha ali
        return l["prefixo"].replace(" ", "&nbsp;") + _num(v, l["casas"]) if v is not None else "—"

    corpo = []
    for l in linhas:
        v = l["pct"]
        if l["estado"] == "hoje":
            fim = f'<b style="{s8}color:{_cor(v)}">{_pct(v)}</b>'
        else:
            fim = f'<span style="{s7}">{"sem pregão" if l["estado"] == "sem_pregao" else "sem cotação"}</span>'
        ant = preco(l, l["ant"]) if l["estado"] == "hoje" else "—"
        corpo.append(
            "<tr>"
            f'<td width="{W_ROT}" nowrap="nowrap" style="width:{W_ROT}px;padding:1.5pt 4.5pt 1.5pt 0">'
            + _p(f'<b style="{s8}color:{T["ink"]}">{_e(l["rotulo"])}</b>') + "</td>"
            f'<td width="{W_ANT}" nowrap="nowrap" style="width:{W_ANT}px;padding:1.5pt 4.5pt 1.5pt 0">'
            + _p(f'<span style="{s8}color:{T["faint"]}">{ant}</span>', "text-align:right") + "</td>"
            f'<td width="{W_ULT}" nowrap="nowrap" style="width:{W_ULT}px;padding:1.5pt 9pt 1.5pt 0">'
            + _p(f'<span style="{s8}color:{T["soft"]}">{preco(l, l["ult"])}</span>', "text-align:right") + "</td>"
            f'<td width="{BAR_HALF}" style="width:{BAR_HALF}px;padding:1.5pt 0">{barra(v, "neg")}</td>'
            f'<td width="1" style="width:1px;background:{T["axis"]};font-size:1pt;line-height:0">'
            '<span style="font-size:1pt">&nbsp;</span></td>'
            f'<td width="{BAR_HALF}" style="width:{BAR_HALF}px;padding:1.5pt 0">{barra(v, "pos")}</td>'
            f'<td width="{W_PCT}" nowrap="nowrap" style="width:{W_PCT}px;padding:0 0 0 6pt">'
            f'{_p(fim, "text-align:right")}</td>'
            "</tr>")
    def rotulo(txt):
        return _p(f'<span style="{s7}">{txt}</span>', "text-align:right")

    cabec = ("<tr>"
             '<td style="padding:0 4.5pt 4.5pt 0"></td>'
             f'<td style="padding:0 4.5pt 4.5pt 0">{rotulo("FECH. ANT.")}</td>'
             f'<td style="padding:0 9pt 4.5pt 0">{rotulo("ÚLTIMO")}</td>'
             '<td colspan="4"></td></tr>')
    return (f'<tr><td style="padding:0 {T["PAD"]}">' +
            _cartao('<table role="presentation" border="0" cellspacing="0" cellpadding="0" width="100%" '
                    f'style="width:100%">{cabec}{"".join(corpo)}</table>') + "</td></tr>")


# ── notícias, hora a hora ──────────────────────────────────────────────────────────────────────
def windows(rows: list) -> list:
    """As janelas que entram no e-mail: 'ok' e 'list' com manchetes, em ordem."""
    return [r for r in rows if r.get("status") in ("ok", "list") and (r.get("items") or [])]


def _label(r) -> str:
    s, e = _dt(r["slot_start"]), _dt(r["slot_end"])
    faixa = f"{s:%H:%M}–{e:%H:%M}"
    return f"Madrugada · {faixa}" if r.get("kind") == "overnight" else faixa


def _headline(it: dict) -> str:
    url = str(it.get("url") or "")
    titulo = _e(it.get("title"))
    if url.startswith(("http://", "https://")):
        titulo = f'<a href="{_e(url)}" style="color:{T["ink"]};text-decoration:none">{titulo}</a>'
    fonte = f' <span style="color:{T["faint"]}">— {_e(it.get("source"))}</span>' if it.get("source") else ""
    tick = ", ".join(_e(t) for t in (it.get("tickers") or []) if t)
    tick = f' <b style="color:{T["soft"]}">({tick})</b>' if tick else ""
    sinal, cor = TAKE.get(it.get("take"), ("", ""))
    take = f' <b style="color:{cor}">{sinal}</b>' if sinal else ""
    return (f'<tr><td width="12" valign="top" style="width:12px;{_f("9pt", T["faint"], "line-height:14pt")}">•</td>'
            f'<td valign="top" style="{_f("9pt", T["body"], "line-height:14pt;padding-bottom:2pt")}">'
            f'{titulo}{fonte}{tick}{take}</td></tr>')


def _bloco_janela(r: dict, primeira: bool) -> str:
    resumo = (r.get("summary") or "").strip() if r.get("status") == "ok" else ""
    texto = (_p(f'<span style="font-family:{T["serif"]};font-size:11.5pt;color:{T["body"]}">{_e(resumo)}</span>',
                "margin:0 0 6pt 0;line-height:17pt")
             if resumo else
             _p(f'<i style="{_f("8.5pt", T["mute"])}">Sem resumo automático nesta hora — as manchetes:</i>',
                "margin:0 0 5pt 0"))
    linhas = "".join(_headline(it) for it in (r.get("items") or []) if isinstance(it, dict))
    sep = "" if primeira else f"margin-top:11pt;padding-top:11pt;border-top:1px solid {T['line']};"
    return (f'<div style="{sep}">' +
            _p(f'<b style="{_f("8pt", T["accent"], "letter-spacing:.9pt")}">{_e(_label(r).upper())}</b>',
               "margin:0 0 4pt 0") + texto +
            '<table role="presentation" border="0" cellspacing="0" cellpadding="0" width="100%" '
            f'style="width:100%">{linhas}</table></div>')


def _bloco_noticias(jan: list) -> str:
    dias, atual = [], None
    for r in jan:
        dia = _dt(r["slot_end"]).date()              # a madrugada (20h→7h) conta para o dia em que termina
        if dia != atual:
            atual = dia
            dias.append((dia, []))
        dias[-1][1].append(r)
    blocos = []
    for k, (dia, rs) in enumerate(dias):
        corpo = "".join(_bloco_janela(r, i == 0) for i, r in enumerate(rs))
        # A divisória entre os dias é RÉGUA (tabela), não borda de <div>: o Word põe a borda e a margem
        # do <div> no 1º parágrafo de dentro, e aqui o 1º filho é a tabela da etiqueta — a separação
        # sumia e a "TERÇA" grudava na última manchete de segunda.
        topo = (_vao(18) + _regua(T["border"], "1pt") + _vao(15)) if k else ""
        blocos.append(topo + _etiqueta_dia(f"{WD[dia.weekday()]}, {dia:%d/%m}") + _vao(9) + corpo)
    return f'<tr><td style="padding:0 {T["PAD"]}">' + "".join(blocos) + "</td></tr>"


# ── o e-mail ───────────────────────────────────────────────────────────────────────────────────
def build(d: date, rows: list, acoes: dict | None = None) -> tuple:
    """(assunto, html) do e-mail do dia `d`. `acoes` = linhas_acoes(...) ou None (sem a tabela)."""
    start, end = bounds(d)
    jan = windows(rows)
    n_man = sum(len(r.get("items") or []) for r in jan)
    subject = f"Resumo do dia — notícias S&M, P&P e NR — {d:%d/%m/%Y}"
    L = []

    # 1. cabeçalho da publicação (o do weekly)
    L.append(f'<tr><td style="padding:19.5pt {T["PAD"]} 12pt {T["PAD"]}">'
             '<table role="presentation" border="0" cellspacing="0" cellpadding="0" width="100%" style="width:100%"><tr>'
             "<td>" + _p(f'<b style="{_f("8.5pt", T["accent"], "letter-spacing:1.4pt")}">ITAÚ BBA EQUITY RESEARCH</b>') +
             _p(f'<span style="font-family:{T["serif"]};font-size:20pt;color:{T["ink"]};letter-spacing:-.3pt">'
                "Resumo do dia</span>", "margin:3pt 0 0 0") + "</td>"
             '<td valign="bottom">' +
             _p(f'<span style="{_f("8.5pt", T["mute"], "letter-spacing:.25pt")}">'
                "Steel &amp; Mining · Pulp &amp; Paper · NR</span>", "text-align:right") + "</td>"
             "</tr></table></td></tr>")
    L.append(f'<tr><td style="padding:0 {T["PAD"]}">' + _regua(T["ink"], "1.5pt") + "</td></tr>")

    # 2. abertura: período + o dia por extenso + a contagem
    periodo = (f"Das {start:%H}h de {WD[start.weekday()].lower()} ({start:%d/%m}) às {end:%H}h de "
               f"{WD[end.weekday()].lower()} ({end:%d/%m}) · horário de Brasília")
    conta = (f"Os resumos de hora em hora da Home: {len(jan)} {'hora' if len(jan) == 1 else 'horas'} com "
             f"notícia · {n_man} {'manchete' if n_man == 1 else 'manchetes'}.")
    L.append(f'<tr><td style="padding:27pt {T["PAD"]} 0 {T["PAD"]}">' +
             _p(f'<b style="{_f("8pt", T["mute"], "letter-spacing:1.15pt")}">{_e(periodo.upper())}</b>') +
             _p(f'<span style="font-family:{T["serif"]};font-size:26.5pt;color:{T["ink"]};letter-spacing:-.45pt">'
                f'{WD_LONGO[d.weekday()]}, {d.day} de {MES[d.month - 1]}</span>', "margin:9pt 0 10pt 0;line-height:30pt") +
             _p(f'<span style="font-family:{T["serif"]};font-size:13pt;color:{T["body"]}">{_e(conta)}</span>',
                "margin:0;line-height:20.25pt") + "</td></tr>")

    # 3. ações em cobertura — a variação do dia (só com pregão hoje)
    if acoes and any(l["estado"] == "hoje" for l in acoes["linhas"]):
        hora = acoes.get("hora")
        leg = (f"Último preço de {d:%d/%m}" + (f" (cotações das {hora:%Hh%M})" if hora else "") +
               " contra o fechamento anterior. Cada papel na moeda em que negocia")
        L.append(_secao("AÇÕES EM COBERTURA", leg))
        L.append(_tabela_acoes(acoes))

    # 4. notícias
    L.append(_secao("NOTÍCIAS, HORA A HORA",
                    "O resumo automático de cada hora — o mesmo da Home — e as manchetes por trás dele"))
    if jan:
        L.append(_bloco_noticias(jan))
    else:
        L.append(f'<tr><td style="padding:0 {T["PAD"]}">' +
                 _p(f'<span style="font-family:{T["serif"]};font-size:12pt;color:{T["body"]}">'
                    "Nenhuma notícia relevante no período.</span>") + "</td></tr>")

    # 5. rodapé
    L.append(f'<tr><td style="padding:25.5pt {T["PAD"]} 0 {T["PAD"]}">' + _regua(T["border"], "1pt") + "</td></tr>")
    L.append(f'<tr><td style="padding:15pt {T["PAD"]} 24pt {T["PAD"]}">' +
             _p(f'<a href="{_e(notify._LINK)}" style="text-decoration:none">'
                f'<b style="{_f("8.5pt", T["accent"])}">Dashboard M&amp;M | P&amp;P ↗</b></a>', "margin:0 0 9pt 0") +
             _p(f'<span style="{_f("8pt", T["mute"], "line-height:12pt")}">'
                "Resumos escritos automaticamente (IA) só a partir dos títulos das notícias — os mesmos da "
                "Home. Confira a matéria antes de usar. (+) / (−) / (=) = leitura para as empresas cobertas."
                "<br>Itaú BBA Equity Research · mensagem automática</span>") + "</td></tr>")

    body = f"""<!DOCTYPE html>
<html lang="pt-BR"><head><meta charset="utf-8"><meta name="color-scheme" content="light">
<title>{_e(subject)}</title></head>
<body style="margin:0;padding:0;background:{T['bg']}">
<table role="presentation" border="0" cellspacing="0" cellpadding="0" width="100%" bgcolor="{T['bg']}" style="width:100%;background:{T['bg']};margin:0;padding:0"><tr><td align="center" style="padding:0;background:{T['bg']}">
<table role="presentation" border="0" cellspacing="0" cellpadding="0" width="{T['W']}" bgcolor="{T['bg']}" style="width:{T['W']}px;max-width:{T['W']}px;background:{T['bg']}">
{"".join(L)}
</table></td></tr></table>
</body></html>"""
    return subject, body


# ── linha de comando ───────────────────────────────────────────────────────────────────────────
def _output(name: str, value: str) -> None:
    p = os.environ.get("GITHUB_OUTPUT")
    if p:
        with open(p, "a", encoding="utf-8") as f:
            f.write(f"{name}={value}\n")


def acoes_do_dia(d: date):
    """A tabela de ações do e-mail de `d`, ou None. Nunca derruba o e-mail: falhou, sai sem ela."""
    if d != datetime.now(BRT).date():
        print("Ações: só no e-mail do próprio dia (reenvio de dia antigo sai sem a tabela).")
        return None
    try:
        tickers = cobertura()
        acoes = linhas_acoes(d, tickers, fetch_quotes(tickers))
        n = sum(1 for l in acoes["linhas"] if l["estado"] == "hoje")
        print(f"Ações: {n} de {len(tickers)} com pregão hoje.")
        return acoes
    except Exception as e:                       # banco piscou: o resumo sai mesmo assim
        print(f"::warning::Ações do dia ficaram fora do e-mail ({type(e).__name__}: {e}).")
        return None


def main() -> int:
    ap = argparse.ArgumentParser(description="Resumo do dia por e-mail (os resumos de hora em hora).")
    ap.add_argument("--date", help="AAAA-MM-DD (padrão: hoje em Brasília)")
    ap.add_argument("--html-out", help="grava o HTML montado neste arquivo")
    ap.add_argument("--send", action="store_true", help="manda o e-mail")
    ap.add_argument("--wait", action="store_true", help="dorme até as 18h e espera a janela das 17–18h")
    ap.add_argument("--to", help="destinatários (vírgula); padrão: os 4 do time")
    ap.add_argument("--test", action="store_true", help="não confere nem marca o 'já mandei hoje'")
    a = ap.parse_args()

    d = date.fromisoformat(a.date) if a.date else datetime.now(BRT).date()
    period = d.isoformat()
    if a.send and not a.test and notify._already_sent(SOURCE, KIND, period):
        print(f"Resumo do dia {period}: já foi enviado — nada a fazer.")
        return 0
    if a.wait:
        estado = wait_until_ready(d)
        if estado == "rearm":
            _output("rearm", "true")
            return 0
        if estado == "late":
            print(f"::error::Resumo do dia {period} não saiu até as {SEND_UNTIL_HOUR}h — não mando mais hoje.")
            return 1
        if a.send and not a.test and notify._already_sent(SOURCE, KIND, period):   # outro job mandou na espera
            print(f"Resumo do dia {period}: já foi enviado — nada a fazer.")
            return 0

    rows = fetch_rows(d)
    subject, body = build(d, rows, acoes_do_dia(d))
    jan = windows(rows)
    print(f"Resumo do dia {period}: {len(jan)} janelas com manchetes ({len(rows)} gravadas no período).")
    if a.html_out:
        with open(a.html_out, "w", encoding="utf-8") as f:
            f.write(body)
        print(f"HTML gravado em {a.html_out}")
    if not a.send:
        return 0
    if not jan:
        print("Nada para mandar (nenhuma janela com manchetes).")
        return 0
    # 2026-11-03: o resumo do dia é um dos DOIS e-mails que vão para o time inteiro (o outro é o
    # dado novo de fonte); o padrão do notify passou a ser só o João.
    to = ([x.strip() for x in a.to.split(",") if x.strip()] if a.to else list(notify.TEAM_RECIPIENTS))
    if a.test:
        ok = notify.send("[TESTE] " + subject, body, to, html=True)
    else:
        ok = notify.once(SOURCE, period, KIND, subject, body, to, html=True)
    if not ok:
        print("::error::e-mail NÃO enviado — o motivo está no aviso 'notify' deste run "
              "(senha de app do Gmail? secrets SMTP_USER / SMTP_PASS).")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
