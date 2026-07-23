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

sys.path.insert(0, os.path.join(HERE, "..", "_shared"))
try:
    import notify
except Exception:
    notify = None

_MESES_PT = {"janeiro": 1, "fevereiro": 2, "março": 3, "marco": 3, "abril": 4, "maio": 5,
             "junho": 6, "julho": 7, "agosto": 8, "setembro": 9, "outubro": 10,
             "novembro": 11, "dezembro": 12}

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


def fetch_page():
    """HTML da página de estatística mensal (ou None em falha de rede)."""
    try:
        return requests.get(PAGE, headers=UA, timeout=60, verify=False).text
    except Exception as e:
        print(f"  [IABr] falha ao abrir a página ({e}).")
        return None


def file_link(html):
    """Acha o Performance-Mensal_AAAA.MM(-N).xls(x) mais novo → (url, 'AAAA-MM') ou (None, None).
    ⚠️ Tolera o sufixo '-N' que o WordPress põe ao re-subir (ex.: ...2026.06-1.xls) — era o que
    quebrava a raspagem (o dado parava calado)."""
    hits = re.findall(r'href="(https?://[^"]*Performance-Mensal_(\d{4})\.(\d{2})(?:-\d+)?\.xlsx?)"', html, re.I)
    if not hits:
        print("  [IABr] não achei o link do Excel na página (layout mudou?).")
        return None, None
    url, y, m = max(hits, key=lambda h: (h[1], h[2]))
    return url, f"{y}-{m}"


def heading_period(html):
    """Lê o cabeçalho 'MÊS ANO - PRODUÇÃO BRASILEIRA' → 'AAAA-MM' (ou None). Sinal robusto do
    mês mais novo, INDEPENDENTE do nome do arquivo (é como o humano confere no site)."""
    m = re.search(r'\b(janeiro|fevereiro|mar[çc]o|abril|maio|junho|julho|agosto|setembro|'
                  r'outubro|novembro|dezembro)\s+(\d{4})\s*[-–—]\s*produ', html, re.I)
    if not m:
        return None
    mes = _MESES_PT.get(m.group(1).lower())
    return f"{m.group(2)}-{mes:02d}" if mes else None


# Mapa por RÓTULO (tolera reordenação/inserção de linhas). Cada seção tem um ÂNCORA único
# (col 0) e, dentro dela, as sublinhas por rótulo. sub=None → o valor está na própria linha
# do âncora (ex.: Vendas Internas = total). Os rótulos "Planos/Longos/Semiacabados" repetem
# entre seções, por isso são buscados SÓ dentro da faixa da seção.
LABEL_SECTIONS = [
    ("iabr_production", r"Produ[çc][aã]o\s*/\s*Production",
     {"crude_steel": r"A[çc]o Bruto", "flat": r"Planos", "long_prod": r"Longos",
      "semi": r"Semiacabados", "slabs": r"Placas", "billets": r"Blocos e Tarugos",
      "pig_iron": r"Ferro-Gusa"}),
    ("iabr_domestic_sales", r"Vendas Internas",
     {"total": None, "flat": r"Planos", "long_prod": r"Longos", "semi": r"Semiacabados"}),
    ("iabr_foreign_market", r"Vendas Externas",
     {"total": None, "flat": r"Planos", "long_prod": r"Longos", "semi": r"Semiacabados"}),
    ("iabr_exports", r"Exporta[çc][õo]es\s*/\s*Exports",
     {"flat_ktons": r"Planos", "long_ktons": r"Longos", "semi_ktons": r"Semiacabados",
      "total_ktons": r"Total\s*\(Mil t", "total_usd_mn": r"US\$\s*Milh[õo]es"}),
    ("iabr_imports", r"Importa[çc][õo]es\s*/\s*Imports",
     {"flat_ktons": r"Planos", "long_ktons": r"Longos", "semi_ktons": r"Semiacabados",
      "total_ktons": r"Total\s*\(Mil t", "total_usd_mn": r"US\$\s*Milh[õo]es"}),
    ("iabr_consumption", r"Consumo Aparente",
     {"total": None, "flat": r"Planos", "long_prod": r"Longos"}),
]


