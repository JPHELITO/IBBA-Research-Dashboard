# -*- coding: utf-8 -*-
"""
Fontes da seção "US market" (mesa de dados, Steel › US market) — tudo aberto, sem login.

  AISI (steel.org)       embarques mensais das usinas (release mensal) e a produção SEMANAL
  worldsteel             produção de aço bruto mensal dos EUA (release mensal, em Mt com 1 casa)
  Fed G.17               utilização da capacidade e índice de produção de aço bruto (mensal)
  Census (API)           exportação de aço pela lista de produtos do AISI (mensal)

A importação (FT900A) mora em `us_steel_census.py` (mesmas regras da base local do analista).

Mesmas regras da base local `us-steel-production` (fontes.py), com duas diferenças de propósito:
  * a produção mensal vem do RELEASE da worldsteel (a base local lia o gráfico do Trading
    Economics, que republica o mesmo número da worldsteel com a mesma precisão — 0,1 Mt);
  * nada de Internet Archive: o robô só soma a semana corrente, toda semana.

Unidades: o AISI publica em net ton (tonelada curta) — 1 net ton = 0,90718474 t métrica.
"""

import io
import os
import re
import json
import html
import time
import zipfile
import datetime as dt
import xml.etree.ElementTree as ET

import requests

try:                                    # TLS de navegador quando disponível (o steel.org já
    from curl_cffi import requests as _cr   # recusou cliente "cru" no passado); senão, requests
except Exception:                       # pragma: no cover
    _cr = None

NET_PARA_METRICA = 0.90718474
UA = {"User-Agent": "Mozilla/5.0 (equity research data robot)"}

AISI_SEMANAL = "https://www.steel.org/industry-data/"
AISI_POSTS = "https://www.steel.org/wp-json/wp/v2/posts"
FED_G17_ZIP = "https://www.federalreserve.gov/releases/g17/data/FRB_g17_xml.zip"
WS_RELEASE = "https://worldsteel.org/media/press-releases/{ano}/{mes}-{ano}-crude-steel-production/"
WS_BUSCA = "https://worldsteel.org/wp-json/wp/v2/search"
AISI_HTS_XLSX = "https://www.census.gov/foreign-trade/reference/codes/aisi/aisi{ano}hts.xlsx"
API_EXPORT = "https://api.census.gov/data/timeseries/intltrade/exports/hs"
SEMIACABADOS_DESC = ("INGOTS AND STEEL FOR CASTINGS", "BLOOMS, BILLETS AND SLABS")

MESES_EN = ("january", "february", "march", "april", "may", "june", "july",
            "august", "september", "october", "november", "december")


def pegar(url, tentativas=3, timeout=120, **kw):
    """GET com até 3 tentativas. Tenta primeiro com TLS de navegador (curl_cffi), depois requests.
    Devolve a resposta (qualquer status) ou levanta erro dizendo o STATUS — retentativa que
    esconde um 403 atrás de "fora do ar" já custou uma rodada inteira na base local."""
    ultimo = None
    for i in range(tentativas):
        for cliente in ("cffi", "requests"):
            try:
                if cliente == "cffi":
                    if _cr is None:
                        continue
                    r = _cr.get(url, impersonate="chrome", timeout=timeout, **kw)
                else:
                    r = requests.get(url, headers=UA, timeout=timeout, **kw)
                if r.status_code in (200, 204, 404):
                    return r
                ultimo = "HTTP %s (%s)" % (r.status_code, cliente)
            except Exception as e:
                ultimo = "%s: %s (%s)" % (type(e).__name__, str(e)[:80], cliente)
        time.sleep(3 * (i + 1))
    raise RuntimeError("falhou %s — %s" % (url, ultimo))


def _num(s):
    if s is None:
        return None
    s = str(s).replace(",", "").strip()
    try:
        return float(s)
    except ValueError:
        return None


def _ym(ano, mes):
    return "%04d-%02d" % (ano, mes)


# ─────────────────────────────────────────── AISI: embarques mensais

RE_EMBARQUE = re.compile(
    r"for the month of\s+([A-Za-z]+)\s+(\d{4}).{0,120}?shipped\s+([\d,]+)\s+net tons", re.I)
RE_MES_ANTERIOR = re.compile(
    r"([\d,]+)\s+net tons shipped in the previous month,\s+([A-Za-z]+)\s+(\d{4})", re.I)
RE_ANO_ANTERIOR = re.compile(
    r"([\d,]+)\s+net tons shipped in\s+([A-Za-z]+)\s+(\d{4})", re.I)


def posts_aisi(paginas=3):
    """Os posts mais recentes do site do AISI (100 por página, do mais novo para o mais velho)."""
    todos = []
    for p in range(1, paginas + 1):
        r = pegar("%s?per_page=100&page=%d&_fields=id,date,content" % (AISI_POSTS, p))
        if r.status_code != 200:
            break
        lote = r.json()
        if not lote:
            break
        todos.extend(lote)
        time.sleep(0.3)
    if not todos:
        raise RuntimeError("AISI: nenhum post lido")
    return todos


