/* =============================================================================
 * model-engine.js — motor de cálculo da "definição viva" (Model Central v2)
 *
 * Avalia o MODELO como DADO (não código): drivers + linhas (contas, c/ fórmula
 * editável) + outputs (indicadores). Determinístico, seguro (parser próprio, SEM
 * eval()), roda no browser E no Node (parity test).
 *
 * Contrato da "def" (1 por empresa):
 *   {
 *     ticker, name, currency, model_date,
 *     years: ["2026E","2027E","2028E"],
 *     drivers: [{ id, label, unit, kind:"live"|"input",
 *                 live_source, base_by_year:[..], min, max }],
 *     lines:   [{ id, label, unit, section, base_by_year:[..],
 *                 formula:"expr" | "",           // "" => usa base_by_year[y]
 *                 params:{ nome:[porAno..] } }], // coeficientes do modelo (editáveis)
 *     outputs: [{ id, label, unit, formula:"expr",
 *                 published_by_year:[..] }]
 *   }
 *
 * Escopo visível numa fórmula (para o ano y):
 *   - cada driver pelo id (valor atual)        -> ex. iron_ore_61
 *   - base_<driverId> (valor-base do modelo)   -> ex. base_iron_ore_61
 *   - base            (base_by_year[y] da própria linha)
 *   - cada param da linha (resolvido no ano y) -> ex. kP, kV, kPV
 *   - cada linha já computada (por id)         -> ex. ebitda, net_debt
 *   - mktcap          (injetado; Modelo OU Ao vivo, conforme a coluna)
 *   - funções: min, max, abs, round, sqrt, pow ; operadores + - * / ^ e unário -
 * ============================================================================= */
