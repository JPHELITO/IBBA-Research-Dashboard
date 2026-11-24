/* =========================================================================
 * tour-content.js — TEXTOS e PASSOS do Tutorial.   window.IBBA_TOURS
 * Motor: tour-lib.js. Editar um texto = editar só este arquivo.
 * UI em inglês (a dashboard é en-US); comentários em PT.
 *
 * Segmento: {id, title, blurb, page (null = qualquer página; aceita lista), url?,
 *            requires?, unlessOff?, cleanup?, steps:[…]}
 * Passo:    {id, title, body, target? (seletor ou lista; sem alvo = cartão no meio), all?,
 *            media?: 'desktop'|'mobile', mobile?: {os mesmos campos, só no celular},
 *            requires?, unlessOff?, onlyIf?, notIf?, call?: ['funcaoGlobal', args…], placement?, pad?, radius?, wait?}
 *   onlyIf:'seletor' / notIf:'seletor' → só com (ou sem) algo na página AGORA (ex.: 'html.desk-on' = mesa de dados ligada)
 *   requires:'flag'  → só com a flag LIGADA (áreas que nascem fechadas: market, exec_calendar…)
 *   unlessOff:'flag' → só some com a flag DESLIGADA (painéis da home, que nascem abertos)
 *   all:true         → destaca TODOS os elementos visíveis do seletor juntos
 *   {click}/{Click} viram tap/Tap no celular · **negrito** vira <b> (nada mais de HTML)
 * ⚠️ tests/test_tour_content.html confere cada alvo e cada função de `call` contra o fonte
 *    das páginas: renomeou um id? o teste acusa — e não o cliente, com um passo pulado.
 * ====================================================================== */
