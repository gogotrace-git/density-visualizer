exports.handler = async function(event) {
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 200,
      headers: corsHeaders(),
      body: ''
    };
  }

  if (event.httpMethod !== 'POST') {
    return jsonResponse(405, { error: 'Method not allowed' });
  }

  try {
    const apiKey = process.env.ARK_API_KEY;
    const model = process.env.ARK_MODEL || 'doubao-seed-2-0-mini-260215';
    if (!apiKey) {
      return jsonResponse(500, { error: 'Missing ARK_API_KEY environment variable.' });
    }

    const body = JSON.parse(event.body || '{}');
    const imageDataUrl = body.imageDataUrl;
    if (!imageDataUrl || typeof imageDataUrl !== 'string') {
      return jsonResponse(400, { error: 'Missing imageDataUrl.' });
    }

    const prompt = [
      '你是一个二维概率密度函数可视化网页的图片识别助手。',
      '你的任务不是解释图片，而是提取可直接用于网页表单的结构化字段。',
      '必须严格只返回 JSON 对象，不要输出任何解释、前言、后记、markdown 代码块。',
      'JSON 键固定为：formula_expr, formula_latex, support, region, source_text, notes, needs_review。',
      '字段要求：',
      '1. formula_expr 只填写二维密度函数的非零部分。可以写成 f(x,y)=...，也可以只写表达式本身；两种都允许。但不要带“0, otherwise / 其余为0 / 其他情况为0”，也不要重复整段分段函数。',
      '2. formula_latex 填对应的 LaTeX 形式，格式类似 f(x,y)=e^{-y}。同样只保留非零部分，不要带分段函数中为 0 的部分。',
      '3. support 只填写 formula_expr 非零部分对应的支持集/定义域，例如 0<x<y、0<=x<=1, 0<=y<=x。',
      '4. region 只填写图片中额外明确给出的积分区域 D。若图片中没有额外积分区域，就置为空字符串。不要把 support 误填到 region。',
      '5. source_text 用尽量简短的一行原始信息概括，可为空字符串。不要写长句解释。',
      '6. notes 只写极短备注，例如“图片模糊”“region 不清晰”；没有备注就置为空字符串。',
      '7. needs_review 只能是 true 或 false。看不清、有歧义时设为 true。',
      '8. 如果图片中给的是分段密度函数，例如 f(x,y)=e^{-y}, 0<x<y; 0, otherwise，那么你必须返回 formula_expr="f(x,y)=exp(-y)" 或 "exp(-y)"，support="0<x<y"，而且不能重复把整个分段函数再写一遍。',
      '9. 不确定时宁可留空，不要猜测。',
      '返回格式示例：',
      '{"formula_expr":"f(x,y)=exp(-y)","formula_latex":"f(x,y)=e^{-y}","support":"0<x<y","region":"","source_text":"f(x,y)=e^{-y}, 0<x<y","notes":"","needs_review":false}'
    ].join('\n');

    const arkResponse = await fetch('https://ark.cn-beijing.volces.com/api/v3/responses', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model,
        input: [
          {
            role: 'user',
            content: [
              { type: 'input_image', image_url: imageDataUrl },
              { type: 'input_text', text: prompt }
            ]
          }
        ]
      })
    });

    const rawResponseText = await arkResponse.text();
    let arkPayload = null;
    try {
      arkPayload = rawResponseText ? JSON.parse(rawResponseText) : null;
    } catch (_) {
      if (!arkResponse.ok) {
        return jsonResponse(arkResponse.status, {
          error: `server-non-json: ${rawResponseText.slice(0, 200)}`
        });
      }
      return jsonResponse(502, {
        error: `upstream-non-json: ${rawResponseText.slice(0, 200)}`
      });
    }

    if (!arkResponse.ok) {
      return jsonResponse(arkResponse.status, {
        error: extractArkError(arkPayload) || 'ARK request failed.',
        details: arkPayload
      });
    }

    const rawText = extractOutputText(arkPayload);
    const parsed = normalizeModelOutput(parseModelJson(rawText));
    return jsonResponse(200, {
      formula_expr: parsed.formula_expr,
      formula_latex: parsed.formula_latex,
      formula_raw: parsed.formula_expr,
      support: parsed.support,
      region: parsed.region,
      source_text: parsed.source_text,
      notes: parsed.notes,
      needs_review: parsed.needs_review,
      raw_model_text: rawText
    });
  } catch (error) {
    return jsonResponse(500, { error: error.message || 'Unexpected server error.' });
  }
};

