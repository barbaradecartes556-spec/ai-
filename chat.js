/* ==========================================================================
   像素风 AI 聊天挂件
   —— 自建前端，通过 /api/dify 调用 Dify 的接口

   为什么不用 Dify 的官方嵌入？
     官方嵌入是一个跨域 iframe：内部样式改不了，而且带有「POWERED BY Dify」品牌标识。
     自己写前端 + 调 API 是 Dify 许可里明确允许的方式
     （许可是针对「使用其前端」的限制，不使用其前端则不受限），
     这样界面风格可以和整站完全统一，也没有任何第三方标识。

   功能与官方 WebApp 对齐，且内容都来自 Dify 后台配置：
     · 新对话设置（role 下拉）   ← GET  /parameters  → user_input_form
     · 开场白 / 推荐问题         ← GET  /parameters  → opening_statement / suggested_questions
     · 历史对话列表              ← GET  /conversations
     · 点击历史回看消息          ← GET  /messages
     · 点赞 / 点踩               ← POST /feedback
     · 全屏、新对话

   安全提醒：
     API Key 由服务端（server.py / api/dify.js）持有，
     这个文件里不会出现任何密钥，请不要把 Key 加进来。
   ========================================================================== */
(function () {
  'use strict';

  /* ---------------------------------------------------------------------
     常量
     --------------------------------------------------------------------- */

  const API = '/api/dify';

  // 拿不到 Dify 配置时的兜底文案（正常情况下用 /parameters 返回的内容）
  const FALLBACK_GREETING = '你好！我是小王的 AI 分身 🤖\n想聊 AI 产品、想看项目经历，随便问。';

  const STORE_CONVERSATION = 'chatw.conversationId';
  const STORE_USER = 'chatw.userId';
  const STORE_INPUTS = 'chatw.inputs';
  const STORE_FULL = 'chatw.fullscreen';

  const el = {};
  const state = {
    open: false,
    streaming: false,
    view: 'chat',        // 'chat' | 'history'
    full: false,
    conversationId: '',
    messageId: '',       // 当前这条回答的 id，用于点赞点踩
    inputs: {},          // { role: '孙悟空' }
    fields: [],          // /parameters 的 user_input_form
    parameters: null,
    conversations: [],
    hasSent: false,      // 用户是否已经发过消息（用于判断能否重刷开场白）
  };

  /* ---------------------------------------------------------------------
     小工具
     --------------------------------------------------------------------- */

  function playSfx(name, vol) {
    try {
      if (window.PixelSite && typeof window.PixelSite.sfx === 'function') {
        window.PixelSite.sfx(name, vol);
      }
    } catch (err) {
      /* 音效失败不影响功能 */
    }
  }

  function store(key, value) {
    try {
      window.sessionStorage.setItem(key, value);
    } catch (err) {
      /* 隐私模式下可能被禁用 */
    }
  }

  function read(key) {
    try {
      return window.sessionStorage.getItem(key) || '';
    } catch (err) {
      return '';
    }
  }

  function storeLocal(key, value) {
    try {
      window.localStorage.setItem(key, value);
    } catch (err) {
      /* ignore */
    }
  }

  function readLocal(key) {
    try {
      return window.localStorage.getItem(key) || '';
    } catch (err) {
      return '';
    }
  }

  /** 给 Dify 用的稳定访客标识，让同一个人的多轮对话和历史记录能串起来 */
  function getUserId() {
    let id = readLocal(STORE_USER);
    if (id) return id;

    id = 'web-' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
    storeLocal(STORE_USER, id);
    return id;
  }

  function apiError(status, data) {
    const fallback = 'HTTP ' + status;
    if (data && typeof data === 'object') return data.error || data.message || fallback;
    return fallback;
  }

  function formatTime(seconds) {
    if (!seconds) return '';
    const date = new Date(seconds * 1000);
    const pad = (n) => String(n).padStart(2, '0');
    return (
      date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate()) +
      ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes())
    );
  }

  function scrollToEnd() {
    if (el.log) el.log.scrollTop = el.log.scrollHeight;
  }

  /* ---------------------------------------------------------------------
     消息渲染
     --------------------------------------------------------------------- */

  /**
   * 追加一条消息。
   * 一律用 textContent 写入，模型返回的内容当纯文本处理，避免注入风险。
   */
  function addMessage(role, text, options) {
    const opts = options || {};

    const wrap = document.createElement('div');
    wrap.className = 'chatw__msg chatw__msg--' + role;

    const bubble = document.createElement('div');
    bubble.className = 'chatw__bubble';

    const span = document.createElement('span');
    span.className = 'chatw__text';
    span.textContent = text || '';
    bubble.appendChild(span);

    wrap.appendChild(bubble);
    el.log.appendChild(wrap);
    if (!opts.noScroll) scrollToEnd();

    return { wrap, bubble, span };
  }

  function addCaret(bubble) {
    const caret = document.createElement('span');
    caret.className = 'chatw__caret';
    caret.textContent = '▮';
    bubble.appendChild(caret);
    return caret;
  }

  function addSysNote(text) {
    const note = document.createElement('p');
    note.className = 'chatw__sys';
    note.textContent = text;
    el.log.appendChild(note);
    scrollToEnd();
  }

  /** 给一条机器人消息挂上 点赞/点踩 */
  function attachActions(msg, messageId, current) {
    if (!messageId) return;

    const acts = document.createElement('div');
    acts.className = 'chatw__acts';

    const make = (rating, label, title) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'chatw__act';
      btn.dataset.rating = rating;
      btn.textContent = label;
      btn.title = title;
      btn.addEventListener('click', () => sendFeedback(btn, messageId, rating, acts));
      return btn;
    };

    acts.appendChild(make('like', '👍', '有帮助'));
    acts.appendChild(make('dislike', '👎', '没帮助'));
    msg.wrap.appendChild(acts);

    if (current === 'like' || current === 'dislike') {
      const on = acts.querySelector('[data-rating="' + current + '"]');
      if (on) on.classList.add('is-on');
    }
  }

  async function sendFeedback(btn, messageId, rating, acts) {
    const already = btn.classList.contains('is-on');
    // 再点一次 = 取消评价
    const next = already ? null : rating;

    try {
      const response = await fetch(API + '?action=feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messageId, rating: next, user: getUserId() }),
      });
      if (!response.ok) throw new Error('HTTP ' + response.status);

      acts.querySelectorAll('.chatw__act').forEach((b) => b.classList.remove('is-on'));
      if (next) btn.classList.add('is-on');
      playSfx(next ? 'coin' : 'click', 0.7);
    } catch (err) {
      playSfx('error');
    }
  }

  /* ---------------------------------------------------------------------
     新对话设置（role 下拉等）
     --------------------------------------------------------------------- */

  /** 按 /parameters 的 user_input_form 动态渲染表单控件 */
  function renderFields() {
    el.fields.textContent = '';

    if (!state.fields.length) {
      el.setup.hidden = true;
      return;
    }
    el.setup.hidden = false;

    state.fields.forEach((item) => {
      const type = Object.keys(item)[0];
      const spec = item[type];
      if (!spec || !spec.variable) return;

      const row = document.createElement('div');
      row.className = 'chatw__field';

      const label = document.createElement('label');
      label.className = 'chatw__field-label';
      label.textContent = spec.label || spec.variable;
      label.title = spec.variable;
      row.appendChild(label);

      const current = state.inputs[spec.variable] != null ? state.inputs[spec.variable] : (spec.default || '');

      if (type === 'select') {
        const select = document.createElement('select');
        select.className = 'chatw__select';
        select.setAttribute('aria-label', spec.label || spec.variable);

        const blank = document.createElement('option');
        blank.value = '';
        blank.textContent = spec.required ? '请选择…' : '不指定';
        select.appendChild(blank);

        (spec.options || []).forEach((opt) => {
          const option = document.createElement('option');
          option.value = opt;
          option.textContent = opt;
          select.appendChild(option);
        });

        select.value = current;
        select.addEventListener('change', () => onFieldChange(spec.variable, select.value));
        row.appendChild(select);
      } else if (type === 'paragraph') {
        const area = document.createElement('textarea');
        area.className = 'chatw__field-input';
        area.rows = 2;
        area.value = current;
        area.placeholder = spec.label || '';
        area.setAttribute('aria-label', spec.label || spec.variable);
        area.addEventListener('change', () => onFieldChange(spec.variable, area.value));
        row.appendChild(area);
      } else {
        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'chatw__field-input';
        input.value = current;
        input.maxLength = spec.max_length || 256;
        input.placeholder = spec.label || '';
        input.setAttribute('aria-label', spec.label || spec.variable);
        input.addEventListener('change', () => onFieldChange(spec.variable, input.value));
        row.appendChild(input);
      }

      el.fields.appendChild(row);
    });
  }

  /**
   * 改动输入项后必须开一段新对话 ——
   * Dify 的 inputs 只在「会话的第一条消息」时生效，
   * 沿用旧 conversation_id 的话新设置不会起作用，这点和官方 WebApp 行为一致。
   */
  function onFieldChange(variable, value) {
    const changed = (state.inputs[variable] || '') !== (value || '');
    state.inputs[variable] = value;
    store(STORE_INPUTS, JSON.stringify(state.inputs));

    if (!changed) return;

    if (state.conversationId) {
      startNewConversation({ silent: true });
      addSysNote('已按「' + variable + ' = ' + (value || '不指定') + '」开启新对话');
      playSfx('jump');
    }
  }

  function loadParameters() {
    return fetch(API + '?action=parameters')
      .then((res) => {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      })
      .then((data) => {
        state.parameters = data;
        state.fields = Array.isArray(data.user_input_form) ? data.user_input_form : [];
        renderFields();
        refreshGreeting();
      })
      .catch(() => {
        // 拿不到配置不影响聊天，只是设置栏和推荐问题不显示
        state.parameters = null;
        state.fields = [];
        renderFields();
      });
  }

  /**
   * 配置是异步拉回来的，可能晚于用户打开面板。
   * 如果用户还没说过话，就用真正的开场白/推荐问题重刷一次，免得多显示一条兜底文案。
   */
  function refreshGreeting() {
    if (!state.open || state.hasSent || state.conversationId) return;
    if (state.view !== 'chat') return;
    clearLog();
    greet();
  }

  /* ---------------------------------------------------------------------
     开场白与推荐问题
     --------------------------------------------------------------------- */

  function renderSuggestions(questions) {
    const list = (questions || []).filter(Boolean);
    if (!list.length) return;

    const box = document.createElement('div');
    box.className = 'chatw__suggest';

    list.forEach((text) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'chatw__chip';
      btn.textContent = text;
      btn.addEventListener('click', () => {
        box.remove();
        send(text);
      });
      box.appendChild(btn);
    });

    el.log.appendChild(box);
    scrollToEnd();
  }

  /** 开场白用 Dify 配置的内容；没有配置才用兜底文案 */
  function greet() {
    if (location.protocol === 'file:') {
      addMessage('bot', FALLBACK_GREETING);
      showSetupHelp('file');
      return;
    }

    const params = state.parameters;
    const opening = params && params.opening_statement ? String(params.opening_statement).trim() : '';

    addMessage('bot', opening || FALLBACK_GREETING);

    if (params && Array.isArray(params.suggested_questions)) {
      renderSuggestions(params.suggested_questions);
    }
  }

  /* ---------------------------------------------------------------------
     报错提示
     --------------------------------------------------------------------- */

  /**
   * 把「跑不起来」的原因翻译成人话 + 下一步该做什么。
   * 直接抛 "Load failed" 之类的原始错误，用户完全不知道该干嘛。
   */
  function showSetupHelp(kind) {
    const MAP = {
      file: [
        '⚠ 你现在的打开方式是「直接双击文件」（地址栏是 file:// 开头）',
        '这种模式下没有 /api/dify 接口，聊天没法工作。',
        '请改用本地服务器：在项目目录执行',
        '    python3 server.py',
        '然后打开  http://localhost:8899',
      ],
      nokey: [
        '⚠ 聊天服务还没配置好（服务端缺少密钥）',
        '把 .env.example 复制成 .env.local，填入 DIFY_API_KEY，',
        '然后重启服务器：python3 server.py',
      ],
      noapi: [
        '⚠ 没找到 /api/dify 接口（HTTP 404）',
        '请用  python3 server.py  启动，',
        '而不是  python3 -m http.server —— 后者只是静态服务器，没有代理接口。',
      ],
    };
    (MAP[kind] || ['⚠ ' + kind]).forEach(addSysNote);
  }

  function isSetupError(message) {
    return /DIFY_API_KEY|未配置/.test(message || '');
  }

  /* ---------------------------------------------------------------------
     发送与流式接收
     --------------------------------------------------------------------- */

  async function send(text) {
    const query = (text || '').trim();
    if (!query || state.streaming) return;

    state.hasSent = true;

    if (state.view === 'history') switchView('chat');

    addMessage('user', query);
    playSfx('blip');

    // 双击打开（file://）时请求根本发不出去，提前给出明确指引
    if (location.protocol === 'file:') {
      playSfx('error');
      showSetupHelp('file');
      return;
    }

    const bot = addMessage('bot', '');
    const caret = addCaret(bot.bubble);

    setBusy(true);

    let received = false;
    let httpStatus = 0;
    let messageId = '';

    try {
      const response = await fetch(API + '?action=chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query: query,
          conversationId: state.conversationId,
          inputs: state.inputs,
          user: getUserId(),
        }),
      });

      httpStatus = response.status;

      if (!response.ok) {
        let message = '请求失败（HTTP ' + response.status + '）';
        try {
          const data = await response.json();
          message = apiError(response.status, data);
        } catch (err) {
          /* 响应不是 JSON，用默认文案 */
        }
        throw new Error(message);
      }

      if (!response.body) throw new Error('浏览器不支持流式响应');

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;

        buffer += decoder.decode(chunk.value, { stream: true });

        // SSE 以空行分隔事件
        const blocks = buffer.split('\n\n');
        buffer = blocks.pop() || '';

        for (const block of blocks) {
          const line = block.trim();
          if (!line.startsWith('data:')) continue;

          const raw = line.slice(5).trim();
          if (!raw) continue;

          let event;
          try {
            event = JSON.parse(raw);
          } catch (err) {
            continue;
          }

          if (event.conversationId) {
            state.conversationId = event.conversationId;
            store(STORE_CONVERSATION, state.conversationId);
          }
          if (event.messageId) messageId = event.messageId;

          if (event.delta) {
            received = true;
            bot.span.textContent += event.delta;
            scrollToEnd();
          }

          if (event.error) throw new Error(event.error);
        }
      }

      if (!received) {
        bot.span.textContent = '（这次没说出话来…… 换个问法再试试？）';
      } else {
        attachActions(bot, messageId, null);
        state.messageId = messageId;
      }
    } catch (error) {
      const message = (error && error.message) || '未知错误';

      if (httpStatus === 404) {
        bot.wrap.remove();
        showSetupHelp('noapi');
      } else if (isSetupError(message)) {
        bot.wrap.remove();
        showSetupHelp('nokey');
      } else {
        bot.span.textContent = '⚠ ' + message;
        bot.wrap.classList.add('is-error');
        playSfx('error');
      }
    } finally {
      if (caret && caret.parentNode) caret.remove();
      setBusy(false);
      if (el.input && state.open) el.input.focus();
    }
  }

  /* ---------------------------------------------------------------------
     历史对话
     --------------------------------------------------------------------- */

  function switchView(view) {
    state.view = view;

    const isHistory = view === 'history';
    el.log.hidden = isHistory;
    el.history.hidden = !isHistory;
    if (el.historyBtn) el.historyBtn.setAttribute('aria-pressed', String(isHistory));

    if (isHistory) loadConversations();
  }

  function loadConversations() {
    el.convs.textContent = '';
    const loading = document.createElement('li');
    loading.className = 'chatw__empty';
    loading.textContent = '加载中…';
    el.convs.appendChild(loading);

    fetch(API + '?action=conversations&limit=30&user=' + encodeURIComponent(getUserId()))
      .then((res) => {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      })
      .then((data) => {
        state.conversations = Array.isArray(data.data) ? data.data : [];
        renderConversations();
      })
      .catch(() => {
        el.convs.textContent = '';
        const fail = document.createElement('li');
        fail.className = 'chatw__empty';
        fail.textContent = '历史记录加载失败';
        el.convs.appendChild(fail);
      });
  }

  function renderConversations() {
    el.convs.textContent = '';

    if (!state.conversations.length) {
      const empty = document.createElement('li');
      empty.className = 'chatw__empty';
      empty.textContent = '还没有历史对话';
      el.convs.appendChild(empty);
      return;
    }

    state.conversations.forEach((conv) => {
      const item = document.createElement('li');

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'chatw__conv';
      if (conv.id === state.conversationId) btn.classList.add('is-active');

      btn.appendChild(document.createTextNode(conv.name || '未命名对话'));

      const role = conv.inputs && conv.inputs.role;
      if (role) {
        const tag = document.createElement('span');
        tag.className = 'chatw__conv-role';
        tag.textContent = role;
        btn.appendChild(tag);
      }

      const time = document.createElement('div');
      time.className = 'chatw__conv-time';
      time.textContent = formatTime(conv.created_at);
      time.style.cssText = 'font-size:1.05rem;color:var(--text-dim2);margin-top:.35rem';
      btn.appendChild(time);

      btn.addEventListener('click', () => openConversation(conv));
      item.appendChild(btn);
      el.convs.appendChild(item);
    });
  }

  /** 把某段历史对话的消息拉回来展示 */
  async function openConversation(conv) {
    switchView('chat');
    setBusy(true);
    clearLog();

    try {
      const url =
        API + '?action=messages&conversationId=' + encodeURIComponent(conv.id) +
        '&limit=50&user=' + encodeURIComponent(getUserId());
      const response = await fetch(url);
      if (!response.ok) throw new Error('HTTP ' + response.status);

      const data = await response.json();
      const list = Array.isArray(data.data) ? data.data.slice().reverse() : [];

      if (!list.length) {
        addSysNote('这段对话没有消息');
        return;
      }

      list.forEach((item) => {
        if (item.query) addMessage('user', item.query, { noScroll: true });
        if (item.answer) {
          const bot = addMessage('bot', item.answer, { noScroll: true });
          attachActions(bot, item.id, item.feedback && item.feedback.rating);
        }
      });
      scrollToEnd();

      // 接着这段对话继续聊
      state.conversationId = conv.id;
      store(STORE_CONVERSATION, conv.id);

      // 还原这段对话使用的设置
      if (conv.inputs) {
        state.inputs = Object.assign({}, conv.inputs);
        store(STORE_INPUTS, JSON.stringify(state.inputs));
        renderFields();
      }

      playSfx('blip');
    } catch (err) {
      addSysNote('⚠ 这段对话加载失败：' + err.message);
      playSfx('error');
    } finally {
      setBusy(false);
    }
  }

  function startNewConversation(options) {
    const opts = options || {};
    state.conversationId = '';
    state.messageId = '';
    store(STORE_CONVERSATION, '');

    clearLog();
    greet();

    if (!opts.silent) {
      playSfx('coin');
      addSysNote('已开启新对话');
    }
    if (state.view === 'history') switchView('chat');
  }

  function clearLog() {
    el.log.textContent = '';
  }

  /* ---------------------------------------------------------------------
     面板开关、全屏、忙碌状态
     --------------------------------------------------------------------- */

  function setBusy(busy) {
    state.streaming = busy;
    if (el.input) el.input.disabled = busy;
    if (el.send) el.send.disabled = busy;
    if (el.panel) el.panel.classList.toggle('is-busy', busy);
  }

  function setFull(on) {
    state.full = on;
    el.panel.classList.toggle('is-full', on);
    if (el.fullBtn) el.fullBtn.setAttribute('aria-pressed', String(on));
    storeLocal(STORE_FULL, on ? '1' : '');
  }

  function openPanel() {
    if (state.open) return;
    state.open = true;

    el.panel.hidden = false;
    requestAnimationFrame(() => el.panel.classList.add('is-open'));

    el.toggle.setAttribute('aria-expanded', 'true');
    el.toggle.classList.add('is-hidden');

    playSfx('jump');

    if (!el.log.childElementCount) {
      greet();
    }
    scrollToEnd();
    setTimeout(() => el.input && el.input.focus(), 260);
  }

  function closePanel() {
    if (!state.open) return;
    state.open = false;

    el.panel.classList.remove('is-open');
    el.toggle.setAttribute('aria-expanded', 'false');
    el.toggle.classList.remove('is-hidden');
    playSfx('click');

    setTimeout(() => {
      if (!state.open) el.panel.hidden = true;
    }, 240);
  }

  /* ---------------------------------------------------------------------
     初始化
     --------------------------------------------------------------------- */

  function init() {
    el.root = document.getElementById('chatw');
    el.toggle = document.getElementById('chatwToggle');
    el.panel = document.getElementById('chatwPanel');
    el.log = document.getElementById('chatwLog');
    el.history = document.getElementById('chatwHistory');
    el.convs = document.getElementById('chatwConvs');
    el.setup = document.getElementById('chatwSetup');
    el.fields = document.getElementById('chatwFields');
    el.form = document.getElementById('chatwForm');
    el.input = document.getElementById('chatwInput');
    el.send = document.getElementById('chatwSend');
    el.close = document.getElementById('chatwClose');
    el.newBtn = document.getElementById('chatwNew');
    el.historyBtn = document.getElementById('chatwHistoryBtn');
    el.fullBtn = document.getElementById('chatwFullBtn');
    el.avatar = document.getElementById('chatwAvatar');

    // 没找到结构就直接退出，别让整站脚本报错
    if (!el.root || !el.toggle || !el.panel || !el.log || !el.form) return;

    state.conversationId = read(STORE_CONVERSATION);
    try {
      state.inputs = JSON.parse(read(STORE_INPUTS) || '{}') || {};
    } catch (err) {
      state.inputs = {};
    }
    if (readLocal(STORE_FULL)) setFull(true);

    // 头像复用首页那个像素机器人
    if (el.avatar && window.PixelSite && typeof window.PixelSite.drawSprite === 'function') {
      window.PixelSite.drawSprite(el.avatar);
    }

    el.toggle.addEventListener('click', () => {
      if (state.open) closePanel();
      else openPanel();
    });

    if (el.close) el.close.addEventListener('click', closePanel);
    if (el.newBtn) el.newBtn.addEventListener('click', () => startNewConversation());
    if (el.fullBtn) el.fullBtn.addEventListener('click', () => setFull(!state.full));
    if (el.historyBtn) {
      el.historyBtn.addEventListener('click', () => {
        switchView(state.view === 'history' ? 'chat' : 'history');
        playSfx('click');
      });
    }

    el.form.addEventListener('submit', (event) => {
      event.preventDefault();
      const value = el.input.value;
      el.input.value = '';
      send(value);
    });

    document.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape' || !state.open) return;
      // Esc 优先退出全屏，再按一次才关窗
      if (state.full) setFull(false);
      else closePanel();
    });

    // 配置拉回来后再渲染设置栏（不阻塞聊天）
    loadParameters();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
