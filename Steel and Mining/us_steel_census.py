# -*- coding: utf-8 -*-
"""
LEITOR DO FT900A (importacao de aco dos EUA) -- copia do coletor que monta a base local
`us-steel-imports` no PC do analista (census_steel.py), para o robo da nuvem
(`update_us_steel.py`) ler o Census com EXATAMENTE as mesmas regras.

Mudou so o lugar do cache: na nuvem ele vai para uma pasta temporaria (nada de
arquivo baixado dentro do repositorio). Para mudar a regra de leitura, mude nos
dois lugares.
Coletor da base de importacao de aco dos EUA.

Fonte: U.S. Census Bureau, relatorio mensal FT900A
"U.S. Imports for Consumption of Steel Products" (Census basis).
E a base oficial americana -- a mesma que alimenta o "Steel Import Monitor"
do Departamento de Comercio (que e so uma tela de Power BI sem exportacao).

Cada mes vem num ZIP. Dentro dele o que interessa e o microdado
(fstldata.txt / pstldata.txt): uma linha por pais x produto x tipo de aco,
com valor em US$, net tons e metric tons.

Quando aquele mes nao tem microdado utilizavel, caimos no Anexo 2
("Exhibit 2 -- From Selected Countries and Areas"), que traz o total por pais
para uma lista selecionada de ~30 paises, sem quebra por produto.

TRES ARMADILHAS que custaram caro e estao tratadas aqui:

  1. O nome do ZIP NAO garante o mes do dado. Em alguns releases o Census
     empacotou o fstldata.txt do mes ANTERIOR (ex.: steelf-excel_1111.zip
     traz outubro/2011). Sem checar o carimbo STAT_MO/STAT_YEAR de dentro do
     arquivo, o mesmo mes entra duas vezes na base.

  2. O Anexo 2 nem sempre esta em steel2f. Em jun/2002 todos os arquivos do
     ZIP vieram com cabecalho de Exhibit 1 (por PRODUTO). Ler "steel2f" no
     escuro somava produto como se fosse pais -- deu 76 milhoes de toneladas
     num mes de 2,5 milhoes.

  3. O Census pendura nota de rodape no rotulo ("Euro Area (2)"). Sem limpar,
     o agregado deixa de ser reconhecido, entra como pais e dobra o volume da
     zona do euro dentro do total.
"""

import io
import os
import re
import time
import zipfile
import datetime as dt
import urllib.request
import urllib.error

import pandas as pd

BASE = "https://www.census.gov/foreign-trade/Press-Release/steel"
CORRENTE = "https://www.census.gov/foreign-trade/Press-Release/current_press_release/steel"
UA = {"User-Agent": "Mozilla/5.0 (equity research)"}

AQUI = os.path.dirname(os.path.abspath(__file__))
# cache fora do repositorio (pasta temporaria do sistema); US_STEEL_CACHE muda o lugar
CACHE = os.environ.get("US_STEEL_CACHE") or os.path.join(__import__("tempfile").gettempdir(), "us_steel_cache", "ft900a")
SAIDA = CACHE

# Ordem de tentativa. O primeiro que servir vence.
#   steelf-excel_  -> final, era 2010-10 em diante
#   steelf_        -> final, era 1999-01 .. 2010-10
#   steelp_        -> preliminar, era 1998-11 .. ~2011
PADROES = [
    ("steelf-excel_{yy}{mm}.zip", "final"),
    ("steelf_{yy}{mm}.zip", "final"),
    ("steelp_{yy}{mm}.zip", "preliminar"),
]

COLUNAS = [
    "mes", "cty_code", "pais", "pais_norm", "grupo_cod", "grupo_desc", "tipo_aco",
    "valor_usd", "net_tons", "metric_tons", "preco_usd_por_tm",
    "fonte", "versao", "is_agregado", "arquivo_origem", "baixado_em",
]

MESES_EN = ("january", "february", "march", "april", "may", "june", "july",
            "august", "september", "october", "november", "december")


def _proximo_mes(ano, mes):
    return (ano + 1, 1) if mes == 12 else (ano, mes + 1)


# ---------------------------------------------------------------- download


def _baixar(url, tentativas=3, pausa=2.0):
    ultimo = None
    for i in range(tentativas):
        try:
            req = urllib.request.Request(url, headers=UA)
            with urllib.request.urlopen(req, timeout=120) as r:
                return r.read()
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return None
            ultimo = e
        except Exception as e:
            ultimo = e
        time.sleep(pausa * (i + 1))
    raise RuntimeError("falhou baixar %s: %s" % (url, ultimo))


def iter_zips(ano, mes, forcar=False):
    """Entrega (nome_arquivo, versao, ZipFile) na ordem de preferencia,
    um por vez e so quando pedido.

    E um gerador de proposito: quando o release final ja resolve, o
    preliminar daquele mes nem chega a ser baixado.
    """
    os.makedirs(CACHE, exist_ok=True)
    yy = "%02d" % (ano % 100)
    mm = "%02d" % mes
    for padrao, versao in PADROES:
        nome = padrao.format(yy=yy, mm=mm)
        caminho = os.path.join(CACHE, nome)
        faltando = os.path.join(CACHE, nome + ".404")
        if not forcar and os.path.exists(faltando):
            continue
        if not forcar and os.path.exists(caminho):
            with open(caminho, "rb") as f:
                yield nome, versao, zipfile.ZipFile(io.BytesIO(f.read()))
            continue
        dados = _baixar("%s/%s" % (BASE, nome))
        if dados is None:
            open(faltando, "wb").close()
            continue
        try:
            z = zipfile.ZipFile(io.BytesIO(dados))
        except zipfile.BadZipFile:
            open(faltando, "wb").close()
            continue
        with open(caminho, "wb") as f:
            f.write(dados)
        time.sleep(0.4)
        yield nome, versao, z


