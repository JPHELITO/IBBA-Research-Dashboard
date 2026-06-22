#!/usr/bin/env python3
"""
ports.py — normalização de nome de porto/URF (FONTE ÚNICA compartilhada).

Funde os vários códigos de URF do MDIC que apontam p/ o mesmo porto físico num
único nome canônico (ex.: '0817800 - PORTO DE SANTOS' → 'Santos'). Usado pelo
SECEX de aço (updater_sm.py) e pelo SECEX de celulose (extractor_pp.py / Fase 2),
p/ os nomes de porto baterem entre as duas dashboards.

(Copiado de Pulp and Paper/extractor_pp.py:norm_port; quando o pulp migrar p/ o
motor MDIC ao vivo na Fase 2, ele passa a importar daqui também.)
"""


def norm_port(urf):
    """'0817800 - PORTO DE SANTOS' → 'Santos'. Funde variantes ALF/IRF/PORTO/AEROPORTO."""
    s = str(urf or "")
    if " - " in s:
        s = s.split(" - ", 1)[1]
    s = s.upper()
    for pre in ("PORTO DE ", "PORTO DO ", "ALF - ", "ALF-", "IRF - ", "IRF-", "IRF ",
                "AEROPORTO INTERNACIONAL DE ", "AEROPORTO INTERNACIONAL ", "AEROPORTO DE "):
        if s.startswith(pre):
            s = s[len(pre):]
    s = s.strip()
    NAMES = {
        "VITORIA": "Vitória", "SANTOS": "Santos", "RIO GRANDE": "Rio Grande",
        "PARANAGUA": "Paranaguá", "SAO LUIS": "São Luís", "SÃO LUÍS": "São Luís",
        "SAO FRANCISCO DO SUL": "São Francisco do Sul", "ITAJAI": "Itajaí",
        "SALVADOR": "Salvador", "SANTANA": "Santana", "IMBITUBA": "Imbituba",
        "MONTE DOURADO": "Monte Dourado", "ALMEIRIM": "Almeirim",
        "RIO DE JANEIRO": "Rio de Janeiro", "ITAGUAI": "Itaguaí",
        "URUGUAIANA": "Uruguaiana", "FOZ DO IGUACU": "Foz do Iguaçu",
        "FOZ DO IGUAÇU": "Foz do Iguaçu", "CURITIBA": "Curitiba",
        "FORTALEZA": "Fortaleza", "CORUMBA": "Corumbá", "CORUMBÁ": "Corumbá",
        "JAGUARAO": "Jaguarão", "CHUI": "Chuí", "CHUÍ": "Chuí",
        "DIONISIO CERQUEIRA": "Dionísio Cerqueira", "DIONÍSIO": "Dionísio Cerqueira",
        "SAO BORJA": "São Borja", "SÃO BORJA": "São Borja", "PONTA PORA": "Ponta Porã",
    }
    return NAMES.get(s, s.title())
