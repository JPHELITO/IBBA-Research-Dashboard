#!/usr/bin/env python3
"""
update_iabr.py — Estatística mensal do IABr (Instituto Aço Brasil), AO VIVO do site.

Torna as tabelas `iabr_*` (steel_sm.db) AUTOSSUFICIENTES: acha o Excel mais novo na
página de estatística mensal do Aço Brasil, baixa e mapeia p/ o schema da dashboard.
100% nuvem (sem navegador). Fonte fresca (~1º dia útil do mês).

Página: https://www.acobrasil.org.br/site/estatistica-mensal/
Arquivo: .../uploads/{AAAA}/{MM}/Performance-Mensal_{AAAA}.{MM}.xls (aba única
"Perfomance Mensal-Monthly"): coluna 0 = rótulo PT/EN; col 1 = Jan/2013, mensal contíguo;
a última coluna é % MoM (ignorada).

Modos:
  python update_iabr.py --check
  python update_iabr.py --update [--force]      # grava meses novos
  python update_iabr.py --backfill              # reconstrói iabr_* a partir do Excel
  python update_iabr.py --reconcile [--months N] # compara Excel x dashboard (validação)

SECEX_DB=<caminho> p/ testar em cópia. Requer xlrd (lê .xls).
"""
import argparse
import io
import os
import re
import sqlite3
import sys
import warnings
from datetime import datetime

import pandas as pd
import requests

warnings.filterwarnings("ignore")

HERE = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.environ.get("SECEX_DB") or os.path.join(HERE, "steel_sm.db")
PAGE = "https://www.acobrasil.org.br/site/estatistica-mensal/"
SHEET = "Perfomance Mensal-Monthly"   # (sic — typo no arquivo da fonte)
UA = {"User-Agent": "Mozilla/5.0"}
NOW = datetime.utcnow().isoformat()

# rótulo->linha (0-based) na aba; col 1 = Jan/2013 (mensal contíguo até a penúltima col)
TABLES = {
    "iabr_production":     {"cols": ["crude_steel", "flat", "long_prod", "semi", "slabs", "billets", "pig_iron"],
                            "rows": [7, 9, 10, 11, 12, 13, 14]},
    "iabr_domestic_sales": {"cols": ["total", "flat", "long_prod", "semi"], "rows": [15, 17, 18, 19]},
    "iabr_foreign_market": {"cols": ["total", "flat", "long_prod", "semi"], "rows": [22, 24, 25, 26]},
    "iabr_exports":        {"cols": ["flat_ktons", "long_ktons", "semi_ktons", "total_ktons", "total_usd_mn"],
                            "rows": [32, 33, 34, 37, 38]},
    "iabr_imports":        {"cols": ["flat_ktons", "long_ktons", "semi_ktons", "total_ktons", "total_usd_mn"],
                            "rows": [41, 42, 43, 44, 45]},
    "iabr_consumption":    {"cols": ["total", "flat", "long_prod"], "rows": [46, 47, 48]},
}


def _num(v):
    try:
        f = float(v)
        return None if pd.isna(f) else round(f, 4)
    except (TypeError, ValueError):
        return None


def _period(col_idx):
    """col 1 -> 2013-01; mensal contíguo. Retorna (period 'AAAA-MM', year, month)."""
    n = col_idx - 1
    y, m = 2013 + n // 12, n % 12 + 1
    return f"{y}-{m:02d}", y, m


def find_latest_xls():
    """Acha o Performance-Mensal_AAAA.MM(-N).xls(x) mais novo. Retorna (url, 'AAAA-MM') ou (None, None).
    ⚠️ Tolera o sufixo '-1' que o WordPress põe ao re-subir o arquivo (ex.:
    Performance-Mensal_2026.06-1.xls) — era o que quebrava a raspagem (dado parava
    silenciosamente). NÃO volta a exigir '\\.xls' colado ao mês.
    NÃO levanta exceção: em falha devolve (None, None) p/ não derrubar o job do SECEX."""
    try:
        html = requests.get(PAGE, headers=UA, timeout=60, verify=False).text
    except Exception as e:
        print(f"  [IABr] falha ao abrir a página ({e}).")
        return None, None
    hits = re.findall(r'href="(https?://[^"]*Performance-Mensal_(\d{4})\.(\d{2})(?:-\d+)?\.xlsx?)"', html, re.I)
    if not hits:
        print("  [IABr] não achei o link do Excel na página do Aço Brasil (layout mudou?).")
        return None, None
    url, y, m = max(hits, key=lambda h: (h[1], h[2]))
    return url, f"{y}-{m}"