def zips_do_mes(ano, mes, forcar=False):
    """Mesma coisa, em lista. So para uso interativo."""
    return list(iter_zips(ano, mes, forcar=forcar))


# ---------------------------------------------------------------- microdado

# O codigo do grupo AISI vem colado no fim da descricao, separado por pontos.
# Cuidado: "SHEETS & STRIP ALL OTHER METALIC COAT.34" tem UM ponto so, porque o
# nome ocupa quase os 40 caracteres do campo. Exigir dois pontos deixava esse
# grupo (1,9% do volume, chapa metalizada) sem codigo e com a descricao suja.
RE_GRUPO = re.compile(r"\.+\s*([0-9][0-9A-Z&]*)\s*$")


def _num(s):
    s = str(s).strip().replace(",", "")
    if s in ("", "(-)", "-", "(NA)", "(D)", "None", "nan"):
        return None
    try:
        return float(s)
    except ValueError:
        return None


def parse_microdado(texto):
    """Le fstldata.txt / pstldata.txt (largura fixa).

    Layout em census.gov/foreign-trade/structures/stlstruc.txt.
    Atencao: ate 2000 a coluna de tipo de aco (A=alloy / C=carbon / S=stainless)
    NAO existe -- a linha e 2 caracteres mais curta. Por isso a cauda e lida
    por split() e nao por posicao fixa.
    """
    linhas = []
    for linha in texto.splitlines():
        if len(linha) < 90:
            continue
        cty = linha[0:4].strip()
        if not cty.isdigit():
            continue
        pais = linha[5:35].strip()
        prod = linha[36:76].strip()
        toks = linha[76:].split()
        if len(toks) == 8:
            tipo, val, net, _apn, met, _apm, mo, yr = toks
        elif len(toks) == 7:
            tipo = "T"
            val, net, _apn, met, _apm, mo, yr = toks
        else:
            continue
        if tipo not in ("A", "C", "S", "T"):
            continue
        if not (mo.isdigit() and yr.isdigit()):
            continue
        m = RE_GRUPO.search(prod)
        # em jan/2007 o Census publicou 3 linhas (139 t no total) com a
        # descricao do produto EM BRANCO. Marco em vez de deixar vazio.
        cod = m.group(1) if m else ("ND" if not prod else "")
        valor = _num(val)
        metric = _num(met)
        linhas.append({
            "mes": pd.Timestamp(int(yr), int(mo), 1),
            "cty_code": cty,
            "pais": pais,
            "grupo_cod": cod,
            "grupo_desc": (nome_canonico(cod, RE_GRUPO.sub("", prod).strip().rstrip("."))
                           if prod else "NAO ESPECIFICADO PELO CENSUS"),
            "tipo_aco": tipo,
            "valor_usd": valor,
            "net_tons": _num(net),
            "metric_tons": metric,
            "preco_usd_por_tm": (valor / metric) if (valor and metric) else None,
            "is_agregado": False,
        })
    return pd.DataFrame(linhas)


# ---------------------------------------------------------------- Anexo 2

# Rotulos que sao SOMA de outras linhas (tem filhos logo abaixo no anexo).
# Tudo o que nao esta aqui e folha -- inclusive os baldes residuais
# "Other EU", "Other Europe", "Other Pacific Rim", "Other S/C A", "Other FSR",
# "Other EE", "Other Western Europe" e "Other", que PRECISAM entrar na soma
# para o total fechar. A unica excecao e "Other Countries", que e cabecalho
# de regiao (tem India / South Africa / Thailand / Other embaixo).
#
# "Association" e "Countries(NICS)" aparecem porque o Census quebra
# "European Free Trade Association" e "Newly Industrialized Countries(NICS)"
# em duas linhas -- o valor vem na segunda.
AGREGADOS = {
    "total census basis", "north america", "europe", "western europe",
    "european union", "euro area", "european free trade association",
    "european free trade", "association", "eastern europe/fsr", "eastern europe",
    "former soviet republics", "pacific rim countries", "pacific rim",
    "newly industrialized countries(nics)", "newly industrialized countries (nics)",
    "newly industrialized", "countries(nics)", "countries (nics)",
    "south/central america", "south and central america", "south america",
    "central america", "asia", "africa", "middle east", "oceania",
    "asia and middle east", "other countries",
}

RE_NOTA = re.compile(r"\s*\(\d+\)\s*$")

# a linha que abre cada bloco: "Total Census Basis" nos anexos por pais,
# "Total Selected Commodities" no anexo por produto
TOTAIS = ("total census basis", "total selected commodities")


def _limpar_rotulo(nome):
    return RE_NOTA.sub("", str(nome).strip()).strip().rstrip(".")


def _eh_agregado(nome):
    n = _limpar_rotulo(nome).lower()
    if n in AGREGADOS:
        return True
    # alguns anexos CORTAM o rotulo na largura da coluna: nos Anexos 2a/2b/2c
    # de abr/2002 aparece "Former Soviet Repu". Sem reconhecer, o agregado
    # entra como pais e o mes fecha 1,4% acima do total publicado.
    return len(n) >= 8 and any(a.startswith(n) for a in AGREGADOS)


