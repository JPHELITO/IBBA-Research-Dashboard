# -*- coding: utf-8 -*-
"""update_empapel_news.py — Empapel (papelão ondulado) automático, a partir das NOTÍCIAS.

O número mensal do Empapel (expedição de papelão ondulado, índice IBPO) NÃO tem planilha
pública nem API — mas aparece nas NOTÍCIAS que a dashboard já coleta (tabela news_articles
no Supabase, via news-hunter). Ele sai DUAS vezes por mês:

  • PRELIMINAR — Fastmarkets (inglês), ~dia 14-16 do mês seguinte. Diz "Preliminary data
    released by ... Empapel ... totaling 356,538 tonnes".  É rápido, mas é revisado.
  • OFICIAL/definitivo — índice IBPO da própria Empapel, ecoado por Valor/CNN/ABTCP/Money
    Times (português), ~dia 1-2 do 2º mês seguinte. "alcançou 359.799 toneladas em maio".

Decisão do analista (2026-07-21): publicar o PRELIMINAR rápido e depois CORRIGIR sozinho
para o OFICIAL quando ele sair (melhor dos dois mundos). Fluxo:

  lê as notícias do Empapel no Supabase → extrai (mês, tonelagem, preliminar/oficial, %a/a)
  por regex → confere (checksum de %a/a vs a série + banda de sanidade) →
  1) REVISA os últimos meses guardados p/ o número OFICIAL quando ele aparece;
  2) INSERE os meses novos (preliminar se o oficial ainda não saiu), em ordem, sem buraco →
  recalcula exp_per_day (=tonelagem/dias úteis) e ltm (soma 12m) →
  3 e-mails (1×/mês cada): "preliminar publicado" (novo), "número oficial" (atualizado),
  "erro/atraso".

Dias úteis do Empapel = SEG-SÁB menos feriados nacionais (as fábricas expedem no sábado;
confirmado contra a série: jun/25=24, mai/26=25 batem).

Modos:
  python update_empapel_news.py --check
  python update_empapel_news.py --update
  python update_empapel_news.py --dry-run        (mostra o que faria, sem gravar)
PULP_DB=<caminho> p/ testar em cópia. Env: SUPABASE_URL, SUPABASE_SERVICE_KEY (+ SMTP p/ e-mail).
"""
from __future__ import annotations

import argparse
import datetime
import json
import os
import re
import sqlite3
import sys
import urllib.parse
import urllib.request
import warnings
from pathlib import Path

warnings.filterwarnings("ignore")

HERE = Path(__file__).resolve().parent
DB_PATH = Path(os.environ.get("PULP_DB") or (HERE / "pulp_paper.db"))
SB_URL = (os.environ.get("SUPABASE_URL") or "").rstrip("/")
SB_KEY = os.environ.get("SUPABASE_SERVICE_KEY") or ""

sys.path.insert(0, str(HERE.parent / "_shared"))
try:
    import notify
except Exception:
    notify = None

SOURCE = "empapel"                       # chave no registry / update_log
DASH_URL = "https://metals-mining-pulp-paper-dashboard.vercel.app"

# meses em inglês (Fastmarkets) e português (IBPO/Valor/CNN/ABTCP)
_MONTHS = {
    "january": 1, "february": 2, "march": 3, "april": 4, "may": 5, "june": 6,
    "july": 7, "august": 8, "september": 9, "october": 10, "november": 11, "december": 12,
    "janeiro": 1, "fevereiro": 2, "março": 3, "marco": 3, "abril": 4, "maio": 5, "junho": 6,
    "julho": 7, "agosto": 8, "setembro": 9, "outubro": 10, "novembro": 11, "dezembro": 12,
}
_MONTH_RE = re.compile(r"\b(" + "|".join(_MONTHS) + r")\b", re.I)

# palavras que dão o SINAL da variação a/a (para o checksum de % a/a)
_NEG = ("drop", "fell", "fall", "declin", "down", "lose", "lost", "lower", "queda", "cai",
        "caiu", "recu", "menor", "redu")
_POS = ("increas", "improv", "rose", "grew", "grow", "gain", "up ", "higher", "avanç",
        "avanc", "alta", "cresce", "cresceu", "maior", "sobe", "subiu", "record", "recorde")


