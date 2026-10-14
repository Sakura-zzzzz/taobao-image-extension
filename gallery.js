/**
 * gallery.js
 * 提取结果展示页：
 *   1. 从 chrome.storage.session 读取内容脚本提交的图片列表
 *   2. 网格展示缩略图 / 尺寸 / 复选框，支持全选、反选、尺寸筛选
 *   3. 勾选后批量下载：fetch -> canvas 转 PNG -> chrome.downloads.download
 *      （fetch 跨域能通是因为 manifest 里声明了对应 host_permissions；
 *        转不了 PNG 的图会回退成原格式下载，并在结果里明确标注）
 */
'use strict';

var STORE_PREFIX = 'imgGrab:item:';
var LAST_KEY = 'imgGrab:last';

/** session 存储不可用时（老版本 Chrome）退回 local */
var store = chrome.storage.session || chrome.storage.local;

var dom = {
  meta: document.getElementById('meta'),
  grid: document.getElementById('grid'),
  empty: document.getElementById('empty'),
  tpl: document.getElementById('cardTpl'),
  selectAll: document.getElementById('selectAll'),
  btnInvert: document.getElementById('btnInvert'),
  btnPickLarge: document.getElementById('btnPickLarge'),
  minSize: document.getElementById('minSize'),
  showSmall: document.getElementById('showSmall'),
  counter: document.getElementById('counter'),
  btnDownload: document.getElementById('btnDownload'),
  progressWrap: document.getElementById('progressWrap'),
  progressBar: document.getElementById('progressBar'),
  progressText: document.getElementById('progressText'),
  report: document.getElementById('report'),
  reportTitle: document.getElementById('reportTitle'),
  reportList: document.getElementById('reportList'),
  btnCopyReport: document.getElementById('btnCopyReport'),
  btnCloseReport: document.getElementById('btnCloseReport'),
  toast: document.getElementById('toast')
};

var state = {
  items: [], // { url, domain, width, height, measured, failed, selected, card, needOrigin }
  busy: false,
  userTouched: false, // 用户手动改过勾选后，不再自动勾选
  reportEntries: []
};

var toastTimer = 0;

// ---------------------------------------------------------------- 工具函数

function toast(message, ms) {
  dom.toast.textContent = message;
  dom.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(function () {
    dom.toast.hidden = true;
  }, ms || 3600);
}

function sleep(ms) {
  return new Promise(function (r) {
    setTimeout(r, ms);
  });
}

function nowText() {
  var d = new Date();
  function p(n) {
    return String(n).padStart(2, '0');
  }
  return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}

function originOf(url) {
  try {
    return new URL(url).origin;
  } catch (e) {
    return '';
  }
}