# O anexo em texto indenta os paises com 8 espacos debaixo da regiao --
# por isso o \s* na frente. Sem ele so as regioes casam e a soma da zero.
RE_LINHA_EX = re.compile(
    r"^\s*(?P<rot>\S.*?\S)\s{2,}(?P<resto>(?:[\d,]+|\(-\))(?:\s+(?:[\d,]+|\(-\)))*)\s*$"
)
RE_VALOR = re.compile(r"[\d,]+|\(-\)")

LIXO = ("exhibit", "quantity in", "(-) represents", "details may", "contact",
        "note:", "countries and", "areas", "not seasonally", "commodity",
        "grouping", "source", "cumulative")


RE_MES = re.compile(r"\b(" + "|".join(MESES_EN) + r")\b")
# "Details may not equal totals due to rounding" tem um "may" que se passa
# por mes de maio. Estas linhas ficam de fora da busca.
RUIDO_CABECALHO = ("details", "represents", "rounding", "contact", "note:")


def _cabecalho_txt(texto, n=18):
    return " ".join(l.strip() for l in texto.splitlines()[:n]).lower()


RE_ANO = re.compile(r"\b(19|20)\d{2}\b")


def _mes_do_bloco_txt(texto, n=18):
    """(mes, ano) do PRIMEIRO bloco Quantidade/Valor do anexo.

    O ano importa: o Census arquivou o release de OUTUBRO DE 2000 com o nome
    steelf_9910.zip. So o mes bateria; o ano denuncia a troca.
    """
    linhas = texto.splitlines()[:n]
    for i, linha in enumerate(linhas):
        low = linha.lower()
        if any(x in low for x in RUIDO_CABECALHO):
            continue
        m = RE_MES.search(low)
        if not m:
            continue
        ano = RE_ANO.search(linha)
        if not ano:                       # ex.: "2002 Data" numa linha acima
            for acima in reversed(linhas[:i]):
                ano = RE_ANO.search(acima)
                if ano:
                    break
        return MESES_EN.index(m.group(1)) + 1, (int(ano.group()) if ano else None)
    return None, None


def _mes_do_bloco_planilha(dados, xlsx, n=14):
    """Idem, olhando so a coluna B -- que e a que rotula o primeiro bloco.

    Nao da para procurar 'cumulative' no cabecalho inteiro e descartar: os
    anexos modernos tem colunas de acumulado do ano ('December Cumulative To
    Date') la na ponta direita, e um teste global jogava fora meses bons.
    """
    for valor in _coluna_b(dados, xlsx, n):
        m = RE_MES.search(str(valor).lower())
        if m:
            return MESES_EN.index(m.group(1)) + 1
    return None


def _coluna_b(dados, xlsx, n):
    if xlsx:
        import openpyxl
        sh = openpyxl.load_workbook(io.BytesIO(dados), data_only=True).worksheets[0]
        return [sh.cell(r, 2).value for r in range(1, min(n, sh.max_row) + 1)
                if sh.cell(r, 2).value not in (None, "")]
    import xlrd
    sh = xlrd.open_workbook(file_contents=dados).sheet_by_index(0)
    return [sh.cell_value(r, 1) for r in range(min(n, sh.nrows))
            if sh.ncols > 1 and sh.cell_value(r, 1) not in (None, "")]


def _valores_por_coluna(linha, cols):
    """Le a linha respeitando a coluna em que cada numero termina."""
    achados = [(t.end(), t.group()) for t in RE_VALOR.finditer(linha)]
    vals = []
    for c in cols:
        casa = [g for e, g in achados if abs(e - c) <= 3]
        vals.append(casa[0] if casa else None)
    return vals


def blocos_anexo_txt(texto):
    """Quebra o anexo em texto nos BLOCOS que ele traz.

    Um mesmo arquivo tem varios: o mes do release e o anterior, os mesmos dois
    meses do ano passado, e o acumulado do ano. Cada bloco comeca num
    cabecalho de periodo e vai ate a linha 'Total Census Basis' e seus paises.

    Ler so o primeiro bloco perde dado: o release de out/2000 (arquivado com o
    nome errado, steelf_9910.zip) e o unico lugar onde sobrou setembro/1999.

    Devolve [{mes, ano, cumulativo, linhas: [(rotulo, [valores por coluna])]}].
    """
    blocos = []
    atual = None
    periodo = (None, None, False)
    ano_contexto = None
    for linha in texto.splitlines():
        s = linha.strip()
        if not s or linha.startswith("_"):
            continue
        low = s.lower()
        crua = RE_LINHA_EX.match(linha.rstrip())
        if not crua:
            ano = RE_ANO.search(linha)
            if ano:
                ano_contexto = int(ano.group())
            if not any(x in low for x in RUIDO_CABECALHO):
                m = RE_MES.search(low)
                if m:
                    periodo = (MESES_EN.index(m.group(1)) + 1,
                               int(ano.group()) if ano else ano_contexto,
                               "cumulative" in low)
                    atual = None
            if "cumulative" in low and atual is None and periodo[0]:
                periodo = (periodo[0], periodo[1], True)
            continue
        if low.startswith(LIXO):
            continue
        rot = crua.group("rot").strip()
        if not rot or rot[0].isdigit():
            continue
        if _limpar_rotulo(rot).lower() in TOTAIS:
            atual = {"mes": periodo[0], "ano": periodo[1], "cumulativo": periodo[2],
                     "cols": [t.end() for t in RE_VALOR.finditer(linha)], "linhas": []}
            blocos.append(atual)
        if atual is None:
            continue
        atual["linhas"].append((rot, _valores_por_coluna(linha, atual["cols"])))
    return blocos


