# -*- coding: utf-8 -*-
"""daily_digest_mail.py — RESUMO DO DIA por e-mail para o time (2026-10-28).

O QUE FAZ
  Junta os "resumos da última hora" da Home — a tabela `news_digest`, que o robô do
  news-hunter (hunter/digest.py) grava de hora em hora — num e-mail só, às 18h (Brasília),
  para os 4 do time (registry.DEFAULT_RECIPIENTS), pela camada única notify.py.
  O texto é o MESMO que a Home mostra: nenhuma IA é chamada aqui.

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
  (28/10/2026: o Gmail derrubou a conexão do runner na porta 587 — o notify tenta a 465).

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

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import notify  # noqa: E402  (camada única de e-mail)

BRT = timezone(timedelta(hours=-3))         # o Brasil não tem horário de verão desde 2019
CUT_HOUR = 18                               # o e-mail cobre até as 18h e sai às 18h
LAST_SLOT_WAIT_MIN = 45                     # espera a janela das 17–18h até 18:45 (o robô desiste às 18:40)
SEND_UNTIL_HOUR = 22                        # depois disso, não manda mais no dia
MAX_SLEEP_S = 4 * 3600 + 50 * 60            # 4h50: cabe no job de 6 h com a espera da última janela
SOURCE, KIND = "daily_digest", "daily"      # a marca do "já mandei hoje" no update_log
WD = ["Segunda", "Terça", "Quarta", "Quinta", "Sexta", "Sábado", "Domingo"]
TAKE = {"+": ("(+)", "#16a34a"), "-": ("(−)", "#c0392b"), "=": ("(=)", "#111111")}
F = "font-family:Arial,Helvetica,sans-serif;"


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


# ── o e-mail ───────────────────────────────────────────────────────────────────────────────────
def _dt(s) -> datetime:
    return datetime.fromisoformat(str(s).replace("Z", "+00:00")).astimezone(BRT)


def _e(s) -> str:
    return html.escape(str(s or ""), quote=True)


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
        titulo = (f'<a href="{_e(url)}" style="color:#1a4c8b;text-decoration:none">{titulo}</a>')
    fonte = f' <span style="color:#737373">— {_e(it.get("source"))}</span>' if it.get("source") else ""
    tick = ", ".join(_e(t) for t in (it.get("tickers") or []) if t)
    tick = f' <b style="color:#111111">({tick})</b>' if tick else ""
    sinal, cor = TAKE.get(it.get("take"), ("", ""))
    take = f' <b style="color:{cor}">{sinal}</b>' if sinal else ""
    return (f'<tr><td width="14" valign="top" style="{F}font-size:13px;line-height:19px;color:#737373">•</td>'
            f'<td valign="top" style="{F}font-size:13px;line-height:19px;color:#111111;padding-bottom:3px">'
            f'{titulo}{fonte}{tick}{take}</td></tr>')


def build(d: date, rows: list) -> tuple:
    """(assunto, html) do e-mail do dia `d`."""
    start, end = bounds(d)
    jan = windows(rows)
    n_man = sum(len(r.get("items") or []) for r in jan)
    subject = f"Resumo do dia — notícias S&M, P&P e NR — {d:%d/%m/%Y}"

    corpo, dia_atual = [], None
    for r in jan:
        dia = _dt(r["slot_end"]).date()              # a madrugada (20h→7h) conta para o dia em que termina
        if dia != dia_atual:
            dia_atual = dia
            corpo.append(
                f'<tr><td style="padding:20px 24px 2px 24px">'
                f'<table width="100%" cellpadding="0" cellspacing="0" border="0"><tr>'
                f'<td style="{F}font-size:14px;font-weight:bold;color:#111111;padding-bottom:5px;'
                f'border-bottom:1px solid #D6D1C9">{WD[dia.weekday()]}, {dia:%d/%m}</td></tr></table></td></tr>')
        resumo = (r.get("summary") or "").strip() if r.get("status") == "ok" else ""
        texto = (f'<p style="margin:0 0 6px 0;{F}font-size:14px;line-height:21px;color:#111111">{_e(resumo)}</p>'
                 if resumo else
                 f'<p style="margin:0 0 6px 0;{F}font-size:12px;line-height:18px;color:#737373">'
                 f'<i>Sem resumo automático nesta hora — as manchetes:</i></p>')
        linhas = "".join(_headline(it) for it in (r.get("items") or []) if isinstance(it, dict))
        corpo.append(
            f'<tr><td style="padding:12px 24px 2px 24px">'
            f'<p style="margin:0 0 4px 0;{F}font-size:12px;font-weight:bold;color:#FF5000">{_e(_label(r))}</p>'
            f'{texto}'
            f'<table width="100%" cellpadding="0" cellspacing="0" border="0">{linhas}</table></td></tr>')

    if not jan:
        corpo.append(f'<tr><td style="padding:20px 24px;{F}font-size:14px;color:#111111">'
                     'Nenhuma notícia relevante no período.</td></tr>')

    intro = (f"Os resumos de hora em hora da Home, das {start:%H}h de {WD[start.weekday()].lower()} "
             f"({start:%d/%m}) às {end:%H}h de {WD[end.weekday()].lower()} ({end:%d/%m}), horário de Brasília"
             f" · {len(jan)} {'janela' if len(jan) == 1 else 'janelas'} · {n_man} "
             f"{'manchete' if n_man == 1 else 'manchetes'}.")
    corpo_html = "".join(corpo)
    body = f"""<!DOCTYPE html>
