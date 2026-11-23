# -*- coding: utf-8 -*-
"""Paridade de importação do aço (HRC e vergalhão): acrescenta a semana que fechou na tabela `steel_parity`.

A página de M&M (mesa de dados › Steel › Prices) refaz a conta da planilha do analista a partir dos INSUMOS de
cada sexta-feira. O histórico (2018 em diante) veio da planilha; este robô só mantém a série viva:

  FOB de origem .... tabela `commodities` (HRC_CHINA / REBAR_TURKEY), o valor da sexta (ou o último antes dela)
  preço doméstico .. tabela `commodities` (HRC_BRAZIL / REBAR_BRAZIL), idem
  câmbio ........... PTAX de venda da sexta (Banco Central); feriado/sem PTAX → o USD_BRL que a dashboard já guarda
  frete, seguro, tarifa, AFRMM e porto ... os da última semana gravada (mudam raramente e são digitados pelo
                     analista: quando mudarem, a planilha é recarregada e ela MANDA sobre o que o robô gravou)

Regras: nunca reescreve uma semana que já existe (ignore-duplicates); sem a tabela (SQL ainda não rodado) sai
sem erro; preço da sexta mais velho que 6 dias → não grava (melhor um furo do que um número repetido).
Só biblioteca padrão. Nunca imprime a chave.

uso:  python _shared/update_steel_parity.py [--dry]        (SUPABASE_URL e SUPABASE_SERVICE_KEY no ambiente)
"""
import datetime as D
import json
import os
import sys
import urllib.error
import urllib.request

PRODUCTS = {"hrc": {"fob": "HRC_CHINA", "dom": "HRC_BRAZIL"}, "rebar": {"fob": "REBAR_TURKEY", "dom": "REBAR_BRAZIL"}}
MAX_FOB_AGE = 6      # dias: o FOB tem de ser da semana
MAX_DOM_AGE = 10     # o doméstico é avaliado uma vez por semana


def _call(method, path, body=None, prefer=None):
    url, key = os.environ["SUPABASE_URL"].rstrip("/"), os.environ["SUPABASE_SERVICE_KEY"]
    h = {"apikey": key, "Authorization": "Bearer " + key, "Content-Type": "application/json"}
    if prefer:
        h["Prefer"] = prefer
    req = urllib.request.Request(url + "/rest/v1/" + path, data=None if body is None else json.dumps(body).encode(), headers=h, method=method)
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            raw = r.read()
            return r.status, (json.loads(raw.decode()) if raw else None)
    except urllib.error.HTTPError as ex:
        return ex.code, ex.read().decode()[:300]


def last_friday(today):
    """a sexta-feira mais recente que já terminou (hoje não conta se for sexta: a semana ainda está aberta)"""
    d = today - D.timedelta(days=1)
    while d.weekday() != 4:
        d -= D.timedelta(days=1)
    return d


def series(daily):
    """[[unix, valor]…] → {data: valor} (o último valor de cada dia)"""
    out = {}
    for p in daily or []:
        if not p or p[1] is None:
            continue
        t = float(p[0])
        out[D.datetime.fromtimestamp(t if t < 2e10 else t / 1000, D.timezone.utc).date()] = float(p[1])
    return out


def at_or_before(s, day, max_age):
    for k in range(max_age + 1):
        v = s.get(day - D.timedelta(days=k))
        if v is not None:
            return v, k
    return None, None


def ptax(day, fetch=None):
    """PTAX de venda do dia (None em feriado ou sem resposta)"""
    u = ("https://olinda.bcb.gov.br/olinda/servico/PTAX/versao/v1/odata/CotacaoDolarDia(dataCotacao=@d)?@d='%s'&$format=json" % day.strftime("%m-%d-%Y"))
    try:
        raw = fetch(u) if fetch else urllib.request.urlopen(urllib.request.Request(u, headers={"User-Agent": "Mozilla/5.0"}), timeout=30).read().decode()
        v = json.loads(raw).get("value") or []
        return float(v[-1]["cotacaoVenda"]) if v else None
    except Exception:
        return None


