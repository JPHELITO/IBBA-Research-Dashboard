#!/usr/bin/env python3
"""
dictionary.py — FONTE ÚNICA de códigos do pipeline, lida de dictionary_codes.csv
(gerado por build_dictionary.py a partir de Standard_NCM_SH6_clmd.xlsx).

Substitui os sets chumbados em updater_sm.py. API pública:
  classify_ncm(ncm)         -> ['<segment>', '<subcategory>']  (ex.: ['long','rebar'])
  all_ncm_set()             -> set de NCM (8-dig) de aço
  segment_ncm_set(key)      -> set de NCM do segmento interno (flat, long, semi)
  subcat_ncm_set(key)       -> set de NCM da subcategoria interna (hrc, crc, flat_others, ...)
  antidumping_sh6_set()     -> set de SH6 (6-dig, str) marcados 'Antidumping' (aço)
  sh6_set(commodity)        -> set de SH6 do commodity ('steel'|'pulp'|'iron_ore')
  sh6_subcategory(sh6, commodity) -> rótulo de subcategoria de um SH6

As chaves internas (segment/subcategory) são idênticas às que o updater_sm.classify_ncm
produz hoje, p/ a troca do motor ser comportamentalmente neutra.
"""
import csv
from pathlib import Path

CSV_PATH = Path(__file__).parent / "dictionary_codes.csv"

# rótulos do dicionário -> chaves internas (compatível com updater_sm.classify_ncm)
_SEGMENT_KEY = {"semi": "semi", "flat": "flat", "long": "long"}
_SUBCAT_KEY = {
    "ingot, billet": "ingot_billet",
    "placa": "placa",
    "hrc": "hrc",
    "heavy plate": "heavy_plate",
    "crc": "crc",
    "coated": "coated",
    "wire rod": "wire_rod",
    "rebar": "rebar",
    "bar": "bar",
    "shapes": "shapes",
    # "others" depende do segmento -> flat_others / long_others (ver _subcat_key)
}


def _load():
    with open(CSV_PATH, newline="", encoding="utf-8") as f:
        return list(csv.DictReader(f))


_ROWS = _load()
_STEEL = [r for r in _ROWS if r["commodity"] == "steel"]


def _seg_key(segment: str) -> str:
    s = (segment or "").strip().lower()
    return _SEGMENT_KEY.get(s, s)


def _subcat_key(segment: str, subcategory: str) -> str:
    sub = (subcategory or "").strip().lower()
    if sub == "others":
        return f"{_seg_key(segment)}_others"
    return _SUBCAT_KEY.get(sub, sub.replace(" ", "_").replace(",", ""))


def classify_ncm(ncm: str) -> list:
    """['segment', 'subcategory'] p/ o NCM; [] se não está no dicionário de aço."""
    c = str(ncm).strip().zfill(8)
    for r in _STEEL:
        if r["ncm"] == c:
            return [_seg_key(r["segment"]), _subcat_key(r["segment"], r["subcategory"])]
    return []


def all_ncm_set() -> set:
    return {r["ncm"] for r in _STEEL if r["ncm"]}


def segment_ncm_set(key: str) -> set:
    return {r["ncm"] for r in _STEEL if r["ncm"] and _seg_key(r["segment"]) == key}


def subcat_ncm_set(key: str) -> set:
    return {r["ncm"] for r in _STEEL
            if r["ncm"] and _subcat_key(r["segment"], r["subcategory"]) == key}


def antidumping_sh6_set() -> set:
    return {r["sh6"] for r in _STEEL if r["sh6"] and r["antidumping"] == "1"}


def sh6_set(commodity: str) -> set:
    return {r["sh6"] for r in _ROWS if r["commodity"] == commodity and r["sh6"]}


def sh6_subcategory(sh6: str, commodity: str = "steel") -> str:
    s = str(sh6).strip().zfill(6)
    for r in _ROWS:
        if r["commodity"] == commodity and r["sh6"] == s:
            return r["subcategory"]
    return ""
