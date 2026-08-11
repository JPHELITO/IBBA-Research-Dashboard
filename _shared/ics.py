# -*- coding: utf-8 -*-
"""ics.py — gerador de calendário iCalendar (.ics), PURO e sem dependência.

Entra uma lista de dicts, sai `bytes`. Zero rede, zero banco, zero libs externas —
o formato são ~20 linhas de texto, e uma biblioteca aqui esconderia exatamente os
detalhes de BYTES que precisam ficar sob controle.

⚠️ A LIÇÃO DO .eml VALE AQUI IGUAL: o defeito de um arquivo destes mora nos BYTES
CRUS, não no texto. Decodificar em Python ou abrir num editor MASCARA o problema —
o Outlook é quem reclama. Por isso os testes (tests/test_ics_bytes.py) medem
`bytes`, nunca `str`.

Armadilhas endereçadas aqui (cada uma já quebrou calendário no mundo real):
  • CRLF em TODA linha, inclusive depois do END:VCALENDAR;
  • dobra de linha em 75 OCTETOS (não caracteres) sem partir sequência UTF-8;
  • DTEND é EXCLUSIVO em evento de dia inteiro (29/10 → DTEND 30/10);
  • SEQUENCE tem que subir quando a data muda, senão o Outlook ignora a alteração;
  • evento que sumiu vira STATUS:CANCELLED — se apenas desaparecer do arquivo,
    fica fantasma na agenda de quem assinou;
  • sem BOM (\\xef\\xbb\\xbf trava parsers do Outlook).

Uso:
    from ics import Event, build_calendar
    data = build_calendar([Event(uid="b3-VALE-2026-ITR3", summary="VALE | 3Q26 Earnings",
                                 start=date(2026,10,29))], name="IBBA Earnings")
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta, timezone

# O Brasil não tem mais horário de verão desde 2019 → São Paulo é UTC-3 fixo.
# Horários são convertidos para UTC ("...Z"), o que dispensa bloco VTIMEZONE.
BRT = timezone(timedelta(hours=-3))

_UID_SAFE = re.compile(r"[^A-Za-z0-9._:@-]")


@dataclass
class Event:
    """Um evento. `start`/`end` como `date` = dia inteiro; como `datetime` = com hora."""
    uid: str
    summary: str
    start: date | datetime
    end: date | datetime | None = None
    sequence: int = 0
    status: str = "CONFIRMED"          # CONFIRMED | TENTATIVE | CANCELLED
    description: str = ""
    location: str = ""
    categories: str = ""
    url: str = ""
    transparent: bool = True           # não marca quem assinou como "ocupado"
    extra: dict = field(default_factory=dict)


# ───────────────────────── formato ────────────────────────────────────────────

def esc_text(v) -> str:
    """Escapa um valor TEXT do RFC 5545.

    A ordem importa: a contrabarra vem PRIMEIRO, senão as escapadas seguintes
    seriam escapadas de novo. E ':' NÃO se escapa em TEXT — erro clássico que
    faz o Outlook mostrar "\\:" no meio do título.
    """
    s = "" if v is None else str(v)
    s = s.replace("\\", "\\\\").replace(";", "\\;").replace(",", "\\,")
    return s.replace("\r\n", "\\n").replace("\r", "\\n").replace("\n", "\\n")


def _safe_cut(raw: bytes, n: int) -> int:
    """Maior corte ≤ n que não parte uma sequência UTF-8.

    Bytes de continuação em UTF-8 têm os 2 bits altos = 10 → (b & 0xC0) == 0x80.
    Recua até cair numa fronteira de caractere. Sem isto, um 'ç' ou 'ã' no fim
    da fatia vira byte solto e o arquivo inteiro deixa de decodificar.
    """
    if len(raw) <= n:
        return len(raw)
    cut = n
    while cut > 0 and (raw[cut] & 0xC0) == 0x80:
        cut -= 1
    return cut or n          # linha patológica: corta seco em vez de travar


def fold(line: str) -> bytes:
    """Dobra uma linha lógica em linhas físicas de no máximo 75 OCTETOS.

    Continuação começa com UM espaço, e esse espaço CONTA para o limite — por isso
    o corpo das continuações tem 74. Quem conta caracteres em vez de bytes gera
    linhas longas demais assim que aparece um acento.
    """
    raw = line.encode("utf-8")
    if len(raw) <= 75:
        return raw
    cut = _safe_cut(raw, 75)
    out, rest = [raw[:cut]], raw[cut:]
    while rest:
        cut = _safe_cut(rest, 74)
        out.append(b" " + rest[:cut])
        rest = rest[cut:]
    return b"\r\n".join(out)


def _dt_utc(v: datetime) -> str:
    """datetime → 'AAAAMMDDTHHMMSSZ'. Ingênuo (sem tz) é lido como horário de Brasília."""
    if v.tzinfo is None:
        v = v.replace(tzinfo=BRT)
    return v.astimezone(timezone.utc).strftime("%Y%m%dT%H%M%SZ")


def _d(v: date) -> str:
    return v.strftime("%Y%m%d")


def safe_uid(v: str, domain: str = "ibba-dashboard") -> str:
    """UID estável e legal. É o que faz o cliente ATUALIZAR em vez de duplicar."""
    v = _UID_SAFE.sub("-", str(v)).strip("-") or "evento"
    return v if "@" in v else f"{v}@{domain}"


# ───────────────────────── montagem ───────────────────────────────────────────

def vevent(ev: Event, dtstamp: str) -> list[str]:
    """Um VEVENT como lista de linhas LÓGICAS (a dobra acontece depois)."""
    L = [f"BEGIN:VEVENT", f"UID:{safe_uid(ev.uid)}", f"DTSTAMP:{dtstamp}"]

    if isinstance(ev.start, datetime):
        L.append(f"DTSTART:{_dt_utc(ev.start)}")
        end = ev.end if isinstance(ev.end, datetime) else ev.start + timedelta(hours=1)
        L.append(f"DTEND:{_dt_utc(end)}")
    else:
        # DTEND é EXCLUSIVO: um evento de 29/10 termina em 30/10. Repetir a data de
        # início produz duração zero e alguns clientes simplesmente não mostram nada.
        L.append(f"DTSTART;VALUE=DATE:{_d(ev.start)}")
        last = ev.end if isinstance(ev.end, date) and not isinstance(ev.end, datetime) else ev.start
        L.append(f"DTEND;VALUE=DATE:{_d(last + timedelta(days=1))}")

    L.append(f"SUMMARY:{esc_text(ev.summary)}")
    if ev.description:
        L.append(f"DESCRIPTION:{esc_text(ev.description)}")
    if ev.location:
        L.append(f"LOCATION:{esc_text(ev.location)}")
    if ev.categories:
        L.append(f"CATEGORIES:{esc_text(ev.categories)}")
    if ev.url:
        L.append(f"URL:{ev.url}")          # URI não leva escape de TEXT
    L.append(f"SEQUENCE:{int(ev.sequence)}")
    L.append(f"STATUS:{ev.status}")
    L.append("TRANSP:TRANSPARENT" if ev.transparent else "TRANSP:OPAQUE")
    for k, v in (ev.extra or {}).items():
        L.append(f"{k}:{esc_text(v)}")
    L.append("END:VEVENT")
    return L


def build_calendar(events, *, name: str, description: str = "",
                   ttl: str = "PT12H", prodid: str = "-//IBBA Research Dashboard//Earnings//PT",
                   now: datetime | None = None) -> bytes:
    """Monta o .ics completo. Devolve BYTES em UTF-8 sem BOM, com CRLF em tudo."""
    dtstamp = _dt_utc(now or datetime.now(timezone.utc))
    lines = [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        f"PRODID:{prodid}",
        "CALSCALE:GREGORIAN",
        "METHOD:PUBLISH",
        f"X-WR-CALNAME:{esc_text(name)}",
        "X-WR-TIMEZONE:America/Sao_Paulo",
        # As duas linhas abaixo PEDEM de quanto em quanto tempo reler. É pedido, não
        # ordem: o Outlook decide sozinho e costuma levar horas. Nada a fazer.
        f"REFRESH-INTERVAL;VALUE=DURATION:{ttl}",
        f"X-PUBLISHED-TTL:{ttl}",
    ]
    if description:
        lines.append(f"X-WR-CALDESC:{esc_text(description)}")
    for ev in events:
        lines.extend(vevent(ev, dtstamp))
    lines.append("END:VCALENDAR")
    # CRLF entre TODAS as linhas e também no fim do arquivo.
    return b"\r\n".join(fold(x) for x in lines) + b"\r\n"
