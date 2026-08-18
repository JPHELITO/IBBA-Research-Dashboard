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

O IABr REVISA os ~12 meses anteriores a cada publicação; por isso o --update reconfere
os últimos REVISE_MONTHS meses contra o Excel e regrava o que mudou (não só o mês novo).

Modos:
  python update_iabr.py --check
  python update_iabr.py --update [--force]      # meses novos + revisões dos últimos 18
  python update_iabr.py --backfill              # reconstrói iabr_* a partir do Excel
  python update_iabr.py --reconcile [--months N] # audita TODOS os campos (sai 1 se divergir)

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
NOTICE = os.path.join(HERE, "_iabr_notice.txt")   # corpo do e-mail (não versionado)
PAGE = "https://www.acobrasil.org.br/site/estatistica-mensal/"
SHEET = "Perfomance Mensal-Monthly"   # (sic — typo no arquivo da fonte)
REVISE_MONTHS = 18   # o IABr revisa ~12 meses p/ trás a cada publicação (margem de folga)
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


def _months_back(period, n):
    """'2026-07', 18 -> '2025-02' (começo da janela de revisão)."""
    if not period:
        return None
    y, m = _shift(int(period[:4]), int(period[5:7]), -n)
    return f"{y}-{m:02d}"


def _differs(a, b):
    """Excel x banco, tolerante a None e a arredondamento."""
    if a is None and b is None:
        return False
    if a is None or b is None:
        return True
    return abs(float(a) - float(b)) > 1e-4


def _fmt(v):
    return "—" if v is None else f"{v:,.3f}"


def revision_table(revs, limit=None):
    """Linhas legíveis das revisões (mesmo texto p/ o log e p/ o e-mail)."""
    out = [f"{'mês':9} {'tabela':22} {'campo':14} {'antes':>13} {'depois':>13} {'dif':>8}"]
    rs = sorted(revs, key=lambda r: (r[1], r[0], r[2]))
    for t, p, c, o, n in (rs[:limit] if limit else rs):
        d = (n - o) / o * 100 if (o not in (None, 0) and n is not None) else float("nan")
        out.append(f"{p:9} {t:22} {c:14} {_fmt(o):>13} {_fmt(n):>13} {d:+7.2f}%")
    if limit and len(rs) > limit:
        out.append(f"... (+{len(rs) - limit} linhas)")
    return out


def write(conn, parsed, revise_from=None, all_rows=False):
    """Grava (1) os meses que ainda NÃO existem e (2) as REVISÕES dos meses a partir de
    `revise_from` cujo valor mudou. `all_rows=True` reescreve tudo (backfill/--force).

    ⚠️ O IABr REVISA os ~12 meses anteriores a cada publicação. Até 2026-08 o updater só
    gravava o mês NOVO (`only_after=dbmax`) e as revisões eram descartadas caladas — o
    dashboard congelava no número da 1ª divulgação (medido em 2026-08-18: 65 valores
    defasados entre 2026-02 e 2026-06, até -10,3% em exportações de planos).

    ⚠️ Só toca em linha que mudou DE VERDADE: reescrever valor igual mexeria no
    `updated_at`, o .db viraria "arquivo alterado" e o robô commitaria de hora em hora à toa.

    Devolve (n_linhas, revisões); revisões = [(tabela, período, campo, antes, depois)].
    """
    n_total = 0
    revisions = []
    for t, spec in TABLES.items():
        if not _table_exists(conn, t):
            print(f"  (tabela {t} não existe — pulando)")
            continue
        cols = ["period", "year", "month"] + spec["cols"] + ["updated_at"]
        ph = ",".join("?" * len(cols))
        cur = {r[0]: r[1:] for r in
               conn.execute(f"SELECT period,{','.join(spec['cols'])} FROM {t}")}
        rows = []
        for period, rec in sorted(parsed[t].items()):
            new = [rec[c] for c in spec["cols"]]
            old = cur.get(period)
            if old is not None and not all_rows:
                if revise_from and period < revise_from:
                    continue                                    # fora da janela de revisão
                changed = [(c, o, v) for c, o, v in zip(spec["cols"], old, new) if _differs(o, v)]
                if not changed:
                    continue                                    # idêntico — não mexe
                revisions += [(t, period, c, o, v) for c, o, v in changed]
            rows.append(tuple([rec["period"], rec["year"], rec["month"]] + new + [NOW]))
        if rows:
            conn.executemany(f"INSERT OR REPLACE INTO {t} ({','.join(cols)}) VALUES ({ph})", rows)
            n_total += len(rows)
    conn.commit()
    return n_total, revisions


