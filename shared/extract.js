/**
 * shared/extract.js
 * 商品图片提取器（纯函数，无副作用，可在多个上下文复用）
 *
 * 使用方：
 *   - content.js            注入到商品详情页后调用 extractImages(document, ...)
 *   - test/selftest.html    直接 <script src> 引入，对同一份逻辑做断言测试
 *
 * 对外暴露：globalThis.ImageGrab
 */
(function (root) {
  'use strict';

  // 内容脚本与「工具栏兜底注入」可能重复执行，这里做幂等保护
  if (root.ImageGrab) return;

  /** 小于该边长的图片直接丢弃；懒加载图片扫描时尺寸为 0，交给画廊加载后二次判定 */
  var MIN_SIDE = 100;

  /** 懒加载属性名：三个平台的历史命名差异很大，全部枚举一遍 */
  var LAZY_ATTRS = [
    'data-src',
    'data-lazy-src',
    'data-original',
    'data-original-src',
    'data-actualsrc',
    'data-ks-lazyload',
    'data-ks-lazyload-src',
    'data-lazyload',
    'data-lazyload-src',
    'data-echo',
    'data-url',
    'data-image',
    'data-img',
    'data-src-url'
  ];

  /** srcset 类属性名 */
  var SRCSET_ATTRS = ['srcset', 'data-srcset', 'data-lazy-srcset', 'data-ks-lazyload-srcset'];

  /**
   * 明确不是商品图的 URL 特征：图标、logo、占位图、二维码、水印、1x1 埋点图等。
   * 注意不要加入过于宽泛的词（例如 img、pic），否则会误杀真实商品图。
   */
  var JUNK_URL_RE = /(?:logo|icon|sprite|avatar|placeholder|blank|spacer|transparent|qrcode|qr_code|erweima|favicon|watermark|nopic|no_pic|default_img|loading|pixel\.gif|1x1)/i;

  /** 图片扩展名（用于识别 <a href> 直链图片） */
  var IMG_EXT_RE = /\.(?:png|jpe?g|webp|gif|bmp|avif|svg)(?:$|[?#])/i;

  /** 命中这些域名的 http:// 一律升级成 https://，避免混合内容被拦截 */
  var HTTPS_UPGRADE_RE = /(?:alicdn\.com|tbcdn\.cn|360buyimg\.com|jd\.com|jd\.hk|pddpic\.com|pinduoduo\.com|yangkeduo\.com|taobao\.com|tmall\.com)$/i;

  /**
   * 淘宝/天猫的图片尺寸后缀，反复剥离可拿到原图：
   *   xxx.jpg_430x430q90.jpg  -> xxx.jpg
   *   xxx.jpg_.webp           -> xxx.jpg
   *   xxx.jpg_q75.jpg         -> xxx.jpg
   *   xxx.jpg_50x50.jpg       -> xxx.jpg
   */
  var TAOBAO_SUFFIX_RE = /_(?:\d+x\d+(?:q\d+)?|q\d+|sum)(\.(?:jpe?g|png|webp|gif))?$|_\.(?:jpe?g|png|webp|gif)$/i;

  /** 命中这些参数说明查询串只是图片处理指令，可以整段去掉（不会影响真实对象名） */
  var PROCESSING_QUERY_RE = /imageMogr2|imgScale|x-oss-process|x-oss-|imageView2|thumbnail|watermark|@base@|resize/i;

  /** 判断元素 class 是否像「图片容器」，元素特别多时用它来缩小 background-image 扫描范围 */
  var BG_HINT_RE = /(?:img|pic|photo|banner|thumb|gallery|cover|sku|main|detail|swiper|carousel|swatch)/i;

  // ---------------------------------------------------------------- 平台识别

  /** 根据 hostname 判断当前是哪个平台 */
  function detectPlatform(hostname) {
    var h = String(hostname || '').toLowerCase();
    if (/(?:^|\.)taobao\.com$/.test(h)) return 'taobao';
    if (/(?:^|\.)tmall\.com$/.test(h)) return 'tmall';
    if (/(?:^|\.)jd\.com$/.test(h) || /(?:^|\.)jd\.hk$/.test(h)) return 'jd';
    if (/(?:^|\.)pinduoduo\.com$/.test(h) || /(?:^|\.)yangkeduo\.com$/.test(h)) return 'pdd';
    return 'unknown';
  }

  /** 本地调试页（demo / 自测页）也允许注入，方便离线验证 */
  function isDebugHost(hostname) {
    return /^(?:localhost|127\.0\.0\.1|\[::1\])$/i.test(String(hostname || '').trim());
  }

  /**
   * 商品详情页 URL 白名单：只有命中才显示悬浮按钮。
   * 平台改版很频繁，这里刻意放宽为「域名 + 关键路径」，漏判时还可点工具栏图标手动触发。
   */
  var DETAIL_PATTERNS = {
    taobao: [/item\.taobao\.com\/item\.htm/i, /[?&]id=\d+/i, /world\.taobao\.com\/item/i],
    tmall: [/detail\.tmall\.com\/item\.htm/i, /[?&]id=\d+/i],
    jd: [
      /item\.jd\.com\/\d+\.html/i,
      /item\.m\.jd\.com\/product\/\d+/i,
      /item\.jd\.hk\/\d+\.html/i,
      /npcitem\.jd\.hk\/\d+/i,
      /cd\.jd\.com\/\d+\.html/i
    ],
    pdd: [
      /mobile\.yangkeduo\.com\/goods\d*\.html/i,
      /mobile\.pinduoduo\.com\/goods\d*\.html/i,
      /yangkeduo\.com\/goods/i,
      /pinduoduo\.com\/goods/i,
      /mms\.pinduoduo\.com\/goods\//i,
      /mms\.pinduoduo\.com\/[^?#]*goods/i
    ]
  };

  function isDetailPage(url, platform) {
    var list = DETAIL_PATTERNS[platform] || [];
    for (var i = 0; i < list.length; i++) {
      if (list[i].test(String(url || ''))) return true;
    }
    return false;
  }

  // ------------------------------------------------------------ URL 归一化

  /**
   * 从 CSS 值里取出所有 url(...)
   * @param {string} value 例如 url("a.jpg"), url(b.jpg)
   * @returns {string[]}
   */
  function extractCssUrls(value) {
    var out = [];
    if (!value || value === 'none') return out;
    var re = /url\(\s*(['"]?)(.*?)\1\s*\)/gi;
    var m;
    while ((m = re.exec(value))) {
      if (m[2]) out.push(m[2]);
    }
    return out;
  }

  /**
   * 从 srcset 里挑最大的一张（1x/2x 与 100w/800w 两种写法都支持）
   * @param {string} value
   * @returns {string[]} 0 或 1 个元素，方便直接丢给 push
   */
  function pickBestFromSrcset(value) {
    if (!value || typeof value !== 'string') return [];
    var parts = value.split(',');
    var best = null;
    var bestScore = -1;
    for (var i = 0; i < parts.length; i++) {
      var seg = parts[i].trim();
      if (!seg) continue;
      var bits = seg.split(/\s+/);
      var url = bits[0];
      if (!url) continue;
      var desc = bits[1] || '';
      var score = 1;
      if (/^\d+w$/i.test(desc)) score = parseInt(desc, 10);
      else if (/^[\d.]+x$/i.test(desc)) score = parseFloat(desc) * 100000; // 2x 一定比 800w 大，用大基数区分
      if (score > bestScore) {
        bestScore = score;
        best = url;
      }
    }
    return best ? [best] : [];
  }

  /**
   * 平台特有的「缩略图 -> 原图」地址还原
   * @returns {boolean} 是否发生过改动（用于标记 upgraded，便于画廊提示）
   */
  function upgradeInPlace(u, platform) {
    var before = u.pathname;
    var path = before;

    // 通用规则：路径里出现 “.jpg_430x430q90.jpg” 这种写法时一定带尺寸后缀
    if (platform === 'taobao' || platform === 'tmall' || /\.(?:jpe?g|png|webp)_/i.test(path)) {
      for (var i = 0; i < 4; i++) {
        var prev = path;
        path = path.replace(TAOBAO_SUFFIX_RE, '');
        if (path === prev) break;
      }
    }

    if (platform === 'jd') {
      // 京东档位：n0 是原图，n1~n5、s81x81_ 都是缩略图
      path = path.replace(/\/n\d+\//i, '/n0/');
      path = path.replace(/\/s\d+x\d+_/i, '/');
      path = path.replace(/^\/s\d+x\d+_/i, '/');
      path = path.replace(/![^/]*$/i, ''); // 去掉 !q70.dpg 之类的处理后缀
      path = path.replace(/\.dpg$/i, '.jpg'); // dpg 是包装格式，真实对象是 jpg
    }

    if (platform === 'pdd') {
      // 拼多多：xxx_400x400.jpg -> xxx.jpg
      path = path.replace(/_(\d+x\d+)(\.(?:jpe?g|png|webp))?$/i, '$2');
      path = path.replace(/_(?:thumb|small|large)$/i, '');
    }

    if (path !== before) {
      u.pathname = path;
      return true;
    }
    return false;
  }

  /**
   * 把任意候选字符串转成可下载的绝对图片地址
   * @returns {{url: string, upgraded: boolean}|null}
   */
  function toAbsoluteImageUrl(raw, base, platform) {
    if (typeof raw !== 'string') return null;
    var value = raw.trim().replace(/^['"]+|['"]+$/g, '');
    if (!value) return null;
    // data: / blob: 是占位图或页面内生成图，一律跳过
    if (/^(?:data|blob|about|javascript|mailto|chrome|chrome-extension):/i.test(value)) return null;
    value = value.replace(/&amp;/g, '&');

    var u;
    try {
      u = new URL(value, base || 'https://example.com/');
    } catch (e) {
      return null;
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    if (u.protocol === 'http:' && HTTPS_UPGRADE_RE.test(u.hostname)) u.protocol = 'https:';
    if (u.search && PROCESSING_QUERY_RE.test(u.search)) u.search = '';

    // 先按原始地址判一次垃圾图：缩略图后缀被剥离后可能丢掉 logo/icon/1x1 这些特征
    if (JUNK_URL_RE.test(u.toString())) return null;

    var upgraded = upgradeInPlace(u, platform);
    return { url: u.toString(), upgraded: upgraded };
  }

  /** 测试与调试用的便捷包装：直接返回最终地址字符串 */
  function upgradeUrl(raw, platform) {
    var r = toAbsoluteImageUrl(raw, 'https://example.com/', platform || 'unknown');
    return r ? r.url : null;
  }

  // ---------------------------------------------------------------- 主流程

  /**
   * 提取页面（或某个子树）里的所有商品图片
   *
   * @param {Document|Element} rootNode 扫描范围；传入元素时便于自测页做隔离断言
   * @param {string} [baseHref] 相对路径补全的基准地址，缺省取文档 baseURI
   * @param {string} [platform] 'taobao' | 'tmall' | 'jd' | 'pdd' | 'unknown'
   * @returns {Array<{url:string, domain:string, sourceTag:string, width:number, height:number, upgraded:boolean, platform:string}>}
   */
  function extractImages(rootNode, baseHref, platform) {
    if (!rootNode) return [];
    var isDoc = rootNode.nodeType === 9;
    var ownerDoc = isDoc ? rootNode : rootNode.ownerDocument;
    if (!ownerDoc) return [];

    var base = baseHref || ownerDoc.baseURI || (ownerDoc.location && ownerDoc.location.href) || 'https://example.com/';
    var plat = platform || detectPlatform(ownerDoc.location ? ownerDoc.location.hostname : '');
    var view = ownerDoc.defaultView;

    /** url -> item，顺便完成去重 */
    var found = new Map();

    function pushOne(raw, sourceTag, el) {
      var norm = toAbsoluteImageUrl(raw, base, plat);
      if (!norm) return;
      if (JUNK_URL_RE.test(norm.url)) return;

      var item = found.get(norm.url);
      if (!item) {
        item = {
          url: norm.url,
          domain: '',
          sourceTag: sourceTag,
          width: 0,
          height: 0,
          upgraded: norm.upgraded,
          platform: plat
        };
        try {
          item.domain = new URL(norm.url).hostname;
        } catch (e) {
          /* 理论上不会发生，忽略 */
        }
        found.set(norm.url, item);
      }
      // 已经加载完成的 <img> 可以顺手记录真实尺寸（懒加载中的图 naturalWidth 为 0）
      if (el && el.tagName === 'IMG' && el.naturalWidth > 0 && !item.width) {
        item.width = el.naturalWidth;
        item.height = el.naturalHeight;
      }
    }

    function push(raw, sourceTag, el) {
      if (Array.isArray(raw)) {
        for (var i = 0; i < raw.length; i++) pushOne(raw[i], sourceTag, el);
        return;
      }
      pushOne(raw, sourceTag, el);
    }

    // 1) <img>：src / 懒加载属性 / srcset / 浏览器最终选中的 currentSrc
    var imgs = rootNode.querySelectorAll('img');
    for (var i = 0; i < imgs.length; i++) {
      var img = imgs[i];
      push(img.getAttribute('src'), 'img:src', img);
      for (var a = 0; a < LAZY_ATTRS.length; a++) {
        var v = img.getAttribute(LAZY_ATTRS[a]);
        if (v) push(v, 'img:' + LAZY_ATTRS[a], img);
      }
      push(pickBestFromSrcset(img.getAttribute('srcset')), 'img:srcset', img);
      for (var s = 0; s < SRCSET_ATTRS.length; s++) {
        var sv = img.getAttribute(SRCSET_ATTRS[s]);
        if (sv) push(pickBestFromSrcset(sv), 'img:' + SRCSET_ATTRS[s], img);
      }
      if (img.currentSrc) push(img.currentSrc, 'img:currentSrc', img);
    }

    // 2) <picture><source srcset>
    var sources = rootNode.querySelectorAll('source[srcset]');
    for (var p = 0; p < sources.length; p++) {
      push(pickBestFromSrcset(sources[p].getAttribute('srcset')), 'source:srcset', null);
    }

    // 3) <video poster>
    var videos = rootNode.querySelectorAll('video[poster]');
    for (var v2 = 0; v2 < videos.length; v2++) {
      push(videos[v2].getAttribute('poster'), 'video:poster', null);
    }

    // 4) 背景图：先读内联 style（几乎零成本），再按需读 computed style
    //    传入的是元素时，把根元素本身也算进来，保证子树的背景图不被漏掉
    var all = [];
    if (!isDoc) all.push(rootNode);
    var descendants = rootNode.querySelectorAll('*');
    for (var d = 0; d < descendants.length; d++) all.push(descendants[d]);
    // 元素特别多时只扫「看起来像图片容器」的元素，避免一次性 style 重算卡住页面
    var heavy = all.length > 6000;
    for (var e = 0; e < all.length; e++) {
      var el = all[e];
      if (el.style && el.style.backgroundImage && el.style.backgroundImage !== 'none') {
        push(extractCssUrls(el.style.backgroundImage), 'style:background-image', null);
      }
      if (!view) continue; // 游离文档没有 defaultView，跳过 computed style
      if (heavy && !BG_HINT_RE.test(el.className || '')) continue;
      var cs = null;
      try {
        cs = view.getComputedStyle(el);
      } catch (err) {
        continue;
      }
      if (cs && cs.backgroundImage && cs.backgroundImage !== 'none') {
        push(extractCssUrls(cs.backgroundImage), 'computed:background-image', null);
      }
    }

    // 5) <a href> 直接指向图片文件（商家后台常见：点图看大图）
    var links = rootNode.querySelectorAll('a[href]');
    for (var k = 0; k < links.length; k++) {
      var href = links[k].getAttribute('href') || '';
      if (IMG_EXT_RE.test(href.split('?')[0])) push(href, 'a:href', null);
    }

    // 尺寸过滤：只对「已经测到尺寸」的图做硬过滤，未加载完的交给画廊二次判定
    var result = [];
    found.forEach(function (item) {
      if (item.width > 0 && (item.width < MIN_SIDE || item.height < MIN_SIDE)) return;
      result.push(item);
    });
    return result;
  }

  root.ImageGrab = {
    MIN_SIDE: MIN_SIDE,
    LAZY_ATTRS: LAZY_ATTRS,
    JUNK_URL_RE: JUNK_URL_RE,
    detectPlatform: detectPlatform,
    isDebugHost: isDebugHost,
    isDetailPage: isDetailPage,
    extractCssUrls: extractCssUrls,
    pickBestFromSrcset: pickBestFromSrcset,
    toAbsoluteImageUrl: toAbsoluteImageUrl,
    upgradeUrl: upgradeUrl,
    extractImages: extractImages
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