def _colunas_de_referencia(texto):
    """Posicao onde cada coluna numerica TERMINA.

    O anexo em texto e de largura fixa e alinhado a direita. Quando uma celula
    vem VAZIA (e nao "(-)"), contar os numeros na ordem em que aparecem joga
    tudo uma coluna para a esquerda: em out/2000 a Moldova estava sem valor no
    mes corrente, o parser leu o valor do mes anterior no lugar dele, e o pais
    entrou duas vezes no total (+2,3%).

    A regua sai da linha 'Total Census Basis', que nunca tem buraco.
    """
    for linha in texto.splitlines():
        if _limpar_rotulo(linha.strip().split("  ")[0]).lower() in TOTAIS:
            cols = [m.end() for m in RE_VALOR.finditer(linha)]
            if len(cols) >= 2:
                return cols
    return None


def _linhas_anexo_txt(texto):
    """Devolve [(rotulo, [num_col0, num_col1, ...])], respeitando a coluna em
    que cada numero esta. Para no segundo 'Total Census Basis' -- dali para
    baixo o arquivo repete o bloco do ano anterior."""
    cols = _colunas_de_referencia(texto)
    fora = []
    totais = 0
    for linha in texto.splitlines():
        if not linha.strip() or linha.startswith("_"):
            continue
        if linha.strip().lower().startswith(LIXO):
            continue
        m = RE_LINHA_EX.match(linha.rstrip())
        if not m:
            continue
        rot = m.group("rot").strip()
        if not rot or rot[0].isdigit():
            continue
        if _limpar_rotulo(rot).lower() in TOTAIS:
            totais += 1
            if totais > 1:
                break
        if cols:
            achados = [(t.end(), t.group()) for t in RE_VALOR.finditer(linha)]
            vals = []
            for c in cols:
                casa = [g for e, g in achados if abs(e - c) <= 3]
                vals.append(casa[0] if casa else None)
        else:
            vals = RE_VALOR.findall(m.group("resto"))
        fora.append((rot, vals))
    return fora


def _linhas_anexo_planilha(dados, xlsx):
    if xlsx:
        import openpyxl
        sh = openpyxl.load_workbook(io.BytesIO(dados), data_only=True).worksheets[0]
        filas = ([sh.cell(r, c).value for c in range(1, sh.max_column + 1)]
                 for r in range(1, sh.max_row + 1))
    else:
        import xlrd
        sh = xlrd.open_workbook(file_contents=dados).sheet_by_index(0)
        filas = ([sh.cell_value(r, c) for c in range(sh.ncols)]
                 for r in range(sh.nrows))
    fora, totais = [], 0
    for fila in filas:
        if not fila or fila[0] in (None, ""):
            continue
        rot = str(fila[0]).strip()
        if rot.lower().startswith(LIXO):
            continue
        vals = [fila[c] if c < len(fila) else None for c in range(1, len(fila))]
        if all(_num(v) is None for v in vals):
            continue
        if _limpar_rotulo(rot).lower() in TOTAIS:
            totais += 1
            if totais > 1:
                break
        fora.append((rot, vals))
    return fora


def _cabecalho_planilha(dados, xlsx, n=14):
    linhas = _todas_celulas(dados, xlsx, n)
    return " ".join(linhas).lower()


def _todas_celulas(dados, xlsx, n):
    if xlsx:
        import openpyxl
        sh = openpyxl.load_workbook(io.BytesIO(dados), data_only=True).worksheets[0]
        return [str(sh.cell(r, c).value)
                for r in range(1, min(n, sh.max_row) + 1)
                for c in range(1, sh.max_column + 1)
                if sh.cell(r, c).value not in (None, "")]
    import xlrd
    sh = xlrd.open_workbook(file_contents=dados).sheet_by_index(0)
    return [str(sh.cell_value(r, c))
            for r in range(min(n, sh.nrows))
            for c in range(sh.ncols)
            if sh.cell_value(r, c) not in (None, "")]


def _montar_anexo(pares, mes_alvo, par, eixo="pais", tipo="T"):
    """par=0 -> primeiro bloco Quantidade/Valor (mes do release);
    par=1 -> segundo bloco (mes anterior ao release).

    eixo='pais'    -> cada linha e um pais, produto fica como TOTAL
    eixo='produto' -> cada linha e um grupo de produto, pais fica como TODOS
    """
    q_i, v_i = 2 * par, 2 * par + 1
    linhas = []
    for rot, vals in pares:
        if len(vals) <= v_i:
            continue
        q, v = _num(vals[q_i]), _num(vals[v_i])
        if q is None and v is None:
            continue
        valor = v * 1000.0 if v is not None else None    # o anexo publica US$ mil
        nome = _limpar_rotulo(rot)
        por_pais = eixo == "pais"
        linhas.append({
            "mes": mes_alvo,
            "cty_code": "",
            "pais": nome if por_pais else "TODOS OS PAISES",
            "grupo_cod": "TOTAL" if por_pais else _codigo_do_produto(nome),
            "grupo_desc": ("TOTAL STEEL MILL PRODUCTS" if por_pais
                           else nome_canonico(_codigo_do_produto(nome), nome)),
            "tipo_aco": tipo,
            "valor_usd": valor,
            "net_tons": None,
            "metric_tons": q,
            "preco_usd_por_tm": (valor / q) if (valor and q) else None,
            "is_agregado": (_eh_agregado(nome) if por_pais
                            else _limpar_rotulo(nome).lower() in TOTAIS),
        })
    return pd.DataFrame(linhas)


