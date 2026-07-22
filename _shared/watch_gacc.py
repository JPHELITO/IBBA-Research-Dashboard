# -*- coding: utf-8 -*-
"""watch_gacc.py — vigia do GACC (cavaco China) + linha preta China×SECEX.

NÃO acessa o portal da alfândega (tem WAF + CAPTCHA — exige você). Em vez disso usa o
CALENDÁRIO: a China publica o detalhado por HS×país ~dia 18-20 do mês seguinte. Se o
dashboard está atrás do esperado, manda 1 e-mail (dedup 1×/mês no update_log) com o link
do portal e a lista de meses que faltam — pra você só baixar e rodar o montar_gacc.py.

Roda na nuvem (GitHub Actions). Lê o pulp_paper.db committado (MAX(period) do GACC).
Env: SMTP_USER, SMTP_PASS, SUPABASE_URL, SUPABASE_SERVICE_KEY (dedup).
"""
from __future__ import annotations
import argparse, datetime, os, sqlite3, sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(HERE))
try:
    import notify
    from registry import DB_PATHS
except Exception:
    notify = None
    DB_PATHS = {"pulp": "Pulp and Paper/pulp_paper.db"}

DB = Path(os.environ.get("PULP_DB") or (ROOT / DB_PATHS["pulp"]))
# link de consulta do portal (o mesmo que você usa; ajuste o período na tela + resolva o puzzle)
PORTAL = ("http://stats.customs.gov.cn/queryDataForEN/queryDataByWhereEn?iEType=1&currencyType=usd"
          "&codeLength=8&outerField1=CODE_TS&outerField2=ORIGIN_COUNTRY&monthFlag=1"
          "&outerValue1=44011100,44011200,44012100,44012200")


def _shift(y, m, d):
    i = y * 12 + (m - 1) + d
    return i // 12, i % 12 + 1


def _months_after(a, b):
    """meses de (a exclusivo) até (b inclusivo), 'AAAA-MM'."""
    ay, am = int(a[:4]), int(a[5:7]); by, bm = int(b[:4]), int(b[5:7])
    out = []; y, m = _shift(ay, am, 1)
    while y * 12 + (m - 1) <= by * 12 + (bm - 1):
        out.append(f"{y}-{m:02d}"); y, m = _shift(y, m, 1)
    return out


def gacc_latest():
    if not DB.exists():
        return None
    con = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
    try:
        r = con.execute("SELECT MAX(period) FROM gacc_woodchips").fetchone()
        return r[0] if r and r[0] else None
    finally:
        con.close()


def expected_latest(now=None):
    """Mês mais recente que JÁ DEVE estar disponível no portal (regra de calendário)."""
    now = now or datetime.datetime.utcnow()
    back = 1 if now.day >= 20 else 2      # ~dia 18-20 sai o mês anterior; antes disso, 2 atrás
    y, m = _shift(now.year, now.month, -back)
    return f"{y}-{m:02d}"


def main():
    ap = argparse.ArgumentParser(description="Vigia do GACC (cavaco China)")
    ap.add_argument("--print", action="store_true", help="só mostra o estado, não manda e-mail")
    args = ap.parse_args()

    dash = gacc_latest()
    exp = expected_latest()
    faltam = _months_after(dash, exp) if dash else []
    print(f"GACC — dashboard: {dash} | esperado disponível: {exp} | faltam: {faltam or '—'}")

    if args.print or not faltam:
        if not faltam:
            print("em dia (nada a avisar).")
        return

    # avisa 1×/mês por 'expected' (dedup)
    lista = ", ".join(faltam)
    subject = f"📦 GACC (cavaco China): provavelmente saiu até {exp} — hora de atualizar"
    body = (
        f"O dashboard está com o GACC até {dash}, e pela data de hoje já deve ter saído o "
        f"detalhado até {exp}.\n\nMeses que faltam: {lista}\n\n"
        f"Passo a passo (rápido):\n"
        f"1) Abra o portal e baixe o CSV do(s) mês(es) que faltam (resolva o puzzle):\n   {PORTAL}\n"
        f"2) Rode:  python montar_gacc.py     (ele lê o CSV e monta o pulp_paper.db)\n"
        f"3) Suba o pulp_paper.db pelo github (a dashboard atualiza em ~1 min).\n\n"
        f"Obs.: se o portal ainda não tiver o mês, é só esperar alguns dias — a China às vezes "
        f"atrasa a divulgação do detalhado.\n— robô IBBA (vigia GACC)")
    if notify:
        try:
            notify.once("gacc", exp, "available", subject, body)
        except Exception as e:
            print(f"(e-mail ignorado: {e})")
    else:
        print("(notify indisponível — e-mail não enviado)")


if __name__ == "__main__":
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass
    main()
