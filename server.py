#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
本地开发服务器

1. 提供静态文件访问（等同 python3 -m http.server）
2. 代理 Dify 的接口，统一挂在 /api/dify 下，用 action 参数区分：

     GET  /api/dify?action=parameters
     GET  /api/dify?action=conversations&user=xxx&limit=20
     GET  /api/dify?action=messages&conversationId=xxx&user=xxx
     POST /api/dify?action=chat       { query, conversationId, inputs, user }
     POST /api/dify?action=feedback   { messageId, rating, user }

为什么需要这层代理？
  Dify 官方明确要求 API Key 只能放在服务端。写进前端 JS 的话，
  任何人打开浏览器控制台都能拿走它、烧你的额度。

用法：
  cd "/Users/younghs/Desktop/个人网站"
  python3 server.py
  然后打开 http://localhost:8899

只用 Python 标准库，不需要 pip 安装任何东西。
"""

import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.abspath(__file__))
PORT = int(os.environ.get('PORT', '8899'))


def load_env():
    """按顺序读取 .env.local / .env；已存在的真实环境变量优先。"""
    for name in ('.env.local', '.env'):
        path = os.path.join(ROOT, name)
        if not os.path.isfile(path):
            continue
        with open(path, encoding='utf-8') as handle:
            for raw in handle:
                line = raw.strip()
                if not line or line.startswith('#') or '=' not in line:
                    continue
                key, value = line.split('=', 1)
                os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


load_env()

DIFY_API_KEY = os.environ.get('DIFY_API_KEY', '').strip()
DIFY_API_BASE = os.environ.get('DIFY_API_BASE', 'https://api.dify.ai/v1').rstrip('/')

# Dify 前面挂着 Cloudflare，它会直接拦掉 Python 默认的 User-Agent
# （实测 Python-urllib/3.9 返回 403，换成浏览器 UA 就是 200），
# 所以这里伪装成普通浏览器。**不要删掉。**
BROWSER_UA = (
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) '
    'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
)


def dify_headers():
    return {
        'Authorization': 'Bearer ' + DIFY_API_KEY,
        'Content-Type': 'application/json',
        'User-Agent': BROWSER_UA,
    }


def humanize_gateway_error(code, raw):
    """
    把 Dify / 网关的错误整理成一句人话。

    - 网关拦截时返回的是一整页 HTML（Cloudflare），直接丢给前端很难看
    - Dify 的正常错误是 JSON，形如 {"code":"...","message":"..."}，
      直接整段丢给前端也会挤爆气泡，所以把 message 抽出来
    """
    text = (raw or '').strip()
    if not text:
        return 'Dify 返回了空响应（HTTP %d）' % code

    if text.startswith('<'):
        return '网关返回了非 JSON 响应（HTTP %d，疑似被 Cloudflare 拦截）' % code

    try:
        data = json.loads(text)
    except Exception:
        return text[:300]

    if isinstance(data, dict):
        message = data.get('message') or data.get('error') or ''
        err_code = data.get('code') or ''
        # 额度用尽是高频错误，单独给一句可执行的提示
        if err_code == 'provider_quota_exceeded':
            return (
                '模型额度已用尽 —— 该 Dify 应用托管模型的免费额度已耗尽。'
                '请到 Dify 后台 → 设置 → 模型供应商，配置你自己的 API Key，'
                '或升级套餐后重试。'
            )
        if message:
            return '%s（%s）' % (message, err_code) if err_code else message
    return text[:300]


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    # ---------------------------------------------------------------- 基础
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')  # 开发期不缓存
        super().end_headers()

    def log_message(self, fmt, *args):
        message = fmt % args
        if '/api/' in message or ' 4' in message or ' 5' in message:
            sys.stderr.write('  %s\n' % message)

    def _cors(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')

    def do_OPTIONS(self):  # noqa: N802
        self.send_response(204)
        self._cors()
        self.end_headers()

    # --------------------------------------------------------------- 路由
    def _route(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path.rstrip('/') != '/api/dify':
            return None, {}
        query = urllib.parse.parse_qs(parsed.query)
        params = {k: v[0] for k, v in query.items() if v}
        return params.get('action', ''), params

    # ------------------------------------------------------ 只读接口（GET）
    def do_GET(self):  # noqa: N802
        action, params = self._route()
        if action is None:
            return super().do_GET()

        if not DIFY_API_KEY:
            self._json(500, {'error': '服务端没有配置 DIFY_API_KEY，请复制 .env.example 为 .env.local 并填入密钥'})
            return

        if action == 'parameters':
            return self._proxy_get('/parameters', {})

        if action == 'conversations':
            return self._proxy_get('/conversations', {
                'user': params.get('user', ''),
                'limit': params.get('limit', '20'),
            })

        if action == 'messages':
            conversation_id = params.get('conversationId', '')
            if not conversation_id:
                return self._json(400, {'error': '缺少 conversationId'})
            return self._proxy_get('/messages', {
                'conversation_id': conversation_id,
                'user': params.get('user', ''),
                'limit': params.get('limit', '50'),
            })

        return self._json(404, {'error': '未知的 action：%s' % action})

    def _proxy_get(self, path, params):
        """转发一个 GET 请求到 Dify，原样返回 JSON。"""
        url = DIFY_API_BASE + path
        if params:
            url += '?' + urllib.parse.urlencode(params)

        request = urllib.request.Request(url, headers=dify_headers(), method='GET')
        try:
            with urllib.request.urlopen(request, timeout=30) as upstream:
                payload = upstream.read().decode('utf-8', 'replace')
        except urllib.error.HTTPError as err:
            raw = err.read().decode('utf-8', 'replace')
            return self._json(err.code, {'error': humanize_gateway_error(err.code, raw)})
        except Exception as err:
            return self._json(502, {'error': '连接 Dify 失败：%s' % err})

        self.send_response(200)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self._cors()
        self.end_headers()
        self.wfile.write(payload.encode('utf-8'))

    # ------------------------------------------------------ 写入接口（POST）
    def do_POST(self):  # noqa: N802
        action, _params = self._route()
        if action is None:
            self.send_error(404, 'Not Found')
            return

        if not DIFY_API_KEY:
            self._json(500, {'error': '服务端没有配置 DIFY_API_KEY，请复制 .env.example 为 .env.local 并填入密钥'})
            return

        try:
            length = int(self.headers.get('Content-Length') or 0)
            payload = json.loads(self.rfile.read(length) or b'{}')
        except Exception:
            self._json(400, {'error': '请求体不是合法 JSON'})
            return

        if action == 'chat':
            return self._chat(payload)
        if action == 'feedback':
            return self._feedback(payload)

        return self._json(404, {'error': '未知的 action：%s' % action})

    def _chat(self, payload):
        """对话：转发为流式请求，边收边用 SSE 推给前端。"""
        query = (payload.get('query') or '').strip()
        if not query:
            return self._json(400, {'error': 'query 不能为空'})

        body = {
            'inputs': payload.get('inputs') or {},
            'query': query,
            'response_mode': 'streaming',
            'user': payload.get('user') or 'web-visitor',
        }
        if payload.get('conversationId'):
            body['conversation_id'] = payload['conversationId']

        request = urllib.request.Request(
            DIFY_API_BASE + '/chat-messages',
            data=json.dumps(body).encode('utf-8'),
            headers=dict(dify_headers(), Accept='text/event-stream'),
            method='POST',
        )

        try:
            upstream = urllib.request.urlopen(request, timeout=180)
        except urllib.error.HTTPError as err:
            raw = err.read().decode('utf-8', 'replace')
            return self._json(err.code, {'error': humanize_gateway_error(err.code, raw)})
        except Exception as err:
            return self._json(502, {'error': '连接 Dify 失败：%s' % err})

        self.send_response(200)
        self.send_header('Content-Type', 'text/event-stream; charset=utf-8')
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Accel-Buffering', 'no')
        self._cors()
        self.end_headers()

        conversation_id = ''
        message_id = ''
        try:
            for raw in upstream:
                line = raw.decode('utf-8', 'replace').strip()
                if not line.startswith('data:'):
                    continue
                data = line[5:].strip()
                if not data or data == '[DONE]':
                    continue
                try:
                    event = json.loads(data)
                except Exception:
                    continue

                if event.get('conversation_id'):
                    conversation_id = event['conversation_id']
                if event.get('message_id'):
                    message_id = event['message_id']
                elif event.get('id') and not message_id:
                    message_id = event['id']

                name = event.get('event')
                if name in ('message', 'agent_message'):
                    chunk = event.get('answer') or ''
                    if chunk:
                        self._sse({'delta': chunk})
                elif name == 'message_end':
                    break
                elif name == 'error':
                    self._sse({'error': event.get('message') or 'Dify 返回了未知错误'})
                    break
        except Exception as err:
            self._sse({'error': '读取响应流中断：%s' % err})
        finally:
            self._sse({'done': True, 'conversationId': conversation_id, 'messageId': message_id})
            try:
                upstream.close()
            except Exception:
                pass

    def _feedback(self, payload):
        """点赞 / 点踩。rating 传 like / dislike / null（= 取消）。"""
        message_id = (payload.get('messageId') or '').strip()
        if not message_id:
            return self._json(400, {'error': '缺少 messageId'})

        body = {
            'rating': payload.get('rating'),
            'user': payload.get('user') or 'web-visitor',
        }
        request = urllib.request.Request(
            DIFY_API_BASE + '/messages/' + urllib.parse.quote(message_id) + '/feedbacks',
            data=json.dumps(body).encode('utf-8'),
            headers=dify_headers(),
            method='POST',
        )
        try:
            with urllib.request.urlopen(request, timeout=30) as upstream:
                text = upstream.read().decode('utf-8', 'replace')
        except urllib.error.HTTPError as err:
            raw = err.read().decode('utf-8', 'replace')
            return self._json(err.code, {'error': humanize_gateway_error(err.code, raw)})
        except Exception as err:
            return self._json(502, {'error': '连接 Dify 失败：%s' % err})

        self.send_response(200)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self._cors()
        self.end_headers()
        self.wfile.write((text or '{}').encode('utf-8'))

    # ------------------------------------------------------------- 工具方法
    def _sse(self, obj):
        payload = ('data: ' + json.dumps(obj, ensure_ascii=False) + '\n\n').encode('utf-8')
        try:
            self.wfile.write(payload)
            self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            raise  # 用户关掉了页面，正常现象

    def _json(self, code, obj):
        payload = json.dumps(obj, ensure_ascii=False).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(payload)))
        self._cors()
        self.end_headers()
        try:
            self.wfile.write(payload)
        except (BrokenPipeError, ConnectionResetError):
            pass


def main():
    server = ThreadingHTTPServer(('', PORT), Handler)

    print('')
    print('  ┌──────────────────────────────────────────────┐')
    print('  │  小王.EXE  本地开发服务器                    │')
    print('  └──────────────────────────────────────────────┘')
    print('')
    print('    地址:  http://localhost:%d' % PORT)
    if DIFY_API_KEY:
        print('    密钥:  已从 .env.local 读取 ✓')
    else:
        print('    密钥:  ✗ 未配置 —— 聊天会报错')
        print('           请复制 .env.example 为 .env.local 并填入 DIFY_API_KEY')
    print('')
    print('    接口:  GET  /api/dify?action=parameters | conversations | messages')
    print('           POST /api/dify?action=chat | feedback')
    print('')
    print('    Ctrl+C 停止')
    print('')

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print('\n  已停止\n')
    finally:
        server.server_close()


if __name__ == '__main__':
    main()