(function (root) {
  'use strict';

  // ----- tokenizer -----------------------------------------------------------
  var NUM = /^[0-9]+(\.[0-9]+)?([eE][+-]?[0-9]+)?/;
  var IDENT = /^[A-Za-z_][A-Za-z0-9_]*/;
  function tokenize(src) {
    var toks = [], i = 0, s = String(src);
    while (i < s.length) {
      var c = s[i];
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { i++; continue; }
      if ('+-*/^(),'.indexOf(c) >= 0) { toks.push({ t: c }); i++; continue; }
      var rest = s.slice(i), m;
      if ((m = rest.match(NUM))) { toks.push({ t: 'num', v: parseFloat(m[0]) }); i += m[0].length; continue; }
      if ((m = rest.match(IDENT))) { toks.push({ t: 'id', v: m[0] }); i += m[0].length; continue; }
      throw new Error("caractere inesperado '" + c + "' na fórmula");
    }
    toks.push({ t: 'eof' });
    return toks;
  }

  // ----- parser (recursivo, precedência) -> AST ------------------------------
  // expr := add ; add := mul (('+'|'-') mul)* ; mul := pow (('*'|'/') pow)*
  // pow := unary ('^' unary)* ; unary := '-' unary | atom
  // atom := num | id | id '(' args ')' | '(' expr ')'
  function parse(src) {
    var toks = tokenize(src), p = 0;
    function peek() { return toks[p]; }
    function next() { return toks[p++]; }
    function expect(t) { var k = next(); if (k.t !== t) throw new Error("esperava '" + t + "'"); return k; }
    function parseExpr() { return parseAdd(); }
    function parseAdd() {
      var l = parseMul();
      while (peek().t === '+' || peek().t === '-') { var op = next().t; l = { k: 'bin', op: op, l: l, r: parseMul() }; }
      return l;
    }
    function parseMul() {
      var l = parsePow();
      while (peek().t === '*' || peek().t === '/') { var op = next().t; l = { k: 'bin', op: op, l: l, r: parsePow() }; }
      return l;
    }
    function parsePow() {
      var l = parseUnary();
      if (peek().t === '^') { next(); return { k: 'bin', op: '^', l: l, r: parsePow() }; } // right-assoc
      return l;
    }
    function parseUnary() {
      if (peek().t === '-') { next(); return { k: 'neg', e: parseUnary() }; }
      if (peek().t === '+') { next(); return parseUnary(); }
      return parseAtom();
    }
    function parseAtom() {
      var k = peek();
      if (k.t === 'num') { next(); return { k: 'num', v: k.v }; }
      if (k.t === '(') { next(); var e = parseExpr(); expect(')'); return e; }
      if (k.t === 'id') {
        next();
        if (peek().t === '(') { // call
          next(); var args = [];
          if (peek().t !== ')') { args.push(parseExpr()); while (peek().t === ',') { next(); args.push(parseExpr()); } }
          expect(')'); return { k: 'call', name: k.v, args: args };
        }
        return { k: 'var', name: k.v };
      }
      throw new Error("token inesperado na fórmula");
    }
    var ast = parseExpr();
    if (peek().t !== 'eof') throw new Error("sobrou conteúdo na fórmula");
    return ast;
  }

  var FUNCS = {
    min: Math.min, max: Math.max, abs: Math.abs, round: Math.round,
    sqrt: Math.sqrt, pow: Math.pow, floor: Math.floor, ceil: Math.ceil
  };

  function evalAst(ast, scope) {
    switch (ast.k) {
      case 'num': return ast.v;
      case 'neg': return -evalAst(ast.e, scope);
      case 'var': {
        if (Object.prototype.hasOwnProperty.call(scope, ast.name)) {
          var v = scope[ast.name];
          if (v == null || (typeof v === 'number' && !isFinite(v))) return NaN;
          return v;
        }
        throw new Error("variável desconhecida: '" + ast.name + "'");
      }
      case 'call': {
        var fn = FUNCS[ast.name];
        if (!fn) throw new Error("função desconhecida: '" + ast.name + "'");
        return fn.apply(null, ast.args.map(function (a) { return evalAst(a, scope); }));
      }
      case 'bin': {
        var l = evalAst(ast.l, scope), r = evalAst(ast.r, scope);
        switch (ast.op) {
          case '+': return l + r; case '-': return l - r;
          case '*': return l * r; case '/': return r === 0 ? NaN : l / r;
          case '^': return Math.pow(l, r);
        }
      }
    }
    throw new Error('AST inválido');
  }

  // cache de parse por fórmula (perf)
  var _cache = {};
  function compile(formula) {
    if (!(formula in _cache)) { _cache[formula] = parse(formula); }
    return _cache[formula];
  }
  function evalFormula(formula, scope) { return evalAst(compile(formula), scope); }

  // identificadores usados (p/ ordenação de dependência + validação/autocomplete)
  function identsOf(formula) {
    var out = {}, ast;
    try { ast = compile(formula); } catch (e) { return []; }
    (function walk(n) {
      if (!n) return;
      if (n.k === 'var') out[n.name] = 1;
      else if (n.k === 'neg') walk(n.e);
      else if (n.k === 'bin') { walk(n.l); walk(n.r); }
      else if (n.k === 'call') n.args.forEach(walk);
    })(ast);
    return Object.keys(out);
  }

  // ----- ordenação topológica das linhas por dependência ---------------------
  function orderLines(lines) {
    var byId = {}; lines.forEach(function (l) { byId[l.id] = l; });
    var ids = lines.map(function (l) { return l.id; });
    var idset = {}; ids.forEach(function (i) { idset[i] = 1; });
    var visited = {}, temp = {}, order = [];
    function visit(id) {
      if (visited[id]) return;
      if (temp[id]) throw new Error("dependência circular na linha '" + id + "'");
      temp[id] = 1;
      var l = byId[id];
      if (l && l.formula) {
        identsOf(l.formula).forEach(function (dep) { if (idset[dep] && dep !== id) visit(dep); });
      }
      temp[id] = 0; visited[id] = 1; order.push(id);
    }
    ids.forEach(visit);
    return order.map(function (id) { return byId[id]; });
  }

  // resolve params da linha para o ano y  -> {nome: valor}
  function paramsForYear(line, y) {
    var out = {};
    if (line.params) {
      Object.keys(line.params).forEach(function (k) {
        var arr = line.params[k];
        out[k] = Array.isArray(arr) ? arr[y] : arr;
      });
    }
    return out;
  }

  /* Calcula UM ano.
   * driverVals: { driverId: number }   (valor atual do driver nesse ano)
   * mktcap: number                     (Modelo OU Ao vivo — quem chama decide)
   * Retorna { lines:{id:val}, outputs:{id:val} }
   */
  function computeYear(def, y, driverVals, mktcap) {
    var baseScope = { mktcap: mktcap };
    (def.drivers || []).forEach(function (d) {
      var b = d.base_by_year ? d.base_by_year[y] : d.base;
      if (b == null) b = 0;                                  // ano sem input próprio (slope 0) -> termo inerte
      var cur = (driverVals && driverVals[d.id] != null) ? driverVals[d.id] : b;
      baseScope[d.id] = cur;
      baseScope['base_' + d.id] = b;
    });
    var lineVals = {};
    orderLines(def.lines || []).forEach(function (l) {
      var val;
      if (l.formula && String(l.formula).trim()) {
        var sc = Object.assign({}, baseScope, lineVals, paramsForYear(l, y), {
          base: l.base_by_year ? l.base_by_year[y] : (l.base != null ? l.base : NaN)
        });
        val = evalFormula(l.formula, sc);
      } else {
        val = l.base_by_year ? l.base_by_year[y] : l.base;
      }
      lineVals[l.id] = val;
    });
    var outVals = {};
    var outScope = Object.assign({}, baseScope, lineVals);
    (def.outputs || []).forEach(function (o) {
      try { outVals[o.id] = evalFormula(o.formula, outScope); }
      catch (e) { outVals[o.id] = NaN; }
    });
    return { lines: lineVals, outputs: outVals };
  }

  /* Calcula TODOS os anos, nas duas óticas Modelo × Ao vivo.
   * opts.driverVals: { driverId: [porAno..] }   (default = base do modelo por ano)
   * opts.mktcapModel: [porAno..]  (preço/câmbio congelados do modelo)
   * opts.mktcapLive:  [porAno..]  (preço/câmbio ao vivo)  — opcional
   */
  function compute(def, opts) {
    opts = opts || {};
    var years = def.years || [];
    var res = { years: years, model: [], live: [] };
    for (var y = 0; y < years.length; y++) {
      var dv = {};
      (def.drivers || []).forEach(function (d) {
        var arr = opts.driverVals && opts.driverVals[d.id];
        dv[d.id] = (arr && arr[y] != null) ? arr[y] : (d.base_by_year ? d.base_by_year[y] : d.base);
      });
      var mcM = opts.mktcapModel ? opts.mktcapModel[y] : (def.market && def.market.mktcap_model_by_year ? def.market.mktcap_model_by_year[y] : NaN);
      res.model.push(computeYear(def, y, dv, mcM));
      if (opts.mktcapLive) res.live.push(computeYear(def, y, dv, opts.mktcapLive[y]));
    }
    return res;
  }

  // valida uma def; retorna lista de problemas (vazia = ok)
  function validateDef(def) {
    var problems = [];
    var known = {};
    (def.drivers || []).forEach(function (d) { known[d.id] = 1; known['base_' + d.id] = 1; });
    known['mktcap'] = 1; known['base'] = 1;
    (def.lines || []).forEach(function (l) { known[l.id] = 1; });
    function checkFormula(where, formula, extra) {
      if (!formula) return;
      var loc = Object.assign({}, known, extra || {});
      try {
        identsOf(formula).forEach(function (id) {
          if (!(id in loc) && !(id in FUNCS)) problems.push(where + ": variável desconhecida '" + id + "'");
        });
      } catch (e) { problems.push(where + ": " + e.message); }
    }
    (def.lines || []).forEach(function (l) {
      var extra = {}; if (l.params) Object.keys(l.params).forEach(function (k) { extra[k] = 1; });
      checkFormula("linha " + l.id, l.formula, extra);
    });
    (def.outputs || []).forEach(function (o) { checkFormula("output " + o.id, o.formula); });
    try { orderLines(def.lines || []); } catch (e) { problems.push(e.message); }
    return problems;
  }

  var API = {
    parse: parse, evalFormula: evalFormula, identsOf: identsOf,
    orderLines: orderLines, computeYear: computeYear, compute: compute,
    validateDef: validateDef, FUNCS: FUNCS
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  root.ModelEngine = API;
})(typeof window !== 'undefined' ? window : globalThis);
