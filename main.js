/* ==========================================================================
   小王.EXE — 交互脚本
   零依赖 · 纯原生 JS
   模块顺序：工具 → 音频 → 精灵 → 开机 → 内容渲染 → 交互 → 彩蛋
   ========================================================================== */
(function () {
  'use strict';

  /* ======================================================================
     0. 小工具
     ====================================================================== */

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  const rand = (min, max) => Math.random() * (max - min) + min;
  const randInt = (min, max) => Math.floor(rand(min, max + 1));
  const pick = (arr) => arr[randInt(0, arr.length - 1)];

  const prefersReduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const isFinePointer = window.matchMedia('(pointer: fine)').matches;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /** 限流：同一 key 在 ms 毫秒内只执行一次 */
  function throttle(key, ms, fn) {
    const now = Date.now();
    throttle._t = throttle._t || {};
    if (throttle._t[key] && now - throttle._t[key] < ms) return;
    throttle._t[key] = now;
    fn();
  }

  /* ======================================================================
     1. 8-bit 音频引擎（Web Audio API，无需任何音频文件）
     ====================================================================== */

  const Sound = (function () {
    let ctx = null;
    let sfxBus = null;
    let bgmBus = null;

    let sfxOn = true;
    let bgmOn = false;

    const music = {
      timer: null,
      step: 0,
      nextTime: 0,
      playing: false,
    };

    const BPM = 128;
    const STEP = 60 / BPM / 2; // 八分音符

    // Am - F - C - G 循环，经典又好听
    const LEAD = [
      69, 72, 76, 72, 65, 69, 72, 69,
      72, 76, 79, 76, 67, 71, 74, 71,
    ];
    const BASS = [
      45, 45, 45, 45, 41, 41, 41, 41,
      48, 48, 48, 48, 43, 43, 43, 43,
    ];

    const midiToFreq = (m) => 440 * Math.pow(2, (m - 69) / 12);

    function ensure() {
      if (ctx) return ctx;
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;

      ctx = new AC();
      sfxBus = ctx.createGain();
      sfxBus.gain.value = 0.16;
      sfxBus.connect(ctx.destination);

      bgmBus = ctx.createGain();
      bgmBus.gain.value = 0;
      bgmBus.connect(ctx.destination);

      return ctx;
    }

    function resume() {
      if (ctx && ctx.state === 'suspended') ctx.resume();
    }

    /** 播放一个方波/三角波音符 */
    function tone(opts) {
      if (!ensure()) return;
      const {
        freq = 440,
        dur = 0.08,
        type = 'square',
        vol = 0.5,
        at = 0,
        slideTo = null,
        bus = sfxBus,
      } = opts;

      const t0 = (at || ctx.currentTime) || ctx.currentTime;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();

      osc.type = type;
      osc.frequency.setValueAtTime(freq, t0);
      if (slideTo) osc.frequency.exponentialRampToValueAtTime(Math.max(20, slideTo), t0 + dur);

      // 硬起硬落，才有 8-bit 的"咔"感
      gain.gain.setValueAtTime(0.0001, t0);
      gain.gain.linearRampToValueAtTime(vol, t0 + 0.008);
      gain.gain.setValueAtTime(vol, t0 + dur * 0.6);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);

      osc.connect(gain);
      gain.connect(bus);
      osc.start(t0);
      osc.stop(t0 + dur + 0.02);
    }

    function schedule() {
      if (!ctx || !music.playing) return;

      while (music.nextTime < ctx.currentTime + 0.15) {
        const i = music.step % LEAD.length;
        const lead = LEAD[i];
        const bass = BASS[i];

        if (i % 2 === 0) {
          tone({ freq: midiToFreq(lead), dur: STEP * 1.6, type: 'square', vol: 0.22, at: music.nextTime, bus: bgmBus });
        }
        if (i % 4 === 0) {
          tone({ freq: midiToFreq(bass), dur: STEP * 3.4, type: 'triangle', vol: 0.34, at: music.nextTime, bus: bgmBus });
        }

        music.nextTime += STEP;
        music.step += 1;
      }
    }

    /* ------------------------------ 音效表 ------------------------------ */

    const sfx = {
      blip(vol = 1) {
        tone({ freq: 900, dur: 0.045, slideTo: 1500, vol: 0.35 * vol });
      },
      click(vol = 1) {
        tone({ freq: 300, dur: 0.07, slideTo: 90, type: 'square', vol: 0.5 * vol });
      },
      coin(vol = 1) {
        if (!ensure()) return;
        const t = ctx.currentTime;
        tone({ freq: 987, dur: 0.07, vol: 0.4 * vol, at: t });
        tone({ freq: 1318, dur: 0.22, vol: 0.4 * vol, at: t + 0.07 });
      },
      levelUp(vol = 1) {
        if (!ensure()) return;
        const t = ctx.currentTime;
        [659, 784, 988, 1318].forEach((f, i) => {
          tone({ freq: f, dur: 0.11, vol: 0.32 * vol, at: t + i * 0.075 });
        });
      },
      error(vol = 1) {
        tone({ freq: 160, dur: 0.2, type: 'sawtooth', vol: 0.4 * vol });
      },
      jump(vol = 1) {
        tone({ freq: 420, dur: 0.16, slideTo: 900, type: 'square', vol: 0.35 * vol });
      },
      key(vol = 1) {
        tone({ freq: 1400 + rand(-120, 180), dur: 0.02, type: 'square', vol: 0.14 * vol });
      },
    };

    function play(name, vol = 1) {
      if (!sfxOn) return;
      resume();
      const fn = sfx[name];
      if (fn) fn(vol);
    }

    function startBgm() {
      if (!ensure()) return false;
      resume();
      if (music.playing) return true;

      music.playing = true;
      music.step = 0;
      music.nextTime = ctx.currentTime + 0.08;
      bgmBus.gain.cancelScheduledValues(ctx.currentTime);
      bgmBus.gain.setValueAtTime(0.0001, ctx.currentTime);
      bgmBus.gain.linearRampToValueAtTime(0.5, ctx.currentTime + 0.6);
      music.timer = setInterval(schedule, 25);
      return true;
    }

    function stopBgm() {
      if (!ctx || !music.playing) return;
      music.playing = false;
      clearInterval(music.timer);
      bgmBus.gain.cancelScheduledValues(ctx.currentTime);
      bgmBus.gain.setValueAtTime(bgmBus.gain.value, ctx.currentTime);
      bgmBus.gain.linearRampToValueAtTime(0.0001, ctx.currentTime + 0.35);
    }

    return {
      unlock() {
        ensure();
        resume();
      },
      play,
      startBgm,
      stopBgm,
      toggleBgm() {
        bgmOn = !bgmOn;
        if (bgmOn) startBgm();
        else stopBgm();
        return bgmOn;
      },
      get bgmOn() {
        return bgmOn;
      },
      toggleSfx() {
        sfxOn = !sfxOn;
        return sfxOn;
      },
      get sfxOn() {
        return sfxOn;
      },
    };
  })();

  /* ======================================================================
     2. 像素精灵（16 × 16 机器人）
     ====================================================================== */

  const SPRITE_BASE = [
    '......##........',
    '......##........',
    '....########....',
    '...##########...',
    '..#1111111111#..',
    '..#1133113311#..',
    '..#1133113311#..',
    '..#1111111111#..',
    '..#1133333311#..',
    '..#1111111111#..',
    '...##########...',
    '....########....',
    '....#222222#....',
    '...##444444##...',
    '..##11111111##..',
    '..############..',
  ];

  // 眨眼：眼睛那两行只保留下面一行
  const SPRITE_BLINK = SPRITE_BASE.map((row, y) =>
    y === 5 ? row.replace(/3/g, '1') : row
  );

  // 开心：嘴巴变弯（用黄色）
  const SPRITE_HAPPY = SPRITE_BASE.map((row, y) =>
    y === 8 ? '..#1155555511#..' : row
  );

  const PALETTE = {
    '#': '#1b0f33',
    '1': '#00f0ff',
    '2': '#00b4cc',
    '3': '#0f0524',
    '4': '#ff2e88',
    '5': '#ffe600',
  };

  function drawSprite(canvas, map) {
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const size = canvas.width / map[0].length;

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.imageSmoothingEnabled = false;

    for (let y = 0; y < map.length; y++) {
      for (let x = 0; x < map[y].length; x++) {
        const color = PALETTE[map[y][x]];
        if (!color) continue;
        ctx.fillStyle = color;
        ctx.fillRect(x * size, y * size, size, size);
      }
    }
  }

  function initAvatars() {
    const big = $('#avatar');
    const small = $('#avatarSmall');
    if (big) drawSprite(big, SPRITE_BASE);
    if (small) drawSprite(small, SPRITE_BASE);

    // 定时眨眼
    if (!prefersReduced && big) {
      const blinkLoop = () => {
        drawSprite(big, SPRITE_BLINK);
        setTimeout(() => {
          drawSprite(big, SPRITE_BASE);
          setTimeout(blinkLoop, randInt(2200, 5200));
        }, randInt(110, 170));
      };
      setTimeout(blinkLoop, 1800);
    }

    // 点击头像：开心 + 彩蛋计数
    let pokes = 0;
    const hint = $('#avatarHint');
    const lines = [
      '你好呀 👋',
      '今天的 token 烧得开心吗？',
      '别点了，我在算成本。',
      '再点一下我就开始说人话了。',
      '好吧，你赢了 —— 解锁成就！',
    ];

    if (big) {
      big.addEventListener('click', () => {
        Sound.play('jump');
        drawSprite(big, SPRITE_HAPPY);
        setTimeout(() => drawSprite(big, SPRITE_BASE), 900);

        pokes += 1;
        if (hint && pokes <= lines.length) hint.textContent = lines[pokes - 1];

        if (pokes === 5) {
          Sound.play('levelUp');
          showToast('成就解锁：摸鱼小能手', '★');
          pokes = 0;
        }
      });

      // 键盘可达
      big.setAttribute('tabindex', '0');
      big.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          big.click();
        }
      });
    }
  }

  /* ======================================================================
     3. 成就提示条
     ====================================================================== */

  let toastTimer = null;
  function showToast(text, icon = '★', duration = 2800) {
    const el = $('#toast');
    const txt = $('#toastText');
    const ico = el && el.querySelector('.toast__icon');
    if (!el || !txt) return;

    txt.textContent = text;
    if (ico) ico.textContent = icon;
    el.classList.add('is-show');

    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('is-show'), duration);
  }

  /* ======================================================================
     4. 开机画面
     ====================================================================== */

  const BOOT_LINES = [
    ['> NEON-BIOS v3.14  初始化和风驱动...', 'log-dim'],
    ['> MOUNTING /dev/brain ......... OK', ''],
    ['> LOADING PIXEL RENDERER ...... OK', ''],
    ['> CHECKING CAFFEINE LEVEL ..... 充足', 'log-warn'],
    ['> 加载用户档案：小王', ''],
    ['> 职业：AI 产品经理', ''],
    ['> 技能点分配：需求洞察 / Prompt / 数据 ...', 'log-dim'],
    ['> 警告：检测到第 8 个需求插入', 'log-err'],
    ['> 已自动忽略 :)', ''],
    ['> ALL SYSTEMS NOMINAL', ''],
  ];

  function initBoot() {
    const boot = $('#boot');
    const logEl = $('#bootLog');
    const press = $('.boot__press');
    const startBtn = $('#startBtn');
    if (!boot || !logEl) return;

    let skipped = false;

    async function typeBoot() {
      for (const [text, cls] of BOOT_LINES) {
        if (skipped) break;

        const line = document.createElement('span');
        if (cls) line.className = cls;
        logEl.appendChild(line);

        for (let i = 0; i < text.length; i++) {
          if (skipped) {
            line.textContent = text;
            break;
          }
          line.textContent += text[i];
          // 中文按字打太密集，隔几个字响一次
          if (i % 3 === 0) Sound.play('key');
          await sleep(text[i].match(/[\u4e00-\u9fa5]/) ? 26 : 12);
        }
        logEl.appendChild(document.createTextNode('\n'));
        await sleep(randInt(60, 150));
      }
      finishBoot();
    }

    function finishBoot() {
      skipped = true;
      if (press) press.classList.add('is-on');
      if (startBtn) startBtn.focus({ preventScroll: true });
    }

    function start() {
      Sound.unlock();
      Sound.play('coin');
      boot.classList.add('is-done');
      document.body.classList.remove('is-booting');

      setTimeout(() => {
        // 先把焦点移出开机层再隐藏：
        // 焦点还留在里面的元素上就设 aria-hidden，浏览器会直接拦下来并报无障碍警告
        if (document.activeElement && boot.contains(document.activeElement)) {
          document.activeElement.blur();
        }
        boot.setAttribute('inert', '');
        boot.setAttribute('aria-hidden', 'true');
        boot.style.display = 'none';
      }, 520);

      startExperience();
    }

    // 点击 / 任意键 → 跳过打字动画
    boot.addEventListener('click', (e) => {
      if (e.target.closest('#startBtn')) return;
      if (!skipped) finishBoot();
    });

    window.addEventListener('keydown', (e) => {
      if (boot.classList.contains('is-done')) return;
      if (skipped) {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          start();
        }
      } else if (e.key !== 'Tab') {
        finishBoot();
      }
    });

    if (startBtn) {
      startBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        start();
      });
    }

    // 减少动效时直接跳过
    if (prefersReduced) {
      logEl.textContent = BOOT_LINES.map((l) => l[0]).join('\n');
      finishBoot();
    } else {
      typeBoot();
    }
  }

  /* ======================================================================
     5. 内容渲染：技能面板 / 升级路线
     ====================================================================== */

  const SKILLS = [
    { name: '需求洞察', en: 'INSIGHT', v: 92, c: 'var(--cyan)' },
    { name: 'Prompt 工程', en: 'PROMPTING', v: 88, c: 'var(--pink)' },
    { name: '数据与实验', en: 'DATA / AB', v: 85, c: 'var(--yellow)' },
    { name: '产品设计', en: 'DESIGN', v: 80, c: 'var(--purple)' },
    { name: '跨团队协作', en: 'TEAMWORK', v: 90, c: 'var(--green)' },
    { name: '技术理解度', en: 'TECH SENSE', v: 78, c: 'var(--cyan)' },
    { name: '咖啡因耐受', en: 'CAFFEINE', v: 99, c: 'var(--pink)' },
  ];

  const ROADMAP = [
    {
      lv: 'LV.1',
      year: '2019 — 2020',
      title: '产品助理',
      desc: '学会了怎么把别人随口一句话的需求，写成一份大家都能看懂的文档。',
    },
    {
      lv: 'LV.2',
      year: '2020 — 2022',
      title: '产品经理',
      desc: '独立负责完整功能线，第一次深刻体会到"上线了"和"做完了"是两件事。',
    },
    {
      lv: 'LV.3',
      year: '2022 — 2024',
      title: 'AI 产品经理',
      desc: '从"不就是调个 API 吗"开始，先后被幻觉和 token 成本各教育过一次。',
    },
    {
      lv: 'LV.4',
      year: '2024 — NOW',
      title: '高级 AI 产品经理',
      desc: '开始定方向：搭评测体系、划产品边界，也学会了说"这个先不做"。',
    },
    {
      lv: 'MAX',
      year: 'NEXT',
      title: '？？？',
      desc: '正在加载下一个存档点…… 也许是一个好用的 Agent，也许是一个更好的问题。',
    },
  ];

  function renderSkills() {
    const panel = $('#skillsPanel');
    if (!panel) return;

    panel.innerHTML = SKILLS.map(
      (s) => `
      <div class="skill" style="--skill-v:${s.v}%;--skill-c:${s.c}">
        <div class="skill__top">
          <span class="skill__name">${s.name}<em>${s.en}</em></span>
          <span class="skill__val">${s.v}</span>
        </div>
        <div class="skill__bar"><div class="skill__fill"></div></div>
      </div>`
    ).join('');
  }

  function renderRoadmap() {
    const list = $('#roadmap');
    if (!list) return;

    list.innerHTML = ROADMAP.map(
      (n, i) => `
      <li class="node${i === 0 ? ' is-active' : ''}">
        <div class="node__card">
          <div class="node__head">
            <span class="node__lv">${n.lv}</span>
            <span class="node__year">${n.year}</span>
          </div>
          <h3 class="node__title">${n.title}</h3>
          <p class="node__desc">${n.desc}</p>
        </div>
      </li>`
    ).join('');
  }

  /* ======================================================================
     6. HERO：星空 + 打字机
     ====================================================================== */

  const STAR_COLORS = ['#eae4ff', '#00f0ff', '#ff2e88', '#ffe600', '#a06bff'];

  function renderStarfield() {
    const box = $('#starfield');
    if (!box) return;

    const count = window.innerWidth < 760 ? 40 : 90;
    const frag = document.createDocumentFragment();

    for (let i = 0; i < count; i++) {
      const star = document.createElement('i');
      const size = Math.random() < 0.75 ? 2 : 3;
      star.style.left = rand(0, 100).toFixed(2) + '%';
      star.style.top = rand(0, 100).toFixed(2) + '%';
      star.style.width = size + 'px';
      star.style.height = size + 'px';
      star.style.background = Math.random() < 0.7 ? '#eae4ff' : pick(STAR_COLORS);
      star.style.animationDelay = rand(0, 3).toFixed(2) + 's';
      star.style.animationDuration = rand(2, 5).toFixed(2) + 's';
      frag.appendChild(star);
    }
    box.appendChild(frag);
  }

  const HERO_PHRASES = [
    '把模型能力，翻译成用户价值。',
    '需求评审中，请勿投喂新需求。',
    'Prompt 调通了，下班！',
    '正在和算法同学友好交流…',
    'AI 产品 = 技术 × 人性 × 一点点运气。',
    '为每一个"这个能不能做"寻找答案。',
  ];

  function initTypewriter() {
    const el = $('#typewriter');
    if (!el) return;

    if (prefersReduced) {
      el.textContent = HERO_PHRASES[0];
      return;
    }

    let phrase = 0;
    let char = 0;
    let deleting = false;

    function tick() {
      const text = HERO_PHRASES[phrase];

      if (!deleting) {
        char += 1;
        el.textContent = text.slice(0, char);
        if (char >= text.length) {
          deleting = true;
          return setTimeout(tick, 1900);
        }
        return setTimeout(tick, 78);
      }

      char -= 1;
      el.textContent = text.slice(0, char);
      if (char <= 0) {
        deleting = false;
        phrase = (phrase + 1) % HERO_PHRASES.length;
        return setTimeout(tick, 420);
      }
      return setTimeout(tick, 32);
    }

    setTimeout(tick, 900);
  }

  /* ======================================================================
     7. 关于我：NPC 逐字对话
     ====================================================================== */

  const DIALOGUE = [
    '嗨！我是小王，一名 AI 产品经理。',
    '简单说：我把大模型那些"听起来很厉害"的能力，拆成用户真的会去点的小按钮。',
    '日常大概是：写 PRD、跑评测集、画流程图，然后和算法同学认真讨论"这个需求到底能不能做"。',
    '我最喜欢的一件事，是把一个原本只有极客会用的功能，改到连我爸妈都能自己上手。',
    '顺便说一句，这个网站是我自己手搓的 —— 像素风，纯 HTML + CSS + JS，没有用任何框架 🕹️',
  ];

  function initDialogue() {
    const box = $('#dialogue');
    const textEl = $('#dialogueText');
    if (!box || !textEl) return;

    let index = 0;
    let typing = false;
    let timer = null;

    function typeLine(line, done) {
      typing = true;
      textEl.textContent = '';
      let i = 0;

      const step = () => {
        if (!typing) return;
        if (i >= line.length) {
          typing = false;
          if (done) done();
          return;
        }
        textEl.textContent += line[i];
        if (i % 2 === 0) Sound.play('key', 0.5);
        i += 1;
        timer = setTimeout(step, 42);
      };
      step();
    }

    function show(i) {
      typeLine(DIALOGUE[i], () => {
        // 打字结束后停留一下，稍微暗示"可以继续"
      });
    }

    box.addEventListener('click', () => {
      Sound.play('blip');

      // 正在打字 → 立即显示完整
      if (typing) {
        typing = false;
        clearTimeout(timer);
        textEl.textContent = DIALOGUE[index];
        return;
      }

      index += 1;
      if (index < DIALOGUE.length) {
        show(index);
      } else {
        index = 0;
        show(index);
        showToast('对话已看完，可以往下逛逛了 ↓', '▼', 2200);
      }
    });

    // 滚到可视区域再开始，避免"还没看到就打完了"
    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            io.disconnect();
            show(0);
          }
        });
      },
      { threshold: 0.25 }
    );
    io.observe(box);
  }

  /* ======================================================================
     8. 通用交互：导航 / 滚动揭示 / 技能条 / 锚点
     ====================================================================== */

  function initNav() {
    const nav = $('#nav');
    const burger = $('#navBurger');
    const menu = $('#navMenu');
    if (!nav) return;

    const hero = $('#hero');

    function onScroll() {
      const threshold = hero ? hero.offsetHeight * 0.55 : 300;
      nav.classList.toggle('is-visible', window.scrollY > threshold);
    }

    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();

    if (burger && menu) {
      burger.addEventListener('click', () => {
        Sound.play('click');
        const open = menu.classList.toggle('is-open');
        burger.setAttribute('aria-expanded', String(open));
      });

      menu.addEventListener('click', (e) => {
        if (e.target.closest('.nav__link')) {
          menu.classList.remove('is-open');
          burger.setAttribute('aria-expanded', 'false');
        }
      });
    }

    // 滚动高亮当前区块
    const links = $$('.nav__link');
    const sections = links
      .map((l) => {
        const id = l.getAttribute('href');
        return id && id.startsWith('#') ? $(id) : null;
      })
      .filter(Boolean);

    if (sections.length && 'IntersectionObserver' in window) {
      const spy = new IntersectionObserver(
        (entries) => {
          entries.forEach((entry) => {
            if (!entry.isIntersecting) return;
            links.forEach((l) => {
              l.classList.toggle('is-active', l.getAttribute('href') === '#' + entry.target.id);
            });
          });
        },
        { rootMargin: '-45% 0px -50% 0px' }
      );
      sections.forEach((s) => spy.observe(s));
    }
  }

  function initReveal() {
    const targets = $$(
      '.stage-label, .section__title, .section__lead, .dialogue, .fact, ' +
      '.skills, .equip, .quest, .node, .contact__card, .contact__note, .footer__big'
    );

    targets.forEach((el) => {
      el.setAttribute('data-reveal', '');
      // 同组元素逐个延迟，形成"像素波"效果
      const siblings = el.parentElement ? Array.from(el.parentElement.children) : [];
      const i = siblings.indexOf(el);
      el.style.transitionDelay = Math.min(i, 6) * 70 + 'ms';
    });

    /**
     * 动画播完后把 data-reveal 摘掉，
     * 这样元素自身的 hover 位移 / 过渡就不会被进场样式压制。
     */
    function settle(el) {
      const delay = parseFloat(el.style.transitionDelay) || 0;
      setTimeout(() => {
        el.removeAttribute('data-reveal');
        el.classList.remove('is-in');
        el.style.transitionDelay = '';
      }, 620 + delay);
    }

    if (!('IntersectionObserver' in window) || prefersReduced) {
      targets.forEach((el) => {
        el.classList.add('is-in');
        settle(el);
      });
      return;
    }

    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          entry.target.classList.add('is-in');
          settle(entry.target);

          // 技能条进入视野时填充
          if (entry.target.classList.contains('skills')) {
            setTimeout(() => {
              $$('.skill', entry.target).forEach((s, i) => {
                setTimeout(() => {
                  s.classList.add('is-filled');
                  Sound.play('blip', 0.4);
                }, i * 110);
              });
            }, 260);
          }

          io.unobserve(entry.target);
        });
      },
      { threshold: 0.15, rootMargin: '0px 0px -8% 0px' }
    );

    targets.forEach((el) => io.observe(el));
  }

  function initSmoothAnchors() {
    // 所有内部锚点平滑滚动
    document.addEventListener('click', (e) => {
      const a = e.target.closest('a[href^="#"]');
      if (!a) return;
      const id = a.getAttribute('href');
      if (!id || id === '#') return;
      const target = $(id);
      if (!target) return;

      e.preventDefault();
      const top = target.getBoundingClientRect().top + window.scrollY - 70;
      window.scrollTo({ top, behavior: prefersReduced ? 'auto' : 'smooth' });
    });

    // HERO 上的两个按钮
    $$('[data-target]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const target = $(btn.dataset.target);
        if (!target) return;
        const top = target.getBoundingClientRect().top + window.scrollY - 70;
        window.scrollTo({ top, behavior: prefersReduced ? 'auto' : 'smooth' });
      });
    });
  }

  function initHud() {
    const bgmBtn = $('#bgmBtn');
    const sfxBtn = $('#sfxBtn');
    const topBtn = $('#topBtn');

    if (bgmBtn) {
      bgmBtn.addEventListener('click', () => {
        const on = Sound.toggleBgm();
        bgmBtn.setAttribute('aria-pressed', String(on));
        bgmBtn.querySelector('.hud__icon').textContent = on ? '♫' : '♪';
        bgmBtn.querySelector('.hud__txt').textContent = on ? 'BGM ON' : 'BGM OFF';
        if (on) showToast('背景音乐已开启 ♫', '♪', 1800);
      });
    }

    if (sfxBtn) {
      sfxBtn.addEventListener('click', () => {
        // 先切换到"关"再判断，保证按钮本身不发多余声音
        const on = Sound.toggleSfx();
        sfxBtn.setAttribute('aria-pressed', String(on));
        sfxBtn.querySelector('.hud__icon').textContent = on ? '🔊' : '🔇';
        sfxBtn.querySelector('.hud__txt').textContent = on ? 'SFX ON' : 'SFX OFF';
        if (on) Sound.play('coin');
      });
    }

    if (topBtn) {
      topBtn.addEventListener('click', () => {
        Sound.play('jump');
        window.scrollTo({ top: 0, behavior: prefersReduced ? 'auto' : 'smooth' });
      });
    }
  }

  function initCopyCards() {
    const cards = [
      { btn: '#copyMail', value: '#mailValue', action: '#mailAction' },
      { btn: '#copyWechat', value: '#wechatValue', action: '#wechatAction' },
    ];

    cards.forEach(({ btn, value, action }) => {
      const el = $(btn);
      const valEl = $(value);
      const actEl = $(action);
      if (!el || !valEl) return;

      el.addEventListener('click', async () => {
        const text = valEl.textContent.trim();

        try {
          if (navigator.clipboard && window.isSecureContext) {
            await navigator.clipboard.writeText(text);
          } else {
            // 本地 file:// 打开的兜底方案
            const ta = document.createElement('textarea');
            ta.value = text;
            ta.setAttribute('readonly', '');
            ta.style.position = 'fixed';
            ta.style.top = '-1000px';
            document.body.appendChild(ta);
            ta.select();
            document.execCommand('copy');
            document.body.removeChild(ta);
          }

          Sound.play('coin');
          el.classList.add('is-copied');
          if (actEl) actEl.textContent = '✓ 已复制！';

          setTimeout(() => {
            el.classList.remove('is-copied');
            if (actEl) actEl.textContent = '点击复制';
          }, 1600);
        } catch (err) {
          Sound.play('error');
          showToast('复制失败，手动选一下呗 🙏', '!', 2600);
        }
      });
    });
  }

  function initHoverSfx() {
    const selector = '.btn, .nav__link, .hud__btn, .contact__card, .quest, .chip, .fact';
    document.addEventListener(
      'mouseover',
      (e) => {
        if (e.target.closest(selector)) {
          throttle('hover', 90, () => Sound.play('blip', 0.5));
        }
      },
      { passive: true }
    );
  }

  /* ======================================================================
     9. 自定义像素光标
     ====================================================================== */

  function initReticle() {
    if (!isFinePointer || prefersReduced) return;

    const reticle = $('#reticle');
    if (!reticle) return;

    document.documentElement.classList.add('has-pixel-cursor');

    let mouseX = -100;
    let mouseY = -100;
    let curX = -100;
    let curY = -100;
    let raf = null;

    function loop() {
      // 轻微的缓动：既有"跟手"的手感，又保留像素光标的一点点滞后
      curX += (mouseX - curX) * 0.55;
      curY += (mouseY - curY) * 0.55;
      reticle.style.transform = `translate3d(${curX}px, ${curY}px, 0)`;

      if (Math.abs(mouseX - curX) > 0.3 || Math.abs(mouseY - curY) > 0.3) {
        raf = requestAnimationFrame(loop);
      } else {
        raf = null;
      }
    }

    document.addEventListener(
      'mousemove',
      (e) => {
        mouseX = e.clientX;
        mouseY = e.clientY;
        if (!raf) raf = requestAnimationFrame(loop);
      },
      { passive: true }
    );

    document.addEventListener(
      'mouseover',
      (e) => {
        // 可点/可输入的元素上，准星换成黄色。input / textarea 不会带 tabindex，得单独列。
        const hot = e.target.closest('a, button, input, textarea, select, [tabindex]');
        reticle.classList.toggle('is-hot', !!hot);
      },
      { passive: true }
    );

    document.addEventListener('mouseleave', () => {
      reticle.style.opacity = '0';
    });
    document.addEventListener('mouseenter', () => {
      reticle.style.opacity = '1';
    });
  }

  /* ======================================================================
     10. 像素彩带（Konami Code 彩蛋）
     ====================================================================== */

  const CONFETTI_COLORS = ['#00f0ff', '#ff2e88', '#ffe600', '#39ff14', '#a06bff', '#ff9640'];

  function initConfetti() {
    const canvas = $('#confetti');
    if (!canvas) return null;

    const ctx = canvas.getContext('2d');
    let particles = [];
    let rafId = null;
    let endTime = 0;

    function resize() {
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
    }
    resize();
    window.addEventListener('resize', resize);

    function spawn(count) {
      particles = [];
      for (let i = 0; i < count; i++) {
        particles.push({
          x: rand(0, canvas.width),
          y: rand(-canvas.height * 0.5, 0),
          w: randInt(4, 10),
          h: randInt(4, 10),
          vy: rand(2.2, 6.5),
          vx: rand(-1.6, 1.6),
          rot: rand(0, Math.PI),
          vr: rand(-0.12, 0.12),
          color: pick(CONFETTI_COLORS),
        });
      }
    }

    function frame() {
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      particles.forEach((p) => {
        p.x += p.vx;
        p.y += p.vy;
        p.rot += p.vr;

        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        ctx.fillStyle = p.color;
        ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
        ctx.restore();
      });

      if (Date.now() < endTime) {
        rafId = requestAnimationFrame(frame);
      } else {
        canvas.classList.remove('is-on');
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        cancelAnimationFrame(rafId);
        rafId = null;
      }
    }

    return function fire(duration = 5200, count = 200) {
      canvas.classList.add('is-on');
      spawn(count);
      endTime = Date.now() + duration;
      if (!rafId) rafId = requestAnimationFrame(frame);
    };
  }

  function initKonami() {
    const fire = initConfetti();
    const SEQUENCE = [
      'ArrowUp', 'ArrowUp', 'ArrowDown', 'ArrowDown',
      'ArrowLeft', 'ArrowRight', 'ArrowLeft', 'ArrowRight', 'b', 'a',
    ];

    let pos = 0;

    window.addEventListener('keydown', (e) => {
      const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;

      if (key === SEQUENCE[pos]) {
        pos += 1;
        if (pos === SEQUENCE.length) {
          pos = 0;
          if (fire) fire();
          Sound.play('levelUp');
          Sound.play('coin', 0.8);

          const motto = $('#footerMotto');
          if (motto) motto.textContent = 'CHEAT MODE ACTIVATED';

          showToast('★★★ 彩蛋解锁：你也太懂了吧 ★★★', '🏆', 4200);
        }
      } else {
        pos = key === SEQUENCE[0] ? 1 : 0;
      }
    });
  }

  /* ======================================================================
     11. 启动
     ====================================================================== */

  function startExperience() {
    // 进入后先给一个小小的成就提示
    setTimeout(() => {
      showToast('欢迎来到小王的世界 · 试试右下角的 BGM', '♪', 4200);
    }, 1400);
  }

  function init() {
    /**
     * 把音效与像素精灵暴露出去，供 js/chat.js（AI 聊天挂件）复用。
     * chat.js 是独立文件，拿不到这里的闭包变量，所以只开放这两个最小接口。
     */
    window.PixelSite = {
      sfx: (name, vol) => Sound.play(name, vol),
      drawSprite: (canvas) => drawSprite(canvas, SPRITE_BASE),
    };

    renderStarfield();
    renderSkills();
    renderRoadmap();

    initAvatars();
    initTypewriter();
    initDialogue();

    initNav();
    initHud();
    initCopyCards();
    initHoverSfx();
    initSmoothAnchors();
    initReticle();
    initKonami();

    // 渲染完成后统一挂载进场动画
    initReveal();

    // 开机画面（最后初始化，保证其它内容已就绪）
    initBoot();

    // 页面被切回来时，如果音频被挂起就恢复
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) Sound.unlock();
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
