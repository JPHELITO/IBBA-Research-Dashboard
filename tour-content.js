/* =========================================================================
 * tour-content.js — TEXTOS e PASSOS do Tutorial.   window.IBBA_TOURS
 * Motor: tour-lib.js. Editar um texto = editar só este arquivo.
 * UI em inglês (a dashboard é en-US); comentários em PT.
 *
 * Segmento: {id, title, blurb, page (null = qualquer página; aceita lista), url?,
 *            requires?, unlessOff?, cleanup?, steps:[…]}
 * Passo:    {id, title, body, target? (seletor ou lista; sem alvo = cartão no meio), all?,
 *            media?: 'desktop'|'mobile', mobile?: {os mesmos campos, só no celular},
 *            requires?, unlessOff?, call?: ['funcaoGlobal', args…], placement?, pad?, radius?, wait?}
 *   requires:'flag'  → só com a flag LIGADA (áreas que nascem fechadas: market, exec_calendar…)
 *   unlessOff:'flag' → só some com a flag DESLIGADA (painéis da home, que nascem abertos)
 *   all:true         → destaca TODOS os elementos visíveis do seletor juntos
 *   {click}/{Click} viram tap/Tap no celular · **negrito** vira <b> (nada mais de HTML)
 * ⚠️ tests/test_tour_content.html confere cada alvo e cada função de `call` contra o fonte
 *    das páginas: renomeou um id? o teste acusa — e não o cliente, com um passo pulado.
 * ====================================================================== */
window.IBBA_TOURS = {
  version: 1,
  // ordem do Full tour e da lista do painel
  order: ['basics', 'home'],
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
          body: 'Reach the research team by e-mail or WhatsApp straight from the top bar.' },
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
        { id: 'pulse', unlessOff: 'market_pulse', target: '[data-tour="home-pulse"]', title: 'Market Pulse',
          body: 'The tone of the newsflow since the last close, from our take on each headline. It describes the news; it is not a forecast.' },
        { id: 'events', requires: 'exec_calendar', target: '[data-tour="home-events"]', title: 'Upcoming events',
          body: 'What is on today and next: earnings, data releases and industry events. **Open calendar** shows the full view.' },
        { id: 'news', unlessOff: 'news_feed', target: '#news-feed', title: 'Latest headlines',
          body: 'The newest stories for our sectors. The badge is our take for the covered companies: **+** positive, **−** negative, **=** neutral.' },
        { id: 'news-filters', unlessOff: 'news_feed', target: ['#news-filter', '#news-sector-filter'], title: 'Filter the feed',
          body: 'Show a single take or sector: S&M, P&P or NR (macro). **View history** opens the full archive.' },
        { id: 'heat-tools', unlessOff: 'heatmap', target: ['#hm-range', '#hm-filter-btn'], title: 'Heatmap controls',
          body: 'Choose the period (day, week, month, YTD, year) and pick up to 15 stocks or indices under **Selected**.' },
        { id: 'heat-grid', unlessOff: 'heatmap', target: '#heatmap-grid', title: 'Open a company',
          body: 'Each tile is a stock and its move over the period. {Click} one for its price chart and comparisons.' }
      ]
    }
  ]
};
