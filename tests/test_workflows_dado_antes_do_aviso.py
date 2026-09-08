# -*- coding: utf-8 -*-
"""Guarda de regressão: NENHUM aviso pode custar o dado.

Em 08/09/2026 o SECEX de agosto ficou 4 dias fora da dashboard porque o passo
"Send email notification" vinha ANTES do "Commit & push". Com a senha de app do
Gmail vencida, o e-mail falhava (535 BadCredentials), o job morria ali e o commit
era PULADO — o banco atualizado existia no runner e ia pro lixo a cada rodada.

A regra que este teste trava, em todos os workflows: se um job grava dado (tem um
passo que faz `git commit`/`git push`), nenhum passo de NOTIFICAÇÃO pode vir antes
dele. O dado sobe primeiro; o aviso vem depois e pode falhar à vontade.

Exceção declarada: passos que gravam o dado E avisam dentro do mesmo script Python
(Empapel/IBÁ/INDA). Ali o e-mail sai por `_shared/notify.py`, que engole qualquer
erro de SMTP e devolve False — nunca levanta exceção, então não derruba a gravação.

Rodar:  python -m pytest tests/test_workflows_dado_antes_do_aviso.py -q
"""
import glob
import os
import re

import pytest
import yaml

BASE = os.path.dirname(os.path.abspath(__file__))
WF_DIR = os.path.join(BASE, "..", ".github", "workflows")

# Passos que gravam a base e, de quebra, mandam e-mail por notify.once() (que nunca
# levanta exceção). Não são "avisos" para efeito desta regra.
GRAVAM_E_AVISAM = re.compile(r"(ler|achar).*(gravar|conferir)", re.I)


def _steps(job):
    return job.get("steps") or []


def _e_aviso(step):
    if GRAVAM_E_AVISAM.search(str(step.get("name", ""))):
        return False
    blob = f"{step.get('uses','')} {step.get('run','')} {step.get('name','')}".lower()
    return "send-mail" in blob or "notify.py" in blob or re.search(r"e-?mail", blob)


def _e_commit(step):
    blob = f"{step.get('run','')}".lower()
    return "git commit" in blob or "git push" in blob


def _jobs():
    for path in sorted(glob.glob(os.path.join(WF_DIR, "*.yml"))):
        doc = yaml.safe_load(open(path, encoding="utf-8")) or {}
        for nome, job in (doc.get("jobs") or {}).items():
            yield os.path.basename(path), nome, job


@pytest.mark.parametrize("arquivo,job_nome,job", list(_jobs()),
                         ids=[f"{a}:{n}" for a, n, _ in _jobs()])
def test_o_aviso_nunca_vem_antes_do_commit(arquivo, job_nome, job):
    steps = _steps(job)
    commits = [i for i, s in enumerate(steps) if _e_commit(s)]
    if not commits:
        return                      # job que não grava dado: nada a proteger
    primeiro_commit = commits[0]
    antes = [(i, steps[i].get("name")) for i in range(primeiro_commit) if _e_aviso(steps[i])]
    assert not antes, (
        f"{arquivo} [{job_nome}]: passo de aviso ANTES do commit "
        f"(passo {primeiro_commit} '{steps[primeiro_commit].get('name')}'): {antes}. "
        "Se o aviso falhar, o dado nunca é publicado — mova o aviso para depois do commit."
    )


def test_a_guarda_pega_o_defeito_que_ela_existe_para_pegar():
    """Sanidade: a regra reprova o arranjo que causou o apagão de setembro/2026."""
    ruim = {"steps": [
        {"name": "Send email notification", "uses": "dawidd6/action-send-mail@v3"},
        {"name": "Commit & push updated DB", "run": "git commit -m x && git push"},
    ]}
    with pytest.raises(AssertionError):
        test_o_aviso_nunca_vem_antes_do_commit("ficticio.yml", "update", ruim)
