// GERADO por tests/fixtures/gerar_comps_antes.py — NAO editar a mao.
// Copia VERBATIM de stock-guide.html ANTES de as funcoes irem para a lib
// (commit imediatamente anterior). E o gabarito de equivalencia.
function n(v){return SG.toNumOrNull(v)}
function _short(t){return String(t||'').replace(/\.(SA|SN|MX|L|HE|AX|F|TO)$/,'')}
const GROUP_OF={iron_ore:'mining',copper:'mining',gold:'mining',mining:'mining',steel:'steel',pulp_paper:'pulp_paper',pp:'pulp_paper'};
function mapComp(c){return{ticker:c.ticker,company_name:c.company_name,is_visible:c.is_visible,display_order:c.display_order,
  sector:c.sector,yahoo_symbol:c.yahoo_symbol,shares_outstanding:n(c.shares_outstanding),
  last_update:c.last_update,target_price:n(c.target_price),recommendation:c.recommendation,
  net_debt_y1:n(c.net_debt_y1),net_debt_y2:n(c.net_debt_y2),ebitda_y1:n(c.ebitda_y1),ebitda_y2:n(c.ebitda_y2),
  net_income_y1:n(c.net_income_y1),net_income_y2:n(c.net_income_y2),
  dividends_y1:n(c.dividends_y1),dividends_y2:n(c.dividends_y2),
  cash_earnings_y1:n(c.cash_earnings_y1),cash_earnings_y2:n(c.cash_earnings_y2),
  ocf_y1:n(c.ocf_y1),ocf_y2:n(c.ocf_y2),
  ev_adjustment_y1:n(c.ev_adjustment_y1),ev_adjustment_y2:n(c.ev_adjustment_y2),
  fx_to_base:n(c.fx_to_base),fx_to_usd:n(c.fx_to_usd),base_ccy:c.base_ccy,trade_ccy:c.trade_ccy,model_url:c.model_url}}
function deriveMultiples(r,mc){  // mc = market cap na MOEDA-BASE
  const ev1=mc!=null&&r.net_debt_y1!=null?mc+r.net_debt_y1+(r.ev_adjustment_y1||0):null;
  const ev2=mc!=null&&r.net_debt_y2!=null?mc+r.net_debt_y2+(r.ev_adjustment_y2||0):null;
  return{evEbitdaY1:ev1!=null&&r.ebitda_y1>0?ev1/r.ebitda_y1:null, evEbitdaY2:ev2!=null&&r.ebitda_y2>0?ev2/r.ebitda_y2:null,
    ndEbitdaY1:r.net_debt_y1!=null&&r.ebitda_y1>0?r.net_debt_y1/r.ebitda_y1:null, ndEbitdaY2:r.net_debt_y2!=null&&r.ebitda_y2>0?r.net_debt_y2/r.ebitda_y2:null,
    pceY1:mc!=null&&r.cash_earnings_y1>0?mc/r.cash_earnings_y1:null, pceY2:mc!=null&&r.cash_earnings_y2>0?mc/r.cash_earnings_y2:null,
    peY1:mc!=null&&r.net_income_y1>0?mc/r.net_income_y1:null, peY2:mc!=null&&r.net_income_y2>0?mc/r.net_income_y2:null,
    divYieldY1:r.dividends_y1!=null&&mc>0?r.dividends_y1/mc*100:null, divYieldY2:r.dividends_y2!=null&&mc>0?r.dividends_y2/mc*100:null}}
function deriveComps(comps,priceByKey,fxRates){
  fxRates=fxRates||{};
  const rows=[];
  const lp=(r)=>{ const cands=[r.yahoo_symbol, r.is_visible?r.ticker:null].filter(Boolean);
    for(const c of cands){ const tries=[c,_short(c)]; if(!/\./.test(c))tries.push(c+'.SA');
      for(const t of tries){ if(priceByKey[t]!=null)return priceByKey[t]; } } return null; };
  comps.map(mapComp).forEach(r=>{
    const live=lp(r);
    // câmbio AO VIVO (USD por unidade da moeda de negociação); snapshot do modelo = fallback
    const trade=r.trade_ccy||'';
    const snapUsdPerTrade=(trade==='USD')?1:(r.fx_to_usd!=null?r.fx_to_usd:null);
    const liveRate=fxRates[trade];                                            // unidades por USD, ao vivo
    const usdPerTrade=(trade==='USD')?1:(liveRate?1/liveRate:snapUsdPerTrade);
    // fator p/ a moeda-BASE do modelo: 1 se base==negociação; senão (base=USD) = usdPerTrade
    const baseEqTrade=(r.fx_to_base!=null?Math.abs(r.fx_to_base-1)<=0.02:true);
    const factorBase=baseEqTrade?1:(usdPerTrade!=null?usdPerTrade:(r.fx_to_base!=null?r.fx_to_base:1));
    const mcBase=r.shares_outstanding!=null&&live!=null?r.shares_outstanding*live*factorBase:null;
    const mcUsd=r.shares_outstanding!=null&&live!=null&&usdPerTrade!=null?r.shares_outstanding*live*usdPerTrade:null;
    const upside=r.target_price!=null&&live!=null&&live>0?r.target_price/live-1:null;
    const toUsd=(usdPerTrade!=null&&factorBase)?usdPerTrade/factorBase:null;   // moeda-base → US$ (p/ agregado)
    const m=deriveMultiples(r,mcBase);
    const eps1=r.net_income_y1!=null&&r.shares_outstanding>0?r.net_income_y1/r.shares_outstanding:null;
    const eps2=r.net_income_y2!=null&&r.shares_outstanding>0?r.net_income_y2/r.shares_outstanding:null;
    const ocfY1=r.ocf_y1!=null&&mcBase>0?r.ocf_y1/mcBase*100:null, ocfY2=r.ocf_y2!=null&&mcBase>0?r.ocf_y2/mcBase*100:null;
    rows.push(Object.assign({},r,{displayName:r.company_name,group:GROUP_OF[r.sector]||'mining',
      livePrice:live,marketCapBrlMn:mcBase,marketCapUsd:mcUsd,toUsd:toUsd,upsidePct:upside,
      epsY1:eps1,epsY2:eps2,ocfYieldY1:ocfY1,ocfYieldY2:ocfY2},m));
  });
  return rows;
}
