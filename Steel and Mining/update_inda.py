# -*- coding: utf-8 -*-
"""update_inda.py — INDA (distribuição de aço plano) automático, do In Data.

O INDA publica o "In Data" (PDF, TEXTO) por mês na área de associados. Descobrimos
que o PDF em si é PÚBLICO (só o link fica atrás do login) → o robô acha o PDF direto
pela URL; o login (INDA_CREDENTIALS) é só reserva. Fluxo:
  acha o In Data mais novo (URL do padrão /uploads/AAAA/MM/In-Data-<Mês>-<Ano>.pdf,
  com login como fallback) → baixa o PDF → o Gemini lê o TEXTO (pág. 2/10/12) →
  2 CHECKSUMS (soma dos produtos = estoque total; giro ≈ estoque/vendas) → grava só o
  mês novo em inda_distribution (calcula sales_ltm=soma12m e sales_ma3=média3m da série)
  → 3 e-mails (detecção/atualizado/erro), 1× por mês.

Modos:
  python update_inda.py --check
  python update_inda.py --update
  python update_inda.py --dry-run [--pdf X.pdf] [--period AAAA-MM]
SECEX_DB=<caminho> p/ testar em cópia. Env: GEMINI_API_KEY, INDA_CREDENTIALS (fallback).
"""
from __future__ import annotations

import argparse
import datetime
import json
import os
import re
import sqlite3
import sys
import warnings
from pathlib import Path

warnings.filterwarnings("ignore")
import requests

HERE = Path(__file__).resolve().parent
DB_PATH = Path(os.environ.get("SECEX_DB") or (HERE / "steel_sm.db"))
UA = {"User-Agent": "Mozilla/5.0"}
BASE = "https://www.inda.org.br"
UPLOADS = BASE + "/wp-content/uploads"
MEMBERS = BASE + "/associados-estatisticas/"
GEMINI_MODEL = os.environ.get("GEMINI_MODEL", "gemini-3.1-flash-lite")
GEMINI_KEY = os.environ.get("GEMINI_API_KEY", "")
VISION_MODELS = list(dict.fromkeys([m.strip() for m in (os.environ.get("INDA_VISION_MODELS")
                     or f"{GEMINI_MODEL},gemini-3.1-flash").split(",") if m.strip()]))

sys.path.insert(0, str(HERE.parent / "_shared"))
try:
    import notify
except Exception:
    notify = None

MESES = {1: "Janeiro", 2: "Fevereiro", 3: "Marco", 4: "Abril", 5: "Maio", 6: "Junho",
         7: "Julho", 8: "Agosto", 9: "Setembro", 10: "Outubro", 11: "Novembro", 12: "Dezembro"}
MESES_ACC = {3: "Março"}
_MES_NUM = {v.lower(): k for k, v in MESES.items()}
_MES_NUM.update({v.lower(): k for k, v in MESES_ACC.items()})

PROMPT = ("Do texto do relatório In-Data (INDA — distribuição de aço plano no Brasil), extraia os "
 "números do MÊS de referência (o mais recente). Responda APENAS JSON: {\"year\":,\"month\":,"
 "\"inventories\":,\"inv_months\":,\"sales\":,\"purchases\":,\"inv_yoy\":,"
 "\"breakdown\":{\"chapa_grossa\":,\"laminados_quente\":,\"laminados_frio\":,\"zincados\":}}. "
 "inventories=estoque TOTAL (mil t), inv_months=giro de estoque (meses), sales=vendas (mil t), "
 "purchases=compras (mil t), inv_yoy=variação % do estoque total vs o mesmo mês do ano anterior, "
 "breakdown=estoque por produto (mil t). Milhar com ponto vira decimal: 1.156,9 -> 1156.9; "
 "vírgula decimal: 3,4 -> 3.4; sinais negativos preservados.\n\nTEXTO:\n")


# ── descoberta do PDF do mês mais novo ────────────────────────────────────────
def _shift(y, m, d):
    idx = y * 12 + (m - 1) + d
    return idx // 12, idx % 12 + 1


def _head_ok(url):
    try:
        r = requests.head(url, headers=UA, timeout=25, verify=False, allow_redirects=True)
        return r.status_code == 200 and "pdf" in (r.headers.get("content-type", "").lower())
    except Exception:
        return False


