// ==UserScript==
// @name         白玉兰远程医学网 - 连播、倍速、学习助手
// @namespace    https://byljxjy.com/
// @version      0.3.0
// @license      MIT
// @description  真实连播倍速、页面进度检查、练习题识别、可选AI建议与练习自动提交（仅主动启用）。
// @author       X
// @match        *://byljxjy.com/*
// @match        *://*.byljxjy.com/*
// @match        *://*.ahzsksw.cn/*
// @match        *://*.ahjxjy.cn/*
// @grant        GM_xmlhttpRequest
// @connect      api.openai.com
// @connect      *
// @all-frames   true
// @run-at       document-idle
// ==/UserScript==

/*
  Approach referenced (MIT):
  https://scriptcat.org/zh-CN/script-show-page/7640
  白玉兰远程医学网｜列表自动连播+倍速, author 技术学习

  This file is an independent rewrite: different message protocol,
  site-scoped matches, persisted rate, and cross-frame play commands
  so the player inside an iframe can be started after a lesson switch.
*/

(function () {
  "use strict";

  const FLAG = "__bylPlaylistSpeedInstalled";
  if (window[FLAG]) return;
  window[FLAG] = true;

  const MSG = {
    NEXT: "BYL_PS_NEXT",
    PLAY: "BYL_PS_PLAY",
    STATS: "BYL_PS_STATS",
  };
  const STORE_KEY = "byl-playlist-speed-rate";
  const HOST_RE = /(^|\.)byljxjy\.com$/i;
  const TRUSTED_HOST_RE = /(^|\.)(byljxjy\.com|ahzsksw\.cn|ahjxjy\.cn)$/i;
  const STATS_KEY = "byl-ps-real-watch-stats";
  const BANK_KEY = "byl-ps-practice-answer-bank";
  const ASSIST_CFG = "byl-ps-assist-cfg";
  const SWITCH_COOLDOWN_MS = 5000;
  const AFTER_CLICK_DELAY_MS = 800;
  const PLAY_RETRY_MS = [600, 1400, 2400, 4000];
  const RATE_MIN = 0.1;
  const RATE_MAX = 16;

  const isTop = window.self === window.top;
  const onMainHost = HOST_RE.test(location.hostname);

  function clampRate(n) {
    const x = Number(n);
    if (!Number.isFinite(x)) return 1;
    return Math.min(RATE_MAX, Math.max(RATE_MIN, Math.round(x * 10) / 10));
  }

  function loadRate() {
    try {
      return clampRate(localStorage.getItem(STORE_KEY) || "1");
    } catch (_) {
      return 1;
    }
  }

  function saveRate(rate) {
    try {
      localStorage.setItem(STORE_KEY, String(rate));
    } catch (_) {}
  }

  let currentRate = isTop && onMainHost ? loadRate() : 1;
  let jumpLocked = false;
  let lastSwitchAt = 0;
  let watchStats = { seconds: 0, completed: 0 };
  if (isTop && onMainHost) {
    try { watchStats = Object.assign(watchStats, JSON.parse(localStorage.getItem(STATS_KEY) || "{}")); } catch (_) {}
  }
  function saveWatchStats() {
    if (!isTop || !onMainHost) return;
    try { localStorage.setItem(STATS_KEY, JSON.stringify(watchStats)); } catch (_) {}
  }
  function sendStats(kind, amount) {
    if (isTop && onMainHost) {
      if (kind === "seconds") watchStats.seconds += amount;
      if (kind === "completed") watchStats.completed += amount;
      saveWatchStats();
    } else {
      try { window.top.postMessage({ type: MSG.STATS, kind, amount }, "*"); } catch (_) {}
    }
  }
  const lastWatchTick = new WeakMap();
  function trackRealPlayback(video) {
    if (video.dataset.bylPsTracked === "1") return;
    video.dataset.bylPsTracked = "1";
    lastWatchTick.set(video, performance.now());
    video.addEventListener("timeupdate", () => {
      const now = performance.now();
      const last = lastWatchTick.get(video) || now;
      lastWatchTick.set(video, now);
      if (!video.paused && !video.seeking && !video.ended && video.readyState >= 2) {
        const delta = Math.min(1, (now - last) / 1000);
        if (delta > 0) sendStats("seconds", delta);
      }
    });
    video.addEventListener("ended", () => sendStats("completed", 1));
  }

  function videosIn(doc) {
    return Array.from((doc || document).querySelectorAll("video"));
  }

  function bindEnded(video) {
    if (video.dataset.bylPsEnded === "1") return;
    video.dataset.bylPsEnded = "1";
    video.addEventListener("ended", function () {
      try {
        window.top.postMessage({ type: MSG.NEXT }, "*");
      } catch (_) {}
    });
  }

  function applyRateAndMaybePlay(play) {
    videosIn(document).forEach(function (video) {
      try {
        video.playbackRate = currentRate;
      } catch (_) {}
      bindEnded(video);
      trackRealPlayback(video);
      if (play) {
        const p = video.play();
        if (p && typeof p.catch === "function") p.catch(function () {});
      }
    });
  }

  function broadcastPlay() {
    const payload = { type: MSG.PLAY, rate: currentRate };
    applyRateAndMaybePlay(true);
    document.querySelectorAll("iframe").forEach(function (frame) {
      try {
        frame.contentWindow.postMessage(payload, "*");
      } catch (_) {}
    });
    // Also ping every frame via the current window tree when same-origin.
    try {
      const walk = function (win) {
        for (let i = 0; i < win.frames.length; i++) {
          try {
            win.frames[i].postMessage(payload, "*");
            walk(win.frames[i]);
          } catch (_) {}
        }
      };
      if (isTop) walk(window);
    } catch (_) {}
  }

  function getListBox() {
    return document.querySelector('div[class*="subjectList"]');
  }

  function getCurrentRow(listBox) {
    const mark = listBox.querySelector('[class*="playerText"]');
    if (!mark) return null;
    let el = mark;
    while (el.parentElement && el.parentElement !== listBox) {
      el = el.parentElement;
    }
    return el.parentElement === listBox ? el : mark;
  }

  function clickNode(node) {
    if (!node) return;
    node.scrollIntoView({ behavior: "smooth", block: "nearest" });
    const target =
      node.matches("a,button,[role='button']")
        ? node
        : node.querySelector("a,button,[role='button']") || node;
    target.click();
  }

  function clickNextLesson() {
    if (!isTop || !onMainHost) return;
    const now = Date.now();
    if (jumpLocked || now - lastSwitchAt < SWITCH_COOLDOWN_MS) return;

    jumpLocked = true;
    lastSwitchAt = now;

    window.setTimeout(function () {
      const listBox = getListBox();
      if (!listBox) {
        jumpLocked = false;
        return;
      }
      const current = getCurrentRow(listBox);
      if (!current) {
        jumpLocked = false;
        return;
      }
      const next = current.nextElementSibling;
      if (!next) {
        jumpLocked = false;
        setStatus("已经是最后一课");
        return;
      }

      videosIn(document).forEach(function (video) {
        try {
          video.pause();
        } catch (_) {}
      });

      const label = (next.textContent || "").trim().replace(/\s+/g, " ").slice(0, 40);
      clickNode(next);
      setStatus(label ? "已切换：" + label : "已切换到下一课");

      PLAY_RETRY_MS.forEach(function (ms) {
        window.setTimeout(broadcastPlay, ms);
      });

      window.setTimeout(function () {
        jumpLocked = false;
      }, SWITCH_COOLDOWN_MS);
    }, AFTER_CLICK_DELAY_MS);
  }

  window.addEventListener("message", function (ev) {
    const data = ev && ev.data;
    if (!data || typeof data !== "object") return;
    try { if (!TRUSTED_HOST_RE.test(new URL(ev.origin).hostname)) return; } catch (_) { return; }
    if (data.type === MSG.NEXT && isTop) {
      clickNextLesson();
    }
    if (data.type === MSG.STATS && isTop && onMainHost) {
      if ((data.kind === "seconds" || data.kind === "completed") &&
          typeof data.amount === "number" && Number.isFinite(data.amount) &&
          data.amount >= 0 && data.amount <= 1) sendStats(data.kind, data.amount);
    }
    if (data.type === MSG.PLAY) {
      if (typeof data.rate === "number") currentRate = clampRate(data.rate);
      applyRateAndMaybePlay(true);
    }
  });

  const observer = new MutationObserver(function () {
    applyRateAndMaybePlay(false);
  });
  if (document.body) {
    observer.observe(document.body, { childList: true, subtree: true });
  } else {
    document.addEventListener(
      "DOMContentLoaded",
      function () {
        if (document.body) observer.observe(document.body, { childList: true, subtree: true });
      },
      { once: true }
    );
  }

  window.setInterval(function () {
    applyRateAndMaybePlay(false);
  }, 1000);

  applyRateAndMaybePlay(false);

  // Panel only on the top frame of the main site, and only once a course list exists
  // (or after a short wait, so the user can still set speed on a player page).
  let statusEl = null;
  function setStatus(text) {
    if (statusEl) statusEl.textContent = text;
  }

  if (!isTop || !onMainHost) return;

  function buildPanel() {
    if (document.getElementById("byl-ps-panel")) return;

    const panel = document.createElement("div");
    panel.id = "byl-ps-panel";
    panel.setAttribute("data-byl-ps", "1");
    Object.assign(panel.style, {
      position: "fixed",
      left: "12px",
      top: "12px",
      zIndex: "2147483646",
      width: "270px",
      padding: "12px",
      background: "#fff",
      color: "#222",
      border: "1px solid #d9d9d9",
      borderRadius: "10px",
      boxShadow: "0 6px 18px rgba(0,0,0,.16)",
      font: "13px/1.45 system-ui, -apple-system, sans-serif",
    });

    const title = document.createElement("div");
    title.textContent = "连播与倍速";
    Object.assign(title.style, {
      fontWeight: "600",
      fontSize: "15px",
      marginBottom: "8px",
      cursor: "move",
      userSelect: "none",
    });
    panel.appendChild(title);

    const row = document.createElement("div");
    Object.assign(row.style, { display: "flex", gap: "6px", marginBottom: "8px" });

    const input = document.createElement("input");
    input.type = "number";
    input.min = String(RATE_MIN);
    input.max = String(RATE_MAX);
    input.step = "0.1";
    input.value = String(currentRate);
    Object.assign(input.style, {
      flex: "1",
      minWidth: "0",
      padding: "6px 8px",
      border: "1px solid #ccc",
      borderRadius: "6px",
    });

    const applyBtn = document.createElement("button");
    applyBtn.type = "button";
    applyBtn.textContent = "应用";
    Object.assign(applyBtn.style, {
      padding: "6px 10px",
      border: "0",
      borderRadius: "6px",
      background: "#1677ff",
      color: "#fff",
      cursor: "pointer",
    });

    function applyFromInput() {
      const next = clampRate(input.value);
      input.value = String(next);
      currentRate = next;
      saveRate(next);
      broadcastPlay();
      setStatus("倍速已设为 " + next + "×");
    }
    applyBtn.addEventListener("click", applyFromInput);
    input.addEventListener("keydown", function (e) {
      if (e.key === "Enter") applyFromInput();
    });

    row.appendChild(input);
    row.appendChild(applyBtn);
    panel.appendChild(row);

    const tools = document.createElement("div");
    Object.assign(tools.style, { display: "flex", gap: "6px" });

    const hideBtn = document.createElement("button");
    hideBtn.type = "button";
    hideBtn.textContent = "隐藏";
    Object.assign(hideBtn.style, {
      flex: "1",
      padding: "6px",
      border: "0",
      borderRadius: "6px",
      background: "#f0f0f0",
      cursor: "pointer",
    });
    hideBtn.addEventListener("click", function () {
      panel.style.display = "none";
    });

    const nextBtn = document.createElement("button");
    nextBtn.type = "button";
    nextBtn.textContent = "下一课";
    Object.assign(nextBtn.style, {
      flex: "1",
      padding: "6px",
      border: "0",
      borderRadius: "6px",
      background: "#f0f0f0",
      cursor: "pointer",
    });
    nextBtn.addEventListener("click", clickNextLesson);

    tools.appendChild(hideBtn);
    tools.appendChild(nextBtn);
    panel.appendChild(tools);

    // Local practice-question answer bank: exact question and answer text matching.
    // Does not invent answers, call remote APIs, or submit exams.
    const practice = document.createElement("div");
    practice.style.cssText = "margin-top:10px;padding-top:8px;border-top:1px solid #ddd";
    const practiceTitle = document.createElement("div");
    practiceTitle.textContent = "练习题辅助（本机答案库）";
    practiceTitle.style.cssText = "font-weight:600;margin-bottom:6px";
    practice.appendChild(practiceTitle);
    const bankBtn = document.createElement("button");
    bankBtn.textContent = "导入/编辑答案库";
    bankBtn.type = "button";
    bankBtn.style.cssText = "padding:5px;margin-right:6px";
    bankBtn.addEventListener("click", () => {
      let old = "{}";
      try { old = localStorage.getItem(BANK_KEY) || "{}"; } catch (_) {}
      const value = window.prompt('输入 JSON 对象，例如 {"什么是ATP？":"三磷酸腺苷"}。选项文字需一致。', old);
      if (value === null) return;
      try {
        const parsed = JSON.parse(value);
        if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") throw new Error("需要 JSON 对象");
        if (Object.values(parsed).some(v => typeof v !== "string" && !Array.isArray(v))) throw new Error("答案需为字符串或字符串数组");
        localStorage.setItem(BANK_KEY, JSON.stringify(parsed));
        setStatus("已导入 " + Object.keys(parsed).length + " 道练习题答案");
      } catch (err) { setStatus("答案库格式错误：" + err.message); }
    });
    const fillBtn = document.createElement("button");
    fillBtn.textContent = "辅助填写练习题";
    fillBtn.type = "button";
    fillBtn.style.cssText = "padding:5px";
    fillBtn.addEventListener("click", () => {
      let bank = {};
      try { bank = JSON.parse(localStorage.getItem(BANK_KEY) || "{}"); } catch (_) {}
      const norm = text => String(text || "").replace(/\s+/g, "").replace(/[：:。.!！?？]/g, "").toLowerCase();
      const entries = Object.entries(bank);
      let filled = 0;
      const inputs = Array.from(document.querySelectorAll('input[type="radio"],input[type="checkbox"]'));
      const groups = new Map();
      for (const input of inputs) {
        if (panel.contains(input)) continue;
        const group = input.closest('fieldset,[class*="question"],[class*="Question"],[class*="topic"],[class*="Topic"],li') || input.parentElement?.parentElement;
        if (!group) continue;
        if (!groups.has(group)) groups.set(group, []);
        groups.get(group).push(input);
      }
      for (const [group, choices] of groups) {
        const text = norm(group.textContent);
        const match = entries.find(([question]) => text.includes(norm(question)) && norm(question).length >= 5);
        if (!match) continue;
        const answers = (Array.isArray(match[1]) ? match[1] : [match[1]]).map(norm);
        for (const input of choices) {
          const label = input.closest("label") || (input.id && document.querySelector(`label[for="${CSS.escape(input.id)}"]`)) || input.parentElement;
          const choice = norm(label?.textContent);
          if (choice && answers.some(answer => choice === answer || choice.endsWith(answer))) {
            if (!input.checked) { input.click(); filled++; }
          }
        }
      }
      setStatus("答案库匹配并勾选 " + filled + " 项；请人工检查后提交");
    });
    practice.append(bankBtn, fillBtn);
    panel.appendChild(practice);
    installLearningTools(panel);


    const statsEl = document.createElement("div");
    statsEl.style.cssText = "margin-top:8px;font-size:12px;color:#444";
    panel.appendChild(statsEl);
    const fmtStats = () => {
      const secs = Math.floor(watchStats.seconds);
      statsEl.textContent = `本机累计实际播放：${Math.floor(secs / 60)} 分 ${secs % 60} 秒 · 播放结束 ${watchStats.completed} 次`;
    };
    fmtStats();
    window.setInterval(fmtStats, 1500);

    statusEl = document.createElement("div");
    Object.assign(statusEl.style, {
      marginTop: "8px",
      fontSize: "12px",
      color: "#666",
    });
    statusEl.textContent = "播完自动下一课 · F2 显示/隐藏";
    panel.appendChild(statusEl);

    // Drag by title
    let drag = null;
    title.addEventListener("mousedown", function (e) {
      if (e.button !== 0) return;
      drag = {
        x: e.clientX - panel.offsetLeft,
        y: e.clientY - panel.offsetTop,
      };
      e.preventDefault();
    });
    document.addEventListener("mousemove", function (e) {
      if (!drag) return;
      panel.style.left = Math.max(0, e.clientX - drag.x) + "px";
      panel.style.top = Math.max(0, e.clientY - drag.y) + "px";
    });
    document.addEventListener("mouseup", function () {
      drag = null;
    });

    document.body.appendChild(panel);

    document.addEventListener("keydown", function (e) {
      if (e.key === "F2" && !e.repeat) {
        panel.style.display = panel.style.display === "none" ? "block" : "none";
      }
    });
  }


  // Website-reported progress: read visible UI only. Never synthesize requests or set course-complete flags.
  function readWebsiteProgress() {
    const roots = Array.from(document.querySelectorAll('[class*="progress" i],[class*="percent" i],[role="progressbar"],progress'));
    const found = [];
    roots.slice(0, 100).forEach(el => {
      if (el.closest('#byl-ps-panel')) return;
      const value = el.getAttribute('aria-valuenow') || el.getAttribute('value');
      const max = el.getAttribute('aria-valuemax') || el.getAttribute('max');
      const text = (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 80);
      let percent = null;
      if (value && max && +max > 0) percent = Math.round((+value / +max) * 100);
      else if (value && +value >= 0 && +value <= 100) percent = +value;
      else {
        const match = text.match(/(?:学习|观看|完成|课程|进度)?[^\d]{0,8}(\d{1,3}(?:\.\d+)?)\s*%/);
        if (match) percent = +match[1];
      }
      if (percent !== null && percent >= 0 && percent <= 100) {
        found.push(`${percent}%${text ? ' · ' + text : ''}`);
      }
    });
    return [...new Set(found)].slice(0, 5);
  }

  function getAssistConfig() {
    let c = {};
    try { c = JSON.parse(localStorage.getItem(ASSIST_CFG) || '{}'); } catch (_) {}
    return Object.assign({ url: 'https://api.openai.com/v1/chat/completions', model:'gpt-4.1-mini', key:'', autoSubmit:false }, c);
  }
  function putAssistConfig(c) {
    try { localStorage.setItem(ASSIST_CFG, JSON.stringify(c)); } catch (_) {}
  }
  const normAssist = s => String(s || '').replace(/\s+/g,'').replace(/[：:。.!！?？]/g,'').toLowerCase();
  function extractPracticeQuestions() {
    const candidates = Array.from(document.querySelectorAll('fieldset,[class*="question" i],[class*="topic" i],[class*="exam-item" i]'));
    const groups = [];
    const seen = new Set();
    for (const root of candidates) {
      if (root.closest('#byl-ps-panel')) continue;
      if (root.querySelectorAll('input[type="radio"],input[type="checkbox"]').length < 2) continue;
      if (Array.from(root.children).some(c => candidates.includes(c) && c.querySelector('input[type="radio"],input[type="checkbox"]'))) continue;
      const inputs = Array.from(root.querySelectorAll('input[type="radio"],input[type="checkbox"]'));
      if (inputs.length > 12 || seen.has(inputs[0])) continue;
      seen.add(inputs[0]);
      const options = inputs.map((input, index) => {
        const label = input.closest('label') || (input.id && document.querySelector(`label[for="${CSS.escape(input.id)}"]`)) || input.parentElement;
        return { index, label: String(label?.textContent || input.value || '').trim().replace(/\s+/g,' '), input };
      });
      const clone = root.cloneNode(true);
      clone.querySelectorAll('label,input,button,select,textarea').forEach(x => x.remove());
      const title = (clone.textContent || root.textContent || '').trim().replace(/\s+/g,' ').slice(0,500);
      if (title.length < 5) continue;
      groups.push({root, title, options, multiple: inputs[0].type === 'checkbox'});
    }
    return groups;
  }
  function aiRequest(config, questions) {
    if (!config.key) return Promise.reject(new Error('请先配置自己的 API Key'));
    const url = new URL(config.url);
    if (url.protocol !== 'https:') return Promise.reject(new Error('API 地址必须是 HTTPS'));
    if (!/^[\w.-]+$/.test(config.model)) return Promise.reject(new Error('模型名格式错误'));
    const payload = {
      model:config.model, temperature:0,
      messages:[
        {role:'system',content:'你是医学科普自测练习辅助工具。请谨慎回答；无法确认则返回空数组。只能输出JSON对象 {"answers":[{"id":0,"indices":[1],"confidence":"high|medium|low","reason":"简短理由"}]}。indices为选项的零基序号。不要编造。'},
        {role:'user',content:JSON.stringify(questions.map((q,id) => ({id,question:q.title, multiple:q.multiple, options:q.options.map(o=>o.label)})))}
      ]
    };
    return new Promise((resolve,reject) => {
      if (typeof GM_xmlhttpRequest !== 'function') return reject(new Error('脚本管理器未提供网络请求权限'));
      GM_xmlhttpRequest({method:'POST',url:url.href,headers:{'Content-Type':'application/json','Authorization':'Bearer '+config.key},data:JSON.stringify(payload),timeout:30000,
        onload:r=> {try {
          if(r.status < 200 || r.status >= 300) throw new Error('API HTTP '+r.status+' '+String(r.responseText).slice(0,180));
          const raw=JSON.parse(r.responseText).choices?.[0]?.message?.content;
          const match=String(raw || '').match(/\{[\s\S]*\}/);
          if(!match) throw new Error('模型未返回答案 JSON');
          const decoded=JSON.parse(match[0]);
          if(!Array.isArray(decoded.answers)) throw new Error('答案结构错误');
          resolve(decoded.answers);
        }catch(e){reject(e)}},onerror:()=>reject(new Error('请求失败，检查域名和跨域授权')),ontimeout:()=>reject(new Error('请求超时'))
      });
    });
  }
  function fillAIAnswers(questions, answers) {
    let matched = 0, incomplete = [];
    for(let i=0;i<questions.length;i++) {
      const q = questions[i];
      const result = answers.find(a=>a.id===i);
      const inds = Array.isArray(result?.indices) ? result.indices : [];
      if (result?.confidence !== 'high' || !inds.length || (!q.multiple && inds.length !== 1) || inds.some(j=>!Number.isInteger(j)||j<0||j>=q.options.length)) {
        incomplete.push(i+1); continue;
      }
      for(const j of inds) {
        const target=q.options[j].input;
        if(!target.checked) target.click();
      }
      if (inds.every(j=>q.options[j].input.checked)) matched++;
      else incomplete.push(i+1);
    }
    return {matched,incomplete};
  }
  function trySubmitPractice(questions) {
    if (!questions.length) throw new Error('没有找到练习题');
    const roots = [...new Set(questions.map(q=>q.root.closest('form') || q.root.parentElement))];
    const buttons = roots.flatMap(r=>Array.from(r.querySelectorAll('button,input[type="submit"],[role="button"]')));
    const submit = buttons.find(b=>/^(提交|交卷|完成练习|提交答案|submit)$/i.test((b.textContent || b.value || '').trim()));
    if(!submit) throw new Error('找不到练习页面原有的提交按钮，需要页面适配');
    submit.click(); // normal site's own submit button: no forged scores/progress
  }
  function installLearningTools(panel) {
    const shell=document.createElement('div');
    shell.style.cssText='border-top:1px solid #ddd;margin-top:10px;padding-top:8px;font-size:12px';
    const heading=document.createElement('strong');heading.textContent='进度与智能练习（实验功能）';shell.appendChild(heading);
    const progress=document.createElement('div');progress.style.cssText='margin:5px 0;color:#555';shell.appendChild(progress);
    const refresh=()=>{const p=readWebsiteProgress(); progress.textContent=p.length ? '网页可见进度：'+p.join(' / ') : '网页未找到可识别的进度标记（不等于0%）';};
    const pbtn=document.createElement('button');pbtn.textContent='刷新网页进度';pbtn.addEventListener('click',refresh);shell.appendChild(pbtn);refresh();
    const config=getAssistConfig();
    const cfgBtn=document.createElement('button');cfgBtn.textContent='配置AI';cfgBtn.style.marginLeft='5px';shell.appendChild(cfgBtn);
    cfgBtn.addEventListener('click',()=>{
      const url=prompt('OpenAI兼容 Chat Completions HTTPS 地址（你提交的题目会发往该服务）',config.url);
      if(url===null)return;
      const model=prompt('模型名称',config.model);if(model===null)return;
      const key=prompt('API Key（本机localStorage保存；共享电脑勿使用）',config.key);if(key===null)return;
      try{if(new URL(url).protocol!=='https:')throw Error('必须使用HTTPS');Object.assign(config,{url,model,key});putAssistConfig(config);setStatus('AI设置已保存，只有点击识题时才调用');}catch(e){setStatus('配置失败：'+e.message)}
    });
    const quizBtn=document.createElement('button');quizBtn.textContent='识别题目并建议答案';quizBtn.style.cssText='display:block;margin-top:6px';shell.appendChild(quizBtn);
    const log=document.createElement('div');log.style.cssText='margin:5px 0;max-height:130px;overflow:auto;white-space:pre-wrap';shell.appendChild(log);
    let ready=false, latest=[];
    quizBtn.addEventListener('click',async()=>{
      ready=false; const questions=extractPracticeQuestions();latest=questions;
      if(!questions.length){log.textContent='没有识别到练习题；可能需要针对真实网页适配选择器。';return}
      log.textContent=`发现 ${questions.length} 道题，正在获取建议答案…`;
      try{
        const answers=await aiRequest(config,questions);
        const result=fillAIAnswers(questions,answers);
        ready=result.matched===questions.length && questions.length>0;
        log.textContent=`识别 ${questions.length} 题，高置信填写 ${result.matched} 题。`+(result.incomplete.length?`\n未确定：第 ${result.incomplete.join(',')} 题。`:'')+'\nAI 可能出错。';
        if (ready && toggle.checked) {
          try {trySubmitPractice(questions); log.textContent+='\n已自动点击网站练习提交按钮，请确认结果。';ready=false;}
          catch(e){log.textContent+='\n自动提交失败：'+e.message}
        }
      }catch(e){log.textContent='失败：'+e.message}
    });
    const autoLabel=document.createElement('label');autoLabel.style.cssText='display:block;margin-top:6px';
    const toggle=document.createElement('input');toggle.type='checkbox';toggle.checked=false;
    toggle.addEventListener('change',()=>{if(toggle.checked && !confirm('开启后，点击“识别题目并建议答案”时，若所有题目均得到高置信建议，将自动点击网页的提交按钮。模型可能答错。确定开启？'))toggle.checked=false;config.autoSubmit=toggle.checked;putAssistConfig(config)});
    autoLabel.append(toggle,document.createTextNode(' 自动提交全部高置信练习题（默认关闭）'));shell.appendChild(autoLabel);
    const submitBtn=document.createElement('button');submitBtn.textContent='检查并提交练习';submitBtn.style.marginTop='6px';shell.appendChild(submitBtn);
    submitBtn.addEventListener('click',()=>{
      if(!toggle.checked){log.textContent='请先主动勾选允许提交';return}
      if(!ready||latest.length===0){log.textContent='请先识题并确保所有题目均高置信填写';return}
      if(!confirm(`将调用网页自己的提交按钮，提交 ${latest.length} 道练习题。确定吗？`))return;
      try{trySubmitPractice(latest);log.textContent='已点击网页提交按钮，请检查网站是否成功接收';ready=false}catch(e){log.textContent='提交未完成：'+e.message}
    });
    panel.appendChild(shell);
  }

  function waitForBodyAndBuild() {
    if (!document.body) {
      document.addEventListener("DOMContentLoaded", waitForBodyAndBuild, { once: true });
      return;
    }
    buildPanel();
  }
  waitForBodyAndBuild();
})();