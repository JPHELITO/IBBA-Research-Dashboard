/* ════════════════════════════════════════════════════════════════════════════
   IBBA · DATA DESK — HELP: o que cada gráfico mostra, em linguagem de cliente (pedido do usuário, 23/11/2026)
   ────────────────────────────────────────────────────────────────────────────
   Um lugar só para os textos (é aqui que se revisa ou troca uma explicação). O motor mostra, acima de cada gráfico:
     WHAT IT SHOWS  → o que é o número (uma frase, com a fonte entre parênteses)
     HOW TO READ    → como ler a vista escolhida (o motor monta a partir do gráfico: Level/YoY/LTM/Seasonal, linha
                      tracejada, período em andamento) + o "how" do próprio indicador, quando ele tem um jeito próprio
   Entrada de um indicador: texto (= what), {what, how} ou função (o) → texto | {what, how}, com o = {prod, label, gran}.
   Seções de preço (data-desk-prices.js): o "how" do indicador vale sempre (elas têm uma vista só).
   Sem entrada aqui, o motor usa a nota antiga do catálogo — nada some.
   ════════════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';
  var NOUN1 = { countries: 'country', products: 'product', ports: 'port', destinations: 'destination', suppliers: 'supplier', grades: 'grade' };

  var H = {
    /* como ler a vista do gráfico principal ({per} = month/quarter/year) */
    view: {
      level: 'Each point is one {per}.',
      yoy: 'Bars show the change against the same {per} a year earlier: green = higher, red = lower.',
      yoyPP: 'Bars show the change against the same {per} a year earlier, in percentage points: green = higher, red = lower.',
      yoyDiff: 'Bars show the change against the same {per} a year earlier, in {unit}: green = higher, red = lower.',
      ltmFlow: 'Each point adds up the last {n}, which removes the seasonality.',
      ltmOther: 'Each point covers the last {n}, which removes the seasonality.',
      seasonal: 'One line per year over the same {pers}: orange = {y}, solid grey = {y1}, dashed = the years before. Hover to read every year.',
      avg12: 'The dashed grey line is the 12-month average.',
      winAvg: 'The dashed line is the average of the window.',
      avgBoth: 'The dashed curve is the 12-month average; the flat dashed line is the average of the window.',
      ma3: 'The dashed line is the 3-month moving average.',
      partial: 'A lighter last point is a {per} still in progress.',
      twoLines: '{c0} line = {a}; {c1} line = {b}.',
      twoBars: '{c0} bars = {a}; {c1} bars = {b}.',
      signBars: 'Green bars = above zero, red = below zero. The dashed line is the average of the window.'
    },

    /* "Who is behind the number": o que a quebra mostra (por seção e quebra) e como ler cada modo */
    /* o motor junta as partes conforme a quebra: [modo] + others (se a quebra tem "Others") + list + click (se dá para escolher) */
    whoHow: {
      volume: 'Each colour is one {noun1} and the bars add up to the total.',
      revenue: 'The same split in US$: each colour is one {noun1} and the bars add up to the total.',
      share: 'Each bar adds up to 100%: the share of each {noun1} in the total.',
      price: 'Average price of each {noun1} (revenue ÷ volume); the thick dashed line is the average of all of them.',
      others: '"Others" groups everything not ticked.',
      othersPrice: 'The thin dashed line is "Others": everything not ticked.',
      list: 'The list ranks them and shows the change against a year earlier.',
      click: 'Click a name to show or hide it.'
    },
    noun1: function (n) { return NOUN1[n] || 'item'; },

    builder: {
      what: 'The series you picked, on one chart. Hover a series name below to see what it measures.',
      calc: {
        level: 'Values as published, each series in its own unit.',
        yoy: 'Each point is the change against the same period a year earlier.',
        ltm: 'Each point covers the last 12 months: the sum for volumes, the average for prices and shares.',
        index: 'Each series starts at 100 at the beginning of the window, so series in different units compare on one scale.'
      }
    },

    /* ══════════════ METALS & MINING ══════════════ */
    mm: {
      imports: {
        vol: 'How much steel Brazil imported in each period, in thousand tonnes (SECEX customs data). More imports mean more competition for Brazilian mills.',
        lead: function (o) { return 'Share of Brazil\'s steel import volume that comes from ' + lead(o.label, 'the largest supplier') + ', the largest supplier (SECEX).'; },
        pen: 'Share of the steel used in Brazil that came from abroad: (apparent consumption − domestic sales) ÷ apparent consumption (IABr). Higher = imports taking more of the market.',
        rev: 'What Brazil paid for imported steel in each period, in US$ million (SECEX customs value).',
        $who: { country: 'Where Brazil\'s imported steel comes from, by country of origin (SECEX).',
          product: 'Which steel products make up the imports: flat, long and semi-finished, and their sub-products (SECEX).' }
      },
      exports: {
        vol: 'How much steel Brazil exported in each period, in thousand tonnes (SECEX customs data).',
        rev: 'Brazil\'s revenue from steel exports in each period, in US$ million (SECEX, FOB value).',
        lead: function (o) { return 'Share of Brazil\'s steel export volume that goes to ' + lead(o.label, 'the largest destination') + ', the largest destination (SECEX).'; },
        $who: { country: 'Where Brazil\'s steel exports go, by country of destination (SECEX).',
          product: 'Which steel products Brazil exports: flat, long and semi-finished, and their sub-products (SECEX).' }
      },
      domestic: {
        sales: 'Steel sold inside Brazil by Brazilian mills, in thousand tonnes (IABr). The total is flat plus long; the split by product is in "Who is behind the number" below.',
        prod: 'Crude steel produced in Brazil — liquid steel before it is rolled into products, so there is no flat/long split (IABr).',
        cons: 'How much steel Brazil used: domestic sales plus imports, in thousand tonnes (IABr apparent consumption).',
        pen: 'Share of the steel used in Brazil that came from abroad: (apparent consumption − domestic sales) ÷ apparent consumption (IABr). Higher = imports taking more of the market.',
        invm: 'How many months of sales the flat-steel distributors\' inventory would cover: stock ÷ monthly sales (INDA). High = distributors are overstocked and tend to buy less from the mills.',
        inv: 'Flat steel held in stock by distributors, in thousand tonnes (INDA).',
        pvs: 'What flat-steel distributors bought from the mills against what they sold to their clients, in thousand tonnes (INDA). Buying more than selling means they are restocking.',
        purch: 'Flat steel bought by distributors from the mills, in thousand tonnes (INDA).',
        isales: 'Flat steel sold by distributors to their clients, in thousand tonnes (INDA) — a close read of end demand.',
        iltm: 'Flat steel sold by distributors over the last 12 months, in thousand tonnes (INDA).',
        ima3: 'Flat steel sold by distributors, 3-month average, in thousand tonnes (INDA).',
        $who: { product: 'How the domestic figure splits by product (IABr).' }
      },
      ore: {
        vol: 'Brazil\'s iron ore exports — fines plus pellets — in million tonnes (SECEX customs data).',
        rev: 'Brazil\'s revenue from iron ore exports, in US$ billion (SECEX, FOB value).',
        china: 'Share of Brazil\'s iron ore export volume that goes to China (SECEX).',
        pel: 'Share of pellets in Brazil\'s iron ore export volume — the rest is fines (SECEX).',
        $who: { dest: 'Where Brazil\'s iron ore goes, by country of destination (SECEX).',
          port: 'Which Brazilian ports ship the iron ore (SECEX).' }
      },
      /* modelo preditivo: k/c/b = Coreia / China / as duas; 3 ou 12 meses; o = {prod: 'HRC|3'} (produto|defasagem) */
      prediction: function (id, o) {
        var m = /^([kcb])(3|12)([se]?)$/.exec(id || ''); if (!m) return null;
        var nm = { k: 'Korea', c: 'China', b: 'Korea and China' }[m[1]], n = m[2], p = String((o && o.prod) || '').split('|'), prod = p[0] || 'steel', lag = p[1] || '3';
        if (m[3] === 's') return 'Brazil\'s imports of ' + prod + ' from ' + nm + ' as recorded by SECEX, summed over ' + n + ' months.';
        if (m[3] === 'e') return nm + '\'s exports of ' + prod + ' to Brazil recorded at origin, summed over ' + n + ' months and moved forward by ' + lag + ' months.';
        return { what: 'Brazil\'s imports of ' + prod + ' from ' + nm + ' as recorded by SECEX (orange) against ' + nm + '\'s exports of the same products to Brazil recorded at origin (black), both summed over ' + n + ' months.',
          how: 'The black line is moved forward by ' + lag + ' months, roughly the time the ships take: exports are counted when ships leave and SECEX counts them when they arrive. Where the black line runs past the last SECEX month, it points to imports still to come.' };
      },
      parity: {
        hrc_prem: { what: 'How much more (or less) Brazilian hot-rolled coil (HRC) costs than Chinese HRC delivered in Brazil, in % — the import parity (Platts prices; Itaú BBA build-up).',
          how: 'Above zero = Brazilian HRC costs more than the imported coil; below zero = imports cost more. One point per week (Fridays); a dashed last stretch is the live estimate with today\'s prices.' },
        rebar_prem: { what: 'How much more (or less) Brazilian rebar costs than Turkish rebar delivered in Brazil, in % — the import parity (Platts prices; Itaú BBA build-up).',
          how: 'Above zero = Brazilian rebar costs more than the imported bar; below zero = imports cost more. The second line shows the same premium if there were no import tariff. One point per week (Fridays); a dashed last stretch is the live estimate.' },
        hrc_usd: { what: 'The two sides of the HRC parity, in US$ per tonne: the Brazilian price converted at the exchange rate, and Chinese HRC landed in Brazil (FOB + freight + insurance + import tariff + AFRMM + port costs). The third line is the Chinese FOB price.',
          how: 'The gap between the first two lines is the premium. One point per week (Fridays).' },
        rebar_usd: { what: 'The two sides of the rebar parity, in US$ per tonne: the Brazilian price converted at the exchange rate, and Turkish rebar landed in Brazil (FOB + freight + insurance + import tariff + AFRMM + port costs). The third line is the Turkish FOB price.',
          how: 'The gap between the first two lines is the premium. One point per week (Fridays).' },
        dom: { what: 'Prices charged by Brazilian mills for hot-rolled coil and rebar, in reais per tonne, ex-works and without taxes (Platts).', how: 'Each point is one assessment; history since 2010.' },
        coal: { what: 'Price of coking coal from Australia — with iron ore, the main raw material of blast-furnace steel — in US$ per tonne (Platts): premium low-vol and low-vol hard coking coal.', how: 'Each point is one day; history since 2008.' }
      },
      oreprices: {
        margin: { what: 'What a Brazilian miner keeps after shipping to China: the 61% Fe iron ore price in China minus the Brazil–China freight, in US$ per tonne (Platts).',
          how: 'A proxy: no adjustment for moisture, quality, royalties or costs. Platts\' 61% index only starts in Feb 2021, so the 62% line takes the same margin back to 2009. One point per day.' },
        grades: { what: 'Iron ore prices in China by iron content, in US$ per dry tonne (Platts): 65% Fe (high grade), 61% Fe (the benchmark) and 58% Fe (low grade).', how: 'The wider the gap between the lines, the more buyers pay for quality. One point per day.' },
        spread: { what: 'What buyers pay for quality, in US$ per tonne (Platts): 65% over 61% Fe, 61% over 58% Fe, and the premium for blast-furnace pellets.', how: 'Premiums widen when steel margins are good and mills pay for productivity. One point per day (the pellet premium is weekly).' },
        freight: { what: 'Cost of shipping iron ore to China from Brazil and from Western Australia, in US$ per wet tonne (Platts).', how: 'The third line is the difference — Brazil\'s distance disadvantage against Australian ore. One point per day.' },
        brands: { what: 'Prices of specific iron ore brands in China, in US$ per dry tonne (Platts): Brazilian Blend Fines (Vale) against the main Australian fines.', how: 'One point per day.' },
        fwd: { what: 'Iron ore swap prices for the next three quarters and for next year, in US$ per dry tonne (Platts): where the market expects prices to go.', how: 'A curve below today\'s price says the market expects prices to fall. One point per day.' }
      },
      chinamills: {
        profit: { what: 'Share of the 247 Chinese blast-furnace steel mills surveyed every week that make a cash profit on their main product, in % (Mysteel). It counts mills, not tonnes: a small mill weighs the same as a large one.',
          how: 'Low readings mean most Chinese mills lose money on each tonne — usually followed by output cuts, which weigh on iron ore demand. The dashed line is the average since 2021. One point per week (Fridays); weeks with no survey (Chinese New Year) are left blank.' },
        hm: { what: 'Hot metal (liquid pig iron) produced per day by the same 247 mills, in thousand tonnes per day (Mysteel). Blast furnaces make hot metal from iron ore, so this is the closest weekly read of China\'s iron ore use.',
          how: 'The dashed line is the average since 2021. One point per week (Fridays); weeks with no survey, or whose figure we could not retrieve (mostly 2021–2023), are left blank.' },
        bf: { what: 'How hard China\'s blast furnaces are running, in % (Mysteel, 247 mills): capacity utilization = hot metal produced ÷ hot metal capacity; operating rate = share of the furnaces that are running.',
          how: 'Both fall when mills cut output or stop furnaces for maintenance. One point per week (Fridays); weeks whose figure we could not retrieve (mostly 2021–2023) are left blank.' },
        pvu: { what: 'Share of mills making money (orange) against blast-furnace capacity utilization (black), both in % and from the same weekly survey of 247 mills (Mysteel).',
          how: 'Margins usually move first: when few mills make money, output tends to be cut in the following weeks; when margins recover, furnaces restart. Both lines share the same % scale.' },
        profit_seas: { what: 'Share of the 247 Chinese mills making money (Mysteel), one line per year, so the same weeks of different years compare directly.',
          how: 'Orange = this year, solid grey = last year, dashed = earlier years. Hover to read every year in the same week.' },
        hm_seas: { what: 'Hot metal output of the 247 Chinese mills, in thousand tonnes per day (Mysteel), one line per year, so the same weeks of different years compare directly.',
          how: 'Orange = this year, solid grey = last year, dashed = earlier years. Output usually dips around Chinese New Year.' }
      }
    },

    /* ══════════════ PULP & PAPER ══════════════ */
    pp: {
      'pulp-secex': {
        vol: 'How much pulp Brazil exported in each period, in thousand tonnes, all ports (SECEX customs data).',
        rev: 'Brazil\'s revenue from pulp exports in each period, in US$ million (SECEX, FOB value).',
        vwd: 'Pulp exports per Brazilian working day, in thousand tonnes per day (SECEX), so that months of different lengths compare fairly.',
        china: 'Share of Brazil\'s pulp export volume that goes to China (SECEX).',
        $who: { port: 'Which Brazilian ports ship the pulp (SECEX).', dest: 'Where Brazil\'s pulp goes, by country of destination (SECEX).' }
      },
      'pulp-gacc': {
        vol: 'Wood chips imported by China, in million bone-dry tonnes (China customs, GACC). Chips are the raw material Chinese mills use to make their own pulp.',
        price: 'The average price China paid for imported wood chips: value ÷ volume, in US$ per bone-dry tonne (GACC).',
        vn: 'Share of China\'s wood chip imports that come from Vietnam, the largest supplier (GACC).',
        $who: { supplier: 'Which countries supply China\'s wood chips (GACC).' }
      },
      'paper-iba': {
        prod: 'Paper produced in Brazil, in thousand tonnes (IBÁ). The split by grade is in "Who is behind the number" below.',
        dom: 'Paper sold in Brazil by Brazilian producers, in thousand tonnes (IBÁ).',
        cons: 'How much paper Brazil used: production + imports − exports, in thousand tonnes (IBÁ). Published only for the total of all grades.',
        pen: 'Share of the paper used in Brazil that was imported: imports ÷ apparent consumption (IBÁ, all grades).',
        exp: 'Paper exported by Brazil, in thousand tonnes (IBÁ).',
        imp: 'Paper imported by Brazil, in thousand tonnes (IBÁ).',
        $who: { grade: 'How Brazil\'s paper figure splits by grade (IBÁ).' }
      },
      'paper-corr': {
        ship: 'Corrugated boxes shipped in Brazil, in thousand tonnes (Empapel). Most goods travel in boxes, so this is a timely read of demand for goods.',
        expday: 'Corrugated box shipments per working day, in thousand tonnes per day (Empapel), so that months of different lengths compare fairly.',
        ltm: 'Corrugated box shipments over the last 12 months, in thousand tonnes (Empapel).',
        wd: 'Working days in the month — part of the monthly swings in shipments comes from this (Empapel).'
      }
    }
  };
  /* "China share" → "China" */
  function lead(label, dflt) { var m = /^(.+?) share$/.exec(String(label || '')); if (!m) return dflt; return (/^(United |Netherlands|Philippines|Czech |Dominican |Bahamas|Gambia|Maldives)/.test(m[1]) ? 'the ' : '') + m[1]; }

  /* a entrada de um indicador (ou null): {what, how} */
  H.get = function (sector, secId, id, o) {
    var S = H[sector], t = S && S[secId], h = null;
    if (typeof t === 'function') h = t(id, o || {}); else if (t) h = t[id];
    if (typeof h === 'function') h = h(o || {});
    if (typeof h === 'string') h = { what: h };
    return h || null;
  };
  /* a quebra do "Who is behind the number" */
  H.who = function (sector, secId, dimId) { var S = H[sector], t = S && S[secId]; return (t && t.$who && t.$who[dimId]) || null; };
  /* {per} {pers} {n} … num texto */
  H.fill = function (s, o) { return String(s || '').replace(/\{(\w+)\}/g, function (_, k) { return o && o[k] != null ? o[k] : ''; }); };
  window.IBBADeskHelp = H;
})();