def parse_xls(content):
    """Retorna {table: {period: {col: valor}}} p/ todos os meses do arquivo."""
    df = pd.ExcelFile(io.BytesIO(content), engine="xlrd").parse(SHEET, header=None)
    ncols = df.shape[1]
    out = {t: {} for t in TABLES}
    for c in range(1, ncols - 1):            # col 1..penúltima (última = % MoM)
        period, y, m = _period(c)
        for t, spec in TABLES.items():
            vals = {col: _num(df.iloc[row, c]) for col, row in zip(spec["cols"], spec["rows"])}
            if any(v is not None for v in vals.values()):
                out[t][period] = {"period": period, "year": y, "month": m, **vals}
    return out


def _table_exists(conn, t):
    return bool(conn.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (t,)).fetchone())


def write(conn, parsed, only_after=None):
    n_total = 0
    for t, spec in TABLES.items():
        if not _table_exists(conn, t):
            print(f"  (tabela {t} não existe — pulando)")
            continue
        cols = ["period", "year", "month"] + spec["cols"] + ["updated_at"]
        ph = ",".join("?" * len(cols))
        rows = []
        for period, rec in sorted(parsed[t].items()):
            if only_after and period <= only_after:
                continue
            rows.append(tuple([rec["period"], rec["year"], rec["month"]] +
                              [rec[c] for c in spec["cols"]] + [NOW]))
        if rows:
            conn.executemany(f"INSERT OR REPLACE INTO {t} ({','.join(cols)}) VALUES ({ph})", rows)
            n_total += len(rows)
    conn.commit()
    return n_total


def latest_db(conn):
    if not _table_exists(conn, "iabr_production"):
        return None
    r = conn.execute("SELECT MAX(period) FROM iabr_production").fetchone()
    return r[0] if r and r[0] else None


def _gh(new, period):
    gh = os.environ.get("GITHUB_ENV")
    if not gh:
        return
    with open(gh, "a") as f:
        f.write(f"IABR_NEW_DATA={new}\n")
        if period:
            f.write(f"IABR_LATEST={period}\n")


def main():
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass
    ap = argparse.ArgumentParser(description="iabr_* ao vivo do site do Aço Brasil")
    ap.add_argument("--check", action="store_true")
    ap.add_argument("--update", action="store_true")
    ap.add_argument("--backfill", action="store_true")
    ap.add_argument("--reconcile", action="store_true")
    ap.add_argument("--force", action="store_true")
    ap.add_argument("--months", type=int, default=6)
    args = ap.parse_args()

    conn = sqlite3.connect(DB_PATH)
    dbmax = latest_db(conn)
    url, xls_period = find_latest_xls()
    print(f"DB: {DB_PATH} | iabr_production até {dbmax} | Excel do site: {xls_period}")

    # Falha da raspagem NÃO derruba o job (era o bug: SystemExit abortava o SECEX inteiro
    # antes do commit). Sinaliza "sem novidade" + erro e sai limpo; o monitoramento (digest/
    # alerta) pega o IABr desatualizado porque é fonte AUTO.
    if not url:
        _gh("false", None)
        gh = os.environ.get("GITHUB_ENV")
        if gh:
            with open(gh, "a") as f:
                f.write("IABR_ERROR=true\n")
        conn.close()
        return
    print(f"  {url}")

    if args.check:
        novo = dbmax is None or xls_period > dbmax
        print(f"=> {'HÁ MÊS NOVO no IABr' if novo else 'sem novidade'}")
        conn.close()
        return

    content = requests.get(url, headers=UA, timeout=120, verify=False).content
    parsed = parse_xls(content)
    prodmax = max(parsed["iabr_production"], default=None)
    print(f"  Excel parseado: produção até {prodmax}")

    if args.reconcile:
        print(f"{'period':9} {'campo':14} {'excel':>11} {'dash':>11} {'dif%':>8}")
        periods = sorted(parsed["iabr_production"])[-args.months:]
        for p in periods:
            for fld in ("crude_steel", "flat", "long_prod"):
                ex = parsed["iabr_production"][p].get(fld)
                row = conn.execute(f"SELECT {fld} FROM iabr_production WHERE period=?", (p,)).fetchone()
                db = row[0] if row else None
                dif = (ex - db) / db * 100 if (ex and db) else float("nan")
                print(f"{p:9} {fld:14} {('' if ex is None else f'{ex:11.1f}')} "
                      f"{('' if db is None else f'{db:11.1f}')} {dif:8.2f}")
        conn.close()
        return

    if args.backfill:
        n = write(conn, parsed)
        print(f"[BACKFILL] {n} linhas gravadas (todas as iabr_*).")
        _gh("true", prodmax)
    elif args.update:
        only_after = None if args.force else dbmax
        n = write(conn, parsed, only_after=only_after)
        novo = dbmax is None or (prodmax and prodmax > dbmax)
        print(f"[UPDATE] {n} linhas | até {prodmax}")
        _gh("true" if (novo or args.force) else "false", prodmax if novo else None)
    else:
        print("Use --check, --update, --backfill ou --reconcile.")
    conn.close()
    print("Concluído.")


if __name__ == "__main__":
    main()
