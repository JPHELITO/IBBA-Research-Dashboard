#!/usr/bin/env python3
"""
update_pulp_secex.py — Exportação de CELULOSE do Brasil por PORTO e por PAÍS, AO VIVO do MDIC.

Torna `secex_pulp_port` e `secex_pulp_country` (pulp_paper.db) AUTOSSUFICIENTES: detecta mês
novo no Comex Stat e atualiza sozinho — fim do Excel manual. Usa os 17 SH6 de celulose do
dicionário, os portos normalizados (_shared/ports.py = iguais aos do dashboard de aço) e o nome
do país em INGLÊS do próprio MDIC (PAIS.csv → NO_PAIS_ING). Fonte fresca (~1 mês de atraso).
O MESMO download alimenta as duas tabelas.

  secex_pulp_port     (period, port)
  secex_pulp_country  (period, country, product)
  As DUAS reconferem o ano corrente + o anterior INTEIROS e gravam só onde o número MUDOU: o
  MDIC revisa o ano corrente, e reescrever igual faria o robô commitar todo dia à toa.
  (Até 30/09/2026 o porto gravava só mês novo — jun/jul-2026 ficaram com o 1º número
  divulgado, julho 19,8 kt acima do revisado. O histórico anterior à janela veio do Excel.)

Produtos (decisão do analista, 2026-09-30) — PRODUCT_SH6 abaixo:
  hardwood   = BKP de fibra curta   470329, 470429
  softwood   = BKP de fibra longa   470321, 470421
  ukp        = não branqueada       470311, 470319, 470411, 470419
  dissolving = solúvel + mecânica   470100, 470200
  other      = o resto (BCTMP 470500 + não-madeira/recuperada 4706xx) — não tem filtro próprio,
               mas entra no Total, senão o total por país não fecharia com o total por porto.

Modos:
  python update_pulp_secex.py --check                     # há mês novo no MDIC?
  python update_pulp_secex.py --update                     # meses novos + janela de revisão (porto e país)
  python update_pulp_secex.py --backfill [--start-year Y]  # recarrega AS DUAS de Y até hoje
  python update_pulp_secex.py --backfill-country [--start-year Y]   # só a tabela por país (1997→)
  python update_pulp_secex.py --reconcile [--months N]     # live x DB + país x porto (sai 1 se divergir)

PULP_DB=<caminho> p/ testar em cópia.
"""
import argparse
import os
import sqlite3
import sys
import time
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

PRODUCT_SH6 = {
    "hardwood":   {"470329", "470429"},
    "softwood":   {"470321", "470421"},
    "ukp":        {"470311", "470319", "470411", "470419"},
    "dissolving": {"470100", "470200"},
}
_PRODUCT_OF = {s: p for p, ss in PRODUCT_SH6.items() for s in ss}

# Nome em inglês do MDIC é o de cartório ("Korea (South), Republic of"); a tela quer o usual.
COUNTRY_SHORT = {
    "Korea (South), Republic of": "South Korea",
    "Korea, Republic of": "South Korea",
    "Taiwan (Formosa)": "Taiwan",
    "United States": "United States",
    "Netherlands (Holland)": "Netherlands",
    "Russian Federation": "Russia",
    "Viet Nam": "Vietnam",
    "Iran, Islamic Republic of": "Iran",
    "Türkiye": "Turkey",
    "Bahrein": "Bahrain",              # grafias do próprio PAIS.csv do MDIC
    "Cote D'Ivore": "Côte d'Ivoire",
    "French Guyana": "French Guiana",
}

REVISE_YEARS = int(os.environ.get("PULP_REVISE_YEARS", "2"))   # ano corrente + o anterior
MAX_SUMICO_FRAC = 0.10   # >10% das linhas "sumindo" da fonte = CSV cortado → não apaga nada
_TRIES = 3


def product_of(sh6):
    return _PRODUCT_OF.get(str(sh6).zfill(6), "other")


def country_map():
    """{CO_PAIS → nome em inglês curto}. Falha de rede → None (o chamador decide)."""
    df = mdic.download_csv(f"{mdic.MDIC_TABS}/PAIS.csv")
    df.columns = [c.strip().strip('"') for c in df.columns]
    out = {}
    for _, r in df.iterrows():
        code = str(r.get("CO_PAIS", "")).strip().strip('"').zfill(3)
        name = str(r.get("NO_PAIS_ING", "") or r.get("NO_PAIS", "")).strip().strip('"')
        out[code] = COUNTRY_SHORT.get(name, name) or "Not defined"
    return out