;(function () {
  // ações que se repetem (objetos simples: o motor executa e a auditoria confere os seletores)
  var OPEN_RAIL = { click: '#rail-toggle', unless: 'body.rail-open' };   // News no celular: abre o painel Filters
  var CLOSE_RAIL = { click: '#rail-toggle', when: 'body.rail-open' };
  var PERF = { click: '#mtabs button[data-tab="performance"]', unless: '#mtabs button.on[data-tab="performance"]' };
  function TAB(t) { return { click: '#mtabs button[data-tab="' + t + '"]' }; }   // abas internas do Market

window.IBBA_TOURS = {
  version: 1,
  // ordem do Full tour e da lista do painel
  order: ['basics', 'home', 'news', 'market', 'marketwatch', 'stockguide', 'quarterly', 'mm', 'pp', 'calendar', 'data'],
  segments: [
    {
      id: 'basics', title: 'Getting around', blurb: 'Menus, analyst contacts and settings', page: null,
      cleanup: ['__gnavMob', 0],   // se o tour parar com o menu ☰ aberto, fecha
      steps: [
        { id: 'welcome', title: 'Welcome to the dashboard',
          body: 'This quick tour shows where everything is. Use **Next** or the arrow keys, and close it anytime.',
          mobile: { body: 'This quick tour shows where everything is. Tap **Next** to move on and close it anytime.' } },

        // ── computador: a barra de cima ──
        { id: 'sectors', media: 'desktop', target: ['#gnav-mm', '#gnav-pp'], title: 'Sector dashboards',
          body: 'Metals & Mining and Pulp & Paper data: prices, production and trade flows. Each ▾ lists its sections.' },
        { id: 'news', media: 'desktop', target: '#gnav-news', title: 'News Hunter',
          body: 'Every headline we track, with our take on it, filters and the full archive.' },
        { id: 'stock-guide', media: 'desktop', requires: 'stock_guide', target: '#gnav-sg', title: 'Stock Guide',
          body: 'Our coverage side by side, with multiples recomputed live from prices and sensitivity tables from our models.' },
        { id: 'market', media: 'desktop', requires: 'market', target: '#gnav-market', title: 'Market',
          body: 'A stock terminal: price charts, comparisons, ratios, correlations and a portfolio simulator.' },
        { id: 'calendar', media: 'desktop', requires: 'exec_calendar', target: '#gnav-cal', title: 'Calendar',
          body: 'Earnings dates, data releases and industry events, by month, week or list.' },
        { id: 'team', media: 'desktop', target: '#gnav-team', title: 'Talk to the analysts',
          body: 'Click the team photos to reach an analyst by e-mail or WhatsApp.' },
        { id: 'theme', media: 'desktop', target: '#gnav-theme', title: 'Light or dark',
          body: 'Switch the whole dashboard between light and dark mode. Your choice is remembered.' },
        { id: 'tutorial', media: 'desktop', target: '#gnav-tutorial', title: 'Replay anytime',
          body: 'Open **Tutorial** to take the full tour again or revisit a single section.' },

        // ── celular: o menu ☰ (cada passo abre ou fecha a folha, então Back também funciona) ──
        { id: 'm-menu', media: 'mobile', call: ['__gnavMob', 0], target: '#gnav-burger', title: 'The menu',
          body: 'Tap here to reach every area of the dashboard.' },
        { id: 'm-sectors', media: 'mobile', call: ['__gnavMob', 1], target: ['[data-tour="m-sectors"]', '.gnav-sheet a[href*="steel_sm_dashboard"]', '.gnav-sheet a[href*="pp_dashboard"]'], all: true,
          title: 'Sector dashboards', body: 'Metals & Mining and Pulp & Paper data: prices, production and trade flows, section by section.' },
        { id: 'm-stock-guide', media: 'mobile', requires: 'stock_guide', call: ['__gnavMob', 1], target: ['[data-tour="m-sg"]', '.gnav-sheet a[href^="/stock-guide.html"]', '.gnav-sheet a.gnm-quarterly'], all: true,
          title: 'Stock Guide', body: 'Our coverage side by side, with live multiples and sensitivity tables from our models.' },
        { id: 'm-market', media: 'mobile', requires: 'market', call: ['__gnavMob', 1], target: ['.gnav-sheet .gnm-mkt', '.gnav-sheet .gnm-mkt-solo'], all: true,
          title: 'Market', body: 'A stock terminal with price charts, comparisons, ratios and a portfolio simulator.' },
        { id: 'm-news', media: 'mobile', call: ['__gnavMob', 1], target: '.gnav-sheet a[href="/news.html"]',
          title: 'News Hunter', body: 'Every headline we track, with our take on it, filters and the full archive.' },
        { id: 'm-calendar', media: 'mobile', requires: 'exec_calendar', call: ['__gnavMob', 1], target: '.gnav-sheet a[href="/agenda.html"]',
          title: 'Calendar', body: 'Earnings dates, data releases and industry events.' },
        { id: 'm-team', media: 'mobile', call: ['__gnavMob', 1], target: '#gnav-mteam',
          title: 'Talk to the analysts', body: 'Reach the research team by e-mail or WhatsApp from here.' },
        { id: 'm-tutorial', media: 'mobile', call: ['__gnavMob', 0], target: '#gnav-tutorial',
          title: 'Replay anytime', body: 'Tap this button to take the full tour again or revisit a single section.' },
        { id: 'm-theme', media: 'mobile', call: ['__gnavMob', 0], target: '#gnav-theme',
          title: 'Light or dark', body: 'Switch the whole dashboard between light and dark mode.' }
      ]
    },
    {
      id: 'home', title: 'Home', blurb: 'Sector cards, commodity prices, the news feed and the heatmap',
      page: '/index.html', url: '/index.html',
      steps: [
        { id: 'sectors', target: '[data-tour="home-sectors"]', title: 'Sector dashboards',
          body: 'Open Metals & Mining, Pulp & Paper or the Stock Guide. The small tabs jump straight to a section.' },
        { id: 'comm-groups', unlessOff: 'commodities', target: '#comm-tabs', title: 'Commodity prices',
          body: 'Prices are grouped by theme. {Click} a group to switch, or let the carousel rotate on its own.' },
        { id: 'comm-cards', unlessOff: 'commodities', target: '#comm-list', title: 'Reading a price card',
          body: 'Latest price and move, a 12-month chart, and the change over the week (**W**), month (**M**), year to date and 12 months (**1Y**).' },
        { id: 'reports', target: '[data-tour="home-reports"]', title: 'Latest reports',
          body: 'Our most recent research. {Click} a title to open the report; **All →** shows the full list.' },
        { id: 'events', requires: 'exec_calendar', target: '[data-tour="home-events"]', title: 'Upcoming events',
          body: 'What is on today and next: earnings, data releases and industry events. **Open calendar** shows the full view.' },
        { id: 'news', unlessOff: 'news_feed', target: '#news-feed', clip: 360, title: 'Latest headlines',
          body: 'The newest stories for our sectors, one per line. The badge is our take for the covered companies: **+** positive, **−** negative, **=** neutral.' },
        { id: 'pulse', unlessOff: 'market_pulse', target: '[data-tour="home-pulse"]', clip: 360, title: 'Market Pulse',
          body: 'Who and what is in the news since the last close: each covered company and each theme, with a bar colored by our take on the headlines. It describes the news; it is not a forecast. {Click} a row to show only those headlines.',
          mobile: { body: 'Who was in the news since the last close: one chip per covered company, with our take on its headlines. {Click} a chip to read them.' } },
        { id: 'news-filters', unlessOff: 'news_feed', target: ['#news-filter', '#news-sector-filter'], title: 'Filter the feed',
          body: 'Show a single take or sector: S&M, P&P or NR (macro). **View history** opens the full archive.' },
        { id: 'heat-tools', unlessOff: 'heatmap', target: ['#hm-range', '#hm-mode', '#hm-filter-btn'], title: 'Heatmap controls',
          body: 'Choose the period (day, week, month, YTD, year), switch between **Absolute** and **Relative** (each stock against the main index of its exchange, in percentage points) and pick up to 20 stocks or indices under **Selected**.' },
        { id: 'heat-baskets', unlessOff: 'heatmap', target: '#hm-baskets', title: 'Baskets',
          body: 'Each sector as an equal-weighted basket, on the same period and measure as the tiles. Hover over a basket to see its companies.',
          mobile: { body: 'Each sector as an equal-weighted basket, on the same period and measure as the tiles. Tap a basket to see its companies.' } },
        { id: 'heat-grid', unlessOff: 'heatmap', target: '#heatmap-grid', clip: 360, title: 'Open a company',
          body: 'Each tile is a stock and its move over the period. {Click} one for its price chart and comparisons.' }
      ]
    },
    {
      id: 'news', title: 'News Hunter', blurb: 'Search, filters, the timeline and the full archive',
      page: '/news.html', url: '/news.html',
      cleanup: CLOSE_RAIL,   // celular: se parar com o painel de filtros aberto, fecha
      steps: [
        { id: 'm-filters', media: 'mobile', call: CLOSE_RAIL, target: '#rail-toggle', title: 'Filters',
          body: 'Search and all the filters live here. Tap to open or close them.' },
        { id: 'search', target: ['#search-input', '#search-chips'], title: 'Search headlines',
          body: 'Type a word and press **Enter** to pin it as a tag. Tags add up: only headlines with all of them stay.',
          mobile: { call: OPEN_RAIL, body: 'Type a word and confirm to pin it as a tag. Tags add up: only headlines with all of them stay.' } },
        { id: 'period', target: ['#period-seg', '#date-from', '#date-to'], title: 'Pick a period',
          body: 'The last 24 or 48 hours, 7 or 30 days, the whole archive, or your own dates.', mobile: { call: OPEN_RAIL } },
        { id: 'sector-take', target: ['#sector-seg', '#take-seg'], title: 'Sector and take',
          body: 'Keep one sector (S&M, P&P or NR) or one take: **+** positive, **−** negative, **=** neutral or no take.', mobile: { call: OPEN_RAIL } },
        { id: 'sources', target: '#src-facet', title: 'Sources',
          body: 'Choose one or more sources. The counts follow everything else you picked.', mobile: { call: OPEN_RAIL } },
        { id: 'clear', target: '#clear-all', title: 'Start over',
          body: 'Clear every filter in one {click}.', mobile: { call: OPEN_RAIL } },
        { id: 'scoreboard', target: '#stat-row', title: 'Scoreboard',
          body: 'Totals for what is on screen. {Click} a number to keep only those headlines.', mobile: { call: CLOSE_RAIL } },
        { id: 'timeline', target: '#tl-svg', title: 'Timeline',
          body: 'Headlines per day, split by take. {Click} a bar to see that day, or drag across bars to pick a range.',
          mobile: { call: CLOSE_RAIL, body: 'Headlines per day, split by take. Tap a bar to see that day.' } },
        { id: 'feed', target: '#feed', clip: 360, title: 'The feed',
          body: 'Grouped by day, newest first. The colored edge is the take; open a headline to read the original story.',
          mobile: { call: CLOSE_RAIL } }
      ]
    },
    {
      id: 'market', title: 'Market', blurb: 'Charts, comparisons, the watchlist and a portfolio simulator',
      page: '/market.html', url: '/market.html', requires: 'market',
      steps: [
        { id: 'header', call: PERF, target: ['#ah', '#ah-mkts'], title: 'The asset header',
          body: 'Price, today’s move and returns for the selected asset, with FX rates and which markets are open.' },
        { id: 'rotation', call: PERF, target: '#car-next', title: 'Up next',
          body: 'The header rotates through our universe; **Auto** turns the rotation on or off. Picking an asset pauses it.' },
        { id: 'range', call: PERF, target: '.ah-range', title: 'Range and dates',
          body: 'Every chart and table follows this range, from one day to the full history, or set your own From–To dates.' },
        { id: 'modes', call: PERF, target: '#chart-mode', title: 'Chart modes',
          body: '**Price**; **% Change** to compare several assets; **Ratio** to track one asset against another, with its mean and ±1σ/±2σ bands.' },
        { id: 'measure', media: 'desktop', call: PERF, target: '#main-chart', title: 'Measure any move',
          body: 'Click and drag across the chart to see the return over that span. A single click clears it.' },
        { id: 'compare', call: PERF, target: '#cmp-row', title: 'Compare',
          body: 'Add suggested peers, the sector index or its commodity, or any other asset with **+ Other…**.' },
        { id: 'watchlist', call: PERF, target: '.wl-card', clip: 360, title: 'Watchlist',
          body: 'Returns for every asset over the range. {Click} a row to chart it; switch between All, Coverage, Peers and Commodities.' },
        { id: 'thesis', call: PERF, target: '#thesis', clip: 360, title: 'Thesis strip',
          body: 'The asset next to its commodity driver, peers and index, as of today.' },
        { id: 'analytics', call: PERF, target: ['#corr-host', '#pf-host'], clip: 360, title: 'Correlation and portfolio',
          body: 'See how the selected assets move together, and test a portfolio: type the weights, or use **Advanced** to change them over time.' }
      ]
    },
    {
      id: 'marketwatch', title: 'Market Watch', blurb: 'Commodities table, short interest, buybacks, insiders and filings',
      page: '/market.html', url: '/market.html', requires: ['market', 'market_watch'],
      cleanup: PERF,   // devolve a página na Performance
      steps: [
        { id: 'tabs', call: PERF, target: '#mtabs', title: 'More tabs',
          body: 'Besides Stocks, Market has our sector baskets, a commodities table and four tabs built on B3 and CVM data.' },
        { id: 'baskets', call: TAB('baskets'), target: '#bk-host', clip: 360, title: 'Baskets',
          body: 'Each sector as an equal-weighted basket. The map shows where every company sits (the long move across, the recent move up); the ranking and the chart compare the baskets and their commodity.' },
        { id: 'commodities', call: TAB('commodities'), target: '#ct-host', clip: 360, title: 'All commodities',
          body: 'Every price in one table, grouped like the carousel. {Click} a column header to sort.' },
        { id: 'short', call: TAB('short'), target: '#mw-host', clip: 360, title: 'Short interest',
          body: 'Shares on loan for each company, as a share of the free float, with the lending fee and its history.' },
        { id: 'buybacks', call: TAB('buybacks'), target: '#mw-host', clip: 360, title: 'Buybacks',
          body: 'Active and past share repurchase programs, with how much each company is authorized to buy.' },
        { id: 'insiders', call: TAB('insiders'), target: '#mw-host', clip: 360, title: 'Insiders',
          body: 'Net buying and selling by controlling shareholders, board and management over the last 12 months.' },
        { id: 'filings', call: TAB('filings'), target: '#mw-host', clip: 360, title: 'Filings',
          body: 'Material facts and notices filed with the CVM, each with a link to the original document.' }
      ]
    },
    {
      id: 'stockguide', title: 'Stock Guide', blurb: 'Our coverage side by side, with live multiples and sensitivities',
      page: '/stock-guide.html', url: '/stock-guide.html', requires: 'stock_guide',
      cleanup: { click: '#sgtab-comp' },
      steps: [
        { id: 'tabs', call: { click: '#sgtab-comp' }, target: '.sg-tabs', title: 'Two views',
          body: '**Comp Table** puts our coverage side by side; **Sensitivity** shows how the numbers move in different scenarios.' },
        { id: 'comps', call: { click: '#sgtab-comp' }, target: '#comps-table', clip: 360, title: 'Comp Table',
          body: 'Rating, target price and upside next to EV/EBITDA, net debt/EBITDA, P/CE and yields for the two estimate years in the header, grouped by sector.' },
        { id: 'live', call: { click: '#sgtab-comp' }, target: '#px-fresh', title: 'Live multiples',
          body: 'Multiples are recomputed from live prices and FX. This line tells you how fresh the quotes are.' },
        { id: 'models', call: { click: '#sgtab-comp' }, target: '#comps-table .model-dl', title: 'Open the model',
          body: '{Click} the download icon to open the full model for that company.' },
        { id: 'peers', unlessOff: 'stock_guide_peers', call: { click: '#sgtab-comp' }, target: '#peers-card', title: 'Global peers',
          body: 'Consensus multiples for international peers, with live prices, to put our coverage in context.' },
        { id: 'sensitivity', requires: 'stock_guide_sensitivity', call: { click: '#sgtab-sens' }, target: '#sens-host', clip: 360, title: 'Sensitivity',
          body: 'Tables from our models: EBITDA, EV/EBITDA, FCF and FCF yield across scenarios. The orange mark shows where spot prices sit today.' }
      ]
    }
    ,{
      id: 'quarterly', title: 'Quarterly', blurb: 'Reported results of our coverage, quarter by quarter',
      page: '/quarterly.html', url: '/quarterly.html', requires: 'quarterly',
      cleanup: { click: '#views button[data-v="board"]' },   // as trocas de visão vivem num IIFE: só dá p/ clicar
      steps: [
        { id: 'views', call: { click: '#views button[data-v="board"]' }, target: '#views', title: 'Four views',
          body: '**Season board** for the latest quarter across our coverage, **Company** for one name in depth, **Compare** to line them up and **Build a chart** to make your own.' },
        { id: 'board', call: { click: '#views button[data-v="board"]' }, target: ['#b-q', '#b-table-wrap', '#b-cards'], clip: 360, title: 'Season board',
          body: 'Revenue, adjusted EBITDA and margin, net income and leverage for each company, with the status of each release.' },
        { id: 'controls', target: ['#ccy', '#basis', '#win'], title: 'Currency, basis and window',
          body: 'Show figures as reported or in US$, per quarter or for the last twelve months, and pick how many quarters to see.' },
        { id: 'company', call: { click: '#views button[data-v="co"]' }, target: ['#c-pick', '#c-kpis'], title: 'Company view',
          body: 'Pick a company for its KPIs, charts and full table. **⤓ Excel** exports every series with the full history.' },
        { id: 'compare', call: { click: '#views button[data-v="cmp"]' }, target: ['#m-metric', '#m-mode', '#m-cos'], title: 'Compare',
          body: 'Pick a metric (headline figures, volumes, prices, cash costs or unit economics) and the companies. See levels, YoY, QoQ or base 100, as lines or bars, with a ranking of the latest quarter.' },
        { id: 'build', call: { click: '#views button[data-v="build"]' }, target: ['#bd-preset', '#bd-add', '#bd-rows'], clip: 360, title: 'Build a chart',
          body: 'Combine up to 8 series from any company, add a free benchmark index, choose the axis and the chart type, or start from a preset. **Copy link** reopens the exact chart.' }
      ]
    },
    {
      id: 'mm', title: 'Steel & Mining', blurb: 'Prices, domestic market and trade flows, with downloadable charts',
      page: '/Steel and Mining/steel_sm_dashboard.html', url: '/Steel and Mining/steel_sm_dashboard.html',
      waitGone: '#loading',   // o banco ainda descendo: a tela "Loading data…" fica na frente de tudo
      // Dois roteiros no mesmo segmento: `notIf: html.desk-on` = abas de sempre · `onlyIf: html.desk-on` = a mesa de dados
      // (Data Desk, flag data_desk; admin vê sempre). Passo sem condição serve aos dois.
      steps: [
        { id: 'sections', notIf: 'html.desk-on', target: ['#steel-subnav', '.mob-sections-list'], title: 'Sections',
          body: 'Domestic Market, Imports and Exports: each section is a set of charts you can filter and download.',
          mobile: { body: 'Pick a section to open its charts. **← Sections** brings this list back anytime.' } },
        { id: 'd-sections', onlyIf: 'html.desk-on', target: ['#steel-subnav', '.mob-sections-list'], title: 'Sections',
          body: 'The bar is organised by commodity. **Overview** lists every indicator with its latest figure; **Steel** and **Iron Ore** open their own sections on the line just below; **Builder** puts series side by side.',
          mobile: { body: 'The list is organised by commodity. Start at **Overview**, or pick a section under **Steel** or **Iron Ore**. **← Sections** brings this list back anytime.' } },
        { id: 'd-prices', onlyIf: 'html.desk-on', call: ['mobSelect', 'parity'], target: '#desk-root .dk-hfstage', clip: 420, title: 'Market prices and import parity',
          body: 'Daily and weekly market prices. **HRC premium** and **Rebar premium** show how much more the domestic product costs than the imported one; the strip under the chart opens the calculation, step by step.',
          mobile: { body: 'Daily and weekly market prices. The premium cards show how much more the domestic product costs than the imported one; the strip under the chart opens the calculation.' } },
        { id: 'm-back', media: 'mobile', call: ['mobSelect', 'domestic'], target: '#mob-back-btn', title: 'Back to sections',
          body: 'Tap **← Sections** anytime to switch to another section.' },
        { id: 'filters', call: ['mobSelect', 'imports'], target: '.filter-bar', title: 'Filters',
          body: 'Choose the product, the granularity (monthly, quarterly, annual) and the window. The charts follow.' },
        { id: 'd-tiles', onlyIf: 'html.desk-on', call: ['mobSelect', 'imports'], target: '#desk-root .dk-tiles', title: 'The numbers on top are buttons',
          body: 'Each card shows the latest figure, how it moved and where it sits in its 5-year range. {Click} a card to put that indicator on the main chart.',
          mobile: { body: 'Each card shows the latest figure and how it moved. Swipe sideways for more, and tap a card to put it on the main chart.' } },
        { id: 'd-stage', onlyIf: 'html.desk-on', call: ['mobSelect', 'imports'], target: '#desk-root .dk-stage', clip: 420, title: 'The main chart',
          body: 'Switch between **Level**, **YoY**, **LTM** and **Seasonal**. Drag the strip under the chart to change the period, or use the window buttons above.' },
        { id: 'd-reading', onlyIf: 'html.desk-on', call: ['mobSelect', 'imports'], target: '#desk-root .dk-read', clip: 360, title: 'Reading',
          body: 'The comparisons, ready: versus last month, last year, the 5-year average and the year to date. {Click} two points on the chart to compare them.' },
        { id: 'd-who', onlyIf: 'html.desk-on', call: ['mobSelect', 'imports'], target: '#desk-root .dk-who', clip: 380, title: 'Who is behind the number',
          body: 'The same figure split by country or by product. {Click} a name to show or hide it; **Countries ▾** lists every country in the database.' },
        { id: 'download', call: ['mobSelect', 'imports'], target: '.section.active .chart-card .ibba-dl', title: 'Download any chart',
          body: '**PNG** saves the chart as you see it; **XLS** downloads its full history, not just the window on screen.' },
        { id: 'raw', target: '.dl-data-btn', title: 'All the data',
          body: 'Download the complete underlying tables, in Excel or CSV.' },
        { id: 'asof', media: 'desktop', target: '#snav-asof', title: 'Data through',   // no celular a faixa fica escondida: sem isto o passo esperava 6 s e era pulado
          body: 'The latest month available in each source, so you know how current the charts are.' },
        { id: 'd-builder', onlyIf: 'html.desk-on', call: ['mobSelect', 'builder'], target: '#desk-root .dk-bstage', clip: 420, title: 'Builder',
          body: 'Put up to 4 series from any section on one chart. Series in different units go to **base 100** automatically, so they compare on one scale. **Copy link** reopens the same view.',
          mobile: { body: 'Put up to 4 series on one chart: tap **+ Add series** to pick them. Series in different units go to **base 100** automatically, so they compare on one scale.' } },
        { id: 'prediction', notIf: 'html.desk-on', unlessOff: 'pred_model', call: [['mobSelect', 'imports'], ['setImportTab', 'prediction']], target: '#im-tab-prediction', clip: 360, title: 'Predictive model',
          body: 'Uses Korea’s and China’s export records to anticipate Brazil’s flat-steel imports about three months ahead.' },
        { id: 'd-prediction', onlyIf: 'html.desk-on', unlessOff: 'pred_model', call: [['mobSelect', 'imports'], ['setImportTab', 'prediction']], target: '#desk-root .dk-stage', clip: 420, title: 'Predictive model',
          body: 'In Imports, **Predictive model** uses Korea’s and China’s export records to anticipate Brazil’s flat-steel imports about three months ahead.' }
      ]
    },
    {
      id: 'pp', title: 'Pulp & Paper', blurb: 'Pulp exports, woodchips, paper and corrugated boxes',
      page: '/Pulp and Paper/pp_dashboard.html', url: '/Pulp and Paper/pp_dashboard.html',
      waitGone: '#loading',
      steps: [
        { id: 'sections', notIf: 'html.desk-on', target: ['#pp-subnav', '.mob-sections-list'], title: 'Sections',
          body: '**Pulp** covers Brazil’s pulp exports by port and China’s woodchip imports; **Paper & Packaging** covers Ibá and corrugated box data.',
          mobile: { body: 'Pick **Pulp** or **Paper & Packaging**. **← Sections** brings this list back anytime.' } },
        { id: 'd-sections', onlyIf: 'html.desk-on', target: ['#pp-subnav', '.mob-sections-list'], title: 'Sections',
          body: '**Overview** lists every indicator. **Pulp** covers exports and China’s woodchips; **Paper & Packaging** covers Ibá and corrugated boxes; **Builder** puts series side by side.',
          mobile: { body: 'Start at **Overview**, or pick **Pulp** or **Paper & Packaging**. **← Sections** brings this list back anytime.' } },
        { id: 'filters', call: [['mobSelect', 'pulp'], ['setPulpTab', 'secex']], target: '.filter-bar', title: 'Filters',
          body: 'Choose the granularity and the window, and the product where it applies. The charts follow.' },
        { id: 'd-tiles', onlyIf: 'html.desk-on', call: [['mobSelect', 'pulp'], ['setPulpTab', 'secex']], target: '#desk-root .dk-tiles', title: 'The numbers on top are buttons',
          body: 'Each card shows the latest figure, how it moved and where it sits in its 5-year range. {Click} a card to put that indicator on the main chart.',
          mobile: { body: 'Each card shows the latest figure and how it moved. Swipe sideways for more, and tap a card to put it on the main chart.' } },
        { id: 'd-stage', onlyIf: 'html.desk-on', call: [['mobSelect', 'pulp'], ['setPulpTab', 'secex']], target: '#desk-root .dk-stage', clip: 420, title: 'The main chart',
          body: 'Switch between **Level**, **YoY**, **LTM** and **Seasonal**. Drag the strip under the chart to change the period, or use the window buttons above.' },
        { id: 'd-reading', onlyIf: 'html.desk-on', call: [['mobSelect', 'pulp'], ['setPulpTab', 'secex']], target: '#desk-root .dk-read', clip: 360, title: 'Reading',
          body: 'The comparisons, ready: versus last month, last year, the 5-year average and the year to date. {Click} two points on the chart to compare them.' },
        { id: 'd-who', onlyIf: 'html.desk-on', call: [['mobSelect', 'pulp'], ['setPulpTab', 'secex']], target: '#desk-root .dk-who', clip: 380, title: 'Who is behind the number',
          body: 'Pulp exports split by port or by destination, in volume, revenue or share. {Click} a name to show or hide it.' },
        { id: 'suppliers', notIf: 'html.desk-on', call: [['mobSelect', 'pulp'], ['setPulpTab', 'gacc']], target: '#gc-cs-toggle', title: 'Woodchips by supplier',
          body: 'Pick which supplier countries appear in this chart — Vietnam and Australia by default.' },
        { id: 'd-suppliers', onlyIf: 'html.desk-on', call: [['mobSelect', 'pulp'], ['setPulpTab', 'gacc']], target: '#desk-root .dk-who', clip: 380, title: 'Woodchips by supplier',
          body: '**Woodchips — GACC** shows China’s imports by supplier. {Click} a country to show or hide it — Vietnam and Australia by default.' },
        { id: 'download', call: [['mobSelect', 'pulp'], ['setPulpTab', 'secex']], target: '.section.active .chart-card .ibba-dl', title: 'Download any chart',
          body: '**PNG** saves the chart as you see it; **XLS** downloads its full history, not just the window on screen.' },
        { id: 'raw', target: '.dl-data-btn', title: 'All the data',
          body: 'Download the complete underlying tables, in Excel or CSV.' },
        { id: 'd-builder', onlyIf: 'html.desk-on', call: ['mobSelect', 'builder'], target: '#desk-root .dk-bstage', clip: 420, title: 'Builder',
          body: 'Put up to 4 series from any section on one chart. Series in different units go to **base 100** automatically, so they compare on one scale. **Copy link** reopens the same view.',
          mobile: { body: 'Put up to 4 series on one chart: tap **+ Add series** to pick them. Series in different units go to **base 100** automatically, so they compare on one scale.' } },
        { id: 'corrugated', notIf: 'html.desk-on', call: [['mobSelect', 'paper'], ['setPaperTab', 'corrugated']], target: '.itab[data-patab="corrugated"]', title: 'Corrugated boxes',
          body: 'In Paper & Packaging, **Corrugated** tracks Empapel’s box shipments, a timely read on domestic demand.' },
        { id: 'd-corrugated', onlyIf: 'html.desk-on', call: [['mobSelect', 'paper'], ['setPaperTab', 'corrugated']], target: '#desk-root .dk-views', title: 'Corrugated boxes',
          body: 'In Paper & Packaging, **Corrugated — Empapel** tracks box shipments, a timely read on domestic demand.' }
      ]
    },
    {
      id: 'calendar', title: 'Calendar', blurb: 'Earnings dates, data releases and industry events',
      page: '/agenda.html', url: '/agenda.html', requires: 'exec_calendar',
      steps: [
        { id: 'views', target: '.cal-seg', title: 'Month, week or list',
          body: 'Switch between month, week and list views. In the month view, {click} a day to open that week.',
          mobile: { body: 'Switch between month, week and list. On a phone the list is the easiest to read.' } },
        { id: 'move', target: ['#cal-prev', '#cal-next', '#cal-today'], title: 'Move in time',
          body: 'Go back or forward, or jump straight to today.' },
        { id: 'filters', target: ['#cal-chips', '#cal-company'], title: 'Filter events',
          body: 'Show only some categories — earnings, data releases, industry events — or a single company.' },
        { id: 'events', target: ['#cal-month', '#cal-week', '#cal-list'], clip: 360, title: 'Event details',
          body: '{Click} any event for its details and links.' }
      ]
    },
    {
      id: 'data', title: 'Data & Glossary', blurb: 'Where each number comes from, how fresh it is and what it means',
      page: '/data.html', url: '/data.html', requires: 'data_page',
      cleanup: { click: '#tabs button[data-tab="sources"]' },
      steps: [
        { id: 'tabs', call: { click: '#tabs button[data-tab="sources"]' }, target: '#tabs', title: 'Sources and glossary',
          body: 'Two tabs: where each number comes from and how fresh it is, and a glossary of the indicators.' },
        { id: 'sources', call: { click: '#tabs button[data-tab="sources"]' }, target: '#src-table', clip: 360, title: 'Freshness',
          body: 'Every source with its latest data and when the next update is expected. The light shows whether it is on time.' },
        { id: 'glossary', call: { click: '#tabs button[data-tab="glossary"]' }, target: ['#gl-chips', '#gl-search'], title: 'Glossary',
          body: 'Search any indicator or filter by section to see what it measures and where it comes from.' }
      ]
    }
  ]
};
})();