def resolve_rows(df):
    """{table: {col: row_idx}} achado pelos RÓTULOS (col 0), ancorado por seção → tolera
    reordenação/inserção de linhas. Cai no índice FIXO (TABLES) p/ qualquer linha que não achar."""
    labels = [str(df.iloc[i, 0] or "") for i in range(df.shape[0])]

    def find(rgx, lo, hi):
        for i in range(max(lo, 0), min(hi, len(labels))):
            if re.search(rgx, labels[i], re.I):
                return i
        return None

    anchors = {t: find(a, 0, len(labels)) for t, a, _ in LABEL_SECTIONS}
    order = sorted(a for a in anchors.values() if a is not None)
    resolved = {t: dict(zip(spec["cols"], spec["rows"])) for t, spec in TABLES.items()}  # base = fixo
    for tbl, _arx, cols in LABEL_SECTIONS:
        a = anchors.get(tbl)
        if a is None:
            print(f"  [IABr] âncora da seção '{tbl}' não achada — uso índices fixos p/ ela.")
            continue
        after = [x for x in order if x > a]
        end = after[0] if after else len(labels)
        for col, srgx in cols.items():
            row = a if srgx is None else find(srgx, a + 1, end)
            if row is not None:
                resolved[tbl][col] = row
    return resolved


def parse_xls(content):
    """Retorna {table: {period: {col: valor}}} p/ todos os meses do arquivo.
    Linhas resolvidas por RÓTULO (resolve_rows) → tolera reordenação."""
    df = pd.ExcelFile(io.BytesIO(content), engine="xlrd").parse(SHEET, header=None)
    rows_by_table = resolve_rows(df)
    ncols = df.shape[1]
    out = {t: {} for t in TABLES}
    for c in range(1, ncols - 1):            # col 1..penúltima (última = % MoM)
        period, y, m = _period(c)
        for t in TABLES:
            vals = {col: _num(df.iloc[row, c]) for col, row in rows_by_table[t].items()}
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


def _shift(y, m, d):
    i = y * 12 + (m - 1) + d
    return i // 12, i % 12 + 1


def _mail(kind, period, subject, body):
    if notify:
        try:
            notify.once("iabr", period, kind, subject, body)
        except Exception as e:
            print(f"  (e-mail '{kind}' ignorado: {e})")


def _overdue_check(dbmax):
    """IABr publica o mês anterior na 2ª/3ª semana. Se passou do dia 25 e o dashboard ainda não
    tem o esperado (atual − 1), avisa (1×/mês)."""
    now = datetime.utcnow()
    if now.day < 25:
        return
    ey, em = _shift(now.year, now.month, -1)
    exp = f"{ey}-{em:02d}"
    if dbmax is None or dbmax < exp:
        _mail("overdue", exp, f"⚠️ IABr ainda sem {exp}",
              f"Já é dia {now.day} e o dashboard não tem o IABr de {exp} (mais novo no dash: {dbmax}). "
              f"Costuma sair na 2ª/3ª semana.\nPágina: {PAGE}")


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
    html = fetch_page()
    url, xls_period = file_link(html) if html else (None, None)
    head_period = heading_period(html) if html else None
    site_period = max([p for p in (xls_period, head_period) if p], default=None)
    print(f"DB: iabr até {dbmax} | site: cabeçalho {head_period} / arquivo {xls_period}")

    if args.check:
        novo = bool(site_period and (dbmax is None or site_period > dbmax))
        print(f"=> {'HÁ MÊS NOVO no IABr' if novo else 'sem novidade'}")
        conn.close()
        return

    # detecção: mês novo no site (cabeçalho OU arquivo) → e-mail "saiu o dado" (1×/mês)
    if site_period and (dbmax is None or site_period > dbmax):
        _mail("detected", site_period, f"📄 Saiu o IABr de {site_period}",
              f"O Aço Brasil publicou a estatística de {site_period}. Vou baixar e publicar.\n{PAGE}")

    # descompasso: o site já ANUNCIA um mês que o link do arquivo ainda não reflete → avisa
    if head_period and (not xls_period or head_period > xls_period):
        _mail("review", head_period, f"⚠️ IABr {head_period} no site, mas o arquivo não atualizou",
              f"O cabeçalho do site já mostra {head_period}, mas o link do Excel ainda está em "
              f"{xls_period or '—'}. Pode ser demora deles ou o nome do arquivo mudou — NÃO publiquei "
              f"esse mês.\nPágina: {PAGE}")

    # Falha/ausência do arquivo NÃO derruba o job (bug antigo: SystemExit abortava o SECEX).
    if not url:
        _gh("false", None)
        gh = os.environ.get("GITHUB_ENV")
        if gh:
            with open(gh, "a") as f:
                f.write("IABR_ERROR=true\n")
        _overdue_check(dbmax)
        conn.close()
        return
    print(f"  {url}")

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
        _overdue_check(dbmax)
    else:
        print("Use --check, --update, --backfill ou --reconcile.")
    conn.close()
    print("Concluído.")


if __name__ == "__main__":
    main()