/** 猜原图扩展名，用于回退下载时的文件名 */
function guessExt(url) {
  var m = /\.(png|jpe?g|webp|gif|bmp|avif|svg)(?:$|[?#])/i.exec(url.split('#')[0]);
  if (!m) return 'jpg';
  var ext = m[1].toLowerCase();
  return ext === 'jpeg' ? 'jpg' : ext;
}

function describeError(err) {
  if (!err) return '未知错误';
  return String((err && err.message) || err);
}

function makeError(message, code) {
  var e = new Error(message);
  if (code) e.code = code;
  return e;
}

// ------------------------------------------------------------ 读取提取结果

async function loadPayload() {
  var sid = new URLSearchParams(location.search).get('sid');
  if (sid) {
    var key = STORE_PREFIX + sid;
    var one = await store.get(key);
    if (one && one[key]) return one[key];
  }
  // 兜底：直接打开 gallery.html（或标签页被复用）时取最近一次提取结果
  var all = await store.get(null);
  var sessions = Object.keys(all)
    .filter(function (k) {
      return k.indexOf(STORE_PREFIX) === 0 && all[k] && all[k].images;
    })
    .map(function (k) {
      return all[k];
    })
    .sort(function (a, b) {
      return (b.createdAt || 0) - (a.createdAt || 0);
    });
  return sessions[0] || null;
}

// ---------------------------------------------------------------- 渲染网格

function minSide() {
  var v = parseInt(dom.minSize.value, 10);
  return isNaN(v) || v < 0 ? 0 : v;
}

function isSmall(item) {
  if (!item.measured) return false; // 还没测到尺寸的先按大图处理
  var m = minSide();
  return item.width < m || item.height < m;
}

function refreshSmallState() {
  state.items.forEach(function (item) {
    if (item.card) item.card.classList.toggle('is-small', isSmall(item));
  });
}

function updateCounter() {
  var selected = state.items.filter(function (it) {
    return it.selected;
  }).length;
  dom.counter.textContent = '已选 ' + selected + ' 张';

  var selectable = state.items.filter(function (it) {
    return !it.failed;
  });
  var allSelected = selectable.length > 0 && selected >= selectable.length;
  dom.selectAll.checked = allSelected;
  dom.selectAll.indeterminate = selected > 0 && !allSelected;

  dom.btnDownload.disabled = state.busy || selected === 0;
}

function setSelected(item, on, fromUser) {
  if (fromUser) state.userTouched = true;
  if (item.failed && on) return;
  item.selected = !!on;
  if (item.card) {
    item.card.classList.toggle('is-selected', item.selected);
    var cb = item.card.querySelector('input[type=checkbox]');
    if (cb) cb.checked = item.selected;
  }
  updateCounter();
}

function createCard(item) {
  var node = dom.tpl.content.firstElementChild.cloneNode(true);
  var img = node.querySelector('img');
  var dims = node.querySelector('.card__dims');
  var domainEl = node.querySelector('.card__domain');
  var badge = node.querySelector('.card__badge');
  var actions = node.querySelector('.card__actions');
  var btnRetry = node.querySelector('.mini--retry');
  var btnGrant = node.querySelector('.mini--grant');
  var cb = node.querySelector('input[type=checkbox]');

  item.card = node;
  item.img = img;

  domainEl.textContent = item.domain || '';
  domainEl.title = item.url;

  // 勾选交互：复选框与点击缩略图都能切换
  cb.addEventListener('change', function () {
    setSelected(item, cb.checked, true);
  });
  img.addEventListener('click', function () {
    setSelected(item, !item.selected, true);
  });

  function markLoaded() {
    item.measured = true;
    item.width = img.naturalWidth || 0;
    item.height = img.naturalHeight || 0;
    dims.textContent = item.width + ' × ' + item.height;
    node.classList.remove('is-failed');
    actions.hidden = true;

    if (isSmall(item)) {
      node.classList.add('is-small');
      setSelected(item, false);
    } else {
      node.classList.remove('is-small');
      // 默认帮用户勾选符合尺寸要求的图，除非用户已经手动改过
      if (!state.userTouched) setSelected(item, true);
    }
    updateCounter();
  }

  function markFailed() {
    item.failed = true;
    item.measured = true;
    dims.textContent = '加载失败';
    node.classList.add('is-failed');
    badge.hidden = false;
    badge.textContent = '加载失败';
    actions.hidden = false;
    setSelected(item, false);
    updateCounter();
  }

  img.addEventListener('load', markLoaded);
  img.addEventListener('error', markFailed);
  img.src = item.url;
  // 命中缓存的图片不会触发 load 事件，这里主动补一次
  if (img.complete && img.naturalWidth > 0) markLoaded();

  btnRetry.addEventListener('click', function () {
    item.failed = false;
    node.classList.remove('is-failed');
    badge.hidden = true;
    dims.textContent = '测量中…';
    img.src = item.url + (item.url.indexOf('?') === -1 ? '?' : '&') + '_igr=' + Date.now();
  });

  // 授权按钮：下载时发现缺少该域名权限才会显示
  if (item.needOrigin) {
    btnGrant.hidden = false;
    btnGrant.textContent = '授权 ' + item.needOrigin;
  }
  btnGrant.addEventListener('click', async function () {
    var origin = item.needOrigin;
    if (!origin) return;
    // 必须在用户手势里直接调用，中间不能有 await
    var granted = false;
    try {
      granted = await chrome.permissions.request({ origins: [origin + '/*'] });
    } catch (e) {
      granted = false;
    }
    if (!granted) {
      toast('没有拿到 ' + origin + ' 的访问权限，这张图无法转 PNG');
      return;
    }
    toast('已授权 ' + origin + '，正在重试');
    item.needOrigin = null;
    retrySingle(item);
  });

  if (item.upgraded) {
    badge.hidden = false;
    badge.textContent = '已取原图';
  }

  return node;
}

function render(payload) {
  dom.grid.innerHTML = '';
  state.items = [];
  state.reportEntries = [];
  dom.report.hidden = true;

  var list = (payload && payload.images) || [];
  if (!list.length) {
    dom.empty.hidden = false;
    dom.meta.textContent = '没有可用的提取结果';
    updateCounter();
    return;
  }

  dom.empty.hidden = true;
  var title = payload.pageTitle || payload.pageUrl || '未知页面';
  dom.meta.textContent = title + ' · 共 ' + list.length + ' 张 · ' + nowText();
  dom.meta.title = payload.pageUrl || '';
  dom.grid.classList.toggle('hide-small', !dom.showSmall.checked);

  list.forEach(function (raw) {
    var item = {
      url: raw.url,
      domain: raw.domain || '',
      width: raw.width || 0,
      height: raw.height || 0,
      upgraded: !!raw.upgraded,
      measured: raw.width > 0,
      failed: false,
      selected: false,
      card: null,
      img: null,
      needOrigin: null
    };
    state.items.push(item);
    dom.grid.appendChild(createCard(item));
  });

  updateCounter();
}

// ------------------------------------------------------------ 选择相关操作

function selectAll(on) {
  state.userTouched = true;
  state.items.forEach(function (item) {
    setSelected(item, on);
  });
}

function invertSelection() {
  state.userTouched = true;
  state.items.forEach(function (item) {
    setSelected(item, !item.selected);
  });
}

function pickLarge() {
  state.userTouched = true;
  state.items.forEach(function (item) {
    setSelected(item, !isSmall(item) && !item.failed);
  });
}

// ------------------------------------------------------------ 下载核心逻辑

/** 该 URL 的域名是否已经拿到权限（决定失败时是提示授权还是直接回退） */
async function hasPermission(url) {
  try {
    var origin = originOf(url) + '/*';
    return await chrome.permissions.contains({ origins: [origin] });
  } catch (e) {
    return false;
  }
}

/** 用扩展页面的 fetch 拿图：host_permissions 命中时不受 CORS 限制 */
async function fetchAsPng(url) {
  var res;
  try {
    res = await fetch(url, { credentials: 'omit', cache: 'force-cache' });
  } catch (e) {
    var need = !(await hasPermission(url));
    throw makeError(
      need ? '请求被拦截（缺少 ' + originOf(url) + ' 的访问权限）' : '请求图片失败：' + describeError(e),
      need ? 'NEED_PERMISSION' : 'FETCH_FAILED'
    );
  }
  if (!res.ok) throw makeError('HTTP ' + res.status + ' ' + res.statusText);
  var blob = await res.blob();
  if (!blob || !blob.size) throw makeError('图片内容为空');
  if (blob.type === 'image/png') return { blob: blob, converted: false };
  return { blob: await convertToPng(blob), converted: true };
}

function loadImage(src) {
  return new Promise(function (resolve, reject) {
    var img = new Image();
    var timer = setTimeout(function () {
      reject(new Error('图片解码超时'));
    }, 20000);
    img.onload = function () {
      clearTimeout(timer);
      resolve(img);
    };
    img.onerror = function () {
      clearTimeout(timer);
      reject(new Error('图片解码失败'));
    };
    img.src = src;
  });
}

function canvasToPng(canvas) {
  return new Promise(function (resolve, reject) {
    try {
      canvas.toBlob(function (blob) {
        if (blob && blob.size) resolve(blob);
        else reject(new Error('canvas 输出为空'));
      }, 'image/png');
    } catch (e) {
      reject(new Error('canvas 导出失败：' + describeError(e)));
    }
  });
}

/** 把图片画进 canvas 再导出 PNG；大图可能超过 canvas 上限，需要给出明确报错 */
async function convertToPng(blob) {
  try {
    var bitmap = await createImageBitmap(blob);
    var w = bitmap.width;
    var h = bitmap.height;
    if (!w || !h) {
      if (bitmap.close) bitmap.close();
      throw new Error('图片尺寸为 0');
    }
    var canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    var ctx = canvas.getContext('2d');
    ctx.drawImage(bitmap, 0, 0, w, h);
    if (bitmap.close) bitmap.close();
    return await canvasToPng(canvas);
  } catch (e) {
    // SVG、异常编码等 createImageBitmap 处理不了的格式，回退到 <img> + drawImage
    return await convertViaImage(blob, e);
  }
}

async function convertViaImage(blob, cause) {
  var objUrl = URL.createObjectURL(blob);
  try {
    var img = await loadImage(objUrl);
    var w = img.naturalWidth || 1000;
    var h = img.naturalHeight || 1000;
    var canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    var ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0, w, h);
    return await canvasToPng(canvas);
  } catch (e) {
    throw new Error('转 PNG 失败：' + describeError(cause || e));
  } finally {
    URL.revokeObjectURL(objUrl);
  }
}

/**
 * 发起下载并等待完成（chrome.downloads.download 回调只代表「已开始」）
 * @returns {Promise<number>} downloadId
 */
function startDownload(url, filename) {
  return new Promise(function (resolve, reject) {
    var settled = false;
    try {
      chrome.downloads.download(
        { url: url, filename: filename, conflictAction: 'uniquify', saveAs: false },
        function (downloadId) {
          var lastErr = chrome.runtime.lastError;
          if (lastErr || typeof downloadId !== 'number') {
            reject(new Error((lastErr && lastErr.message) || '下载启动失败'));
            return;
          }
          var timer = setTimeout(function () {
            finish(); // 超时不再等待，按「已提交」处理
          }, 90000);

          function cleanup() {
            clearTimeout(timer);
            chrome.downloads.onChanged.removeListener(onChanged);
          }
          function finish() {
            if (settled) return;
            settled = true;
            cleanup();
            resolve(downloadId);
          }
          function fail(err) {
            if (settled) return;
            settled = true;
            cleanup();
            reject(err);
          }
          function onChanged(delta) {
            if (delta.id !== downloadId) return;
            var cur = delta.state && delta.state.current;
            if (cur === 'complete') finish();
            else if (cur === 'interrupted') {
              fail(new Error('下载中断：' + ((delta.error && delta.error.current) || '未知原因')));
            }
          }
          chrome.downloads.onChanged.addListener(onChanged);
        }
      );
    } catch (e) {
      reject(e);
    }
  });
}

/**
 * 下载单张图片
 * @param {object} item
 * @param {number} seq 从 1 开始的序号，用于「商品图_001.png」
 */
async function downloadOne(item, seq) {
  var base = '商品图_' + String(seq).padStart(3, '0');

  try {
    var converted = await fetchAsPng(item.url);
    var objUrl = URL.createObjectURL(converted.blob);
    var pngName = base + '.png';
    try {
      await startDownload(objUrl, pngName);
    } finally {
      // 下载已经开始，延迟回收 blob URL，避免撤销过早导致下载失败
      setTimeout(function () {
        URL.revokeObjectURL(objUrl);
      }, 20000);
    }
    return {
      item: item,
      status: 'ok',
      filename: pngName,
      note: converted.converted ? '转码为 PNG' : '原图即 PNG'
    };
  } catch (err) {
    if (err && err.code === 'NEED_PERMISSION') {
      item.needOrigin = originOf(item.url);
      return {
        item: item,
        status: 'need-permission',
        note: describeError(err)
      };
    }

    // 回退：按原格式直接下载（下载由浏览器发起，不需要 host 权限）
    try {
      var ext = guessExt(item.url);
      var fname = base + '.' + ext;
      await startDownload(item.url, fname);
      return {
        item: item,
        status: 'fallback',
        filename: fname,
        note: '未能转 PNG（' + describeError(err) + '），已按原格式下载'
      };
    } catch (err2) {
      return {
        item: item,
        status: 'fail',
        note: describeError(err) + '；回退下载同样失败：' + describeError(err2)
      };
    }
  }
}

function updateProgress(done, total, stats) {
  var pct = total ? Math.round((done / total) * 100) : 0;
  dom.progressBar.style.width = pct + '%';
  var text = '正在下载 ' + done + '/' + total + ' · 成功 ' + stats.ok + ' · 原格式回退 ' + stats.fallback + ' · 失败 ' + stats.fail;
  if (stats.need) text += ' · 待授权 ' + stats.need;
  dom.progressText.textContent = text;
}

function setBusy(busy) {
  state.busy = busy;
  dom.btnDownload.disabled = busy || !state.items.some(function (it) {
    return it.selected;
  });
  dom.btnDownload.textContent = busy ? '下载中…' : '下载选中';
}

function renderReport() {
  var entries = state.reportEntries;
  if (!entries.length) return;
  var label = { ok: '成功', fallback: '原格式', 'need-permission': '待授权', fail: '失败' };
  dom.report.hidden = false;
  dom.reportList.innerHTML = '';
  entries.forEach(function (entry) {
    var li = document.createElement('li');
    var status = document.createElement('span');
    status.className = 'report__status report__status--' + entry.status;
    status.textContent = label[entry.status] || entry.status;
    var detail = document.createElement('span');
    detail.className = 'report__detail';
    detail.textContent = (entry.filename ? entry.filename + ' · ' : '') + entry.note + ' · ' + entry.item.url;
    li.appendChild(status);
    li.appendChild(detail);
    dom.reportList.appendChild(li);
  });

  var ok = entries.filter(function (e) {
    return e.status === 'ok';
  }).length;
  var fallback = entries.filter(function (e) {
    return e.status === 'fallback';
  }).length;
  var need = entries.filter(function (e) {
    return e.status === 'need-permission';
  }).length;
  var fail = entries.filter(function (e) {
    return e.status === 'fail';
  }).length;
  dom.reportTitle.textContent = '下载结果：成功 ' + ok + ' · 原格式 ' + fallback + ' · 待授权 ' + need + ' · 失败 ' + fail;
}

async function downloadSelected() {
  if (state.busy) return;
  var picked = state.items.filter(function (it) {
    return it.selected;
  });
  if (!picked.length) {
    toast('请先勾选要下载的图片');
    return;
  }

  state.busy = true;
  setBusy(true);
  state.reportEntries = [];
  dom.report.hidden = true;
  dom.progressWrap.hidden = false;

  var stats = { ok: 0, fallback: 0, need: 0, fail: 0 };
  var done = 0;
  var cursor = 0;
  var total = picked.length;
  updateProgress(0, total, stats);

  async function worker() {
    while (cursor < picked.length) {
      var idx = cursor++;
      var item = picked[idx];
      var entry = await downloadOne(item, idx + 1);
      if (entry.status === 'ok') stats.ok++;
      else if (entry.status === 'fallback') stats.fallback++;
      else if (entry.status === 'need-permission') stats.need++;
      else stats.fail++;
      state.reportEntries.push(entry);
      done++;
      updateProgress(done, total, stats);
      renderReport();
      if (entry.status === 'need-permission') refreshGrantButtons();
    }
  }

  // 并发 3：既不会让平台 CDN 限流，也不会太慢
  var workers = [];
  for (var i = 0; i < Math.min(3, total); i++) workers.push(worker());
  await Promise.all(workers);

  dom.progressWrap.hidden = true;
  state.busy = false;
  setBusy(false);
  renderReport();

  var parts = ['成功 ' + stats.ok];
  if (stats.fallback) parts.push('原格式 ' + stats.fallback);
  if (stats.need) parts.push('待授权 ' + stats.need);
  if (stats.fail) parts.push('失败 ' + stats.fail);
  toast('下载完成：' + parts.join(' · '), 6000);
}

/** 授权成功后的单张重试 */
async function retrySingle(item) {
  if (state.busy) return;
  state.busy = true;
  setBusy(true);
  dom.progressWrap.hidden = false;
  var stats = { ok: 0, fallback: 0, need: 0, fail: 0 };
  updateProgress(0, 1, stats);

  var seq = state.items.indexOf(item) + 1;
  var entry = await downloadOne(item, seq);
  state.reportEntries.push(entry);
  if (entry.status === 'ok') stats.ok++;
  else if (entry.status === 'fallback') stats.fallback++;
  else if (entry.status === 'need-permission') stats.need++;
  else stats.fail++;
  updateProgress(1, 1, stats);

  dom.progressWrap.hidden = true;
  state.busy = false;
  setBusy(false);
  renderReport();
  toast(
    entry.status === 'ok'
      ? '已下载：' + entry.filename
      : entry.status === 'fallback'
        ? '已按原格式下载：' + entry.filename
        : '这张图仍失败：' + entry.note
  );
}

/** 让「待授权」的卡片显示授权按钮 */
function refreshGrantButtons() {
  state.items.forEach(function (item) {
    if (!item.card || !item.needOrigin) return;
    var btn = item.card.querySelector('.mini--grant');
    if (!btn) return;
    btn.hidden = false;
    btn.textContent = '授权 ' + item.needOrigin;
    item.card.querySelector('.card__actions').hidden = false;
    var badge = item.card.querySelector('.card__badge');
    badge.hidden = false;
    badge.textContent = '待授权';
  });
}

// ---------------------------------------------------------------- 事件绑定

dom.selectAll.addEventListener('change', function () {
  selectAll(dom.selectAll.checked);
});

dom.btnInvert.addEventListener('click', invertSelection);
dom.btnPickLarge.addEventListener('click', pickLarge);

dom.minSize.addEventListener('change', function () {
  refreshSmallState();
  updateCounter();
});

dom.showSmall.addEventListener('change', function () {
  dom.grid.classList.toggle('hide-small', !dom.showSmall.checked);
});

dom.btnDownload.addEventListener('click', downloadSelected);

dom.btnCloseReport.addEventListener('click', function () {
  dom.report.hidden = true;
});

dom.btnCopyReport.addEventListener('click', async function () {
  var text = state.reportEntries
    .map(function (e) {
      return '[' + e.status + '] ' + (e.filename || '-') + ' ' + e.note + ' ' + e.item.url;
    })
    .join('\n');
  try {
    await navigator.clipboard.writeText(text || '没有可复制的结果');
    toast('结果已复制到剪贴板');
  } catch (e) {
    toast('复制失败，请手动选择文本');
  }
});

// ---------------------------------------------------------------- 启动

(async function init() {
  try {
    var payload = await loadPayload();
    render(payload);
    if (!payload || !(payload.images || []).length) {
      dom.empty.hidden = false;
    }
  } catch (e) {
    dom.meta.textContent = '读取提取结果失败：' + describeError(e);
    dom.empty.hidden = false;
  }
})();
