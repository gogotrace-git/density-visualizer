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
      '1. formula_expr 只填写二维密度函数的“非零部分”表达式，不要带 f(x,y)=，不要带“0, otherwise / 其余为0 / 其他情况为0”。例如 exp(-y)、4.8*y*(2-x)、6*x^2*y。',
      '2. formula_latex 填对应的 LaTeX 形式，格式类似 f(x,y)=e^{-y}。同样只保留非零部分，不要带分段函数中为 0 的部分。',
      '3. support 只填写 formula_expr 非零部分对应的支持集/定义域，例如 0<x<y、0<=x<=1, 0<=y<=x。',
      '4. region 只填写图片中额外明确给出的积分区域 D。若图片中没有额外积分区域，就置为空字符串。不要把 support 误填到 region。',
      '5. source_text 用尽量简短的一行原始信息概括，可为空字符串。不要写长句解释。',
      '6. notes 只写极短备注，例如“图片模糊”“region 不清晰”；没有备注就置为空字符串。',
      '7. needs_review 只能是 true 或 false。看不清、有歧义时设为 true。',
      '8. 如果图片中给的是分段密度函数，例如 f(x,y)=e^{-y}, 0<x<y; 0, otherwise，那么你必须返回 formula_expr="exp(-y)"，support="0<x<y"。',
      '9. 不确定时宁可留空，不要猜测。',
      '返回格式示例：',
      '{"formula_expr":"exp(-y)","formula_latex":"f(x,y)=e^{-y}","support":"0<x<y","region":"","source_text":"f(x,y)=e^{-y}, 0<x<y","notes":"","needs_review":false}'
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
  try {
    return JSON.parse(text);
  } catch (_) {}
  const match = text.match(/\{[\s\S]*\}/);
  if (match) return JSON.parse(match[0]);
  throw new Error('Model output was not valid JSON.');
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

function cleanupFormulaExpr(value) {
  let s = (value || '').trim();
  if (!s) return '';
  s = s.replace(/^\s*f\s*[\(\[]\s*x\s*,\s*y\s*[\)\]]\s*=\s*/i, '');
  s = s.replace(/[，；;]/g, ',');
  s = s.replace(/\s+/g, ' ');
  s = s.replace(/(^|,)\s*(0|0\.)\s*(,\s*)?(otherwise|else|other cases?)\b.*$/i, '');
  s = s.replace(/(^|,)\s*(0|0\.)\s*(,\s*)?(其余.*|其他.*|否则.*)$/i, '');
  s = s.replace(/,\s*0\s*$/i, '');
  s = s.replace(/\botherwise\b.*$/i, '');
  s = s.replace(/\belse\b.*$/i, '');
  s = s.replace(/其余情况为?0.*$/i, '');
  s = s.replace(/其他情况为?0.*$/i, '');
  s = s.replace(/其余为?0.*$/i, '');
  s = s.replace(/其他为?0.*$/i, '');
  s = s.replace(/[,;，；]\s*$/,'').trim();
  return s;
}

function cleanupFormulaLatex(value) {
  let s = (value || '').trim();
  if (!s) return '';
  s = s.replace(/[，；;]/g, ',');
  s = s.replace(/(^|,)\s*0\s*(,\s*)?(otherwise|else|other cases?)\b.*$/i, '');
  s = s.replace(/(^|,)\s*0\s*(,\s*)?(其余.*|其他.*|否则.*)$/i, '');
  s = s.replace(/[,;，；]\s*$/,'').trim();
  if (s && !/^f\s*\(/i.test(s)) s = `f(x,y)=${s}`;
  return s;
}

function formulaExprToLatex(expr) {
  return expr ? `f(x,y)=${expr}` : '';
}

function cleanupSupport(value) {
  return (value || '').replace(/[；;]/g, ',').trim();
}

function cleanupRegion(value) {
  return (value || '').replace(/[；;]/g, ',').trim();
}

function cleanupSourceText(value) {
  let s = (value || '').trim();
  if (!s) return '';
  s = s.replace(/\s+/g, ' ');
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