def _aggregate(df):
    """df MDIC EXP -> ({(period,y,m,port): [kt, usd_mn]}, {(period,y,m,country,product): [kt, usd_mn]})."""
    by_port, by_country = {}, {}
    for _, r in df.iterrows():
        period = str(r["period"]).strip()
        y, m = int(period[:4]), int(period[5:7])
        kt, usd = float(r["kg"]) / 1e6, float(r["usd"]) / 1e6
        a = by_port.setdefault((period, y, m, str(r["port"]).strip() or "Outros"), [0.0, 0.0])
        a[0] += kt; a[1] += usd
        c = by_country.setdefault((period, y, m, str(r["country"]).strip() or "Not defined",
                                   product_of(r["sh6"])), [0.0, 0.0])
        c[0] += kt; c[1] += usd
    return by_port, by_country


def fetch(years, port_map, pais_map):
    """Baixa EXP_{ano} (3 tentativas por ano). Devolve (agg_porto, agg_pais, anos_ok).
    Ano que falhou fica FORA de anos_ok: quem grava não pode tratar ausência como 'zero'."""
    agg_p, agg_c, ok = {}, {}, set()
    for y in years:
        df = None
        for t in range(_TRIES):
            df = mdic.download_mdic_year(y, "exp", PULP_SH6, pais_map=pais_map, port_map=port_map)
            if df is not None:
                break
            print(f"    tentativa {t + 1}/{_TRIES} falhou para {y}")
            time.sleep(5 * (t + 1))
        if df is None:
            print(f"::warning::EXP_{y} não baixou — {y} fica de fora desta rodada")
            continue
        ok.add(y)
        p, c = _aggregate(df)
        for k, v in p.items():
            a = agg_p.setdefault(k, [0.0, 0.0]); a[0] += v[0]; a[1] += v[1]
        for k, v in c.items():
            a = agg_c.setdefault(k, [0.0, 0.0]); a[0] += v[0]; a[1] += v[1]
    return agg_p, agg_c, ok


def _latest(conn):
    row = conn.execute("SELECT MAX(period) FROM secex_pulp_port").fetchone()
    return row[0] if row and row[0] else None


def ensure_country_table(conn):
    conn.execute("""CREATE TABLE IF NOT EXISTS secex_pulp_country (
        period TEXT NOT NULL, year INT, month INT, country TEXT NOT NULL, product TEXT NOT NULL,
        volume_ktons REAL, revenue_usd_mn REAL,
        PRIMARY KEY (period, country, product)) WITHOUT ROWID""")


def _ensure_calendar(conn, periods):
    if not periods:
        return
    ph = ",".join("?" * len(periods))
    existing = {r[0] for r in conn.execute(f"SELECT period FROM calendar WHERE period IN ({ph})",
                                           tuple(periods))}
    cal = [(p, int(p[:4]), int(p[5:7]), working_days(int(p[:4]), int(p[5:7])))
           for p in sorted(periods) if p not in existing]
    if cal:
        conn.executemany("INSERT INTO calendar (period,year,month,working_days) VALUES (?,?,?,?)", cal)


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
    _ensure_calendar(conn, periods)
    conn.commit()
    return len(rows)


def sync_port(conn, agg, years, allow_mass_delete=False):
    """Mesma janela de revisão do país, para secex_pulp_port (tabela sem PK → apaga e reinsere
    só a linha que mudou). Devolve (novas, revisadas, removidas, periodos_tocados)."""
    if not years:
        return 0, 0, 0, set()
    live = {(p, port): (y, m, round(v[0], 3), round(v[1], 3))
            for (p, y, m, port), v in agg.items() if y in years}
    ph = ",".join("?" * len(years))
    db = {(r[0], r[1]): (r[2], r[3]) for r in conn.execute(
        f"SELECT period,port,volume_ktons,revenue_usd_mn FROM secex_pulp_port WHERE year IN ({ph})",
        tuple(years))}
    new = [k for k in live if k not in db]
    rev = [k for k in live if k in db and db[k] != live[k][2:]]
    gone = [k for k in db if k not in live]
    if gone and not allow_mass_delete and len(gone) > MAX_SUMICO_FRAC * max(len(db), 1):
        print(f"::warning::porto: {len(gone)} de {len(db)} linhas sumiriam da fonte — parece CSV "
              f"cortado. Nada é apagado nesta rodada.")
        gone = []
    conn.executemany("DELETE FROM secex_pulp_port WHERE period=? AND port=?", rev + gone)
    conn.executemany("INSERT INTO secex_pulp_port (period,year,month,port,volume_ktons,revenue_usd_mn) "
                     "VALUES (?,?,?,?,?,?)", [(p, *live[(p, port)][:2], port, *live[(p, port)][2:])
                                               for (p, port) in new + rev])
    touched = {k[0] for k in new + rev + gone}
    _ensure_calendar(conn, touched)
    conn.commit()
    return len(new), len(rev), len(gone), touched


