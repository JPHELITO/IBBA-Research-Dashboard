# -*- coding: utf-8 -*-
"""status_digest.py — o "panorama de tudo" por e-mail.

Lê o registro de fontes (registry.py), pergunta a cada uma qual o estado atual e
manda UM e-mail com todas numa tabela: como puxa, última atualização, próximo
esperado, e um farol 🟢/🟡/🔴. É o "me deixe atualizado" num lugar só.

Como sabe o estado:
  • fontes de .db (steel/pulp): abre o arquivo committado e lê MAX(period).
  • feeds ao vivo (Supabase): lê o timestamp mais recente (updated_at / found_at).

Dois modos:
  python _shared/status_digest.py --digest   # SEMPRE manda o panorama (cron semanal)
  python _shared/status_digest.py --alert    # só manda se algo estiver 🔴 (roda mais vezes)
  python _shared/status_digest.py --print     # só imprime no terminal (não envia) — p/ testar

Env: SUPABASE_URL, SUPABASE_SERVICE_KEY (p/ os feeds ao vivo), SMTP_USER/SMTP_PASS (p/ enviar).
"""
from __future__ import annotations

import argparse
import calendar
import os
import sqlite3
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import registry  # noqa: E402
import notify    # noqa: E402

try:
    import requests
except ImportError:
    requests = None

ROOT = Path(__file__).resolve().parent.parent      # raiz do repo do frontend
LINK = "https://metals-mining-pulp-paper-dashboard.vercel.app"

GREEN, AMBER, RED, GREY = "🟢", "🟡", "🔴", "⚪"


def _period_end(period: str) -> datetime | None:
    """'2026-06' → 30/06/2026 23:59 (UTC). Fim do mês do período."""
    try:
        y, m = int(period[:4]), int(period[5:7])
        last = calendar.monthrange(y, m)[1]
        return datetime(y, m, last, 23, 59, tzinfo=timezone.utc)
    except Exception:
        return None


def _next_period(period: str) -> str:
    try:
        y, m = int(period[:4]), int(period[5:7])
        return f"{y + 1}-01" if m == 12 else f"{y}-{m + 1:02d}"
    except Exception:
        return "—"


def _db_latest(sector: str, table: str, period_col: str):
    """Abre o .db committado e lê MAX(period_col). Devolve (period, erro)."""
    rel = registry.DB_PATHS.get(sector)
    if not rel:
        return None, "sem caminho de db"
    path = ROOT / rel
    if not path.exists():
        return None, "arquivo não encontrado"
    try:
        con = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
        row = con.execute(f'SELECT MAX("{period_col}") FROM "{table}"').fetchone()
        con.close()
        return (row[0] if row else None), None
    except Exception as e:
        return None, str(e)[:60]


def _supabase_fresh(table: str, col: str):
    """Timestamp mais recente de um feed ao vivo no Supabase. Devolve (dt, erro)."""
    url = os.environ.get("SUPABASE_URL", "").rstrip("/")
    key = os.environ.get("SUPABASE_SERVICE_KEY", "")
    if not (url and key and requests):
        return None, "sem SUPABASE_URL/KEY"
    try:
        r = requests.get(f"{url}/rest/v1/{table}?select={col}&order={col}.desc&limit=1",
                         headers={"apikey": key, "Authorization": f"Bearer {key}"}, timeout=25)
        data = r.json()
        if not data:
            return None, "vazio"
        raw = data[0].get(col)
        return datetime.fromisoformat(raw.replace("Z", "+00:00")), None
    except Exception as e:
        return None, str(e)[:60]