def _candidatos(z, raizes):
    """Arquivos do ZIP que casam com uma raiz de anexo, em qualquer extensao.

    Exhibit 1  -> steel1f   (por PRODUTO, todos os paises)
    Exhibit 1a/1b/1c -> por produto, so liga / inox / carbono
    Exhibit 2  -> steel2f   (por PAIS, aco total)
    Exhibit 2a/2b/2c -> por pais, so liga / inox / carbono
    """
    for n in z.namelist():
        base = os.path.basename(n).lower()
        raiz, _, ext = base.rpartition(".")
        if ext in ("txt", "xls", "xlsx") and raiz in raizes:
            yield n


def _candidatos_anexo(z):
    """steel2f / steel2p -- o anexo do aco TOTAL."""
    return _candidatos(z, ("steel2f", "steel2p"))


def _ler_anexo(z, cand, mes_alvo, par, chave="countries", eixo="pais", tipo="T"):
    """Le um candidato se ele realmente servir para o mes pedido.

    par=0: o primeiro bloco do anexo tem que ser o proprio mes.
    par=1: o primeiro bloco tem que ser o mes SEGUINTE -- ai o segundo bloco,
           que e o que vamos ler, e o mes que queremos.
    """
    esperado = mes_alvo.month if par == 0 else (mes_alvo.month % 12) + 1
    ano_esperado = mes_alvo.year
    if par == 1 and mes_alvo.month == 12:
        ano_esperado += 1                    # o release seguinte ja e de janeiro
    dados = z.read(cand)
    base = cand.lower()
    if base.endswith(".txt"):
        texto = dados.decode("latin-1")
        if chave not in _cabecalho_txt(texto):
            return None      # o Census ja empacotou a tabela errada com este nome
        pares = None
        for bloco in blocos_anexo_txt(texto):
            if bloco["cumulativo"] or bloco["mes"] != esperado:
                continue
            if bloco["ano"] is not None and bloco["ano"] != ano_esperado:
                continue
            pares = bloco["linhas"]
            break
        if pares is None:
            return None
    else:
        xlsx = base.endswith(".xlsx")
        if chave not in _cabecalho_planilha(dados, xlsx):
            return None
        if _mes_do_bloco_planilha(dados, xlsx) != esperado:
            return None
        pares = _linhas_anexo_planilha(dados, xlsx)
    df = _montar_anexo(pares, mes_alvo, par, eixo=eixo, tipo=tipo)
    return df if not df.empty else None


def anexo_paises(ano, mes, forcar=False):
    """Total por pais daquele mes, vindo do Anexo 2.

    Tenta o release do proprio mes (primeiro bloco de colunas) e, se ele
    estiver quebrado -- foi o caso de junho/2002 --, tenta o release do mes
    SEGUINTE, onde o mes que a gente quer aparece como bloco de comparacao.
    Devolve (DataFrame, nome_do_zip, versao, origem) ou (None, ...).
    """
    mes_alvo = pd.Timestamp(ano, mes, 1)
    for nome, versao, z in iter_zips(ano, mes, forcar=forcar):
        for cand in _candidatos_anexo(z):
            df = _ler_anexo(z, cand, mes_alvo, par=0)
            if df is not None:
                return df, "%s!%s" % (nome, cand), versao, "release do mes"
    a2, m2 = _proximo_mes(ano, mes)
    for nome, versao, z in iter_zips(a2, m2, forcar=forcar):
        for cand in _candidatos_anexo(z):
            df = _ler_anexo(z, cand, mes_alvo, par=1)
            if df is not None:
                return df, "%s!%s" % (nome, cand), versao, "release do mes seguinte"
    return None, "", "", ""


def _pares_da_planilha(dados, xlsx, n=14):
    """(indice_do_par, mes, ano) lidos da linha de rotulos de periodo.

    Os anexos em planilha trazem varios pares Quantidade/Valor: mes do
    release, mes anterior, o MESMO mes um ano atras, e acumulados do ano.
    """
    linhas = _linhas_cabecalho_planilha(dados, xlsx, n)
    for fila in linhas:
        achados = []
        for c, valor in enumerate(fila):
            if valor in (None, ""):
                continue
            texto = str(valor).lower()
            m = RE_MES.search(texto)
            if not m:
                continue
            ano = RE_ANO.search(str(valor))
            achados.append(((c - 1) // 2, MESES_EN.index(m.group(1)) + 1,
                            int(ano.group()) if ano else None,
                            "cumulative" in texto))
        if len(achados) >= 2:
            return achados
    return []


def _linhas_cabecalho_planilha(dados, xlsx, n):
    if xlsx:
        import openpyxl
        sh = openpyxl.load_workbook(io.BytesIO(dados), data_only=True).worksheets[0]
        return [[sh.cell(r, c).value for c in range(1, sh.max_column + 1)]
                for r in range(1, min(n, sh.max_row) + 1)]
    import xlrd
    sh = xlrd.open_workbook(file_contents=dados).sheet_by_index(0)
    return [[sh.cell_value(r, c) for c in range(sh.ncols)]
            for r in range(min(n, sh.nrows))]