def _url_for_month(dy, dm):
    """URL do In Data de um mês de DADO específico (proba as pastas de publicação prováveis)."""
    now = datetime.datetime.utcnow()
    names = [MESES[dm]] + ([MESES_ACC[dm]] if dm in MESES_ACC else [])
    pubs, seen = [], set()
    for f in (2, 1, 3):                           # pasta de publicação ~ dado+2 (±1)
        pubs.append(_shift(dy, dm, f))
    pubs += [(now.year, now.month), _shift(now.year, now.month, -1)]
    for py, pm in pubs:
        if (py, pm) in seen or (py, pm) < (2019, 1):
            continue
        seen.add((py, pm))
        for name in names:
            for suf in ("", "-1", "-2"):
                u = f"{UPLOADS}/{py}/{pm:02d}/In-Data-{name}-{dy}{suf}.pdf"
                if _head_ok(u):
                    return u
    return None


def find_via_url():
    """O In Data mais novo disponível (newest-first: now-1, now-2, now-3)."""
    now = datetime.datetime.utcnow()
    for dback in (1, 2, 3):
        dy, dm = _shift(now.year, now.month, -dback)
        u = _url_for_month(dy, dm)
        if u:
            return f"{dy}-{dm:02d}", u
    return None, None


def find_new_months(dash):
    """[(period, url)] de TODOS os meses > dash até o mais novo, EM ORDEM (mais antigo primeiro).
    Preencher todos evita BURACO na série (senão MA3/LTM saem errados)."""
    newest, _ = find_via_url()
    if not newest:
        return []
    ny, nm = int(newest[:4]), int(newest[5:7])
    cy, cm = (_shift(int(dash[:4]), int(dash[5:7]), 1) if dash else _shift(ny, nm, -11))
    out = []
    while (cy * 12 + cm) <= (ny * 12 + nm):
        u = _url_for_month(cy, cm)
        if u:
            out.append((f"{cy}-{cm:02d}", u))
        cy, cm = _shift(cy, cm, 1)
    return out


def find_via_login():
    """Fallback: loga (INDA_CREDENTIALS) e lê o link exato do In Data mais novo."""
    try:
        creds = json.loads(os.environ.get("INDA_CREDENTIALS", "") or "{}")
    except Exception:
        creds = {}
    if not creds.get("username"):
        return None, None
    try:
        s = requests.Session(); s.headers.update(UA); s.verify = False
        s.get(BASE + "/wp-login.php", timeout=40)
        r = s.post(BASE + "/wp-login.php", timeout=40, data={
            "log": creds["username"], "pwd": creds["password"], "rememberme": "forever",
            "wp-submit": "Acessar", "testcookie": "1", "redirect_to": MEMBERS})
        if "wp-login" in r.url or re.search(r"erro|não está corret|inv[aá]lid", r.text[:2000], re.I):
            print("  [INDA] login falhou.")
            return None, None
        html = s.get(MEMBERS, timeout=40).text
        best = (None, None)
        for u in re.findall(r'href=["\']([^"\']*[Ii]n[-_]?[Dd]ata[^"\']*\.pdf)["\']', html):
            m = re.search(r'[Ii]n[-_]?[Dd]ata-([A-Za-zçÇ]+)-(\d{4})', u)
            if not m:
                continue
            mn = _MES_NUM.get(m.group(1).lower())
            if not mn:
                continue
            per = f"{m.group(2)}-{mn:02d}"
            if best[0] is None or per > best[0]:
                best = (per, u if u.startswith("http") else BASE + u)
        return best
    except Exception as e:
        print(f"  [INDA] fallback de login deu erro ({e}).")
        return None, None


def find_latest():
    per, url = find_via_url()
    if per:
        return per, url, "url"
    per, url = find_via_login()          # reserva
    return per, url, ("login" if per else None)


# ── extração (Gemini no TEXTO) + escalonamento ────────────────────────────────
def pdf_text(pdf_bytes, pages=(2, 10, 12)):
    from pypdf import PdfReader
    import io
    r = PdfReader(io.BytesIO(pdf_bytes))
    return "\n".join(f"[PAGINA {p}]\n" + (r.pages[p - 1].extract_text() or "")
                     for p in pages if p <= len(r.pages))


def gemini_extract(text, model=None):
    if not GEMINI_KEY:
        raise RuntimeError("GEMINI_API_KEY ausente.")
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{model or GEMINI_MODEL}:generateContent"
    body = {"contents": [{"parts": [{"text": PROMPT + text}]}],
            "generationConfig": {"temperature": 0, "response_mime_type": "application/json"}}
    r = requests.post(url, headers={"x-goog-api-key": GEMINI_KEY, "Content-Type": "application/json"},
                      data=json.dumps(body), timeout=120)
    r.raise_for_status()
    t = r.json()["candidates"][0]["content"]["parts"][0]["text"]
    return json.loads(re.sub(r"^```(json)?|```$", "", t.strip(), flags=re.I | re.M).strip())