def _texto(post):
    t = re.sub(r"<[^>]+>", " ", post["content"]["rendered"])
    return re.sub(r"\s+", " ", html.unescape(t)).strip()


def embarques(posts):
    """{ 'AAAA-MM': (net_tons, 'data da publicação') } — para cada mês vale a publicação MAIS
    RECENTE (o AISI revisa: o release de um mês cita o mês anterior e o mesmo mês do ano passado)."""
    obs = {}

    def anotar(ano, mes_nome, valor, publicado):
        mes_nome = mes_nome.lower()
        if valor is None or mes_nome not in MESES_EN:
            return
        obs.setdefault(_ym(int(ano), MESES_EN.index(mes_nome) + 1), []).append((publicado, valor))

    for post in posts:
        texto = _texto(post)
        if "net tons" not in texto.lower() or "shipped" not in texto.lower():
            continue
        m = RE_EMBARQUE.search(texto)
        if not m:
            continue
        pub = post["date"][:10]
        anotar(m.group(2), m.group(1), _num(m.group(3)), pub)
        for rx in (RE_MES_ANTERIOR, RE_ANO_ANTERIOR):
            for a in rx.finditer(texto):
                anotar(a.group(3), a.group(2), _num(a.group(1)), pub)
    out = {}
    for ym, lista in obs.items():
        lista.sort()
        out[ym] = (lista[-1][1], lista[-1][0])
    return out


# ─────────────────────────────────────────── AISI: produção semanal

RE_SEMANA = re.compile(
    r"week ending on\s+([A-Za-z]+ \d{1,2}, \d{4})\s*,?\s*domestic raw steel production was\s+"
    r"([\d,]+)\s+net tons while the capability utilization rate was\s+([\d.]+)\s*percent", re.I)
RE_SEMANA_ALT = re.compile(
    r"week ending\s+([A-Za-z]+ \d{1,2}, \d{4}).{0,90}?production was\s+([\d,]+)\s+net tons"
    r".{0,140}?utilization (?:rate )?(?:was|then was)\s+([\d.]+)", re.I)


def semana_atual():
    """(AAAA-MM-DD, produção em net tons, utilização %) da semana publicada agora no site, ou None."""
    r = pegar(AISI_SEMANAL)
    if r.status_code != 200:
        raise RuntimeError("AISI semanal: HTTP %s" % r.status_code)
    texto = re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", " ", r.text)))
    m = RE_SEMANA.search(texto) or RE_SEMANA_ALT.search(texto)
    if not m:
        return None
    quando = dt.datetime.strptime(m.group(1).replace("  ", " "), "%B %d, %Y").date()
    return quando.isoformat(), _num(m.group(2)), _num(m.group(3))


# ─────────────────────────────────────────── Fed G.17

SERIES_FED = {
    "CAPUTL.G3311A2.S": "util",     # utilização da capacidade, ferro e aço (NAICS 3311,2), % — com ajuste sazonal
    "IP.N3311A2R.S": "ipraw",       # índice de produção de AÇO BRUTO (2017 = 100) — com ajuste sazonal
}


def fed_g17():
    """{ nome: { 'AAAA-MM': valor } } — arquivo XML completo do G.17 (o Fed reescreve o histórico)."""
    r = pegar(FED_G17_ZIP, timeout=300)
    if r.status_code != 200:
        raise RuntimeError("Fed G.17: HTTP %s" % r.status_code)
    z = zipfile.ZipFile(io.BytesIO(r.content))
    raiz = ET.fromstring(z.read("G17_data.xml"))
    out = {v: {} for v in SERIES_FED.values()}
    for el in raiz.iter():
        if not el.tag.endswith("Series"):
            continue
        nome = SERIES_FED.get(el.attrib.get("SERIES_NAME"))
        if not nome:
            continue
        for o in el:
            if not o.tag.endswith("Obs"):
                continue
            per, val = o.attrib.get("TIME_PERIOD"), _num(o.attrib.get("OBS_VALUE"))
            if per and val is not None:
                out[nome][per[:7]] = val
    if not all(out.values()):
        raise RuntimeError("Fed G.17: série não encontrada no arquivo (%s)" % [k for k, v in out.items() if not v])
    return out


# ─────────────────────────────────────────── worldsteel: aço bruto mensal

RE_WS_EUA = re.compile(
    r"(?:The )?(?:United States|US|U\.S\.)\s+(?:is estimated to have |was estimated to have )?produced\s+([\d.]+)\s*Mt", re.I)


