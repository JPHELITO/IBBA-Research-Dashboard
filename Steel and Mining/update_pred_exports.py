#!/usr/bin/env python3
"""
update_pred_exports.py — LINHA PRETA do modelo preditivo (autossuficiente).

Exportações de aço de CHINA + COREIA p/ o BRASIL, mensais, nos SH6 classificados
como ANTIDUMPING no dicionário (_shared/dictionary_codes.csv → 55 SH6). Alimenta a
tabela `pred_exports` em steel_sm.db. É o indicador que ANTECIPA as importações
brasileiras (linha laranja `import_prediction`) — ambas usam o MESMO conjunto de
SH6 antidumping (decisão do usuário 2026-06-19), p/ comparação maçã-com-maçã.

Fonte: UN Comtrade API.
  - Com COMTRADE_KEY (grátis, registrado em comtradeplus.un.org): endpoint final,
    100k linhas/chamada, 500 chamadas/dia.
  - Sem chave: preview público (500 linhas/chamada, 100 chamadas/dia) — chunk menor.

Modos:
  python update_pred_exports.py --check                 # último período DB vs Comtrade
  python update_pred_exports.py --update [--force]      # puxa meses novos -> pred_exports
  python update_pred_exports.py --backfill [--start-year YYYY]   # recarrega a janela

⚠️ FALLBACK / HISTÓRICO APENAS. Descoberto em 2026-06-19 que o Comtrade está defasado
demais (China ~2024-12; Coreia ~2025-12) vs. as fontes nativas frescas. A fonte PRIMÁRIA
da linha preta é `update_korea.py` (Coreia, API data.go.kr) + o robô nativo da China.
Este script NÃO roda em cron; use só p/ backfill histórico ou validação cruzada. Usa
INSERT OR IGNORE → NUNCA sobrescreve dado nativo fresco já presente.
"""
import argparse
import os
import sqlite3
import sys
import time
from datetime import datetime
from pathlib import Path

try:
    import requests
except ImportError:
    sys.exit("Faltando dependência: pip install requests")

HERE = Path(__file__).parent
DB_PATH = Path(os.environ.get("SECEX_DB") or (HERE / "steel_sm.db"))  # SECEX_DB p/ testar em cópia
sys.path.insert(0, str(HERE.parent / "_shared"))
import dictionary as _dict  # noqa: E402

NOW = datetime.utcnow().isoformat()

# ── Comtrade ─────────────────────────────────────────────────────────────────────
COMTRADE_KEY = os.environ.get("COMTRADE_KEY", "").strip()
BASE_FINAL   = "https://comtradeapi.un.org/data/v1/get/C/M/HS"        # precisa de chave
BASE_PREVIEW = "https://comtradeapi.un.org/public/v1/preview/C/M/HS"  # keyless, 500 linhas
REPORTERS    = {"156": "China", "410": "Korea"}   # M49: China=156, Rep. da Coreia=410
PARTNER_BR   = "76"
FLOW_EXPORT  = "X"
CHUNK_MONTHS = 12 if COMTRADE_KEY else 6          # períodos por chamada (cabe no teto de linhas)
SLEEP_S      = 0.5 if COMTRADE_KEY else 6.0        # respeita o rate-limit (keyless é apertado)

AD_SH6 = sorted(_dict.antidumping_sh6_set())       # 55 SH6 antidumping
DEFAULT_START_YEAR = datetime.utcnow().year - 8    # ~8 anos de histórico p/ o modelo


def _subcat(sh6: str) -> str:
    """SH6 -> subcategoria do dicionário (hrc/crc/coated/...); 'other' se não mapear."""
    return _dict.sh6_subcategory(str(sh6).zfill(6), "steel") or "other"


def _ym_list(start_ym: str, end_ym: str) -> list:
    """['YYYYMM', ...] de start..end inclusive (entradas 'YYYY-MM')."""
    sy, sm = map(int, start_ym.split("-"))
    ey, em = map(int, end_ym.split("-"))
    out, y, m = [], sy, sm
    while (y, m) <= (ey, em):
        out.append(f"{y}{m:02d}")
        m += 1
        if m > 12:
            m, y = 1, y + 1
    return out


def _chunks(lst, n):
    for i in range(0, len(lst), n):
        yield lst[i:i + n]


def _fetch(reporter: str, periods: list, cmdcodes: list) -> list:
    """Uma chamada Comtrade -> lista de linhas {period,cmdCode,primaryValue,netWgt}."""
    params = {
        "reporterCode": reporter,
        "partnerCode":  PARTNER_BR,
        "flowCode":     FLOW_EXPORT,
        "period":       ",".join(periods),
        "cmdCode":      ",".join(cmdcodes),
    }
    headers = {"User-Agent": "Mozilla/5.0"}
    if COMTRADE_KEY:
        base = BASE_FINAL
        headers["Ocp-Apim-Subscription-Key"] = COMTRADE_KEY
    else:
        base = BASE_PREVIEW
    for attempt in range(4):
        try:
            r = requests.get(base, params=params, headers=headers, timeout=90, verify=True)
            if r.status_code == 200:
                return r.json().get("data") or []
            if r.status_code in (429, 500, 502, 503):   # rate-limit / transitório → espera e tenta de novo
                time.sleep(SLEEP_S * (attempt + 2))
                continue
            print(f"    [Comtrade] HTTP {r.status_code}: {r.text[:160]}")
            return []
        except requests.RequestException as e:
            print(f"    [Comtrade] erro de rede ({e}); retry...")
            time.sleep(SLEEP_S * (attempt + 2))
    print("    [Comtrade] falhou após retries.")
    return []


