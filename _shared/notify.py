# -*- coding: utf-8 -*-
"""notify.py — camada ÚNICA de e-mail da dashboard (smtplib).

Substitui os e-mails espalhados (4 blocos action-send-mail nos workflows + o
send_email do updater_sm.py). Puxa destinatários/rótulo do registro de fontes.

Nunca derruba o workflow: qualquer erro é logado e vira `return False`.

Env: SMTP_USER, SMTP_PASS (app password do Gmail), SMTP_SERVER=smtp.gmail.com, SMTP_PORT=587

Uso (linha de comando, p/ os workflows):
  python _shared/notify.py --kind new_data --source pulp_secex --period 2026-06 \
      [--detail "cron MDIC"]
  python _shared/notify.py --subject "..." --body "..." [--to a@x,b@y] [--html]

Uso (import, p/ o status_digest):
  from notify import send
  send("assunto", "<html>...</html>", html=True)
"""
from __future__ import annotations

import argparse
import json
import os
import smtplib
import ssl
import sys
import urllib.request
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText

try:
    from registry import DEFAULT_RECIPIENTS, get
except Exception:                       # rodando fora do _shared (fallback)
    DEFAULT_RECIPIENTS = ["joao.helito@itaubba.com"]   # 2026-08-03: só o e-mail do Itaú
    def get(_key):  # type: ignore
        return None


def _env(name, default=None):
    v = os.environ.get(name)
    return v if v not in (None, "") else default


def send(subject: str, body: str, to: list[str] | None = None, html: bool = False) -> bool:
    """Envia 1 e-mail. Devolve True/False; NUNCA levanta exceção."""
    user = _env("SMTP_USER"); pw = _env("SMTP_PASS")
    server = _env("SMTP_SERVER", "smtp.gmail.com"); port = int(_env("SMTP_PORT", "587"))
    to = to or DEFAULT_RECIPIENTS
    if not user or not pw:
        print("notify: SMTP_USER/SMTP_PASS ausentes — e-mail ignorado.", file=sys.stderr)
        return False
    msg = MIMEMultipart("alternative")
    msg["Subject"] = subject
    msg["From"] = f"IBBA Dashboard <{user}>"
    msg["To"] = ", ".join(to)
    msg.attach(MIMEText(body, "html" if html else "plain", "utf-8"))
    try:
        ctx = ssl.create_default_context()
        with smtplib.SMTP(server, port, timeout=30) as s:
            s.starttls(context=ctx)
            s.login(user, pw)
            s.sendmail(user, to, msg.as_string())
        print(f"notify: e-mail enviado ({subject!r}) → {', '.join(to)}")
        return True
    except Exception as e:
        print(f"notify: falha ao enviar (ignorado): {e}", file=sys.stderr)
        return False


# ── conveniências cientes do registro ────────────────────────────────────────
_LINK = "https://metals-mining-pulp-paper-dashboard.vercel.app"


def new_data(source_key: str, period: str | None, detail: str | None = None) -> bool:
    """E-mail 'atualização feita / dado novo' de uma fonte (usa o rótulo do registro)."""
    s = get(source_key) or {}
    label = s.get("label", source_key)
    to = s.get("recipients", DEFAULT_RECIPIENTS)
    subject = f"✅ {label} — atualizado" + (f": {period}" if period else "")
    body = (f"A base '{label}' foi atualizada automaticamente.\n\n"
            + (f"Novo período: {period}\n" if period else "")
            + (f"Detalhe: {detail}\n" if detail else "")
            + f"\nDashboard: {_LINK}\n\n— robô IBBA (news/data pipeline)")
    return send(subject, body, to)


def alert(subject: str, body: str, to: list[str] | None = None) -> bool:
    """E-mail de PROBLEMA (fonte atrasada / erro)."""
    return send(f"⚠️ {subject}", body, to)