def build_row(product, week, last, fob_s, dom_s, fx):
    """a linha da semana, ou (None, motivo). `last` = a última linha gravada do produto (de onde vêm frete, tarifa…)."""
    fob, age = at_or_before(fob_s, week, MAX_FOB_AGE)
    if fob is None:
        return None, "sem FOB na semana"
    dom, _ = at_or_before(dom_s, week, MAX_DOM_AGE)
    if dom is None:
        dom = last.get("dom_brl")
    if dom is None or not fx:
        return None, "sem preço doméstico ou câmbio"
    return {"product": product, "week": week.isoformat(), "fob": round(fob, 2), "freight": last["freight"], "insurance": last["insurance"], "tariff": last["tariff"],
            "afrmm": last["afrmm"], "port": last["port"], "dom_brl": round(float(dom), 2), "fx": round(float(fx), 4), "source": "robot"}, None


def premium(r):
    cif = (r["fob"] + r["freight"]) * (1 + r["insurance"])
    imp = cif + cif * r["tariff"] + r["freight"] * r["afrmm"] + r["port"]
    return (r["dom_brl"] / r["fx"]) / imp - 1


def main(argv):
    dry = "--dry" in argv
    today = (D.datetime.now(D.timezone.utc) - D.timedelta(hours=3)).date()   # Brasília
    week = last_friday(today)
    st, last = _call("GET", "steel_parity?select=product,week,freight,insurance,tariff,afrmm,port,dom_brl&order=week.desc&limit=6")
    if st != 200:
        print(f"steel_parity ainda não existe ou não respondeu (HTTP {st}) — nada a fazer. Rode admin/supabase_market_prices.sql.")
        return 0
    lastp = {}
    for r in last:
        lastp.setdefault(r["product"], r)
    todo = [p for p in PRODUCTS if p in lastp and lastp[p]["week"] < week.isoformat()]
    if not todo:
        print(f"semana de {week} já gravada (ou tabela vazia: carregue o histórico da planilha primeiro) — nada a fazer.")
        return 0
    codes = sorted({c for p in todo for c in PRODUCTS[p].values()})
    st, com = _call("GET", "commodities?select=code,daily&code=in.(" + ",".join(codes) + ")")
    if st != 200:
        print(f"::error::commodities não respondeu (HTTP {st})")
        return 1
    S = {r["code"]: series(r["daily"]) for r in com}
    fx, src = ptax(week), "PTAX"
    if not fx and (today - week).days <= 3:
        st, m = _call("GET", "macro_indicators?select=code,value&code=eq.USD_BRL")
        fx, src = (float(m[0]["value"]) if st == 200 and m else None), "USD_BRL da dashboard (sem PTAX no dia)"
    if not fx:
        for k in range(1, 5):   # feriado e robô atrasado: a última PTAX antes da sexta
            fx, src = ptax(week - D.timedelta(days=k)), f"PTAX de {week - D.timedelta(days=k)}"
            if fx:
                break
    rows = []
    for p in todo:
        r, why = build_row(p, week, lastp[p], S.get(PRODUCTS[p]["fob"], {}), S.get(PRODUCTS[p]["dom"], {}), fx)
        if not r:
            print(f"::warning::{p}: semana de {week} NÃO gravada — {why}")
            continue
        rows.append(r)
        print(f"{p}: semana de {week} · FOB {r['fob']} + frete {r['freight']} · doméstico {r['dom_brl']} ÷ {r['fx']} ({src}) → prêmio {premium(r) * 100:+.1f}%")
    if not rows or dry:
        print("(simulação: nada gravado)" if dry and rows else "nada gravado.")
        return 0
    st, d = _call("POST", "steel_parity?on_conflict=product,week", rows, prefer="resolution=ignore-duplicates,return=minimal")
    if st not in (200, 201, 204):
        print(f"::error::gravação falhou (HTTP {st}) {d}")
        return 1
    print(f"gravado: {len(rows)} linha(s).")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