def verify(d):
    """2 checksums independentes. Lista vazia = passou."""
    probs = []
    inv = d.get("inventories"); sales = d.get("sales"); giro = d.get("inv_months")
    b = d.get("breakdown") or {}
    parts = [b.get(k) for k in ("chapa_grossa", "laminados_quente", "laminados_frio", "zincados")]
    if inv is not None and all(p is not None for p in parts):
        if abs(sum(parts) - inv) > 1.6:
            probs.append(f"soma dos produtos {sum(parts):.1f} ≠ estoque total {inv}")
    else:
        probs.append("faltou o breakdown de estoque por produto")
    if inv and sales and giro is not None:
        calc = inv / sales
        if abs(calc - giro) > 0.2:
            probs.append(f"giro calc {calc:.2f} (estoque/vendas) ≠ impresso {giro}")
    return probs


def extract_with_escalation(pdf_bytes):
    text = pdf_text(pdf_bytes)
    d, probs, model = None, ["não rodou"], None
    for model in VISION_MODELS:
        try:
            d = gemini_extract(text, model)
        except Exception as e:
            d, probs = None, [f"erro de extração ({model}): {e}"]; continue
        probs = verify(d)
        if not probs:
            return d, [], model
        print(f"  {model}: {len(probs)} checagem(ns) falharam → escalando…")
    return d, probs, model


# ── colunas calculadas (validadas contra o banco) ─────────────────────────────
def compute_derived(conn, period, sales):
    """sales_ma3 = média dos 3 últimos meses; sales_ltm = soma dos 12 últimos. Da série + o novo."""
    rows = conn.execute("SELECT period, sales FROM inda_distribution WHERE period < ? ORDER BY period",
                        (period,)).fetchall()
    ser = {p: s for p, s in rows if s is not None}
    ser[period] = sales
    ps = sorted(ser)
    i = ps.index(period)
    last3 = [ser[ps[j]] for j in range(max(0, i - 2), i + 1)]
    last12 = [ser[ps[j]] for j in range(max(0, i - 11), i + 1)]
    ma3 = round(sum(last3) / len(last3), 4) if last3 else None
    ltm = round(sum(last12), 4) if last12 else None
    return ma3, ltm


def _easter(y):
    a = y % 19; b = y // 100; c = y % 100; d = b // 4; e = b % 4; f = (b + 8) // 25
    g = (b - f + 1) // 3; h = (19 * a + b - d - g + 15) % 30; i = c // 4; k = c % 4
    l = (32 + 2 * e + 2 * i - h - k) % 7; m = (a + 11 * h + 22 * l) // 451
    mo = (h + l - 7 * m + 114) // 31; da = ((h + l - 7 * m + 114) % 31) + 1
    return datetime.date(y, mo, da)


def working_days(y, m):
    e = _easter(y)
    hol = {datetime.date(y, mn, dd) for mn, dd in
           [(1, 1), (4, 21), (5, 1), (9, 7), (10, 12), (11, 2), (11, 15), (12, 25)]}
    hol |= {e - datetime.timedelta(days=x) for x in (2, 47, 48)} | {e + datetime.timedelta(days=60)}
    if y >= 2024:
        hol.add(datetime.date(y, 11, 20))
    d = datetime.date(y, m, 1); n = 0
    while d.month == m:
        if d.weekday() < 5 and d not in hol:
            n += 1
        d += datetime.timedelta(days=1)
    return n


INDA_COLS = ["period", "year", "month", "inventories", "inv_months", "purchases", "sales",
             "working_days", "inv_yoy", "hist_avg", "sales_ltm", "sales_ma3", "updated_at"]


def write_period(conn, period, d):
    y, m = int(period[:4]), int(period[5:7])
    ma3, ltm = compute_derived(conn, period, d.get("sales"))
    row = {"period": period, "year": y, "month": m,
           "inventories": d.get("inventories"), "inv_months": d.get("inv_months"),
           "purchases": d.get("purchases"), "sales": d.get("sales"),
           "working_days": working_days(y, m), "inv_yoy": d.get("inv_yoy"),
           "hist_avg": None, "sales_ltm": ltm, "sales_ma3": ma3,
           "updated_at": datetime.datetime.utcnow().isoformat()}
    conn.execute("DELETE FROM inda_distribution WHERE period=?", (period,))
    conn.execute(f"INSERT INTO inda_distribution ({','.join(INDA_COLS)}) "
                 f"VALUES ({','.join('?' * len(INDA_COLS))})", [row[c] for c in INDA_COLS])
    conn.commit()
    return ma3, ltm


def dash_latest(conn):
    r = conn.execute("SELECT MAX(period) FROM inda_distribution").fetchone()
    return r[0] if r and r[0] else None