def total_alternativo(ano, mes, forcar=False):
    """Confirmacao vinda de OUTRO arquivo.

    O release do mesmo mes do ano SEGUINTE repete o mes de um ano atras num
    bloco proprio. Como e outro arquivo, publicado um ano depois, bater com
    ele e prova de verdade -- nao e o numero se conferindo consigo mesmo.
    Devolve (metric_tons, nome_do_arquivo) ou (None, "").
    """
    mes_alvo = pd.Timestamp(ano, mes, 1)
    # dois caminhos independentes: o release do mesmo mes um ano depois
    # (que repete o mes num bloco proprio) e o release do mes seguinte
    # (onde o mes que queremos e a coluna de comparacao).
    for a2, m2 in ((ano + 1, mes), _proximo_mes(ano, mes)):
        for nome, _versao, z in iter_zips(a2, m2, forcar=forcar):
            for cand in _candidatos_anexo(z):
                df = _df_do_periodo(z, cand, ano, mes, mes_alvo)
                if df is None:
                    continue
                linha = df[df["pais"].str.lower() == "total census basis"]
                if len(linha):
                    return float(linha.iloc[0]["metric_tons"]), "%s!%s" % (nome, cand)
    return None, ""


def _df_do_periodo(z, cand, ano, mes, mes_alvo):
    """Procura, dentro de um anexo qualquer, o bloco/par daquele mes e ano."""
    dados = z.read(cand)
    base = cand.lower()
    if base.endswith(".txt"):
        texto = dados.decode("latin-1")
        if "countries" not in _cabecalho_txt(texto):
            return None
        for bloco in blocos_anexo_txt(texto):
            if not bloco["cumulativo"] and bloco["mes"] == mes and bloco["ano"] == ano:
                return _montar_anexo(bloco["linhas"], mes_alvo, 0)
        return None
    xlsx = base.endswith(".xlsx")
    if "countries" not in _cabecalho_planilha(dados, xlsx):
        return None
    for idx, m, a, cumul in _pares_da_planilha(dados, xlsx):
        if cumul or m != mes:
            continue
        if a is not None and a != ano:
            continue
        if a is None and idx != 1:
            # sem ano no rotulo, so aceito o par de comparacao imediato,
            # que por construcao e o mes anterior ao release
            continue
        return _montar_anexo(_linhas_anexo_planilha(dados, xlsx), mes_alvo, idx)
    return None


def total_oficial(ano, mes, forcar=False):
    """A linha 'Total Census Basis' publicada pelo Census para aquele mes.

    E o gabarito independente: o Anexo 2 e produzido por um caminho diferente
    do microdado, entao se os dois batem o parser esta certo de verdade.
    Devolve (metric_tons, valor_usd) ou (None, None).
    """
    df, _arq, _v, _o = anexo_paises(ano, mes, forcar=forcar)
    if df is None:
        return None, None
    linha = df[df["pais"].str.lower() == "total census basis"]
    if not len(linha):
        return None, None
    return float(linha.iloc[0]["metric_tons"]), float(linha.iloc[0]["valor_usd"])


# ---------------------------------------------------------------- orquestracao


def coletar_mes(ano, mes, forcar=False):
    """Devolve (DataFrame, dict_log) para um mes."""
    mes_alvo = pd.Timestamp(ano, mes, 1)
    log = {"mes": mes_alvo, "fonte": "", "versao": "", "arquivo": "",
           "linhas": 0, "paises": 0, "obs": ""}

    estado = {"achou_zip": False, "descartes": []}

    # 1) microdado do release FINAL.
    #    O preliminar fica de fora nesta passada de proposito: misturar
    #    preliminar com final abre um degrau artificial na serie (em jan/2004
    #    o preliminar esta 2,2% abaixo do final). Melhor perder a quebra por
    #    produto naquele mes do que sujar o total por pais.
    df, log2 = _tentar_microdado(ano, mes, mes_alvo, forcar, estado, so_final=True)
    if df is not None:
        log.update(log2)
        return df, log

    if not estado["achou_zip"]:
        log["obs"] = "nenhum ZIP publicado"
        return pd.DataFrame(columns=COLUNAS), log

    # 2a) Anexos 2a/2b/2c -- pais x tipo de aco. E a quebra mais fina que
    #     existe nos meses sem microdado; somar A+S+C reproduz o Anexo 2.
    df, arquivo, versao = anexo_paises_por_tipo(ano, mes, forcar=forcar)
    if df is not None:
        df = _finalizar(df, "anexo2abc", versao, arquivo)
        obs = ["sem cruzamento pais x produto; pais x tipo de aco (liga/inox/carbono)"]
        obs += estado["descartes"]
        log.update(fonte="anexo2abc", versao=versao, arquivo=arquivo.split("!")[0],
                   linhas=len(df), paises=int((~df["is_agregado"]).sum()) // 3,
                   obs="; ".join(obs))
        return df, log

    # 2b) Anexo 2 puro -- so o total por pais
    df, arquivo, versao, origem = anexo_paises(ano, mes, forcar=forcar)
    if df is not None:
        df = _finalizar(df, "anexo2", versao, arquivo)
        obs = ["sem abertura por produto; so paises selecionados (%s)" % origem]
        obs += estado["descartes"]
        log.update(fonte="anexo2", versao=versao, arquivo=arquivo.split("!")[0],
                   linhas=len(df), paises=int((~df["is_agregado"]).sum()),
                   obs="; ".join(obs))
        return df, log

    # 3) ultimo recurso: microdado preliminar
    df, log2 = _tentar_microdado(ano, mes, mes_alvo, forcar, estado, so_final=False)
    if df is not None:
        log.update(log2)
        log["obs"] = ("dado PRELIMINAR -- o Census ainda revisa; " + log["obs"]).strip("; ")
        return df, log

    log["obs"] = "ZIP existe mas nem microdado nem Anexo 2 servem. %s" % "; ".join(
        estado["descartes"])
    return pd.DataFrame(columns=COLUNAS), log