# ── busca das notícias no Supabase ────────────────────────────────────────────
def _sb_get(params: dict) -> list:
    if not (SB_URL and SB_KEY):
        raise RuntimeError("SUPABASE_URL/SUPABASE_SERVICE_KEY ausentes.")
    url = f"{SB_URL}/rest/v1/news_articles?{urllib.parse.urlencode(params)}"
    req = urllib.request.Request(url, headers={"apikey": SB_KEY, "Authorization": f"Bearer {SB_KEY}"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.load(r)


def fetch_articles() -> list:
    """Puxa tudo que possa ser o número mensal do Empapel (filtro fino é no Python)."""
    ors = ("snippet.ilike.*Empapel*,snippet.ilike.*IBPO*,title.ilike.*Empapel*,title.ilike.*IBPO*,"
           "title.ilike.*corrugated*,title.ilike.*papel*ondulado*,"
           "snippet.ilike.*corrugated board*,snippet.ilike.*papel*ondulado*")
    return _sb_get({"select": "published_at,source_name,title,snippet", "or": f"({ors})",
                    "order": "published_at.desc", "limit": "120"})


# ── extração (regex determinística) ───────────────────────────────────────────
def parse_tonnage(text: str):
    """(kton, preciso?) — pega a tonelagem do texto. None se não achar.
    '356,538 tonnes'/'359.799 toneladas' -> 356.538/359.799 (preciso);
    '359,7 mil toneladas' -> 359.7 (menos preciso)."""
    m = re.search(r"([\d.,]+)\s*mil\s+toneladas", text, re.I)
    if m:
        v = m.group(1).replace(".", "").replace(",", ".")
        try:
            return round(float(v), 3), False
        except ValueError:
            pass
    # forma 6 dígitos com separador de milhar (vírgula em inglês, ponto em português)
    for m in re.finditer(r"(\d{1,3}(?:[.,]\d{3})+)\s*(?:tonnes|toneladas|t\b)", text, re.I):
        digits = re.sub(r"[^\d]", "", m.group(1))
        if len(digits) >= 5:                          # >= 10.000 t (descarta números pequenos)
            return round(int(digits) / 1000.0, 3), True
    return None, None


def parse_month_year(text: str, published_at: str):
    """(period 'AAAA-MM') do mês de DADO. Usa o 1º nome de mês do texto + a data de publicação."""
    m = _MONTH_RE.search(text)
    if not m:
        return None
    mn = _MONTHS[m.group(1).lower()]
    try:
        pub = datetime.date.fromisoformat(published_at[:10])
    except Exception:
        return None
    y = pub.year
    if mn > pub.month:                                # dez publicado em jan -> ano anterior
        y -= 1
    return f"{y}-{mn:02d}"


def parse_yoy(text: str):
    """% variação a/a (com sinal) se der p/ ler, senão None."""
    m = re.search(r"([\d]+(?:[.,]\d+)?)\s*%", text)
    if not m:
        return None
    pct = float(m.group(1).replace(",", "."))
    low = text.lower()
    seg = low[max(0, m.start() - 60): m.start() + 5]  # contexto ao redor do %
    if any(w in seg for w in _NEG):
        return -pct
    if any(w in seg for w in _POS):
        return pct
    return pct                                        # default: positivo


def classify(a: dict):
    """Vira um candidato {period, kton, precise, preliminary, yoy, source, title} ou None."""
    title = a.get("title") or ""
    snip = a.get("snippet") or ""
    text = f"{title}. {snip}".strip()
    low = text.lower()
    assoc = ("empapel" in low) or ("ibpo" in low)
    product = any(k in low for k in ("papelão ondulado", "papelao ondulado",
                                     "corrugated board", "corrugated shipments"))
    brazil = assoc or ("brasil" in low) or ("brazil" in low) or ("papel" in low)
    if not ((assoc or product) and brazil):
        return None
    kton, precise = parse_tonnage(text)
    period = parse_month_year(text, a.get("published_at") or "")
    if kton is None or period is None:
        return None
    return {"period": period, "kton": kton, "precise": bool(precise),
            "preliminary": ("preliminary" in low) or ("preliminar" in low),
            "yoy": parse_yoy(text), "source": a.get("source_name") or "?",
            "title": title, "published": (a.get("published_at") or "")[:10]}


def gather(articles: list) -> dict:
    """{period: {'prelim': cand, 'official': cand}} — melhor candidato de cada tipo por mês.
    Preferência: mais preciso, depois mais recente."""
    out: dict = {}
    def better(new, cur):
        if cur is None:
            return True
        if new["precise"] != cur["precise"]:
            return new["precise"]
        return new["published"] >= cur["published"]
    for a in articles:
        c = classify(a)
        if not c:
            continue
        slot = out.setdefault(c["period"], {"prelim": None, "official": None})
        key = "prelim" if c["preliminary"] else "official"
        if better(c, slot[key]):
            slot[key] = c
    return out


# ── dias úteis (SEG-SÁB menos feriados) ───────────────────────────────────────
def _easter(y):
    a = y % 19; b = y // 100; c = y % 100; d = b // 4; e = b % 4; f = (b + 8) // 25
    g = (b - f + 1) // 3; h = (19 * a + b - d - g + 15) % 30; i = c // 4; k = c % 4
    l = (32 + 2 * e + 2 * i - h - k) % 7; mm = (a + 11 * h + 22 * l) // 451
    mo = (h + l - 7 * mm + 114) // 31; da = ((h + l - 7 * mm + 114) % 31) + 1
    return datetime.date(y, mo, da)


def working_days(y, m):
    """Seg-SÁB, excluindo feriados nacionais + Corpus Christi (Empapel conta sábado)."""
    e = _easter(y)
    hol = {datetime.date(y, mn, dd) for mn, dd in
           [(1, 1), (4, 21), (5, 1), (9, 7), (10, 12), (11, 2), (11, 15), (12, 25)]}
    hol |= {e - datetime.timedelta(days=x) for x in (2, 47, 48)} | {e + datetime.timedelta(days=60)}
    if y >= 2024:
        hol.add(datetime.date(y, 11, 20))
    d = datetime.date(y, m, 1); n = 0
    while d.month == m:
        if d.weekday() < 6 and d not in hol:          # < 6 = seg..sáb (só tira domingo)
            n += 1
        d += datetime.timedelta(days=1)
    return n


def _shift(y, m, d):
    idx = y * 12 + (m - 1) + d
    return idx // 12, idx % 12 + 1


# ── leitura/escrita do banco ──────────────────────────────────────────────────
EMP_COLS = ["period", "year", "month", "shipments_kton", "working_days", "exp_per_day", "ltm_shipments"]


def load_series(conn) -> dict:
    return {p: s for p, s in conn.execute(
        "SELECT period, shipments_kton FROM empapel ORDER BY period")}


def dash_latest(conn):
    r = conn.execute("SELECT MAX(period) FROM empapel").fetchone()
    return r[0] if r and r[0] else None


def recompute_from(conn, start_period):
    """Recalcula exp_per_day (=tonelagem/dias úteis) e ltm (soma 12m) de todos os meses
    >= start_period, em ordem (uma revisão mexe no ltm dos meses seguintes)."""
    ser = {p: s for p, s in conn.execute("SELECT period, shipments_kton FROM empapel")}
    periods = sorted(p for p in ser if p >= start_period)
    allp = sorted(ser)
    for p in periods:
        y, m = int(p[:4]), int(p[5:7])
        wd = working_days(y, m)
        val = ser[p]
        exp = round(val / wd, 5) if (val is not None and wd) else None
        i = allp.index(p)
        window = [ser[allp[j]] for j in range(max(0, i - 11), i + 1) if ser[allp[j]] is not None]
        ltm = round(sum(window), 3) if len(window) >= 1 else None
        conn.execute("UPDATE empapel SET working_days=?, exp_per_day=?, ltm_shipments=? WHERE period=?",
                     (wd, exp, ltm, p))
    conn.commit()


def write_value(conn, period, kton):
    """Insere/substitui a tonelagem de um mês (derivados vêm depois no recompute_from)."""
    y, m = int(period[:4]), int(period[5:7])
    conn.execute("DELETE FROM empapel WHERE period=?", (period,))
    conn.execute(f"INSERT INTO empapel ({','.join(EMP_COLS)}) VALUES ({','.join('?' * len(EMP_COLS))})",
                 [period, y, m, kton, working_days(y, m), None, None])
    conn.commit()


# ── validação (checksum de %a/a + banda de sanidade) ──────────────────────────
def validate(series: dict, period, kton, yoy_stated):
    """(ok, motivo). series = {period: shipments} já guardados."""
    y, m = int(period[:4]), int(period[5:7])
    py, pm = _shift(y, m, -12)
    prev = series.get(f"{py}-{pm:02d}")
    if yoy_stated is not None and prev:
        comp = (kton / prev - 1) * 100
        if abs(comp - yoy_stated) > 0.6:
            return False, f"%a/a calc {comp:+.1f} ≠ texto {yoy_stated:+.1f}"
    # banda: dentro de ±30% da média dos 3 meses guardados anteriores
    prevs, cy, cmm = [], y, m
    for _ in range(3):
        cy, cmm = _shift(cy, cmm, -1)
        v = series.get(f"{cy}-{cmm:02d}")
        if v is not None:
            prevs.append(v)
    if prevs:
        mean = sum(prevs) / len(prevs)
        if not (0.70 * mean <= kton <= 1.30 * mean):
            return False, f"{kton:.1f} fora da banda (média3 {mean:.1f})"
    return True, "ok"


# ── e-mails / sinais p/ o workflow ────────────────────────────────────────────
def _gh(**kv):
    gh = os.environ.get("GITHUB_ENV")
    if gh:
        with open(gh, "a") as f:
            for k, v in kv.items():
                f.write(f"{k}={v}\n")


def _mail(kind, period, subject, body):
    if notify:
        try:
            notify.once(SOURCE, period, kind, subject, body)
        except Exception as e:
            print(f"  (e-mail '{kind}' ignorado: {e})")


def _overdue_check(conn, gathered):
    """O preliminar sai ~dia 14-16 do mês seguinte. Se passou do dia 22 e o mês esperado
    (atual − 1) não está no banco nem apareceu nas notícias, avisa (1×/mês)."""
    now = datetime.datetime.utcnow()
    if now.day < 22:
        return
    ey, em = _shift(now.year, now.month, -1)
    exp = f"{ey}-{em:02d}"
    have = conn.execute("SELECT 1 FROM empapel WHERE period=?", (exp,)).fetchone()
    news = gathered.get(exp) and (gathered[exp]["prelim"] or gathered[exp]["official"])
    if not have and not news:
        _mail("overdue", exp, f"⚠️ Empapel ainda sem {exp}",
              f"Já é dia {now.day} e não achei o número do Empapel de {exp} (papelão ondulado) "
              f"nem no banco nem nas notícias. O preliminar costuma sair entre os dias 14 e 16 "
              f"no Fastmarkets; o oficial (IBPO) no começo do mês seguinte.")


# ── orquestração ──────────────────────────────────────────────────────────────
def run(conn, gathered, do_write: bool):
    """Aplica revisões (→ oficial) e inserções (preliminar/oficial). Retorna resumo p/ log."""
    series = load_series(conn)
    dash = dash_latest(conn)
    changed = []                                      # (period, kind, old, new)
    earliest = None

    # 1) REVISÃO: os últimos 3 meses guardados viram o número OFICIAL quando ele aparece
    for p in sorted(series)[-3:]:
        off = (gathered.get(p) or {}).get("official")
        if not off:
            continue
        old = series[p]
        if old is not None and round(old, 3) == round(off["kton"], 3):
            continue                                  # já está no oficial
        ok, why = validate(series, p, off["kton"], off["yoy"])
        if old and abs(off["kton"] - old) / old > 0.05:
            ok, why = False, f"revisão suspeita ({old:.1f} → {off['kton']:.1f})"
        if not ok:
            _mail("review", p, f"⚠️ Empapel {p}: revisão oficial não confere",
                  f"Vi o número OFICIAL de {p} nas notícias ({off['kton']:.3f} kt, {off['source']}), "
                  f"mas não bateu na conferência ({why}). NÃO alterei. Título: {off['title']}")
            continue
        if do_write:
            write_value(conn, p, off["kton"]); series[p] = off["kton"]
        changed.append((p, "official", old, off["kton"]))
        earliest = min(earliest or p, p)

    # 2) INSERÇÃO: do mês seguinte ao último guardado até o mês passado, sem buraco
    now = datetime.datetime.utcnow()
    last_done = f"{now.year - (now.month == 1)}-{(now.month - 2) % 12 + 1:02d}"  # atual − 1
    cy, cm = (_shift(int(dash[:4]), int(dash[5:7]), 1) if dash else (now.year, now.month))
    while f"{cy:04d}-{cm:02d}" <= last_done:
        p = f"{cy:04d}-{cm:02d}"
        cand = (gathered.get(p) or {})
        chosen = cand.get("official") or cand.get("prelim")
        if not chosen:
            break                                     # sem notícia → para (não deixa buraco)
        ok, why = validate(series, p, chosen["kton"], chosen["yoy"])
        if not ok:
            _mail("review", p, f"⚠️ Empapel {p}: número não confere",
                  f"Achei {p} nas notícias ({chosen['kton']:.3f} kt, {chosen['source']}), mas não "
                  f"passou na conferência ({why}). NÃO publiquei. Título: {chosen['title']}")
            break
        kind = "official" if chosen is cand.get("official") else "prelim"
        if do_write:
            write_value(conn, p, chosen["kton"]); series[p] = chosen["kton"]
        changed.append((p, kind, None, chosen["kton"]))
        earliest = min(earliest or p, p)
        cy, cm = _shift(cy, cm, 1)

    if do_write and earliest:
        recompute_from(conn, earliest)               # exp_per_day + ltm dos meses afetados
    return changed


def main():
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass
    ap = argparse.ArgumentParser(description="Empapel automático (via notícias)")
    ap.add_argument("--check", action="store_true", help="só diz se há novidade")
    ap.add_argument("--update", action="store_true", help="grava + e-mails + sinais p/ CI")
    ap.add_argument("--dry-run", action="store_true", help="mostra o que faria, sem gravar")
    args = ap.parse_args()

    conn = sqlite3.connect(DB_PATH)
    dash = dash_latest(conn)
    try:
        arts = fetch_articles()
    except Exception as e:
        print(f"Falha ao ler notícias: {e}"); _gh(EMP_NEW_DATA="false"); conn.close(); return
    gathered = gather(arts)
    months = ", ".join(sorted(gathered)) or "—"
    print(f"Empapel — dashboard: {dash} | meses achados nas notícias: {months}")

    if args.check:
        pend = run(conn, gathered, do_write=False)
        novo = bool(pend)
        print("NOVIDADE" if novo else "em dia")
        for p, k, old, new in pend:
            print(f"  {p}: {k} {old}→{new}")
        _gh(EMP_NEW="true" if novo else "false")
        conn.close(); return

    if args.dry_run:
        pend = run(conn, gathered, do_write=False)
        if not pend:
            print("Nada a fazer (em dia).")
        for p, k, old, new in pend:
            wd = working_days(int(p[:4]), int(p[5:7]))
            tag = "REVISÃO→oficial" if old is not None else ("insere OFICIAL" if k == "official" else "insere preliminar")
            print(f"  {p}: {tag} | {old}→{new} kt | dias úteis {wd} | exp/dia {new/wd:.4f}")
        conn.close(); return

    # --update (padrão do CI)
    _overdue_check(conn, gathered)
    changed = run(conn, gathered, do_write=True)
    if not changed:
        print("Sem novidade — em dia."); _gh(EMP_NEW_DATA="false"); conn.close(); return

    for p, k, old, new in changed:
        verb = "revisado p/ oficial" if old is not None else ("publicado (oficial)" if k == "official" else "publicado (preliminar)")
        print(f"  ✅ {p} {verb}: {new:.3f} kt")
        if old is not None or k == "official":
            _mail("updated", p, f"✅ Empapel {p}: número oficial publicado",
                  f"O número OFICIAL do Empapel de {p} (papelão ondulado) foi {'revisado' if old else 'publicado'} "
                  f"no dashboard: {new:.3f} mil t. {DASH_URL}")
        else:
            _mail("new", p, f"📦 Empapel {p}: preliminar publicado",
                  f"Saiu o dado PRELIMINAR do Empapel de {p} (papelão ondulado): {new:.3f} mil t. "
                  f"Publiquei no dashboard; vou corrigir p/ o número oficial quando o IBPO divulgar "
                  f"(~começo do mês seguinte). {DASH_URL}")

    latest = max(p for p, *_ in changed)
    _gh(EMP_NEW_DATA="true", EMP_LATEST=latest)
    conn.close()


if __name__ == "__main__":
    main()
