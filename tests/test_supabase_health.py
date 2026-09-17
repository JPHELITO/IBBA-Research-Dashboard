# -*- coding: utf-8 -*-
"""Testes da sentinela do corte de cota do Supabase (_shared/supabase_health.py).

Exercitam a função PURA `diagnosticar()` e a aritmética do ciclo. Nenhum teste
toca a rede: as respostas do Supabase entram como dicionários montados à mão,
inclusive o corpo real de um 402 da Fair Use Policy.

O que estes testes protegem, além do óbvio:
  • que o 402 tenha PRIORIDADE sobre qualquer outro erro (num corte, um endpoint
    pode dar 402 e outro dar timeout — o alerta certo é o do corte);
  • que silêncio NÃO seja confundido com corte (queda do provedor ≠ cota);
  • que o texto do alerta continue dizendo que o clipping cai — é a frase que faz
    o usuário agir, e é a primeira que alguém apagaria "enxugando" a mensagem.

Rodar:  python -m pytest tests/test_supabase_health.py -q
"""
import os
import sys
from datetime import date

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "_shared"))
import supabase_health as sh  # noqa: E402

# corpo real que o Supabase devolve quando a Fair Use Policy está aplicada
CORPO_402 = '{"message":"Project is restricted","code":"exceeded_egress_quota"}'


def _r(*codigos, corpo=""):
    """Monta o resultado dos 3 endpoints a partir dos códigos HTTP."""
    return [
        {"nome": nome, "path": path.split("?")[0], "status": st,
         "corpo": corpo if st == 402 else ""}
        for (nome, path), st in zip(sh.CHECKS, codigos)
    ]


# ── caminho feliz ────────────────────────────────────────────────────────────
def test_tudo_200_e_ok_e_nao_gera_email():
    codigo, assunto, _ = sh.diagnosticar(_r(200, 200, 200))
    assert codigo == "ok"
    assert assunto == ""          # assunto vazio = nada a enviar


# ── o corte ──────────────────────────────────────────────────────────────────
def test_402_em_todos_e_restrito():
    codigo, assunto, corpo = sh.diagnosticar(_r(402, 402, 402, corpo=CORPO_402))
    assert codigo == "restrito"
    assert "CORTADO" in assunto
    assert "exceeded_egress_quota" in corpo


def test_402_em_um_so_ja_e_restrito():
    # o Storage pode responder antes de o corte propagar; um 402 já basta
    assert sh.diagnosticar(_r(200, 200, 402, corpo=CORPO_402))[0] == "restrito"


def test_402_vence_timeout_no_mesmo_ciclo():
    # cenário real de corte: um endpoint devolve 402, outro estoura o tempo.
    # O alerta tem que ser o do CORTE, não o de "provedor fora do ar".
    assert sh.diagnosticar(_r(402, None, None, corpo=CORPO_402))[0] == "restrito"


def test_codigo_desconhecido_nao_quebra_a_mensagem():
    corpo_estranho = '{"message":"Project is restricted"}'   # sem o campo code
    codigo, _, corpo = sh.diagnosticar(_r(402, 402, 402, corpo=corpo_estranho))
    assert codigo == "restrito"
    assert "exceeded_*_quota" in corpo       # cai no genérico em vez de estourar


def test_alerta_diz_que_o_clipping_cai_e_como_resolver():
    _, _, corpo = sh.diagnosticar(_r(402, 402, 402, corpo=CORPO_402))
    assert "CLIPPING" in corpo               # o que faz o usuário agir
    assert "US$ 25" in corpo                 # o desbloqueio imediato
    assert "Nenhum dado foi perdido" in corpo  # o que evita pânico


# ── queda do provedor: parecido, mas NÃO é o corte ───────────────────────────
def test_silencio_total_e_fora_do_ar_nao_corte():
    codigo, assunto, corpo = sh.diagnosticar(_r(None, None, None))
    assert codigo == "fora_do_ar"
    assert "CORTADO" not in assunto
    assert "NÃO é o corte" in corpo


def test_5xx_em_todos_tambem_e_fora_do_ar():
    assert sh.diagnosticar(_r(503, 503, 503))[0] == "fora_do_ar"


def test_5xx_nao_e_conclusivo_mas_4xx_e():
    # governa a repetição: só repete o que pode ser soluço de rede
    assert sh._conclusivo(200) and sh._conclusivo(402) and sh._conclusivo(401)
    assert not sh._conclusivo(500) and not sh._conclusivo(None)


# ── a sentinela enferrujada ──────────────────────────────────────────────────
def test_401_e_problema_da_sentinela_nao_da_dash():
    codigo, assunto, corpo = sh.diagnosticar(_r(401, 200, 200))
    assert codigo == "estranho"
    assert "sentinela" in assunto.lower()
    assert "chave pública" in corpo


def test_parcialmente_mudo_nao_vira_fora_do_ar():
    # um respondeu: o provedor não caiu inteiro, então é caso de olhar, não de pânico
    assert sh.diagnosticar(_r(200, None, None))[0] == "estranho"


# ── aritmética do ciclo (dia 27) ─────────────────────────────────────────────
def test_reset_no_mes_corrente():
    assert sh.proximo_reset(date(2026, 9, 17)) == date(2026, 9, 27)


def test_no_proprio_dia_27_o_proximo_reset_e_o_mes_seguinte():
    assert sh.proximo_reset(date(2026, 9, 27)) == date(2026, 10, 27)


def test_depois_do_27_vai_para_o_mes_seguinte():
    assert sh.proximo_reset(date(2026, 9, 30)) == date(2026, 10, 27)


def test_virada_de_ano():
    assert sh.proximo_reset(date(2026, 12, 30)) == date(2027, 1, 27)


def test_fevereiro_tem_dia_27():
    # o dia 27 existe em todo mês — é por isso que a âncora não precisa de gambiarra
    assert sh.proximo_reset(date(2027, 2, 1)) == date(2027, 2, 27)


def test_alerta_mostra_a_data_do_proximo_reset():
    _, _, corpo = sh.diagnosticar(_r(402, 402, 402, corpo=CORPO_402), hoje=date(2026, 9, 17))
    assert "27/09" in corpo


# ── o vigia não pode morrer no log ───────────────────────────────────────────
def test_saida_ascii_para_console_cp1252():
    # o console do Windows estoura na seta "→"; a sentinela degrada em vez de morrer
    assert sh._ascii("banco → HTTP 402") == "banco ? HTTP 402"


def test_imprimir_nunca_levanta():
    sh._imprimir("tabela com seta → e emoji 🩺")   # se levantar, o teste falha