def _tentar_microdado(ano, mes, mes_alvo, forcar, estado, so_final):
    for nome, versao, z in iter_zips(ano, mes, forcar=forcar):
        estado["achou_zip"] = True
        if so_final and versao != "final":
            continue
        alvo = [n for n in z.namelist()
                if os.path.basename(n).lower() in ("fstldata.txt", "pstldata.txt")]
        if not alvo:
            continue
        df = parse_microdado(z.read(alvo[0]).decode("latin-1"))
        if df.empty:
            continue
        # ARMADILHA 1: o nome do ZIP nao garante o mes do dado.
        carimbos = set(df["mes"].unique())
        if carimbos != {mes_alvo}:
            aviso = "%s carimbado %s" % (
                nome, ", ".join(pd.Timestamp(c).strftime("%Y-%m") for c in sorted(carimbos)))
            if aviso not in estado["descartes"]:
                estado["descartes"].append(aviso)
            continue
        df = _finalizar(df, "microdado", versao, "%s!%s" % (nome, alvo[0]))
        return df, {"fonte": "microdado", "versao": versao, "arquivo": nome,
                    "linhas": len(df), "paises": df["pais_norm"].nunique(),
                    "obs": "; ".join(estado["descartes"])}
    return None, {}


# Schedule C x nomes do Anexo 2 -- so o necessario para as series baterem
SINONIMOS = {
    "korea": "Korea, South",
    "south korea": "Korea, South",
    "columbia": "Colombia",
    "turkiye": "Turkey",
    "viet nam": "Vietnam",
    "russian federation": "Russia",
}


def _norm_pais(nome):
    n = str(nome).strip()
    return SINONIMOS.get(n.lower(), n)


def _finalizar(df, fonte, versao, arquivo):
    df = df.copy()
    df["pais_norm"] = df["pais"].map(_norm_pais)
    df["fonte"] = fonte
    df["versao"] = versao
    df["arquivo_origem"] = arquivo
    df["baixado_em"] = dt.date.today().isoformat()
    for c in COLUNAS:
        if c not in df.columns:
            df[c] = None
    return df[COLUNAS]


def meses(inicio=(1999, 1), fim=None):
    if fim is None:
        hoje = dt.date.today()
        fim = (hoje.year, hoje.month)
    a, m = inicio
    while (a, m) <= fim:
        yield a, m
        m += 1
        if m == 13:
            a, m = a + 1, 1


# ------------------------------------------------- outros anexos publicados
#
# Os meses sem microdado nao ficam so com o total por pais. O mesmo ZIP traz:
#   Exhibit 1 / 1a / 1b / 1c -> por PRODUTO (todos os paises), aco total e
#                               depois liga / inox / carbono
#   Exhibit 2a / 2b / 2c     -> por PAIS, liga / inox / carbono
# O que nao existe nesses meses e o CRUZAMENTO pais x produto.

# nome do grupo AISI -> codigo. O Exhibit 1 escreve em Title Case e as vezes
# abrevia; o microdado escreve em maiuscula. Comparo sem espaco nem pontuacao.
_GRUPOS_AISI = {
    "1A": "INGOTS AND STEEL FOR CASTINGS", "1B": "BLOOMS, BILLETS AND SLABS",
    "3": "WIRE RODS", "4": "STRUCTURAL SHAPES HEAVY", "5": "STEEL PILING",
    "6A": "PLATES CUT LENGTHS", "6B": "PLATES IN COILS", "7": "RAILS STANDARD",
    "8": "RAILS ALL OTHER", "9": "RAILROAD ACCESSORIES", "14": "BARS - HOT ROLLED",
    "14A": "BARS - LIGHT SHAPED", "15": "BARS - REINFORCING",
    "16": "BARS-COLD FINISHED", "17": "TOOL STEEL", "18": "STANDARD PIPE",
    "19": "OIL COUNTRY GOODS", "20": "LINE PIPE",
    "20A": "LINE PIPE > 16 INCHES IN DIAMETER",
    "20B": "LINE PIPE <= 16 INCHES IN DIAMETER", "20C": "LINE PIPE - NOT SPECIFIED",
    "21A": "MECHANICAL TUBING", "21B": "PRESSURE TUBING",
    "21C&D": "STAINLESS PIPE & TUBING", "21E": "PIPE & TUBING NONCLASSIFIED",
    "22A": "STRUCTURAL PIPE & TUBE", "22B": "PIPE FOR PILING", "23": "WIRE DRAWN",
    "28": "BLACK PLATE", "29": "TIN PLATE", "29A": "TIN FREE STEEL",
    "31": "SHEETS HOT ROLLED", "32": "SHEETS COLD ROLLED",
    "33A": "SHEETS & STRIP GALV HOT DIPPED", "33B": "SHEETS & STRIP GALV ELECTROLYT",
    "34": "SHEETS & STRIP ALL OTHER METALIC COAT",
    "35": "SHEETS & STRIP - ELECTRICAL", "36": "STRIP - HOT ROLLED",
    "37": "STRIP - COLD ROLLED", "41": "RAILS - USED",
}
# como o Exhibit 1 abrevia alguns nomes
_APELIDOS_AISI = {
    "SHEETS&STRIPALLOTHMETCOAT": "34",
    "SHEETS&STRIPGALVELECTROLYTIC": "33B",
    "STAINLESSPIPE&TUBE": "21C&D",
    "PIPE&TUBINGNONCLASS": "21E",
    "SHEETS&STRIPELECTRICAL": "35",
}


