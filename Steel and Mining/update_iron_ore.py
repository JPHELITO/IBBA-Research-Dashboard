#!/usr/bin/env python3
"""
update_iron_ore.py — Comércio exterior de MINÉRIO DE FERRO do Brasil, AO VIVO do MDIC.

Cria/atualiza `secex_iron_ore` (steel_sm.db): exportação + importação mensais de
Fines (SH6 260111) e Pellets (260112), por país. Fonte fresca (~1 mês), janela rolante
~6 anos. Usa _shared/mdic.py (mesmo Comex Stat do SECEX) — NÃO mexe nas tabelas do
updater_sm.py (isolado p/ não arriscar o pipeline de aço validado).

Modos:
  python update_iron_ore.py --check
  python update_iron_ore.py --update [--force]
  python update_iron_ore.py --backfill [--start-year YYYY]

SECEX_DB=<caminho> p/ testar em cópia.
"""
import argparse
import os
import sqlite3
import sys
from datetime import datetime
from pathlib import Path

HERE = Path(__file__).parent
DB_PATH = Path(os.environ.get("SECEX_DB") or (HERE / "steel_sm.db"))
sys.path.insert(0, str(HERE.parent / "_shared"))
import dictionary as _dict   # noqa: E402
import mdic                  # noqa: E402

NOW = datetime.utcnow().isoformat()
IRON_SH6 = _dict.sh6_set("iron_ore")               # 260111 (Fines), 260112 (Pellets)
RECENT_FROM = f"{datetime.utcnow().year - 6}-01"   # janela rolante ~6 anos


def _product(sh6: str) -> str:
    return _dict.sh6_subcategory(str(sh6).zfill(6), "iron_ore") or "other"  # Fines/Pellets


def ensure_table(conn):
    conn.execute("""CREATE TABLE IF NOT EXISTS secex_iron_ore (
        period TEXT, direction TEXT, product TEXT, country TEXT,
        volume_ktons REAL, revenue_usd_mn REAL,
        PRIMARY KEY (period, direction, product, country)) WITHOUT ROWID""")
    conn.commit()


def _latest(conn):
    r = conn.execute("SELECT MAX(period) FROM secex_iron_ore").fetchone()
    return r[0] if r and r[0] else None


def _aggregate(df, direction, only_after=None):
    agg = {}
    for _, r in df.iterrows():
        period = str(r["period"]).strip()
        if period < RECENT_FROM:
            continue
        if only_after and period <= only_after:
            continue
        sh6 = str(r["sh6"]).strip()
        if sh6 not in IRON_SH6:
            continue
        prod = _product(sh6)
        country = str(r["country"]).strip() or "Outros"
        a = agg.setdefault((period, direction, prod, country), [0.0, 0.0])
        a[0] += float(r["kg"]) / 1e6
        a[1] += float(r["usd"]) / 1e6
    return agg


def fetch(years, pais_map):
    agg = {}
    for y in years:
        for d in ("exp", "imp"):
            df = mdic.download_mdic_year(y, d, IRON_SH6, pais_map=pais_map)
            if df is None:
                continue
            for k, v in _aggregate(df, d).items():
                a = agg.setdefault(k, [0.0, 0.0]); a[0] += v[0]; a[1] += v[1]
    return agg


def upsert(conn, agg):
    rows = [(p, d, prod, c, round(v[0], 6), round(v[1], 6)) for (p, d, prod, c), v in agg.items()]
    conn.executemany("INSERT OR REPLACE INTO secex_iron_ore "
                     "(period,direction,product,country,volume_ktons,revenue_usd_mn) "
                     "VALUES (?,?,?,?,?,?)", rows)
    conn.commit()
    return len(rows)


def _gh(new, period):
    gh = os.environ.get("GITHUB_ENV")
    if not gh:
        return
    with open(gh, "a") as f:
        f.write(f"IRON_NEW_DATA={new}\n")
        if period:
            f.write(f"IRON_LATEST={period}\n")


def main():
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass
    ap = argparse.ArgumentParser(description="secex_iron_ore (Fines/Pellets) ao vivo do MDIC")
    ap.add_argument("--check", action="store_true")
    ap.add_argument("--update", action="store_true")
    ap.add_argument("--backfill", action="store_true")
    ap.add_argument("--force", action="store_true")
    ap.add_argument("--start-year", type=int, default=datetime.utcnow().year - 6)
    args = ap.parse_args()

    now = datetime.utcnow()
    conn = sqlite3.connect(DB_PATH)
    ensure_table(conn)
    latest = _latest(conn)
    print(f"DB: {DB_PATH} | secex_iron_ore até {latest} | SH6 {sorted(IRON_SH6)}")
    pais_map = mdic.fetch_pais_lookup()

    if args.check:
        agg = fetch([now.year], pais_map)
        avail = max((k[0] for k in agg), default=None)
        print(f"MDIC tem até {avail} | DB {latest} => "
              f"{'HÁ MÊS NOVO' if (avail and (latest is None or avail > latest)) else 'sem novidade'}")
        conn.close()
        return

    if args.backfill or latest is None:
        years = list(range(args.start_year, now.year + 1))
        conn.execute("DELETE FROM secex_iron_ore")
        conn.commit()
        agg = fetch(years, pais_map)
        n = upsert(conn, agg)
        per = sorted({k[0] for k in agg})
        print(f"[BACKFILL] {n} linhas | {per[0] if per else '—'}..{per[-1] if per else '—'}")
        _gh("true", per[-1] if per else None)
    elif args.update:
        years = [now.year - 1, now.year] if now.month <= 2 else [now.year]
        agg = fetch(years, pais_map)
        agg = {k: v for k, v in agg.items() if args.force or latest is None or k[0] > latest}
        if not agg:
            print("Nenhum mês novo.")
            _gh("false", None)
            conn.close()
            return
        n = upsert(conn, agg)
        conn.execute("DELETE FROM secex_iron_ore WHERE period < ?", (RECENT_FROM,))  # poda rolante
        conn.commit()
        per = sorted({k[0] for k in agg})
        print(f"[UPDATE] {n} linhas | períodos novos: {per}")
        _gh("true", per[-1])
    else:
        print("Use --check, --update ou --backfill.")
    conn.close()
    print("Concluído.")


if __name__ == "__main__":
    main()