def evaluate(now: datetime) -> list[dict]:
    """Avalia cada fonte → dict com status/farol/detalhes p/ a tabela do e-mail."""
    out = []
    for s in registry.all_sources():
        row = {"src": s, "farol": GREY, "status": "—", "ultimo": "—", "proximo": "—"}
        if s["cadence"] == "monthly":
            period, err = _db_latest(s["db"], s["table"], s["period_col"])
            if err or not period:
                row.update(farol=GREY, status=f"sem leitura ({err or 'vazio'})")
            else:
                end = _period_end(period)
                age = (now - end).days if end else 999
                row["ultimo"] = period
                row["proximo"] = f"{_next_period(period)}"
                over = s.get("overdue_days", 45)
                if age <= over:
                    row.update(farol=GREEN, status=f"em dia ({age}d)")
                elif age <= over + 20:
                    row.update(farol=AMBER, status=f"aguardando ({age}d)")
                else:
                    row.update(farol=RED, status=f"ATRASADO ({age}d)")
        else:  # live
            dt, err = _supabase_fresh(s["table"], s.get("fresh_col", "updated_at"))
            if err or not dt:
                row.update(farol=GREY, status=f"sem leitura ({err or 'vazio'})")
            else:
                mins = max(0.0, (now - dt).total_seconds() / 60)
                row["ultimo"] = dt.astimezone(timezone.utc).strftime("%d/%m %H:%M UTC")
                row["proximo"] = "contínuo"
                lim = s.get("stale_min", 240)
                # "há 30442 min" não é leitura p/ ninguém: minutos até 2 h, horas até 2 dias, depois dias
                ago = (f"{mins:.0f} min" if mins < 120 else f"{mins/60:.0f} h" if mins < 2880 else f"{mins/1440:.0f} d")
                if mins <= lim:
                    row.update(farol=GREEN, status=f"vivo (há {ago})")
                elif mins <= lim * 2:
                    row.update(farol=AMBER, status=f"lento (há {ago})")
                else:
                    row.update(farol=RED, status=f"PARADO (há {ago})")
        out.append(row)
    return out


def publish_status(rows: list[dict], now: datetime) -> int:
    """Grava o panorama na tabela `data_source_status` (Supabase) — é o que a página "Data"
    da dashboard mostra ao CLIENTE (via RPC get_data_source_status). Uma linha por fonte,
    upsert por key. Nunca levanta; devolve quantas gravou.

    Por que aqui e não no navegador: o "até quando vai o dado" de cada base mensal é o
    MAX(period) do .db committado — ler isso no cliente custaria baixar 46 MB. O robô lê no
    Actions (segundos) e publica um resumo de 17 linhas.
    """
    url = os.environ.get("SUPABASE_URL", "").rstrip("/")
    key = os.environ.get("SUPABASE_SERVICE_KEY", "")
    if not (url and key and requests):
        print("publish: sem SUPABASE_URL/KEY — nada gravado.")
        return 0
    state_of = {GREEN: "green", AMBER: "amber", RED: "red", GREY: "grey"}
    # o status é escrito em português p/ o e-mail interno; o cliente lê em inglês
    def _en(txt: str) -> str:
        t = txt or ""
        for pt, en in (("em dia", "on schedule"), ("aguardando", "waiting"), ("ATRASADO", "overdue"),
                       ("vivo (há", "live ("), ("lento (há", "slow ("), ("PARADO (há", "stalled ("),
                       ("sem leitura", "no reading"), (" min)", " min ago)"), (" h)", " h ago)"), (" d)", " d ago)"),
                       ("vazio", "empty"), ("sem SUPABASE_URL/KEY", "not measured")):
            t = t.replace(pt, en)
        return t
    payload = []
    for r in rows:
        s = r["src"]
        payload.append({
            "key": s["key"],
            "label": s.get("client_label") or s["label"],
            "client_desc": s.get("client_desc") or "",
            "client_cadence": s.get("client_cadence") or "",
            "sector": s["sector"],
            "cadence": s["cadence"],
            "how_pulled": registry.COMO_PUXA.get(s.get("how_pulled"), s.get("how_pulled") or ""),
            "auto": bool(s.get("auto")),
            "state": state_of.get(r["farol"], "grey"),
            "status_text": _en(r["status"]),
            "last_period": None if r["ultimo"] == "—" else r["ultimo"],
            "next_expected": None if r["proximo"] == "—" else r["proximo"],
            "checked_at": now.isoformat(),
        })
    try:
        resp = requests.post(f"{url}/rest/v1/data_source_status?on_conflict=key",
                             headers={"apikey": key, "Authorization": f"Bearer {key}",
                                      "Content-Type": "application/json",
                                      "Prefer": "resolution=merge-duplicates,return=minimal"},
                             json=payload, timeout=40)
        if not resp.ok:
            print(f"publish: HTTP {resp.status_code} {resp.text[:200]} (rodou admin/supabase_data_page.sql?)")
            return 0
        print(f"publish: {len(payload)} fontes gravadas em data_source_status")
        return len(payload)
    except Exception as e:  # noqa: BLE001
        print(f"publish falhou (ignorado): {e}")
        return 0