def _chave_produto(nome):
    return re.sub(r"[^A-Z0-9&<>=]", "", str(nome).upper())


_MAPA_PRODUTO = {_chave_produto(v): k for k, v in _GRUPOS_AISI.items()}
_MAPA_PRODUTO.update(_APELIDOS_AISI)
produtos_sem_codigo = set()


def _codigo_do_produto(nome):
    chave = _chave_produto(nome)
    cod = _MAPA_PRODUTO.get(chave)
    if cod is None and len(chave) >= 12:
        # o Exhibit 1 corta o nome na largura da coluna:
        # "LINE PIPE > 16 INCHES IN DIAMETE" (sem o R final)
        casa = {c for k, c in _MAPA_PRODUTO.items() if k.startswith(chave)}
        if len(casa) == 1:
            cod = casa.pop()
    if cod is None and _limpar_rotulo(nome).lower() not in TOTAIS:
        produtos_sem_codigo.add(nome)
    return cod or ""


def nome_canonico(cod, alternativo=""):
    """O mesmo grupo aparece escrito de tres jeitos ("BARS-COLD FINISHED" no
    microdado, "Bars - Cold Finished" no Anexo 1, e cortado quando o nome nao
    cabe na coluna). Padronizo pelo codigo, senao o mesmo produto vira duas
    linhas na tabela dinamica."""
    return _GRUPOS_AISI.get(cod, str(alternativo).upper())


def _buscar_exhibit(ano, mes, raizes, chave, eixo, tipo, forcar=False):
    """Procura o anexo no release do proprio mes e, se ele estiver quebrado,
    no release do mes seguinte (onde o mes vira coluna de comparacao)."""
    mes_alvo = pd.Timestamp(ano, mes, 1)
    a2, m2 = _proximo_mes(ano, mes)
    for a, m, par, origem in ((ano, mes, 0, "release do mes"),
                              (a2, m2, 1, "release do mes seguinte")):
        for nome, versao, z in iter_zips(a, m, forcar=forcar):
            for cand in _candidatos(z, raizes):
                df = _ler_anexo(z, cand, mes_alvo, par, chave, eixo, tipo)
                if df is not None:
                    return df, "%s!%s" % (nome, cand), versao, origem
    return None, "", "", ""


ANEXOS_POR_TIPO = (("steel2af", "steel2ap", "A"),
                   ("steel2bf", "steel2bp", "S"),
                   ("steel2cf", "steel2cp", "C"))


def anexo_paises_por_tipo(ano, mes, forcar=False):
    """Pais x tipo de aco (A=liga, S=inox, C=carbono), dos Anexos 2a/2b/2c.

    Nos meses sem microdado e a quebra mais fina que existe por pais. Somar os
    tres tipos reproduz o total do Anexo 2 -- da para conferir.
    """
    partes, arquivos, versao = [], [], ""
    for raiz_f, raiz_p, tipo in ANEXOS_POR_TIPO:
        df, arq, ver, _origem = _buscar_exhibit(
            ano, mes, (raiz_f, raiz_p), "countries", "pais", tipo, forcar)
        if df is None:
            return None, "", ""
        partes.append(df)
        arquivos.append(arq)
        versao = ver
    return pd.concat(partes, ignore_index=True), " + ".join(arquivos), versao


ANEXOS_PRODUTO = ((("steel1f", "steel1p"), "T"),
                  (("steel1af", "steel1ap"), "A"),
                  (("steel1bf", "steel1bp"), "S"),
                  (("steel1cf", "steel1cp"), "C"))


def anexo_produtos(ano, mes, por_tipo=False, forcar=False):
    """Grupo de produto x mes, somando todos os paises (Exhibit 1).

    Existe em TODOS os meses, inclusive nos que nao tem microdado -- e o que
    permite ter a serie por produto completa de 1999 ate hoje.
    por_tipo=True acrescenta a quebra liga / inox / carbono (Exhibit 1a/1b/1c).
    """
    alvos = ANEXOS_PRODUTO if por_tipo else ANEXOS_PRODUTO[:1]
    partes, arquivos, versao = [], [], ""
    for raizes, tipo in alvos:
        df, arq, ver, _origem = _buscar_exhibit(
            ano, mes, raizes, "commodity", "produto", tipo, forcar)
        if df is None:
            if tipo == "T":
                return None, "", ""
            continue
        partes.append(df)
        arquivos.append(arq)
        versao = ver
    if not partes:
        return None, "", ""
    return pd.concat(partes, ignore_index=True), " + ".join(arquivos), versao
