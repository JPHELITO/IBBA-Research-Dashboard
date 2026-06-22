#!/usr/bin/env python3
"""
test_dictionary_equivalence.py — REGRESSÃO da classificação de aço.

Compara a classificação derivada do dicionário (dictionary.py = fonte da verdade)
contra um SNAPSHOT congelado do comportamento legado (golden_classification_legacy.json,
gerado uma vez a partir dos sets chumbados antigos do updater_sm.py).

Diferenças ESPERADAS (aprovadas pelo usuário em 2026-06-19):
  72251900: (ausente no legado) -> ['flat','crc']     # código novo no dicionário
  72261900: ['flat','flat_others'] -> ['flat','crc']  # reclassificado p/ CRC

Passa (exit 0) se as ÚNICAS divergências forem exatamente essas. Qualquer outra
divergência = drift acidental no dicionário -> exit 1 (revisar antes de mexer no motor).

Uso: python _shared/test_dictionary_equivalence.py
"""
import json
import sys
from pathlib import Path

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE))
import dictionary as D  # noqa: E402

GOLDEN = HERE / "golden_classification_legacy.json"

# divergências intencionais e aprovadas (legado -> dicionário)
APPROVED = {
    "72251900": [None, ["flat", "crc"]],
    "72261900": [["flat", "flat_others"], ["flat", "crc"]],
}


def main() -> int:
    golden = json.loads(GOLDEN.read_text(encoding="utf-8"))
    union = set(golden) | D.all_ncm_set()

    diffs = {}
    for ncm in sorted(union):
        old = golden.get(ncm)              # None se não existia no legado
        new = D.classify_ncm(ncm) or None  # [] -> None
        if old != new:
            diffs[ncm] = [old, new]

    print(f"NCM no legado: {len(golden)} | NCM no dicionário: {len(D.all_ncm_set())}")
    print(f"Divergências encontradas: {len(diffs)}")
    for ncm, (old, new) in diffs.items():
        mark = "OK (aprovada)" if APPROVED.get(ncm) == [old, new] else "XX INESPERADA"
        print(f"  {ncm}: {old} -> {new}   [{mark}]")

    print(f"\nAntidumping (dicionário): {len(D.antidumping_sh6_set())} SH6 distintos "
          f"(modelo preditivo migra p/ esses na Fase 2).")

    if diffs == APPROVED:
        print("\nRESULTADO: OK — somente as 2 mudanças aprovadas. Classificação sob controle.")
        return 0
    print("\nRESULTADO: XX — divergências inesperadas. Revisar o dicionário.")
    return 1


if __name__ == "__main__":
    sys.exit(main())
