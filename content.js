/**
 * content.js
 * 商品详情页内容脚本：
 *   1. 判断当前页是否为平台商品详情页，是才注入右下角悬浮按钮
 *   2. 点击后自动滚动一遍页面触发懒加载，再调用 ImageGrab.extractImages 提取
 *   3. 通过 chrome.runtime.sendMessage 把图片列表交给 Service Worker
 *
 * 依赖：shared/extract.js（在 manifest 里先于本文件加载）
 */
(function () {
  'use strict';

  var api = globalThis.ImageGrab;
  if (!api) return;

  // 幂等保护：内容脚本自动注入 + 工具栏手动注入可能同时发生
  if (window.__imgGrabLoaded) return;
  window.__imgGrabLoaded = true;

  var MSG_IMAGES = 'IMG_GRAB_IMAGES';
  var MSG_TRIGGER = 'IMG_GRAB_TRIGGER';
  var MSG_PING = 'IMG_GRAB_PING';

  var platform = api.detectPlatform(location.hostname);
  var isDebug = api.isDebugHost(location.hostname);
  // 本地调试页放行；其余只允许平台商品详情页显示按钮
  var allowed = isDebug || (platform !== 'unknown' && api.isDetailPage(location.href, platform));

  var rootEl = null;
  var btnEl = null;
  var toastEl = null;
  var toastTimer = 0;
  var busy = false;

  // ------------------------------------------------------------ 通信小工具

  function sendMessage(msg) {
    return new Promise(function (resolve, reject) {
      try {
        chrome.runtime.sendMessage(msg, function (res) {
          var err = chrome.runtime.lastError;
          if (err) reject(new Error(err.message || '扩展通信失败'));
          else resolve(res);
        });
      } catch (e) {
        reject(new Error('扩展上下文已失效，请刷新页面后重试'));
      }
    });
  }

  function sleep(ms) {
    return new Promise(function (r) {
      setTimeout(r, ms);
    });
  }

  // ---------------------------------------------------------------- 悬浮按钮

  function ensureUI() {
    if (rootEl && document.documentElement.contains(rootEl)) return;

    rootEl = document.createElement('div');
    rootEl.id = 'img-grab-root';
    // 定位相关的属性用内联 !important 写死，避免被平台的全局样式覆盖
    rootEl.setAttribute(
      'style',
      'all: initial; position: fixed !important; right: 20px !important; bottom: 90px !important;' +
        ' z-index: 2147483000 !important; display: block !important; line-height: 0 !important;'
    );

    btnEl = document.createElement('button');
    btnEl.type = 'button';
    btnEl.className = 'ig-btn';
    btnEl.textContent = '获取图片';
    btnEl.title = '提取当前页面所有商品图片';
    btnEl.addEventListener('click', onButtonClick);

    toastEl = document.createElement('div');
    toastEl.className = 'ig-toast';
    toastEl.hidden = true;

    rootEl.appendChild(btnEl);
    rootEl.appendChild(toastEl);
    document.documentElement.appendChild(rootEl);
  }

  function setButton(state, text) {
    if (!btnEl) return;
    btnEl.classList.remove('is-busy', 'is-done', 'is-warn');
    if (state === 'busy') btnEl.classList.add('is-busy');
    else if (state === 'done') btnEl.classList.add('is-done');
    else if (state === 'warn') btnEl.classList.add('is-warn');
    if (text) btnEl.textContent = text;
  }

  function toast(message, type) {
    if (!toastEl) return;
    toastEl.textContent = message;
    toastEl.className = 'ig-toast' + (type ? ' ig-toast--' + type : '');
    toastEl.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      if (toastEl) toastEl.hidden = true;
    }, 5200);
  }

  function resetButtonLater() {
    setTimeout(function () {
      if (busy) return;
      setButton('idle', '获取图片');
    }, 4000);
  }

  // ---------------------------------------------------------------- 提取流程

  /**
   * 自动滚一遍页面触发懒加载（淘宝/京东/拼多多的详情图都是滚动后才真正加载）
   * 结束后回到原位置，避免打扰用户
   */
  function autoScroll(onProgress) {
    var step = Math.max(Math.round(window.innerHeight * 0.85), 400);
    var maxSteps = 40; // 上限，防止无限循环
    var deadline = Date.now() + 15000;
    var startY = window.scrollY;

    return (async function () {
      window.scrollTo(0, 0);
      await sleep(150);

      for (var i = 0; i < maxSteps; i++) {
        if (Date.now() > deadline) break;

        // 每一轮都重新量一次高度：懒加载出来的内容会把页面撑长
        var height = Math.max(
          document.body ? document.body.scrollHeight : 0,
          document.documentElement.scrollHeight
        );
        var maxScroll = Math.max(height - window.innerHeight, 0);
        var y = Math.min(i * step, maxScroll);
        window.scrollTo(0, y);
        if (onProgress) onProgress(Math.min(0.95, (i + 1) / 12));

        // 已经到底，给懒加载留出加载时间后收工
        if (y >= maxScroll) break;
        await sleep(200);
      }

      window.scrollTo(0, startY);
      if (onProgress) onProgress(1);
      await sleep(250);
    })();
  }

  /**
   * 执行一次完整提取
   * @param {{silent?: boolean}} [opts] silent 为 true 时不依赖悬浮按钮（用于工具栏手动触发）
   */
  async function runExtraction(opts) {
    var silent = !!(opts && opts.silent);
    if (busy) return { ok: false, error: '正在提取中，请稍候' };
    busy = true;
    var progress = function (p) {
      if (silent) return;
      setButton('busy', '扫描中 ' + Math.round(p * 100) + '%');
    };
    if (!silent) setButton('busy', '扫描中 0%');

    try {
      await autoScroll(progress);
      var images = api.extractImages(document, location.href, platform);

      if (!images.length) {
        if (!silent) setButton('warn', '未找到图片');
        toast('没有识别到商品图片，等图片加载完再点一次试试', 'warn');
        resetButtonLater();
        return { ok: false, error: 'no-image' };
      }

      var res = await sendMessage({
        type: MSG_IMAGES,
        platform: platform,
        pageUrl: location.href,
        pageTitle: document.title,
        images: images
      });

      if (!silent) setButton('done', '已找到 ' + images.length + ' 张');
      if (!res || res.ok === false) {
        toast('打开图片列表失败：' + ((res && res.error) || '未知错误'), 'error');
      }
      resetButtonLater();
      return { ok: true, count: images.length, sid: res && res.sid };
    } catch (e) {
      if (!silent) setButton('idle', '获取图片');
      toast('提取失败：' + (e && e.message ? e.message : e), 'error');
      return { ok: false, error: String((e && e.message) || e) };
    } finally {
      busy = false;
    }
  }

  function onButtonClick() {
    runExtraction({ silent: false });
  }

  // ---------------------------------------------------------------- 消息监听

  // 无论是否显示按钮都注册监听：工具栏图标可以在任意页面手动触发一次提取
  chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (!msg || typeof msg.type !== 'string') return;
    if (msg.type === MSG_TRIGGER) {
      runExtraction({ silent: !allowed })
        .then(function (r) {
          sendResponse(r);
        })
        .catch(function (e) {
          sendResponse({ ok: false, error: String(e) });
        });
      return true; // 异步响应
    }
    if (msg.type === MSG_PING) {
      sendResponse({ ok: true, platform: platform, allowed: allowed });
      return true;
    }
  });

  // 非详情页直接结束，保证「其他页面不显示按钮」
  if (!allowed) return;

  ensureUI();

  // 单页应用路由切换后按钮可能被清掉，监听一下补回来
  var mo = new MutationObserver(function () {
    if (rootEl && !document.documentElement.contains(rootEl)) {
      document.documentElement.appendChild(rootEl);
    }
  });
  try {
    mo.observe(document.documentElement, { childList: true });
  } catch (e) {
    /* 忽略：极端情况下观察失败不影响主流程 */
  }
})();