# ── envio "uma vez só" (anti-spam) — lembra pelo update_log do Supabase ───────
# Como vamos checar de hora em hora, cada e-mail (fonte+mês+tipo) só pode sair 1×.
# Guardamos um registro no update_log já existente: source, method="mail:<kind>",
# detail=<period>. Antes de enviar, olhamos se já existe esse registro. Sem SQL novo.
def _supa(path, method="GET", body=None):
    url = _env("SUPABASE_URL"); key = _env("SUPABASE_SERVICE_KEY")
    if not (url and key):
        return None
    req = urllib.request.Request(url.rstrip("/") + "/rest/v1/" + path, method=method,
        headers={"apikey": key, "Authorization": "Bearer " + key,
                 "Content-Type": "application/json", "Prefer": "return=minimal"},
        data=json.dumps(body).encode() if body is not None else None)
    with urllib.request.urlopen(req, timeout=20) as r:
        raw = r.read()
        return json.loads(raw) if raw else []


def _already_sent(source, kind, period):
    from urllib.parse import quote
    try:
        rows = _supa(f"update_log?source=eq.{quote(source)}&method=eq.{quote('mail:'+kind)}"
                     f"&detail=eq.{quote(period)}&select=id&limit=1")
        return bool(rows)
    except Exception as e:
        print(f"notify.once: não consegui checar dedup ({e}) — envio mesmo assim.", file=sys.stderr)
        return False   # fail-open: melhor um e-mail repetido do que um alerta perdido


def _mark_sent(source, kind, period):
    try:
        _supa("update_log", "POST", {"source": source, "method": "mail:" + kind, "detail": period})
    except Exception as e:
        print(f"notify.once: não consegui marcar dedup ({e}).", file=sys.stderr)


def once(source: str, period: str, kind: str, subject: str, body: str,
         to: list[str] | None = None, html: bool = False) -> bool:
    """Envia UMA vez por (source, period, kind). Repetições no mesmo mês são ignoradas.

    Devolve True tanto quando ENVIA quanto quando PULA por dedup — nos dois casos o aviso
    está resolvido. Só False quando o envio realmente falhou (é o que o --require observa).
    """
    if period and _already_sent(source, kind, period):
        print(f"notify.once: já enviei '{kind}' de {source} {period} — pulando.")
        return True
    ok = send(subject, body, to, html)
    if ok and period:
        _mark_sent(source, kind, period)
    return ok


def main():
    ap = argparse.ArgumentParser(description="Envia e-mail (camada única).")
    ap.add_argument("--source"); ap.add_argument("--period"); ap.add_argument("--kind")
    ap.add_argument("--subject"); ap.add_argument("--body"); ap.add_argument("--body-file")
    ap.add_argument("--to"); ap.add_argument("--html", action="store_true")
    ap.add_argument("--require", action="store_true",
                    help="sai com erro se o e-mail NÃO for enviado — deixa o job VERMELHO e o "
                         "GitHub avisa. Sem isso, falha de SMTP é engolida (default histórico) e "
                         "some no log: foi assim que a senha do Gmail expirou sem ninguém ver.")
    a = ap.parse_args()
    to = [x.strip() for x in a.to.split(",")] if a.to else None
    body = a.body
    if a.body_file:
        with open(a.body_file, encoding="utf-8") as f:
            body = f.read()
    if a.source and a.period and a.kind:
        # e-mail com DEDUP (1× por fonte+mês+tipo) — p/ os workflows horários não spammarem.
        ok = once(a.source, a.period, a.kind, a.subject or f"{a.kind} {a.source} {a.period}",
                  body or "", to, a.html)
    elif a.subject and body is not None:
        ok = send(a.subject, body, to, a.html)
    else:
        sys.exit("uso: --source/--period/--kind (dedup) OU --subject/--body")
    if a.require and not ok:
        print("::error::e-mail NÃO enviado — confira os secrets SMTP_USER / SMTP_PASS "
              "(senha de app do Gmail).", file=sys.stderr)
        sys.exit(1)
    sys.exit(0)   # sem --require, nunca derruba o workflow por causa de e-mail


if __name__ == "__main__":
    main()
