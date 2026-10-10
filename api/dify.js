/**
 * Vercel Serverless Function（Edge Runtime）
 * 对应本地开发用的 server.py —— 同一个接口约定，一套前端代码两边都能跑。
 *
 *   GET  /api/dify?action=parameters
 *   GET  /api/dify?action=conversations&user=xxx&limit=20
 *   GET  /api/dify?action=messages&conversationId=xxx&user=xxx
 *   POST /api/dify?action=chat       { query, conversationId, inputs, user }
 *   POST /api/dify?action=feedback   { messageId, rating, user }
 *
 * 部署到 Vercel：
 *   1. 把整个文件夹推到 Git 仓库，在 Vercel 里 Import
 *   2. Settings → Environment Variables 添加 DIFY_API_KEY
 *      （可选）DIFY_API_BASE = https://api.dify.ai/v1
 *   3. 重新部署
 *   Vercel 会自动把 api/dify.js 映射成 /api/dify，和前端写死的路径一致。
 *
 * ⚠ API Key 只在这里读取，绝不能出现在前端代码里。
 */

export const config = { runtime: 'edge' };

const API_BASE = (process.env.DIFY_API_BASE || 'https://api.dify.ai/v1').replace(/\/+$/, '');

// Dify 前面挂着 Cloudflare，会拦掉看起来像脚本的 User-Agent
// （实测 Python-urllib 被 403），这里统一带浏览器 UA。**不要删。**
const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function cors() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  };
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...cors() },
  });
}

function difyHeaders(apiKey, extra = {}) {
  return {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
    'User-Agent': BROWSER_UA,
    ...extra,
  };
}

/**
 * 把 Dify / 网关的错误整理成一句人话。
 * - 网关拦截时返回一整页 HTML（Cloudflare），别原样丢给前端
 * - Dify 的正常错误是 {"code":"...","message":"..."}，把 message 抽出来
 */
function readableError(status, raw) {
  const text = String(raw || '').trim();
  if (!text) return `Dify 返回了空响应（HTTP ${status}）`;
  if (text.startsWith('<')) {
    return `网关返回了非 JSON 响应（HTTP ${status}，疑似被 Cloudflare 拦截）`;
  }

  try {
    const data = JSON.parse(text);
    if (data && typeof data === 'object') {
      const code = data.code || '';
      // 额度用尽是高频错误，单独给一句可执行的提示
      if (code === 'provider_quota_exceeded') {
        return (
          '模型额度已用尽 —— 该 Dify 应用托管模型的免费额度已耗尽。' +
          '请到 Dify 后台 → 设置 → 模型供应商，配置你自己的 API Key，或升级套餐后重试。'
        );
      }
      const message = data.message || data.error || '';
      if (message) return code ? `${message}（${code}）` : message;
    }
  } catch {
    /* 不是 JSON，按纯文本处理 */
  }

  return text.slice(0, 300);
}