<html lang="pt-BR"><head><meta charset="utf-8"><meta name="color-scheme" content="light">
<title>{_e(subject)}</title></head>
<body style="margin:0;padding:0;background:#ffffff">
<table width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#ffffff" style="background:#ffffff"><tr><td align="center">
<table width="640" cellpadding="0" cellspacing="0" border="0" bgcolor="#ffffff" style="width:640px;background:#ffffff">
<tr><td bgcolor="#111111" style="background:#111111;padding:16px 24px 14px 24px">
<p style="margin:0;{F}font-size:11px;color:#bdbdbd;letter-spacing:1px">ITAÚ BBA · EQUITY RESEARCH · LATAM S&amp;M, P&amp;P &amp; NR</p>
<p style="margin:4px 0 0 0;{F}font-size:22px;font-weight:bold;color:#ffffff">Resumo do dia</p>
<p style="margin:2px 0 0 0;{F}font-size:13px;color:#ffffff">{WD[d.weekday()]}, {d:%d/%m/%Y}</p>
</td></tr>
<tr><td height="3" bgcolor="#FF5000" style="background:#FF5000;height:3px;font-size:1px;line-height:1px">&nbsp;</td></tr>
<tr><td style="padding:14px 24px 0 24px;{F}font-size:12px;line-height:18px;color:#737373">{_e(intro)}</td></tr>
{corpo_html}
<tr><td style="padding:22px 24px 22px 24px">
<table width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
<td style="{F}font-size:11px;line-height:16px;color:#8c8c8c;border-top:1px solid #e3e3e3;padding-top:10px">
Resumos escritos automaticamente (IA) só a partir dos títulos das notícias — os mesmos da coluna
"Last hour" da Home. Confira a matéria antes de usar. (+) / (−) / (=) = leitura para as empresas cobertas.
<a href="{_e(notify._LINK)}" style="color:#1a4c8b;text-decoration:none">Abrir a dashboard</a>
</td></tr></table></td></tr>
</table></td></tr></table>
</body></html>"""
    return subject, body


# ── linha de comando ───────────────────────────────────────────────────────────────────────────
def _output(name: str, value: str) -> None:
    p = os.environ.get("GITHUB_OUTPUT")
    if p:
        with open(p, "a", encoding="utf-8") as f:
            f.write(f"{name}={value}\n")


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
    subject, body = build(d, rows)
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
    to = [x.strip() for x in a.to.split(",") if x.strip()] if a.to else None
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