def _html(rows: list[dict], now: datetime) -> str:
    def sec_rows(sector, titulo):
        rs = [r for r in rows if r["src"]["sector"] == sector]
        if not rs:
            return ""
        trs = ""
        for r in rs:
            s = r["src"]
            man = "" if s.get("auto") else " <span style='color:#b45309'>· manual</span>"
            trs += (f"<tr><td>{r['farol']} <b>{s['label']}</b>{man}</td>"
                    f"<td>{registry.COMO_PUXA.get(s['how_pulled'], s['how_pulled'])}</td>"
                    f"<td>{r['ultimo']}</td><td>{r['proximo']}</td><td>{r['status']}</td></tr>")
        return (f"<tr><td colspan=5 style='background:#f4f3f0;font-weight:700;padding:6px 8px'>{titulo}</td></tr>"
                + trs)
    style = ("table{border-collapse:collapse;width:100%;font:13px Arial,sans-serif}"
             "td{border-bottom:1px solid #e3e3e3;padding:5px 8px;vertical-align:top}"
             "th{text-align:left;padding:5px 8px;color:#8c8c8c;font-size:11px;text-transform:uppercase}")
    head = "<tr><th>Fonte</th><th>Como puxa</th><th>Última</th><th>Próximo</th><th>Status</th></tr>"
    reds = sum(1 for r in rows if r["farol"] == RED)
    ambers = sum(1 for r in rows if r["farol"] == AMBER)
    resumo = (f"{reds} 🔴 · {ambers} 🟡 · {sum(1 for r in rows if r['farol']==GREEN)} 🟢"
              f" · {sum(1 for r in rows if r['farol']==GREY)} ⚪")
    return (f"<html><head><style>{style}</style></head><body>"
            f"<h2 style='font:600 18px Arial'>Panorama das fontes — {now.strftime('%d/%m/%Y')}</h2>"
            f"<p style='color:#555'>{resumo}</p>"
            f"<table>{head}"
            + sec_rows('steel', 'Steel &amp; Mining')
            + sec_rows('pulp', 'Pulp &amp; Paper')
            + sec_rows('live', 'Ao vivo (cotações · commodities · macro · notícias)')
            + f"</table><p style='color:#8c8c8c;font-size:11px;margin-top:14px'>"
            f"🟢 em dia · 🟡 aguardando/lento · 🔴 atrasado/parado · ⚪ sem leitura. "
            f"Dashboard: {LINK}</p></body></html>")


def main():
    ap = argparse.ArgumentParser(description="Panorama das fontes por e-mail")
    ap.add_argument("--digest", action="store_true", help="sempre envia o panorama")
    ap.add_argument("--alert", action="store_true", help="só envia se houver 🔴")
    ap.add_argument("--print", dest="only_print", action="store_true", help="só imprime, não envia")
    ap.add_argument("--publish", action="store_true",
                    help="grava o panorama em data_source_status (página Data do cliente); combina com os outros")
    a = ap.parse_args()
    now = datetime.now(timezone.utc)
    rows = evaluate(now)

    # terminal (sempre) — resumo legível
    for r in rows:
        s = r["src"]
        print(f"  {r['farol']} {s['label'][:34]:34} {r['ultimo']:16} {r['status']}")
    reds = [r for r in rows if r["farol"] == RED]
    print(f"\n  {len(reds)} atrasada(s)/parada(s).")

    if a.publish:
        publish_status(rows, now)
    if a.only_print or (a.publish and not (a.digest or a.alert)):
        return
    html = _html(rows, now)
    if a.digest:
        notify.send(f"📊 Panorama das fontes — {now.strftime('%d/%m/%Y')}", html, html=True)
    elif a.alert:
        # Alerta SÓ para fontes AUTOMÁTICAS vermelhas (uma quebra de verdade). As manuais
        # (INDA/IBÁ/etc.) ficam cronicamente atrasadas até serem automatizadas — alertar delas
        # toda vez seria spam; elas aparecem no panorama semanal (--digest). Lição do "spam de cobertura".
        auto_reds = [r for r in reds if r["src"].get("auto")]
        if auto_reds:
            nomes = ", ".join(r["src"]["label"] for r in auto_reds)
            notify.send(f"⚠️ Fonte automática com problema: {nomes}", html, html=True)
        else:
            print("  (nenhuma fonte AUTOMÁTICA 🔴 — nenhum alerta enviado.)")
    else:
        print("  Use --digest, --alert ou --print.")


if __name__ == "__main__":
    main()