export default async function handler(request) {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: cors() });
  }

  const url = new URL(request.url);
  if (url.pathname.replace(/\/+$/, '') !== '/api/dify') {
    return json({ error: 'Not Found' }, 404);
  }

  const apiKey = (process.env.DIFY_API_KEY || '').trim();
  if (!apiKey) {
    return json({ error: '服务端没有配置 DIFY_API_KEY 环境变量' }, 500);
  }

  const action = url.searchParams.get('action') || '';

  /* ------------------------------ 只读接口 ------------------------------ */
  if (request.method === 'GET') {
    let endpoint = '';
    let params = {};

    if (action === 'parameters') {
      endpoint = '/parameters';
    } else if (action === 'conversations') {
      endpoint = '/conversations';
      params = { user: url.searchParams.get('user') || '', limit: url.searchParams.get('limit') || '20' };
    } else if (action === 'messages') {
      const conversationId = url.searchParams.get('conversationId') || '';
      if (!conversationId) return json({ error: '缺少 conversationId' }, 400);
      endpoint = '/messages';
      params = {
        conversation_id: conversationId,
        user: url.searchParams.get('user') || '',
        limit: url.searchParams.get('limit') || '50',
      };
    } else {
      return json({ error: `未知的 action：${action}` }, 404);
    }

    const target = new URL(API_BASE + endpoint);
    Object.entries(params).forEach(([key, value]) => target.searchParams.set(key, value));

    let upstream;
    try {
      upstream = await fetch(target, { headers: difyHeaders(apiKey) });
    } catch (error) {
      return json({ error: `连接 Dify 失败：${error.message}` }, 502);
    }

    const text = await upstream.text();
    if (!upstream.ok) {
      let message = `Dify 返回错误 ${upstream.status}`;
      try {
        const parsed = JSON.parse(text);
        message = parsed.message || parsed.error || message;
      } catch {
        message = readableError(upstream.status, text);
      }
      return json({ error: message }, upstream.status);
    }

    return new Response(text, {
      headers: { 'Content-Type': 'application/json; charset=utf-8', ...cors() },
    });
  }

  if (request.method !== 'POST') {
    return json({ error: '不支持的请求方法' }, 405);
  }

  /* ------------------------------ 写入接口 ------------------------------ */
  let payload;
  try {
    payload = await request.json();
  } catch {
    return json({ error: '请求体不是合法 JSON' }, 400);
  }

  if (action === 'feedback') {
    const messageId = String(payload.messageId || '').trim();
    if (!messageId) return json({ error: '缺少 messageId' }, 400);

    let upstream;
    try {
      upstream = await fetch(`${API_BASE}/messages/${encodeURIComponent(messageId)}/feedbacks`, {
        method: 'POST',
        headers: difyHeaders(apiKey),
        body: JSON.stringify({ rating: payload.rating, user: payload.user || 'web-visitor' }),
      });
    } catch (error) {
      return json({ error: `连接 Dify 失败：${error.message}` }, 502);
    }

    const text = await upstream.text();
    if (!upstream.ok) return json({ error: readableError(upstream.status, text) }, upstream.status);
    return new Response(text || '{}', {
      headers: { 'Content-Type': 'application/json; charset=utf-8', ...cors() },
    });
  }

  if (action !== 'chat') {
    return json({ error: `未知的 action：${action}` }, 404);
  }

  const query = String(payload.query || '').trim();
  if (!query) return json({ error: 'query 不能为空' }, 400);

  const body = {
    inputs: payload.inputs || {},
    query,
    response_mode: 'streaming',
    user: payload.user || 'web-visitor',
  };
  if (payload.conversationId) body.conversation_id = payload.conversationId;

  let upstream;
  try {
    upstream = await fetch(`${API_BASE}/chat-messages`, {
      method: 'POST',
      headers: difyHeaders(apiKey, { Accept: 'text/event-stream' }),
      body: JSON.stringify(body),
    });
  } catch (error) {
    return json({ error: `连接 Dify 失败：${error.message}` }, 502);
  }

  if (!upstream.ok) {
    return json({ error: readableError(upstream.status, await upstream.text()) }, upstream.status);
  }

  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  let conversationId = '';
  let messageId = '';
  let buffer = '';

  const stream = new ReadableStream({
    async start(controller) {
      const send = (obj) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));

      try {
        const reader = upstream.body.getReader();

        outer: for (;;) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith('data:')) continue;

            const data = trimmed.slice(5).trim();
            if (!data || data === '[DONE]') continue;

            let event;
            try {
              event = JSON.parse(data);
            } catch {
              continue;
            }

            if (event.conversation_id) conversationId = event.conversation_id;
            if (event.message_id) messageId = event.message_id;
            else if (event.id && !messageId) messageId = event.id;

            if (event.event === 'message' || event.event === 'agent_message') {
              if (event.answer) send({ delta: event.answer });
            } else if (event.event === 'message_end') {
              break outer;
            } else if (event.event === 'error') {
              send({ error: event.message || 'Dify 返回了未知错误' });
              break outer;
            }
          }
        }
      } catch (error) {
        send({ error: `读取响应流中断：${error.message}` });
      } finally {
        send({ done: true, conversationId, messageId });
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store, no-transform',
      'X-Accel-Buffering': 'no',
      ...cors(),
    },
  });
}