def _gh(**kv):
    gh = os.environ.get("GITHUB_ENV")
    if gh:
        with open(gh, "a") as f:
            for k, v in kv.items():
                f.write(f"{k}={v}\n")


def _mail(kind, period, subject, body):
    if notify:
        try:
            notify.once("inda_distribution", period, kind, subject, body)
        except Exception as e:
            print(f"  (e-mail '{kind}' ignorado: {e})")


def _overdue_check(site_period):
    """INDA publica o dado de ~2 meses atrás, entre os dias 15-31. Se passou do dia 28 e a
    fonte ainda não tem o esperado (mês atual − 2), avisa (1× por período esperado)."""
    now = datetime.datetime.utcnow()
    if now.day < 28:
        return
    y, m = _shift(now.year, now.month, -2)
    exp = f"{y}-{m:02d}"
    if site_period is None or site_period < exp:
        _mail("overdue", exp, f"⚠️ INDA ainda não publicou {exp}",
              f"Já é dia {now.day} e o INDA não publicou o In Data de {exp} (mais novo achado: {site_period}). "
              f"Costuma sair entre os dias 15 e 31.\nÁrea: {MEMBERS}")


def main():
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass
    ap = argparse.ArgumentParser(description="INDA automático (In Data PDF)")
    ap.add_argument("--check", action="store_true")
    ap.add_argument("--update", action="store_true")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--pdf", help="PDF local (teste)")
    ap.add_argument("--period", help="período do PDF local (AAAA-MM)")
    args = ap.parse_args()

    conn = sqlite3.connect(DB_PATH)
    dash = dash_latest(conn)

    if args.pdf:
        d, probs, model = extract_with_escalation(Path(args.pdf).read_bytes())
        period = args.period or (f"{d['year']}-{int(d['month']):02d}" if d and d.get("year") else None)
        print(f"  período: {period} | modelo: {model} | checagens falhas: {len(probs)}")
        for p in probs[:8]:
            print("   · " + p)
        if not probs and period:
            ma3, ltm = compute_derived(conn, period, d.get("sales"))
            print(f"  extraído: estoque={d['inventories']} giro={d['inv_months']} vendas={d['sales']} "
                  f"compras={d['purchases']} | calc: MA3={ma3} LTM={ltm}")
            if not args.dry_run:
                write_period(conn, period, d); print(f"  gravado {period}.")
        conn.close(); return

    newest, _url, via = find_latest()
    print(f"INDA mais novo: {newest} (via {via}) | dashboard: {dash}")
    if args.check:
        novo = bool(newest and (dash is None or newest > dash))
        print("MÊS NOVO disponível" if novo else "em dia")
        _gh(INDA_NEW="true" if novo else "false", INDA_SITE=newest or "", INDA_DASH=dash or "")
        conn.close(); return

    _overdue_check(newest)
    pend = find_new_months(dash)          # TODOS os meses faltando, do mais antigo ao mais novo
    if not pend:
        print("Sem mês novo — em dia."); _gh(INDA_NEW_DATA="false"); conn.close(); return

    print(f"  {len(pend)} mês(es) novo(s) a preencher: {[p for p, _ in pend]}")
    published = []
    for period, url in pend:
        _mail("detected", period, f"📄 Saiu o INDA de {period}",
              f"O INDA publicou o In Data de {period}. Vou ler o PDF e, se conferir, publicar.\n{url}")
        try:
            pdf_bytes = requests.get(url, headers=UA, timeout=120, verify=False).content
        except Exception as e:
            print(f"  {period}: download falhou ({e}) — paro aqui."); break
        d, probs, model = extract_with_escalation(pdf_bytes)
        if d is None or probs:
            print(f"  ⚠️ {period}: não passou ({model}) — PARO (mantém a série contígua).")
            for p in probs[:8]:
                print("   · " + p)
            _mail("review", period, f"⚠️ INDA {period} precisa de conferência",
                  f"Li o In Data de {period} (modelos {VISION_MODELS}), mas os checksums não bateram. "
                  f"NÃO publiquei (e parei p/ não deixar buraco na série).\nProblemas:\n- "
                  + "\n- ".join(probs[:8]) + f"\nPDF: {url}")
            _gh(INDA_REVIEW="true", INDA_SITE=period)
            break
        ma3, ltm = write_period(conn, period, d)
        print(f"  ✅ {period} gravado (estoque {d['inventories']}, giro {d['inv_months']}, "
              f"MA3 {ma3}, LTM {ltm}) [{model}].")
        published.append((period, model))

    if published:
        _gh(INDA_NEW_DATA="true", INDA_LATEST=published[-1][0], INDA_MODEL=published[-1][1])
    else:
        _gh(INDA_NEW_DATA="false")
    conn.close()


if __name__ == "__main__":
    main()