def fetch_pred_exports(start_ym: str, end_ym: str) -> dict:
    """Puxa China+Coreia → Brasil (SH6 antidumping) no intervalo; agrega por
    (period 'YYYY-MM', country, product=subcategoria). Retorna {key:[usd,kg]}."""
    agg = {}
    periods = _ym_list(start_ym, end_ym)
    for rep, cname in REPORTERS.items():
        n_rows = 0
        for pchunk in _chunks(periods, CHUNK_MONTHS):
            data = _fetch(rep, pchunk, AD_SH6)
            for d in data:
                per_raw = str(d.get("period", ""))
                if len(per_raw) != 6:
                    continue
                period = f"{per_raw[:4]}-{per_raw[4:6]}"
                product = _subcat(d.get("cmdCode", ""))
                usd = float(d.get("primaryValue") or 0)
                kg  = float(d.get("netWgt") or 0)
                k = (period, cname, product)
                a = agg.setdefault(k, [0.0, 0.0])
                a[0] += usd
                a[1] += kg
                n_rows += 1
            time.sleep(SLEEP_S)
        print(f"  [Comtrade] {cname}: {n_rows} linhas brutas em {len(periods)} meses")
    return agg


def upsert_pred_exports(conn, rows):
    conn.executemany(
        "INSERT OR IGNORE INTO pred_exports "   # fallback: NUNCA sobrescreve dado nativo fresco
        "(period,country,product,value_usd,volume_kg,updated_at) VALUES (?,?,?,?,?,?)",
        rows,
    )
    conn.commit()


def ensure_table(conn):
    conn.execute("""
        CREATE TABLE IF NOT EXISTS pred_exports (
            period TEXT, country TEXT, product TEXT,
            value_usd REAL, volume_kg REAL, updated_at TEXT,
            PRIMARY KEY (period, country, product)
        )""")
    conn.commit()


def get_latest(conn) -> str | None:
    row = conn.execute("SELECT MAX(period) FROM pred_exports").fetchone()
    return row[0] if row and row[0] else None


def _write_gh_env(new_data: str, period):
    gh = os.environ.get("GITHUB_ENV")
    if not gh:
        return
    with open(gh, "a") as f:
        f.write(f"PRED_EXP_NEW_DATA={new_data}\n")
        if period:
            f.write(f"PRED_EXP_LATEST={period}\n")


def _agg_to_rows(agg):
    return [(p, c, prod, round(v[0], 2), round(v[1], 2), NOW)
            for (p, c, prod), v in agg.items()]


def main():
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass
    ap = argparse.ArgumentParser(description="pred_exports (linha preta) via UN Comtrade")
    ap.add_argument("--check", action="store_true")
    ap.add_argument("--update", action="store_true")
    ap.add_argument("--backfill", action="store_true")
    ap.add_argument("--force", action="store_true")
    ap.add_argument("--start-year", type=int, default=DEFAULT_START_YEAR)
    args = ap.parse_args()

    now = datetime.utcnow()
    cur_ym = f"{now.year}-{now.month:02d}"
    print(f"DB: {DB_PATH} | chave Comtrade: {'sim' if COMTRADE_KEY else 'não (preview)'} | "
          f"{len(AD_SH6)} SH6 antidumping")

    conn = sqlite3.connect(DB_PATH)
    ensure_table(conn)
    latest = get_latest(conn)
    print(f"Último período em pred_exports: {latest or '—'}")

    if args.check:
        # sonda os 2 meses anteriores (Comtrade atrasa) p/ ver o que já saiu
        probe_start = f"{now.year - (1 if now.month <= 2 else 0)}-{((now.month - 2 - 1) % 12) + 1:02d}"
        agg = fetch_pred_exports(probe_start, cur_ym)
        avail = max((k[0] for k in agg), default=None)
        print(f"Último período disponível no Comtrade (sonda): {avail or '—'}")
        conn.close()
        return

    if args.backfill or latest is None:
        start_ym = f"{args.start_year}-01"
        print(f"[FILL] pred_exports de {start_ym} até {cur_ym} (INSERT OR IGNORE — não apaga, só preenche lacunas)...")
        agg = fetch_pred_exports(start_ym, cur_ym)
    elif args.update:
        if args.force:
            start_ym = f"{args.start_year}-01"
        else:
            ly, lm = map(int, latest.split("-"))
            lm += 1
            if lm > 12:
                lm, ly = 1, ly + 1
            start_ym = f"{ly}-{lm:02d}"
        if start_ym > cur_ym:
            print("Nada a buscar (DB já no mês corrente).")
            _write_gh_env("false", None)
            conn.close()
            return
        print(f"[UPDATE] pred_exports de {start_ym} até {cur_ym}...")
        agg = fetch_pred_exports(start_ym, cur_ym)
    else:
        print("Use --check, --update ou --backfill.")
        conn.close()
        return

    rows = _agg_to_rows(agg)
    if rows:
        upsert_pred_exports(conn, rows)
        new_latest = max(k[0] for k in agg)
        new = bool(latest is None or new_latest > latest or args.force or args.backfill)
        print(f"  pred_exports: {len(rows)} linhas | até {new_latest}")
        _write_gh_env("true" if new else "false", new_latest if new else None)
    else:
        print("  Comtrade não retornou dados novos.")
        _write_gh_env("false", None)

    conn.close()
    print("Concluído.")


if __name__ == "__main__":
    main()
