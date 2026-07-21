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
import os
import smtplib
import ssl
import sys
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText

try:
    from registry import DEFAULT_RECIPIENTS, get
except Exception:                       # rodando fora do _shared (fallback)
    DEFAULT_RECIPIENTS = ["jphelito@gmail.com", "joao.helito@itaubba.com"]
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


def main():
    ap = argparse.ArgumentParser(description="Envia e-mail (camada única).")
    ap.add_argument("--kind", choices=["new_data", "alert", "raw"], default="raw")
    ap.add_argument("--source"); ap.add_argument("--period"); ap.add_argument("--detail")
    ap.add_argument("--subject"); ap.add_argument("--body"); ap.add_argument("--body-file")
    ap.add_argument("--to"); ap.add_argument("--html", action="store_true")
    a = ap.parse_args()
    to = [x.strip() for x in a.to.split(",")] if a.to else None
    if a.kind == "new_data":
        if not a.source:
            sys.exit("--source é obrigatório p/ --kind new_data")
        ok = new_data(a.source, a.period, a.detail)
    else:
        body = a.body
        if a.body_file:
            with open(a.body_file, encoding="utf-8") as f:
                body = f.read()
        if not a.subject or body is None:
            sys.exit("--subject e --body/--body-file são obrigatórios")
        ok = (alert(a.subject, body, to) if a.kind == "alert" else send(a.subject, body, to, a.html))
    sys.exit(0 if ok else 0)   # nunca falha o workflow por causa de e-mail


if __name__ == "__main__":
    main()
