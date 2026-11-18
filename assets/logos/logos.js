/* IBBA · LOGOS das empresas cobertas (gerado em 18/11/2026; origem de cada arquivo em FONTES.md)
   Para cada empresa há QUATRO arquivos, todos sem fundo:
     mark      só o símbolo, para fundo CLARO        markDark   só o símbolo, para fundo ESCURO
     full      símbolo + nome, para fundo CLARO      fullDark   símbolo + nome, para fundo ESCURO
   Regra de uso (pedido do usuário): onde o logo é pequeno (fichas, listas, cenas) vai SÓ o símbolo; ao abrir a
   página de uma empresa vai o logo completo, com o nome.
   IBBALogo('VALE3.SA', {full:true, dark:true}) devolve o endereço do arquivo (ou null se a empresa não tem logo).
   markRatio / fullRatio = largura ÷ altura do arquivo (para reservar o espaço antes de a imagem chegar). */
(function () {
  var B = '/assets/logos/';
  var M = {
    "VALE": {
      "name": "Vale",
      "mark": "VALE-mark.svg",
      "markDark": "VALE-mark-dark.svg",
      "markRatio": 1.298,
      "full": "VALE-full.svg",
      "fullDark": "VALE-full-dark.svg",
      "fullRatio": 2.448
    },
    "CMIN3": {
      "name": "CSN Mineração",
      "mark": "CMIN3-mark.svg",
      "markDark": "CMIN3-mark-dark.svg",
      "markRatio": 1.374,
      "full": "CMIN3-full.png",
      "fullDark": "CMIN3-full-dark.png",
      "fullRatio": 2.464
    },
    "CSNA3": {
      "name": "CSN",
      "mark": "CSNA3-mark.svg",
      "markDark": "CSNA3-mark-dark.svg",
      "markRatio": 1.374,
      "full": "CSNA3-full.svg",
      "fullDark": "CSNA3-full-dark.svg",
      "fullRatio": 2.181
    },
    "GGBR4": {
      "name": "Gerdau",
      "mark": "GGBR4-mark.svg",
      "markDark": "GGBR4-mark-dark.svg",
      "markRatio": 1.035,
      "full": "GGBR4-full.svg",
      "fullDark": "GGBR4-full-dark.svg",
      "fullRatio": 3.509
    },
    "USIM5": {
      "name": "Usiminas",
      "mark": "USIM5-mark.svg",
      "markDark": "USIM5-mark-dark.svg",
      "markRatio": 0.81,
      "full": "USIM5-full.svg",
      "fullDark": "USIM5-full-dark.svg",
      "fullRatio": 6.278
    },
    "TX": {
      "name": "Ternium",
      "mark": "TX-mark.svg",
      "markDark": "TX-mark-dark.svg",
      "markRatio": 0.911,
      "full": "TX-full.svg",
      "fullDark": "TX-full-dark.svg",
      "fullRatio": 3.07
    },
    "AUGO": {
      "name": "Aura Minerals",
      "mark": "AUGO-mark.png",
      "markDark": "AUGO-mark-dark.png",
      "markRatio": 0.878,
      "full": "AUGO-full.png",
      "fullDark": "AUGO-full-dark.png",
      "fullRatio": 1.688
    },
    "SCCO": {
      "name": "Southern Copper",
      "mark": "SCCO-mark.svg",
      "markDark": "SCCO-mark-dark.svg",
      "markRatio": 0.996,
      "full": "SCCO-full.svg",
      "fullDark": "SCCO-full-dark.svg",
      "fullRatio": 5.072
    },
    "GMEXICOB": {
      "name": "Grupo México",
      "mark": "GMEXICOB-mark.svg",
      "markDark": "GMEXICOB-mark-dark.svg",
      "markRatio": 1.019,
      "full": "GMEXICOB-full.svg",
      "fullDark": "GMEXICOB-full-dark.svg",
      "fullRatio": 5.224
    },
    "CS": {
      "name": "Capstone Copper",
      "mark": "CS-mark.svg",
      "markDark": "CS-mark-dark.svg",
      "markRatio": 0.462,
      "full": "CS-full.svg",
      "fullDark": "CS-full-dark.svg",
      "fullRatio": 2.247
    },
    "ERO": {
      "name": "Ero Copper",
      "mark": "ERO-mark.svg",
      "markDark": "ERO-mark-dark.svg",
      "markRatio": 1.036,
      "full": "ERO-full.svg",
      "fullDark": "ERO-full-dark.svg",
      "fullRatio": 3.836
    },
    "HBM": {
      "name": "Hudbay Minerals",
      "mark": "HBM-mark.svg",
      "markDark": "HBM-mark-dark.svg",
      "markRatio": 0.944,
      "full": "HBM-full.svg",
      "fullDark": "HBM-full-dark.svg",
      "fullRatio": 6.009
    },
    "LUN": {
      "name": "Lundin Mining",
      "mark": "LUN-mark.svg",
      "markDark": "LUN-mark-dark.svg",
      "markRatio": 1.117,
      "full": "LUN-full.svg",
      "fullDark": "LUN-full-dark.svg",
      "fullRatio": 7.735
    },
    "ARA": {
      "name": "Aclara Resources",
      "mark": "ARA-mark.png",
      "markDark": "ARA-mark-dark.png",
      "markRatio": 1.012,
      "full": "ARA-full.png",
      "fullDark": "ARA-full-dark.png",
      "fullRatio": 2.439
    },
    "VMM": {
      "name": "Viridis Mining & Minerals",
      "mark": "VMM-mark.png",
      "markDark": "VMM-mark-dark.png",
      "markRatio": 1.0,
      "full": "VMM-full.svg",
      "fullDark": "VMM-full-dark.svg",
      "fullRatio": 3.341
    },
    "SUZB3": {
      "name": "Suzano",
      "mark": "SUZB3-mark.svg",
      "markDark": "SUZB3-mark-dark.svg",
      "markRatio": 1.15,
      "full": "SUZB3-full.svg",
      "fullDark": "SUZB3-full-dark.svg",
      "fullRatio": 4.294
    },
    "KLBN11": {
      "name": "Klabin",
      "mark": "KLBN11-mark.svg",
      "markDark": "KLBN11-mark-dark.svg",
      "markRatio": 1.955,
      "full": "KLBN11-full.svg",
      "fullDark": "KLBN11-full-dark.svg",
      "fullRatio": 1.362
    },
    "RANI3": {
      "name": "Irani",
      "mark": "RANI3-mark.png",
      "markDark": "RANI3-mark-dark.png",
      "markRatio": 0.503,
      "full": "RANI3-full.png",
      "fullDark": "RANI3-full-dark.png",
      "fullRatio": 1.584
    },
    "CMPC": {
      "name": "CMPC",
      "mark": "CMPC-mark.svg",
      "markDark": "CMPC-mark-dark.svg",
      "markRatio": 1.115,
      "full": "CMPC-full.svg",
      "fullDark": "CMPC-full-dark.svg",
      "fullRatio": 2.509
    },
    "COPEC": {
      "name": "Empresas Copec",
      "mark": "COPEC-mark.svg",
      "markDark": "COPEC-mark-dark.svg",
      "markRatio": 1.001,
      "full": "COPEC-full.png",
      "fullDark": "COPEC-full-dark.png",
      "fullRatio": 6.006
    }
  };
  Object.keys(M).forEach(function (k) { var e = M[k]; ['mark', 'markDark', 'full', 'fullDark'].forEach(function (p) { e[p] = B + e[p]; }); });
  /* outros códigos da mesma empresa (ação preferencial/ordinária, ADR, BDR) */
  var ALIAS = { VALE3: 'VALE', GGB: 'GGBR4', GGBR3: 'GGBR4', GOAU4: 'GGBR4', GOAU3: 'GGBR4', AURA33: 'AUGO', ORA: 'AUGO', SID: 'CSNA3', USIM3: 'USIM5',
                SUZ: 'SUZB3', KLBN3: 'KLBN11', KLBN4: 'KLBN11', RANI4: 'RANI3', GMEXICO: 'GMEXICOB', GMBXF: 'GMEXICOB' };
  window.IBBA_LOGOS = M;
  window.IBBALogo = function (code, o) {
    o = o || {}; var k = String(code || '').split('.')[0].toUpperCase(); k = ALIAS[k] || k;
    var e = M[k]; if (!e) return null;
    return e[(o.full ? 'full' : 'mark') + (o.dark ? 'Dark' : '')] || null;
  };
})();
