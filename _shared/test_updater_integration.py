#!/usr/bin/env python3
"""
test_updater_integration.py — garante que o updater_sm LIVE usa o dicionário.

Após a migração (2026-06-19), verifica que o updater_sm:
  - importa sem erro (e carrega dictionary.py do _shared);
  - ALL_NCM == dicionário (273 NCM de aço);
  - classify_ncm() == dictionary.classify_ncm() p/ todos os NCM;
  - mantém os sets de PREVISÃO (HRC_SH6/CRC_SH6/PRED_SH6_PREFIXES) intactos
    (a migração p/ os 55 SH6 antidumping é da Fase 2, não desta).

Uso: python _shared/test_updater_integration.py
"""
import importlib.util
import sys
from pathlib import Path

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE))
import dictionary as D  # noqa: E402

UPDATER = HERE.parent / "Steel and Mining" / "updater_sm.py"


def _load_updater():
    spec = importlib.util.spec_from_file_location("updater_sm", UPDATER)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def main() -> int:
    u = _load_updater()
    ok = True

    n = len(u.ALL_NCM)
    print(f"ALL_NCM = {n} (esperado 273, == dicionário)")
    ok &= (n == 273 == len(D.all_ncm_set()) and set(u.ALL_NCM) == D.all_ncm_set())

    mism = [c for c in sorted(u.ALL_NCM) if u.classify_ncm(c) != D.classify_ncm(c)]
    print(f"classify_ncm: {len(mism)} divergencias updater vs dicionario")
    ok &= not mism

    samples = {
        "72131000": ["long", "rebar"], "72081000": ["flat", "hrc"],
        "72251900": ["flat", "crc"], "72261900": ["flat", "crc"],
        "72072000": ["semi", "ingot_billet"],
    }
    for ncm, exp in samples.items():
        got = u.classify_ncm(ncm)
        flag = "OK" if got == exp else "XX"
        print(f"  {flag} {ncm} -> {got}")
        ok &= (got == exp)

    pred_ok = (len(u._AD_SH6) == 55
               and u._classify_sh6("72083900") is not None   # 720839 = HRC antidumping
               and u._classify_sh6("99999999") is None)        # não-aço/não-antidumping
    print(f"PREVISAO rebaseada p/ ANTIDUMPING: _AD_SH6={len(u._AD_SH6)} SH6 | "
          f"_classify_sh6(72083900)={u._classify_sh6('72083900')} | (99999999)={u._classify_sh6('99999999')}")
    ok &= pred_ok

    print("\nRESULTADO:",
          "OK - updater usa o dicionario e esta consistente." if ok
          else "XX - inconsistencia, revisar.")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