function extractArkError(payload) {
  return payload?.error?.message || payload?.message || '';
}

function extractOutputText(payload) {
  if (typeof payload?.output_text === 'string' && payload.output_text.trim()) {
    return payload.output_text.trim();
  }
  const output = Array.isArray(payload?.output) ? payload.output : [];
  const pieces = [];
  for (const item of output) {
    const content = Array.isArray(item?.content) ? item.content : [];
    for (const block of content) {
      if (typeof block?.text === 'string') pieces.push(block.text);
      if (typeof block?.content === 'string') pieces.push(block.content);
    }
  }
  return pieces.join('\n').trim();
}

function parseModelJson(text) {
  if (!text) return {};
  const candidates = [text];
  const match = text.match(/\{[\s\S]*\}/);
  if (match) candidates.push(match[0]);
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch (_) {}
    try {
      return JSON.parse(repairJsonBackslashes(candidate));
    } catch (_) {}
  }
  throw new Error('Model output was not valid JSON.');
}

function repairJsonBackslashes(text) {
  if (!text) return text;
  return text.replace(/\\(?!["\\\/bfnrtu])/g, '\\\\');
}

function normalizeModelOutput(payload) {
  const formulaExpr = cleanupFormulaExpr(
    ensureString(payload.formula_expr) || ensureString(payload.formula_raw) || ensureString(payload.formula)
  );
  const formulaLatex = cleanupFormulaLatex(
    ensureString(payload.formula_latex) || formulaExprToLatex(formulaExpr)
  );
  const support = cleanupSupport(ensureString(payload.support));
  const region = cleanupRegion(ensureString(payload.region));
  const sourceText = cleanupSourceText(ensureString(payload.source_text));
  const notes = cleanupNotes(ensureString(payload.notes));
  const needsReview = Boolean(payload.needs_review) || !formulaExpr || !support;
  return {
    formula_expr: formulaExpr,
    formula_latex: formulaLatex,
    support,
    region,
    source_text: sourceText,
    notes,
    needs_review: needsReview
  };
}

function ensureString(value) {
  return typeof value === 'string' ? value.trim() : '';
}


function insertImplicitMultiplication(expr) {
  let s = (expr || '').trim();
  if (!s) return '';
  s = s.replace(/\s+/g, '');
  for (let i = 0; i < 8; i++) {
    const prev = s;
    s = s.replace(/(\d)([xy])/gi, '$1*$2');
    s = s.replace(/(\d)\(/g, '$1*(');
    s = s.replace(/([xy])\(/gi, '$1*(');
    s = s.replace(/\)(\d|[xy])/gi, ')*$1');
    s = s.replace(/([xy])([xy])/gi, '$1*$2');
    s = s.replace(/\)\(/g, ')*(');
    if (s === prev) break;
  }
  return s;
}

function canonicalizeSimpleClause(clause) {
  const s = ensureString(clause).replace(/≤/g, '<=').replace(/≥/g, '>=').replace(/\s+/g, '');
  if (!s) return '';
  let m = s.match(/^(-?\d+(?:\.\d+)?)(<=|<)(x|y)$/i);
  if (m) return `${m[1]}${m[2]}${m[3].toLowerCase()}`;
  m = s.match(/^(x|y)(<=|<)(-?\d+(?:\.\d+)?)$/i);
  if (m) return `${m[1].toLowerCase()}${m[2]}${m[3]}`;
  m = s.match(/^(x|y)(>=|>)(-?\d+(?:\.\d+)?)$/i);
  if (m) return `${m[3]}${m[2] === '>=' ? '<=' : '<'}${m[1].toLowerCase()}`;
  m = s.match(/^(-?\d+(?:\.\d+)?)(>=|>)(x|y)$/i);
  if (m) return `${m[3].toLowerCase()}${m[2] === '>=' ? '<=' : '<'}${m[1]}`;
  return s;
}

function extractImpliedSimpleClauses(clause) {
  const compact = canonicalizeSimpleClause(clause);
  const exprs = compact.split(/<=|>=|<|>/g);
  const ops = compact.match(/<=|>=|<|>/g) || [];
  if (ops.length < 2) return [];
  const out = [];
  for (let i = 0; i < ops.length; i++) out.push(`${exprs[i]}${ops[i]}${exprs[i + 1]}`);
  return out;
}

function chooseBetterLower(current, next) {
  if (!current) return next;
  if (Number(next.num) > Number(current.num)) return next;
  if (Number(next.num) < Number(current.num)) return current;
  if (current.op === '<' && next.op === '<=') return current;
  return next;
}

function chooseBetterUpper(current, next) {
  if (!current) return next;
  if (Number(next.num) < Number(current.num)) return next;
  if (Number(next.num) > Number(current.num)) return current;
  if (current.op === '<' && next.op === '<=') return current;
  return next;
}

function simplifySupportText(value) {
  let s = ensureString(value);
  if (!s) return '';
  s = s.replace(/[；;]/g, ',').replace(/，/g, ',');
  s = s.replace(/\\le/g, '<=').replace(/\\ge/g, '>=');
  s = s.replace(/≤/g, '<=').replace(/≥/g, '>=');
  let clauses = s.split(/[;,]/).map(canonicalizeSimpleClause).filter(Boolean);
  clauses = [...new Set(clauses)];
  const implied = new Set();
  clauses.forEach(clause => extractImpliedSimpleClauses(clause).forEach(x => implied.add(canonicalizeSimpleClause(x))));
  clauses = clauses.filter(clause => {
    const ops = clause.match(/<=|>=|<|>/g) || [];
    return ops.length >= 2 || !implied.has(clause);
  });

  const consumed = new Set();
  const rebuilt = [];
  ['x', 'y'].forEach(variable => {
    let lower = null, upper = null, lowerClause = '', upperClause = '';
    clauses.forEach(clause => {
      let m = clause.match(new RegExp(`^(-?\\d+(?:\\.\\d+)?)(<=|<)${variable}$`, 'i'));
      if (m) {
        const cand = { num: m[1], op: m[2] };
        const better = chooseBetterLower(lower, cand);
        if (better === cand) { lower = cand; lowerClause = clause; }
        return;
      }
      m = clause.match(new RegExp(`^${variable}(<=|<)(-?\\d+(?:\\.\\d+)?)$`, 'i'));
      if (m) {
        const cand = { num: m[2], op: m[1] };
        const better = chooseBetterUpper(upper, cand);
        if (better === cand) { upper = cand; upperClause = clause; }
      }
    });
    if (lower && upper) {
      consumed.add(lowerClause);
      consumed.add(upperClause);
      rebuilt.push(`${lower.num}${lower.op}${variable}${upper.op}${upper.num}`);
    }
  });

  clauses = clauses.filter(clause => !consumed.has(clause)).concat(rebuilt);
  clauses = [...new Set(clauses)].filter(Boolean);
  clauses.sort((a, b) => {
    const score = clause => {
      const s = canonicalizeSimpleClause(clause);
      if (/x/.test(s) && !/y/.test(s)) return 0;
      if (/y/.test(s) && /x/.test(s)) return 2;
      if (/y/.test(s)) return 1;
      return 3;
    };
    return score(a) - score(b);
  });
  return clauses.join(', ');
}

function normalizeFormulaBody(value) {
  let s = ensureString(value);
  if (!s) return '';
  s = s.replace(/\\le/g, '<=').replace(/\\ge/g, '>=');
  s = s.replace(/≤/g, '<=').replace(/≥/g, '>=');
  return insertImplicitMultiplication(s);
}


function cleanupFormulaExpr(value) {
  let s = (value || '').trim();
  if (!s) return '';
  const hadPrefix = /^\s*f\s*[\(\[]\s*x\s*,\s*y\s*[\)\]]\s*=\s*/i.test(s);
  s = s.replace(/[，；;]/g, ',');
  s = s.replace(/\s+/g, ' ');
  s = s.replace(/(^|,|;)\s*(0|0\.)\s*(,\s*)?(otherwise|else|other cases?)\b.*$/i, '');
  s = s.replace(/(^|,|;)\s*(0|0\.)\s*(,\s*)?(其余.*|其他.*|否则.*)$/i, '');
  s = s.replace(/,\s*0\s*$/i, '');
  s = s.replace(/\botherwise\b.*$/i, '');
  s = s.replace(/\belse\b.*$/i, '');
  s = s.replace(/其余情况为?0.*$/i, '');
  s = s.replace(/其他情况为?0.*$/i, '');
  s = s.replace(/其余为?0.*$/i, '');
  s = s.replace(/其他为?0.*$/i, '');
  s = s.replace(/^\s*f\s*[\(\[]\s*x\s*,\s*y\s*[\)\]]\s*=\s*/i, '');
  s = stripTrailingSupportLikeText(s);
  s = s.replace(/[,;，；]\s*$/,'').trim();
  s = normalizeFormulaBody(s);
  return (hadPrefix && s) ? `f(x,y)=${s}` : s;
}


function stripTrailingSupportLikeText(value) {
  let s = (value || '').trim();
  if (!s) return '';
  const parts = s.split(',').map(part => part.trim()).filter(Boolean);
  if (parts.length <= 1) return s;
  const keep = [];
  for (const part of parts) {
    if (looksLikeSupportText(part)) continue;
    keep.push(part);
  }
  return keep.length ? keep.join(', ') : parts[0];
}

function looksLikeSupportText(part) {
  if (!part) return false;
  const s = part.replace(/\s+/g, '');
  if (!/[xy]/i.test(s)) return false;
  if (/(<|>|<=|>=|≤|≥)/.test(s)) return true;
  if (/^0[,，]?/.test(s)) return true;
  return false;
}

function cleanupFormulaLatex(value) {
  let s = (value || '').trim();
  if (!s) return '';
  s = s.replace(/[，；;]/g, ',');
  s = s.replace(/(^|,)\s*0\s*(,\s*)?(otherwise|else|other cases?)\b.*$/i, '');
  s = s.replace(/(^|,)\s*0\s*(,\s*)?(其余.*|其他.*|否则.*)$/i, '');
  s = s.replace(/[,;，；]\s*$/,'').trim();
  s = normalizeFormulaBody(s);
  if (s && !/^f\s*\(/i.test(s)) s = `f(x,y)=${s}`;
  return s;
}

function formulaExprToLatex(expr) {
  return expr ? `f(x,y)=${expr}` : '';
}

function cleanupSupport(value) {
  let s = (value || '').trim();
  if (!s) return '';
  s = s.replace(/[；;]/g, ',');
  s = s.replace(/，/g, ',');
  s = s.replace(/^support[:：]?/i, '');
  s = s.replace(/^定义域[:：]?/, '');
  s = s.replace(/^支持集[:：]?/, '');
  s = s.replace(/\\le/g, '<=').replace(/\\ge/g, '>=');
  s = s.replace(/≤/g, '<=').replace(/≥/g, '>=');
  s = s.replace(/\s+/g, '');
  s = s.replace(/[,;，；]\s*(0|0\.)\s*(otherwise|else|其他.*|其余.*)$/i, '');
  return s;
}

function cleanupRegion(value) {
  let s = (value || '').trim();
  if (!s) return '';
  s = s.replace(/[；;]/g, ',');
  s = s.replace(/，/g, ',');
  s = s.replace(/^D\s*=\s*/i, '');
  s = s.replace(/^region[:：]?/i, '');
  s = s.replace(/^积分区域[:：]?/, '');
  s = s.replace(/^区域[:：]?/, '');
  s = s.replace(/\\le/g, '<=').replace(/\\ge/g, '>=');
  s = s.replace(/≤/g, '<=').replace(/≥/g, '>=');
  return s.trim();
}

function cleanupSourceText(value) {
  let s = (value || '').trim();
  if (!s) return '';
  s = s.replace(/\s+/g, ' ');
  s = s.replace(/[；;]/g, ',');
  s = s.replace(/(^|,|;)\s*0\s*(,\s*)?(otherwise|else|other cases?|其余.*|其他.*|否则.*)$/i, '');
  s = s.replace(/(f\s*\(\s*x\s*,\s*y\s*\)\s*=.+?),\s*f\s*\(\s*x\s*,\s*y\s*\)\s*=.+$/i, '$1');
  s = s.replace(/[,;，；]\s*$/,'').trim();
  if (s.length > 120) s = s.slice(0, 120);
  return s;
}

function cleanupNotes(value) {
  let s = (value || '').trim();
  if (s.length > 80) s = s.slice(0, 80);
  return s;
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  };
}

function jsonResponse(statusCode, payload) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...corsHeaders()
    },
    body: JSON.stringify(payload)
  };
}