def _country_rows(agg, years):
    return {(p, c, prod): (y, m, round(v[0], 3), round(v[1], 3))
            for (p, y, m, c, prod), v in agg.items() if y in years}


def sync_country(conn, agg, years, allow_mass_delete=False):
    """Deixa secex_pulp_country dos `years` igual à fonte, tocando SÓ no que mudou.
    Devolve (novas, revisadas, removidas, periodos_tocados)."""
    ensure_country_table(conn)
    if not years:
        return 0, 0, 0, set()
    live = _country_rows(agg, years)
    ph = ",".join("?" * len(years))
    db = {(r[0], r[1], r[2]): (r[3], r[4]) for r in conn.execute(
        f"SELECT period,country,product,volume_ktons,revenue_usd_mn FROM secex_pulp_country "
        f"WHERE year IN ({ph})", tuple(years))}
    new = [k for k in live if k not in db]
    rev = [k for k in live if k in db and db[k] != live[k][2:]]
    gone = [k for k in db if k not in live]
    if gone and not allow_mass_delete and len(gone) > MAX_SUMICO_FRAC * max(len(db), 1):
        print(f"::warning::{len(gone)} de {len(db)} linhas sumiriam da fonte — parece CSV cortado. "
              f"Nada é apagado nesta rodada.")
        gone = []
    ins = [(p, live[(p, c, pr)][0], live[(p, c, pr)][1], c, pr, *live[(p, c, pr)][2:])
           for (p, c, pr) in new + rev]
    conn.executemany("INSERT OR REPLACE INTO secex_pulp_country "
                     "(period,year,month,country,product,volume_ktons,revenue_usd_mn) "
                     "VALUES (?,?,?,?,?,?,?)", ins)
    conn.executemany("DELETE FROM secex_pulp_country WHERE period=? AND country=? AND product=?", gone)
    touched = {k[0] for k in new + rev + gone}
    _ensure_calendar(conn, touched)
    conn.commit()
    return len(new), len(rev), len(gone), touched


def _write_gh_env(new, period):
    gh = os.environ.get("GITHUB_ENV")
    if not gh:
        return
    with open(gh, "a") as f:
        f.write(f"PULP_NEW_DATA={new}\n")
        if period:
            f.write(f"PULP_LATEST={period}\n")


def reconcile(conn, agg_p, agg_c, months):
    """Três conferências; devolve True se tudo bate (tolerância de arredondamento)."""
    ok = True
    live = {}
    for (p, _, _, _), v in agg_p.items():
        live[p] = live.get(p, 0) + v[0]
    print(f"{'period':9} {'live_kt':>10} {'porto_db':>10} {'pais_db':>10} {'dif_porto%':>11} {'dif_pais%':>10}")
    for p in sorted(live)[-months:]:
        port = conn.execute("SELECT COALESCE(SUM(volume_ktons),0) FROM secex_pulp_port WHERE period=?",
                            (p,)).fetchone()[0]
        ctry = conn.execute("SELECT COALESCE(SUM(volume_ktons),0) FROM secex_pulp_country WHERE period=?",
                            (p,)).fetchone()[0]
        dp = (live[p] - port) / port * 100 if port else float("nan")
        dc = (live[p] - ctry) / ctry * 100 if ctry else float("nan")
        print(f"{p:9} {live[p]:10.1f} {port:10.1f} {ctry:10.1f} {dp:11.2f} {dc:10.2f}")
        if not ctry or abs(dc) > 0.01:
            ok = False
    # célula a célula na tabela por país
    live_c = _country_rows(agg_c, {y for (_, y, _, _, _) in agg_c})
    diffs = 0
    for (p, c, pr), (y, m, kt, usd) in live_c.items():
        r = conn.execute("SELECT volume_ktons,revenue_usd_mn FROM secex_pulp_country "
                         "WHERE period=? AND country=? AND product=?", (p, c, pr)).fetchone()
        if r is None or (r[0], r[1]) != (kt, usd):
            diffs += 1
    print(f"secex_pulp_country: {len(live_c)} células conferidas, {diffs} divergentes")
    return ok and diffs == 0


