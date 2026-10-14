/**
 * background.js — Service Worker
 *
 * 职责（刻意保持轻量，MV3 里 SW 随时可能被回收，所以不保存任何内存状态）：
 *   1. 接收内容脚本发来的图片列表，写入 chrome.storage.session 暂存
 *   2. 打开（或复用）gallery.html 标签页展示结果
 *   3. 工具栏图标点击时的兜底注入：按钮没出现的页面也能手动触发提取
 *
 * 注意：PNG 转换与下载不在这里做。SW 没有 DOM / canvas / createObjectURL，
 *       转 PNG 需要 canvas，统一放在扩展页面 gallery.html 里执行。
 */
'use strict';

/** storage.session 的键前缀，避免和别的东西撞名 */
var STORE_PREFIX = 'imgGrab:item:';
var LAST_KEY = 'imgGrab:last';
var GALLERY_TAB_KEY = 'imgGrab:galleryTabId';

var MSG_IMAGES = 'IMG_GRAB_IMAGES';
var MSG_TRIGGER = 'IMG_GRAB_TRIGGER';

/** 生成一个短会话 id */
function newSid() {
  return 'g' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

/**
 * 打开画廊页；已经开过就复用同一个标签页，避免开一堆重复页
 * @param {string|null} sid 会话 id，画廊页据此取数据
 */
async function openGallery(sid) {
  var url = chrome.runtime.getURL('gallery.html') + (sid ? '?sid=' + encodeURIComponent(sid) : '');

  try {
    var store = await chrome.storage.session.get(GALLERY_TAB_KEY);
    var tabId = store[GALLERY_TAB_KEY];
    if (typeof tabId === 'number') {
      await chrome.tabs.update(tabId, { url: url, active: true });
      try {
        var tab = await chrome.tabs.get(tabId);
        if (tab && typeof tab.windowId === 'number') {
          await chrome.windows.update(tab.windowId, { focused: true });
        }
      } catch (e) {
        /* 取不到标签页信息不影响展示 */
      }
      return tabId;
    }
  } catch (e) {
    /* 标签页已被关闭，走下面的新建分支 */
  }

  var created = await chrome.tabs.create({ url: url, active: true });
  try {
    await chrome.storage.session.set({ [GALLERY_TAB_KEY]: created.id });
  } catch (e) {
    /* 写入失败只是下次无法复用标签页 */
  }
  return created.id;
}

/**
 * 处理内容脚本提交的图片列表
 */
async function handleImages(msg, sender) {
  var images = Array.isArray(msg.images)
    ? msg.images.filter(function (it) {
        return it && typeof it.url === 'string' && it.url;
      })
    : [];

  if (!images.length) return { ok: false, error: '没有可用的图片地址' };

  var sid = newSid();
  var payload = {
    sid: sid,
    pageUrl: msg.pageUrl || '',
    pageTitle: msg.pageTitle || '',
    platform: msg.platform || 'unknown',
    tabId: sender && sender.tab ? sender.tab.id : null,
    createdAt: Date.now(),
    images: images
  };

  var patch = {};
  patch[STORE_PREFIX + sid] = payload;
  patch[LAST_KEY] = sid;
  await chrome.storage.session.set(patch);

  // 顺手清理太老的会话，避免 session 存储无限膨胀
  pruneOldSessions(sid).catch(function () {});

  await openGallery(sid);
  return { ok: true, sid: sid, count: images.length };
}

/** 只保留最近 8 个会话 */
async function pruneOldSessions(keepSid) {
  var all = await chrome.storage.session.get(null);
  var entries = [];
  Object.keys(all).forEach(function (key) {
    if (key.indexOf(STORE_PREFIX) === 0 && key !== STORE_PREFIX + keepSid) {
      entries.push({ key: key, createdAt: (all[key] && all[key].createdAt) || 0 });
    }
  });
  if (entries.length <= 8) return;
  entries.sort(function (a, b) {
    return b.createdAt - a.createdAt;
  });
  var toRemove = entries.slice(8).map(function (e) {
    return e.key;
  });
  if (toRemove.length) await chrome.storage.session.remove(toRemove);
}

// ---------------------------------------------------------------- 消息路由

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (!msg || typeof msg.type !== 'string') return;

  if (msg.type === MSG_IMAGES) {
    handleImages(msg, sender)
      .then(sendResponse)
      .catch(function (e) {
        sendResponse({ ok: false, error: String((e && e.message) || e) });
      });
    return true; // 异步响应
  }
});

// ------------------------------------------------- 工具栏图标的兜底注入

chrome.action.onClicked.addListener(async function (tab) {
  if (!tab || typeof tab.id !== 'number') return;
  var url = tab.url || '';
  if (!/^(?:https?|file):/i.test(url)) return;

  // 样式先注入，保证按钮即使是通过兜底路径出现也有外观
  try {
    await chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: ['content.css'] });
  } catch (e) {
    /* 已注入过或页面受限，忽略 */
  }

  var injected = false;
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['shared/extract.js', 'content.js']
    });
    injected = true;
  } catch (e) {
    console.warn('[图片提取] 注入脚本失败：', e);
  }

  // 通知内容脚本立即跑一次提取（已注入的情况下是唯一有效路径）
  try {
    await chrome.tabs.sendMessage(tab.id, { type: MSG_TRIGGER });
  } catch (e) {
    if (!injected) console.warn('[图片提取] 当前页面无法通信：', e);
  }
});

// ---------------------------------------------------------------- 生命周期

chrome.runtime.onInstalled.addListener(async function () {
  try {
    await chrome.storage.session.clear();
  } catch (e) {
    /* 忽略 */
  }
});

// 画廊标签页被关掉后清掉记录，下次重新新建
chrome.tabs.onRemoved.addListener(async function (tabId) {
  try {
    var store = await chrome.storage.session.get(GALLERY_TAB_KEY);
    if (store[GALLERY_TAB_KEY] === tabId) {
      await chrome.storage.session.remove(GALLERY_TAB_KEY);
    }
  } catch (e) {
    /* 忽略 */
  }
});