def worldsteel_mes(ano, mes):
    """Produção de aço bruto dos EUA no mês (mil t), do release mensal da worldsteel, ou None se o
    release ainda não saiu. O número é estimativa da própria worldsteel (base: AISI) e vem em Mt com
    uma casa — a mesma precisão da série histórica."""
    url = WS_RELEASE.format(ano=ano, mes=MESES_EN[mes - 1])
    r = pegar(url)
    if r.status_code == 404:
        # o endereço segue um padrão, mas confirmo pela busca do site antes de dizer "não saiu"
        b = pegar("%s?search=%s&per_page=5" % (WS_BUSCA, requests.utils.quote("%s %d crude steel production" % (MESES_EN[mes - 1].title(), ano))))
        alvo = "%s-%d-crude-steel-production" % (MESES_EN[mes - 1], ano)
        achou = [x.get("url") for x in (b.json() if b.status_code == 200 else []) if alvo in (x.get("url") or "")]
        if not achou:
            return None
        r = pegar(achou[0])
        if r.status_code != 200:
            return None
    if r.status_code != 200:
        return None
    texto = re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", " ", re.sub(r"<script.*?</script>|<style.*?</style>", " ", r.text, flags=re.S))))
    # confere que o release é do mês pedido (o título traz "<Mês> <ano> crude steel production")
    if not re.search(r"%s %d crude steel production" % (MESES_EN[mes - 1], ano), texto, re.I):
        return None
    m = RE_WS_EUA.search(texto)
    if not m:
        raise RuntimeError("worldsteel %s: release sem a frase dos EUA" % _ym(ano, mes))
    return float(m.group(1)) * 1000.0


# ─────────────────────────────────────────── Census API: exportação

def codigos_aisi(hoje=None):
    """Lista HTS do AISI (define "produto siderúrgico"): {hs6} válidos e {hs6} semiacabados.
    O arquivo leva o ANO no nome (aisi2026hts.xlsx) — tenta o ano corrente e volta até 3 anos."""
    import pandas as pd
    hoje = hoje or dt.date.today()
    ultimo = None
    for ano in range(hoje.year, hoje.year - 4, -1):
        r = pegar(AISI_HTS_XLSX.format(ano=ano))
        if r.status_code != 200:
            ultimo = "HTTP %s (%d)" % (r.status_code, ano)
            continue
        d = pd.read_excel(io.BytesIO(r.content), header=None)
        d = d.rename(columns={0: "desc", 1: "hts"})
        d["desc"] = d["desc"].ffill()
        d = d[d["hts"].notna()].copy()
        d["hts"] = d["hts"].astype(str).str.replace(r"\D", "", regex=True)
        d = d[d["hts"].str.len() == 10]
        hs6 = set(d["hts"].str[:6])
        semi = set(d.loc[d["desc"].astype(str).str.strip().str.upper().isin(SEMIACABADOS_DESC), "hts"].str[:6])
        if len(hs6) > 100:
            return hs6, semi, ano
        ultimo = "lista curta demais (%d)" % len(hs6)
    raise RuntimeError("lista HTS do AISI não encontrada: %s" % ultimo)


def _toneladas(linha, cab):
    """Tonelada métrica de uma linha de 10 dígitos (KG ou T na 1ª quantidade), ou None."""
    iq = next((k for k, c in enumerate(cab) if c.endswith("QTY_1_MO")), None)
    if iq is None or "UNIT_QY1" not in cab:
        return None
    try:
        q = float(linha[iq])
    except (ValueError, TypeError):
        return None
    un = linha[cab.index("UNIT_QY1")]
    return q / 1000.0 if un == "KG" else q if un == "T" else None


def exportacao_mes(ym, hs6, semi, chave=None):
    """(t total, t semiacabados, US$) exportados no mês pela lista do AISI, ou None se o mês ainda não
    foi publicado (a API responde 204). Consulta = todos os HS10 do mês (a quantidade só existe no
    10 dígitos) e o filtro é feito aqui — calibrado na base local: −0,2% a +1,0% contra o FT900A."""
    url = "%s?get=E_COMMODITY,ALL_VAL_MO,QTY_1_MO,UNIT_QY1&COMM_LVL=HS10&time=%s" % (API_EXPORT, ym)
    if chave:
        url += "&key=" + chave
    ultimo = None
    for i in range(4):
        try:
            r = requests.get(url, timeout=300, headers=UA)
            if r.status_code == 204 or not r.text.strip():
                return None
            r.raise_for_status()
            d = r.json()
            break
        except Exception as e:
            ultimo = "%s: %s" % (type(e).__name__, str(e)[:80].replace(chave or "§", "***"))
            time.sleep(5 * (i + 1))
    else:
        raise RuntimeError("Census API (exportação %s): %s" % (ym, ultimo))
    cab = d[0]
    iv = [k for k, c in enumerate(cab) if c.endswith("VAL_MO")][0]
    t = t_semi = usd = 0.0
    n = 0
    for l in d[1:]:
        cod = l[0]
        if len(cod) != 10 or cod[:6] not in hs6:
            continue
        n += 1
        try:
            usd += float(l[iv])
        except (ValueError, TypeError):
            pass
        q = _toneladas(l, cab)
        if q is None:
            continue
        t += q
        if cod[:6] in semi:
            t_semi += q
    if n == 0:
        return None
    return t, t_semi, usd