def main():
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass
    ap = argparse.ArgumentParser(description="secex_pulp_port + secex_pulp_country ao vivo do MDIC")
    ap.add_argument("--check", action="store_true")
    ap.add_argument("--update", action="store_true")
    ap.add_argument("--backfill", action="store_true")
    ap.add_argument("--backfill-country", action="store_true")
    ap.add_argument("--reconcile", action="store_true")
    ap.add_argument("--force", action="store_true")
    ap.add_argument("--start-year", type=int, default=2015)
    ap.add_argument("--months", type=int, default=6)
    args = ap.parse_args()

    now = datetime.utcnow()
    conn = sqlite3.connect(DB_PATH)
    ensure_country_table(conn)
    latest = _latest(conn)
    print(f"DB: {DB_PATH} | secex_pulp_port até {latest} | {len(PULP_SH6)} SH6 de celulose")

    port_map = mdic.build_port_map(mdic.fetch_urf_lookup())
    pais_map = country_map()

    if args.check:
        agg, _, _ = fetch([now.year], port_map, pais_map)
        avail = max((k[0] for k in agg), default=None)
        novo = avail and (latest is None or avail > latest)
        print(f"Disponível no MDIC (EXP {now.year}): {avail} | DB: {latest} => "
              f"{'HÁ MÊS NOVO' if novo else 'sem novidade'}")
        conn.close()
        return

    if args.reconcile:
        agg_p, agg_c, ok_years = fetch([now.year - 1, now.year], port_map, pais_map)
        if not ok_years:
            print("::error::nenhum ano baixou — reconcile NÃO conferiu nada")
            sys.exit(1)
        good = reconcile(conn, agg_p, agg_c, args.months)
        conn.close()
        sys.exit(0 if good else 1)

    if args.backfill or args.backfill_country:
        years = list(range(args.start_year, now.year + 1))
        agg_p, agg_c, ok_years = fetch(years, port_map, pais_map)
        if args.backfill:
            periods = sorted({k[0] for k in agg_p if k[1] in ok_years})
            n = _write_periods(conn, agg_p, periods)
            print(f"[BACKFILL porto] {n} linhas em {len(periods)} períodos")
        n_new, n_rev, n_gone, touched = sync_country(conn, agg_c, ok_years, allow_mass_delete=True)
        print(f"[BACKFILL país] anos {sorted(ok_years)} | novas {n_new} · revisadas {n_rev} · "
              f"removidas {n_gone}")
        conn.execute("VACUUM")
        _write_gh_env("true", max(touched) if touched else None)
    elif args.update:
        years = [now.year - k for k in range(REVISE_YEARS - 1, -1, -1)]
        agg_p, agg_c, ok_years = fetch(years, port_map, pais_map)
        new_periods = sorted({k[0] for k in agg_p if k[1] in ok_years and
                              (latest is None or k[0] > latest)})
        p_new, p_rev, p_gone, p_touched = sync_port(conn, agg_p, ok_years)
        print(f"[UPDATE porto] anos {sorted(ok_years)} | novas {p_new} · revisadas {p_rev} · "
              f"removidas {p_gone} | meses novos: {new_periods or 'nenhum'}")
        n_new, n_rev, n_gone, touched = sync_country(conn, agg_c, ok_years)
        print(f"[UPDATE país] anos {sorted(ok_years)} | novas {n_new} · revisadas {n_rev} · "
              f"removidas {n_gone}")
        changed = bool(p_touched) or bool(touched)
        if changed:
            conn.execute("VACUUM")   # INSERT OR REPLACE/DELETE deixam páginas soltas no arquivo
        latest_now = _latest(conn)
        _write_gh_env("true" if changed else "false", latest_now if changed else None)
    else:
        print("Use --check, --update, --backfill, --backfill-country ou --reconcile.")
    conn.close()
    print("Concluído.")


if __name__ == "__main__":
    main()