def latest_db(conn):
    if not _table_exists(conn, "iabr_production"):
        return None
    r = conn.execute("SELECT MAX(period) FROM iabr_production").fetchone()
    return r[0] if r and r[0] else None


def _gh(new, period, revised=0, kind="updated", subject=""):
    gh = os.environ.get("GITHUB_ENV")
    if not gh:
        return
    with open(gh, "a") as f:
        f.write(f"IABR_NEW_DATA={new}\n")
        if period:
            f.write(f"IABR_LATEST={period}\n")
        f.write(f"IABR_REVISED={revised}\n")
        f.write(f"IABR_KIND={kind}\n")
        if subject:
            f.write(f"IABR_SUBJECT={subject}\n")


def notice_file(novo, period, revs):
    """Escreve o corpo do e-mail (o workflow envia com --body-file)."""
    L = [f"A estatística mensal do Aço Brasil de {period} foi lida e publicada no dashboard."
         if novo else
         f"O Aço Brasil REVISOU números de meses já publicados (arquivo de {period})."]
    if revs:
        L += ["", f"{len(revs)} valores revisados retroativamente:", ""] + revision_table(revs, limit=60)
    L += ["", "https://metals-mining-pulp-paper-dashboard.vercel.app/Steel%20and%20Mining/"]
    with open(NOTICE, "w", encoding="utf-8") as f:
        f.write(chr(10).join(L))
    return NOTICE


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
    ap.add_argument("--revise-months", type=int, default=REVISE_MONTHS,
                    help="quantos meses p/ trás reconferir contra o Excel (revisões do IABr)")
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
        # Auditoria COMPLETA: todas as 6 tabelas, todos os campos, últimos N meses.
        # Sai com código 1 se achar divergência → serve de "prova" e de check automático.
        periods = sorted(parsed["iabr_production"])[-args.months:]
        ncampos = sum(len(sp["cols"]) for sp in TABLES.values())
        print(f"Conferindo {len(periods)} meses ({periods[0]}..{periods[-1]}) x {ncampos} campos\n")
        print(f"{'mês':9} {'tabela':22} {'campo':14} {'excel':>13} {'dash':>13} {'dif':>8}")
        bad = 0
        for t, spec in TABLES.items():
            if not _table_exists(conn, t):
                continue
            dbv = {r[0]: dict(zip(spec["cols"], r[1:])) for r in
                   conn.execute(f"SELECT period,{','.join(spec['cols'])} FROM {t}")}
            for p in periods:
                for fld in spec["cols"]:
                    ex = parsed[t].get(p, {}).get(fld)
                    dv = dbv.get(p, {}).get(fld)
                    if not _differs(ex, dv):
                        continue
                    bad += 1
                    d = (dv - ex) / ex * 100 if (ex not in (None, 0) and dv is not None) else float("nan")
                    print(f"{p:9} {t:22} {fld:14} {_fmt(ex):>13} {_fmt(dv):>13} {d:+7.2f}%")
        print(f"\n=> {bad} divergência(s).")
        conn.close()
        sys.exit(1 if bad else 0)

    if args.backfill:
        n, _ = write(conn, parsed, all_rows=True)
        print(f"[BACKFILL] {n} linhas gravadas (todas as iabr_*).")
        notice_file(True, prodmax, [])
        _gh("true", prodmax, kind="updated",
            subject=f"✅ IABr {prodmax} publicado no dashboard")
    elif args.update:
        revise_from = _months_back(prodmax, args.revise_months)
        n, revs = write(conn, parsed, revise_from=revise_from, all_rows=args.force)
        novo = dbmax is None or (prodmax and prodmax > dbmax)
        print(f"[UPDATE] {n} linhas | até {prodmax} | {len(revs)} valores revisados "
              f"(janela desde {revise_from})")
        if revs:
            print("\n".join(revision_table(revs, limit=40)))
        notice_file(novo, prodmax, revs)
        _gh("true" if (novo or revs or args.force) else "false", prodmax,
            revised=len(revs),
            kind="updated" if novo else f"revised-{len(revs)}",
            subject=(f"✅ IABr {prodmax} publicado no dashboard" if novo else
                     f"♻️ IABr — {len(revs)} números revisados pelo Aço Brasil"))
        _overdue_check(dbmax)
    else:
        print("Use --check, --update, --backfill ou --reconcile.")
    conn.close()
    print("Concluído.")


if __name__ == "__main__":
    main()
