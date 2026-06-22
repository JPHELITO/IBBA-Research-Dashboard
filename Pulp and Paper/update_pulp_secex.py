#!/usr/bin/env python3
"""
update_pulp_secex.py — Exportação de CELULOSE do Brasil por PORTO, AO VIVO do MDIC.

Torna `secex_pulp_port` (pulp_paper.db) AUTOSSUFICIENTE: detecta mês novo no Comex Stat e
atualiza sozinho — fim do Excel manual. MANTÉM o histórico existente (1997→) e só grava os
meses novos. Usa os 17 SH6 de celulose do dicionário e os portos normalizados
(_shared/ports.py = iguais aos do dashboard de aço). Fonte fresca (~1 mês de atraso).

Modos:
  python update_pulp_secex.py --check                    # há mês novo no MDIC?
  python update_pulp_secex.py --update [--force]          # grava meses novos
  python update_pulp_secex.py --backfill [--start-year Y] # recarrega de Y até hoje
  python update_pulp_secex.py --reconcile [--months N]    # compara live x DB no overlap (validação)

PULP_DB=<caminho> p/ testar em cópia.
"""
import argparse
import os
import sqlite3
import sys
from datetime import datetime
from pathlib import Path

HERE = Path(__file__).parent
DB_PATH = Path(os.environ.get("PULP_DB") or (HERE / "pulp_paper.db"))
sys.path.insert(0, str(HERE.parent / "_shared"))
import dictionary as _dict   # noqa: E402
import mdic                  # noqa: E402
sys.path.insert(0, str(HERE))
from extractor_pp import working_days  # noqa: E402

PULP_SH6 = _dict.sh6_set("pulp")   # 17 SH6 de celulose (4701..4706)


def _aggregate(df):
    """df MDIC EXP (com sh6/port) -> {(period,year,month,port): [kton, USD_mn]}."""
    agg = {}
    for _, r in df.iterrows():
        period = str(r["period"]).strip()
        y, m = int(period[:4]), int(period[5:7])
        port = str(r["port"]).strip() or "Outros"
        a = agg.setdefault((period, y, m, port), [0.0, 0.0])
        a[0] += float(r["kg"]) / 1e6
        a[1] += float(r["usd"]) / 1e6
    return agg


def fetch(years, port_map):
    agg = {}
    for y in years:
        df = mdic.download_mdic_year(y, "exp", PULP_SH6, port_map=port_map)
        if df is None:
            continue
        for k, v in _aggregate(df).items():
            a = agg.setdefault(k, [0.0, 0.0]); a[0] += v[0]; a[1] += v[1]
    return agg


def _latest(conn):
    row = conn.execute("SELECT MAX(period) FROM secex_pulp_port").fetchone()
    return row[0] if row and row[0] else None


def _write_periods(conn, agg, periods):
    """Substitui (DELETE+INSERT) secex_pulp_port + completa calendar dos períodos dados.
    (secex_pulp_port/calendar não têm PK → DELETE antes de inserir evita duplicar.)"""
    if not periods:
        return 0
    ph = ",".join("?" * len(periods))
    conn.execute(f"DELETE FROM secex_pulp_port WHERE period IN ({ph})", tuple(periods))
    rows = [(p, y, m, port, round(v[0], 3), round(v[1], 3))
            for (p, y, m, port), v in agg.items() if p in periods]
    conn.executemany("INSERT INTO secex_pulp_port (period,year,month,port,volume_ktons,revenue_usd_mn) "
                     "VALUES (?,?,?,?,?,?)", rows)
    existing = {r[0] for r in conn.execute(f"SELECT period FROM calendar WHERE period IN ({ph})", tuple(periods))}
    cal = []
    for p in periods:
        if p in existing:
            continue
        y, m = int(p[:4]), int(p[5:7])
        cal.append((p, y, m, working_days(y, m)))
    if cal:
        conn.executemany("INSERT INTO calendar (period,year,month,working_days) VALUES (?,?,?,?)", cal)
    conn.commit()
    return len(rows)


def _write_gh_env(new, period):
    gh = os.environ.get("GITHUB_ENV")
    if not gh:
        return
    with open(gh, "a") as f:
        f.write(f"PULP_NEW_DATA={new}\n")
        if period:
            f.write(f"PULP_LATEST={period}\n")


def main():
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass
    ap = argparse.ArgumentParser(description="secex_pulp_port ao vivo do MDIC")
    ap.add_argument("--check", action="store_true")
    ap.add_argument("--update", action="store_true")
    ap.add_argument("--backfill", action="store_true")
    ap.add_argument("--reconcile", action="store_true")
    ap.add_argument("--force", action="store_true")
    ap.add_argument("--start-year", type=int, default=2015)
    ap.add_argument("--months", type=int, default=6)
    args = ap.parse_args()

    now = datetime.utcnow()
    conn = sqlite3.connect(DB_PATH)
    latest = _latest(conn)
    print(f"DB: {DB_PATH} | secex_pulp_port até {latest} | {len(PULP_SH6)} SH6 de celulose")

    if args.check:
        port_map = mdic.build_port_map(mdic.fetch_urf_lookup())
        agg = fetch([now.year], port_map)
        avail = max((k[0] for k in agg), default=None)
        novo = avail and (latest is None or avail > latest)
        print(f"Disponível no MDIC (EXP {now.year}): {avail} | DB: {latest} => "
              f"{'HÁ MÊS NOVO' if novo else 'sem novidade'}")
        conn.close()
        return

    port_map = mdic.build_port_map(mdic.fetch_urf_lookup())

    if args.reconcile:
        agg = fetch([now.year - 1, now.year], port_map)
        live = {}
        for (p, _, _, _), v in agg.items():
            live[p] = live.get(p, 0) + v[0]
        print(f"{'period':9} {'live_kt':>11} {'db_kt':>11} {'dif%':>8}")
        for p in sorted(live)[-args.months:]:
            db = conn.execute("SELECT COALESCE(SUM(volume_ktons),0) FROM secex_pulp_port WHERE period=?",
                              (p,)).fetchone()[0]
            dif = (live[p] - db) / db * 100 if db else float("nan")
            print(f"{p:9} {live[p]:11.1f} {db:11.1f} {dif:8.2f}")
        conn.close()
        return

    if args.backfill:
        years = list(range(args.start_year, now.year + 1))
        agg = fetch(years, port_map)
        periods = sorted({k[0] for k in agg})
        n = _write_periods(conn, agg, periods)
        print(f"[BACKFILL] {n} linhas em {len(periods)} períodos "
              f"({periods[0] if periods else '—'}..{periods[-1] if periods else '—'})")
        _write_gh_env("true", periods[-1] if periods else None)
    elif args.update:
        years = [now.year - 1, now.year] if now.month <= 2 else [now.year]
        agg = fetch(years, port_map)
        new_periods = sorted({k[0] for k in agg if args.force or latest is None or k[0] > latest})
        if not new_periods:
            print("Nenhum mês novo.")
            _write_gh_env("false", None)
            conn.close()
            return
        n = _write_periods(conn, agg, new_periods)
        print(f"[UPDATE] {n} linhas | períodos novos: {new_periods}")
        _write_gh_env("true", new_periods[-1])
    else:
        print("Use --check, --update, --backfill ou --reconcile.")
    conn.close()
    print("Concluído.")


if __name__ == "__main__":
    main()
