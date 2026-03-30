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

    const imageFile = dataUrlToFile(imageDataUrl);
    const uploadedFile = await uploadToArkFiles(apiKey, imageFile);
    const fileId = uploadedFile?.id;
    if (!fileId) {
      return jsonResponse(502, {
        error: '上传图片到 Ark Files API 失败，未拿到 file_id。',
        details: uploadedFile || undefined
      });
    }

    const prompt = [
      '你是一个数学可视化网页的识别助手。',
      '请从图片中提取与二维概率密度函数可视化直接相关的信息。',
      '只输出 JSON，不要输出解释，不要使用 markdown 代码块。',
      'JSON 键固定为：formula_raw, support, region, source_text, notes。',
      '要求：',
      '1. formula_raw 填二维密度函数，尽量写成便于前端解析的形式，例如 4.8*y*(2-x) 或 f(x,y)=4.8*y*(2-x)。',
      '2. support 只填支持集/定义域，例如 0<=x<=1, 0<=y<=x。',
      '3. region 只填额外给出的积分区域 D；如果图片里没有明确给出，就置为空字符串。',
      '4. source_text 尽量用一行概括图中与函数相关的原始文字。',
      '5. 不能确定时宁可留空，不要猜。',
      '6. 如果图片中是分段表达，请把“其他为0”之类的信息体现在 notes 中，而不是 support 中。'
    ].join('\n');

    const arkResponse = await fetch('https://ark.cn-beijing.volces.com/api/v3/responses', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model,
        text: { format: { type: 'json_object' } },
        input: [
          {
            role: 'user',
            content: [
              { type: 'input_image', file_id: fileId },
              { type: 'input_text', text: prompt }
            ]
          }
        ]
      })
    });

    const arkRawText = await arkResponse.text();
    const arkJson = tryParseJson(arkRawText);
    if (!arkResponse.ok) {
      return jsonResponse(arkResponse.status, {
        error: extractArkError(arkJson) || summarizeNonJsonError(arkRawText) || 'ARK request failed.',
        details: arkJson || undefined,
        raw_preview: previewText(arkRawText),
        file_id: fileId
      });
    }
    if (!arkJson) {
      return jsonResponse(502, {
        error: 'ARK returned a non-JSON response.',
        raw_preview: previewText(arkRawText),
        file_id: fileId
      });
    }

    const rawText = extractOutputText(arkJson);
    const parsed = parseModelJson(rawText);
    return jsonResponse(200, {
      formula_raw: ensureString(parsed.formula_raw),
      support: ensureString(parsed.support),
      region: ensureString(parsed.region),
      source_text: ensureString(parsed.source_text),
      notes: ensureString(parsed.notes),
      raw_model_text: rawText,
      file_id: fileId
    });
  } catch (error) {
    return jsonResponse(500, { error: error.message || 'Unexpected server error.' });
  }
};

async function uploadToArkFiles(apiKey, imageFile) {
  const form = new FormData();
  form.append('purpose', 'user_data');
  form.append('file', new Blob([imageFile.buffer], { type: imageFile.mimeType }), imageFile.filename);

  const response = await fetch('https://ark.cn-beijing.volces.com/api/v3/files', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`
    },
    body: form
  });

  const raw = await response.text();
  const json = tryParseJson(raw);
  if (!response.ok) {
    const msg = extractArkError(json) || summarizeNonJsonError(raw) || `Files API request failed (${response.status}).`;
    throw new Error(`${msg} ${previewText(raw)}`.trim());
  }
  if (!json) {
    throw new Error(`Files API 返回了非 JSON 内容：${previewText(raw)}`);
  }
  return json;
}

function dataUrlToFile(dataUrl) {
  const match = /^data:([^;]+);base64,(.+)$/s.exec(dataUrl || '');
  if (!match) {
    throw new Error('Unsupported image data format.');
  }
  const mimeType = match[1].trim().toLowerCase();
  const base64 = match[2].trim();
  const buffer = Buffer.from(base64, 'base64');
  const ext = mimeToExt(mimeType);
  return {
    mimeType,
    buffer,
    filename: `upload.${ext}`
  };
}

function mimeToExt(mimeType) {
  if (mimeType === 'image/png') return 'png';
  if (mimeType === 'image/jpeg') return 'jpg';
  if (mimeType === 'image/webp') return 'webp';
  if (mimeType === 'image/gif') return 'gif';
  return 'bin';
}

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

function tryParseJson(text) {
  if (!text || typeof text !== 'string') return null;
  try {
    return JSON.parse(text);
  } catch (_) {
    return null;
  }
}

function previewText(text) {
  return typeof text === 'string' ? text.replace(/\s+/g, ' ').slice(0, 240) : '';
}

function summarizeNonJsonError(text) {
  const preview = previewText(text);
  if (!preview) return '';
  if (preview.startsWith('<?xml')) return '上游服务返回了 XML 错误页，请检查文件上传方式、图片格式、图片大小或模型/接口配置。';
  if (preview.startsWith('<!DOCTYPE') || preview.startsWith('<html')) return '上游服务返回了 HTML 错误页，请检查接口路径、鉴权或部署配置。';
  return '';
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

function ensureString(value) {
  return typeof value === 'string' ? value.trim() : '';
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
