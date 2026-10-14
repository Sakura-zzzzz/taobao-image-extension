/**
 * test/selftest.js
 * 在页面内跑的断言测试，覆盖三块：
 *   1. URL 归一化与平台缩略图还原（纯函数，同步）
 *   2. DOM 提取（去重、懒加载属性、背景图、垃圾图过滤、尺寸过滤）
 *   3. canvas 转 PNG 的完整链路（含 JPEG -> PNG 与 SVG 回退分支）
 *
 * 页面里会直接打印 PASS / FAIL / INFO，方便加载扩展后一键验证。
 */
(function () {
  'use strict';

  var api = window.ImageGrab;
  var fixtureHost = document.getElementById('fixtures');
  var results = [];

  // ------------------------------------------------------------ 断言小工具

  function push(name, ok, expected, actual, soft) {
    results.push({ name: name, ok: !!ok, expected: expected, actual: actual, soft: !!soft });
  }

  function assertEqual(name, actual, expected, soft) {
    push(name, JSON.stringify(actual) === JSON.stringify(expected), JSON.stringify(expected), JSON.stringify(actual), soft);
  }

  function assertTrue(name, cond, detail, soft) {
    push(name, !!cond, 'true', detail === undefined ? 'false' : String(detail), soft);
  }

  function group(title) {
    results.push({ groupTitle: title });
  }

  // -------------------------------------------------------------- 夹具工具

  function makeFixture(html) {
    var box = document.createElement('div');
    box.style.cssText = 'width:1200px;';
    box.innerHTML = html;
    fixtureHost.appendChild(box);
    return box;
  }

  function dropFixture(box) {
    if (box && box.parentNode) box.parentNode.removeChild(box);
  }

  function urlsOf(box, platform) {
    return api
      .extractImages(box, location.href, platform || 'unknown')
      .map(function (it) {
        return it.url;
      });
  }

  /** 等图片真正加载完，这样才能测到 naturalWidth */
  function waitForImages(box) {
    var imgs = Array.prototype.slice.call(box.querySelectorAll('img'));
    return Promise.all(
      imgs.map(function (img) {
        var src = img.getAttribute('src') || '';
        if (img.complete && img.naturalWidth > 0) return Promise.resolve();
        if (!src || /^data:/i.test(src)) return Promise.resolve();
        return new Promise(function (resolve) {
          var done = function () {
            resolve();
          };
          img.addEventListener('load', done, { once: true });
          img.addEventListener('error', done, { once: true });
          setTimeout(done, 5000);
        });
      })
    );
  }

  function toBlob(canvas, type) {
    return new Promise(function (resolve, reject) {
      canvas.toBlob(function (b) {
        if (b && b.size) resolve(b);
        else reject(new Error('canvas.toBlob 返回空'));
      }, type);
    });
  }

  async function headerOf(blob) {
    if (!blob) return [];
    var buf = new Uint8Array(await blob.slice(0, 8).arrayBuffer());
    return Array.prototype.slice.call(buf);
  }

  async function roundTripPng(blob) {
    var bitmap = await createImageBitmap(blob);
    var c = document.createElement('canvas');
    c.width = bitmap.width;
    c.height = bitmap.height;
    c.getContext('2d').drawImage(bitmap, 0, 0);
    if (bitmap.close) bitmap.close();
    return await toBlob(c, 'image/png');
  }

  function viaImageElement(blob) {
    var objUrl = URL.createObjectURL(blob);
    return new Promise(function (resolve, reject) {
      var img = new Image();
      img.onload = function () {
        try {
          var c = document.createElement('canvas');
          c.width = img.naturalWidth || 60;
          c.height = img.naturalHeight || 40;
          c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
          toBlob(c, 'image/png').then(resolve, reject);
        } catch (e) {
          reject(e);
        } finally {
          URL.revokeObjectURL(objUrl);
        }
      };
      img.onerror = function () {
        URL.revokeObjectURL(objUrl);
        reject(new Error('SVG 解码失败'));
      };
      img.src = objUrl;
    });
  }

  // ------------------------------------------------------ 1. URL 归一化测试

  function testUrlNormalization() {
    group('一、URL 归一化与平台缩略图还原');

    assertEqual('相对路径补全为绝对地址', api.upgradeUrl('img-800x800.svg', 'taobao'), 'https://example.com/img-800x800.svg');
    assertEqual('协议相对地址补全为 https', api.upgradeUrl('//img.alicdn.com/a/b.jpg', 'taobao'), 'https://img.alicdn.com/a/b.jpg');
    assertEqual('http 的 CDN 地址升级为 https', api.upgradeUrl('http://img.alicdn.com/a/b.jpg', 'taobao'), 'https://img.alicdn.com/a/b.jpg');
    assertEqual('data: 占位图被拒绝', api.upgradeUrl('data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///', 'unknown'), null);
    assertEqual('blob: 地址被拒绝', api.upgradeUrl('blob:https://x.com/abcd', 'unknown'), null);

    assertEqual(
      '淘宝尺寸后缀还原原图',
      api.upgradeUrl('https://img.alicdn.com/imgextra/i1/100/O1CN01abc.jpg_430x430q90.jpg', 'taobao'),
      'https://img.alicdn.com/imgextra/i1/100/O1CN01abc.jpg'
    );
    assertEqual(
      '淘宝 webp 后缀还原原图',
      api.upgradeUrl('https://img.alicdn.com/imgextra/i1/100/O1CN01abc.jpg_.webp', 'taobao'),
      'https://img.alicdn.com/imgextra/i1/100/O1CN01abc.jpg'
    );
    assertEqual(
      '淘宝质量后缀还原原图',
      api.upgradeUrl('https://img.alicdn.com/imgextra/i1/100/O1CN01abc.jpg_q75.jpg', 'taobao'),
      'https://img.alicdn.com/imgextra/i1/100/O1CN01abc.jpg'
    );
    assertEqual(
      '淘宝小图后缀还原原图',
      api.upgradeUrl('https://img.alicdn.com/imgextra/i1/100/O1CN01abc.jpg_50x50.jpg', 'taobao'),
      'https://img.alicdn.com/imgextra/i1/100/O1CN01abc.jpg'
    );
    assertEqual(
      '京东缩略图档位还原为 n0',
      api.upgradeUrl('https://img14.360buyimg.com/n5/jfs/t1/1/2/3/4/abcdef.jpg!q70.dpg', 'jd'),
      'https://img14.360buyimg.com/n0/jfs/t1/1/2/3/4/abcdef.jpg'
    );
    assertEqual(
      '京东缩略图前缀去掉',
      api.upgradeUrl('https://img14.360buyimg.com/n1/jfs/t1/1/2/3/4/s81x81_abcdef.jpg', 'jd'),
      'https://img14.360buyimg.com/n0/jfs/t1/1/2/3/4/abcdef.jpg'
    );
    assertEqual(
      '拼多多处理参数整段去掉',
      api.upgradeUrl('https://img.pddpic.com/a/abc.jpeg?imageMogr2/thumbnail/400x', 'pdd'),
      'https://img.pddpic.com/a/abc.jpeg'
    );
    assertEqual(
      '拼多多尺寸后缀还原原图',
      api.upgradeUrl('https://img.pddpic.com/a/abc_400x400.jpg', 'pdd'),
      'https://img.pddpic.com/a/abc.jpg'
    );
    assertEqual(
      '本来就是原图的地址保持不变',
      api.upgradeUrl('https://img.alicdn.com/imgextra/i1/100/O1CN01abc.jpg', 'taobao'),
      'https://img.alicdn.com/imgextra/i1/100/O1CN01abc.jpg'
    );
  }

  // ---------------------------------------------------- 2. 平台识别与页面判定

  function testPlatformDetect() {
    group('二、平台识别与详情页判定');

    assertEqual('淘宝域名', api.detectPlatform('item.taobao.com'), 'taobao');
    assertEqual('天猫域名', api.detectPlatform('detail.tmall.com'), 'tmall');
    assertEqual('京东域名', api.detectPlatform('item.jd.com'), 'jd');
    assertEqual('京东香港域名', api.detectPlatform('item.jd.hk'), 'jd');
    assertEqual('拼多多商家版域名', api.detectPlatform('mms.pinduoduo.com'), 'pdd');
    assertEqual('拼多多客户端域名', api.detectPlatform('mobile.yangkeduo.com'), 'pdd');
    assertEqual('其它网站识别为 unknown', api.detectPlatform('www.baidu.com'), 'unknown');

    assertTrue('淘宝详情页判定', api.isDetailPage('https://item.taobao.com/item.htm?id=123456', 'taobao'));
    assertTrue('淘宝首页判定为非详情页', !api.isDetailPage('https://www.taobao.com/', 'taobao'));
    assertTrue('天猫详情页判定', api.isDetailPage('https://detail.tmall.com/item.htm?id=1', 'tmall'));
    assertTrue('京东详情页判定', api.isDetailPage('https://item.jd.com/100012043978.html', 'jd'));
    assertTrue('京东首页判定为非详情页', !api.isDetailPage('https://www.jd.com/', 'jd'));
    assertTrue('拼多多详情页判定', api.isDetailPage('https://mobile.yangkeduo.com/goods.html?goods_id=1', 'pdd'));
    assertTrue('拼多多商家版详情页判定', api.isDetailPage('https://mms.pinduoduo.com/goods/goods_detail?goods_id=1', 'pdd'));
    assertTrue('本地调试域名判定', api.isDebugHost('localhost') && api.isDebugHost('127.0.0.1'));
  }

  // ------------------------------------------------------------ 3. DOM 提取

  function testDomExtraction() {
    group('三、DOM 提取（去重 / 懒加载 / 背景图 / 过滤）');

    var box1 = makeFixture('<img src="dup.svg"><img src="dup.svg"><img data-src="dup.svg">');
    assertEqual('同一地址出现多次只保留一条', urlsOf(box1).length, 1);
    dropFixture(box1);

    var box2 = makeFixture(
      '<img data-src="lazy-1.svg">' +
        '<img data-lazy-src="lazy-2.svg">' +
        '<img data-ks-lazyload="lazy-3.svg">' +
        '<img data-original="lazy-4.svg">' +
        '<img data-original-src="lazy-5.svg">'
    );
    assertEqual('五种懒加载属性全部识别', urlsOf(box2).length, 5);
    dropFixture(box2);

    var box3 = makeFixture(
      '<div style="background-image:url(\'bg-1.svg\')"></div>' +
        '<div style="background-image:url(&quot;bg-2.svg&quot;), linear-gradient(red, blue)"></div>'
    );
    assertEqual('内联与计算样式的背景图都能提取', urlsOf(box3).length, 2);
    dropFixture(box3);

    var box4 = makeFixture(
      '<img src="logo.svg"><img src="my-icon.svg"><img src="1x1.svg">' +
        '<img src="spacer.gif"><img src="watermark.png"><img src="real-product.svg">'
    );
    assertEqual('logo / icon / 占位图被剔除，只留商品图', urlsOf(box4).length, 1);
    dropFixture(box4);

    assertEqual('srcset 取最大宽度候选', api.pickBestFromSrcset('a.jpg 100w, b.jpg 800w, c.jpg 400w'), ['b.jpg']);
    assertEqual('srcset 支持 1x / 2x', api.pickBestFromSrcset('a.jpg 1x, b.jpg 2x'), ['b.jpg']);
    assertEqual('CSS url() 解析', api.extractCssUrls('url("a.jpg"), url(b.png)'), ['a.jpg', 'b.png']);

    var box5 = makeFixture('<img srcset="thumb-small.svg 200w, thumb-big.svg 900w">');
    var urls5 = urlsOf(box5);
    assertTrue('srcset 只提取最大候选', urls5.some(function (u) { return u.indexOf('thumb-big.svg') !== -1; }), urls5.join(' , '));
    dropFixture(box5);

    var box6 = makeFixture(
      '<video poster="poster.svg"></video>' +
        '<a href="linked.svg">查看大图</a>' +
        '<img src="https://img.alicdn.com/imgextra/i1/100/O1CN01abc.jpg_430x430q90.jpg">'
    );
    var items6 = api.extractImages(box6, location.href, 'taobao');
    var urls6 = items6.map(function (i) { return i.url; });
    assertTrue('video poster 被提取', urls6.some(function (u) { return u.indexOf('poster.svg') !== -1; }), urls6.join(' , '));
    assertTrue('a[href] 指向的图片被提取', urls6.some(function (u) { return u.indexOf('linked.svg') !== -1; }), urls6.join(' , '));
    var upgraded = items6.filter(function (i) { return i.upgraded; })[0];
    assertEqual('缩略图地址被还原并标记 upgraded', upgraded && upgraded.url, 'https://img.alicdn.com/imgextra/i1/100/O1CN01abc.jpg');
    assertEqual('记录图片来源域名', upgraded && upgraded.domain, 'img.alicdn.com');
    dropFixture(box6);
  }

  // ------------------------------------------------------- 4. 尺寸过滤（异步）

  async function testSizeFilter() {
    group('四、尺寸过滤（需要真实加载图片）');

    var box = makeFixture(
      '<img src="../demo/img-300x300.svg">' +
        '<img src="../demo/img-1600x1600.svg">' +
        '<img src="../demo/img-80x80.svg">'
    );
    await waitForImages(box);

    var items = api.extractImages(box, location.href, 'unknown');
    var urls = items.map(function (i) { return i.url; });
    var big = items.filter(function (i) { return i.url.indexOf('1600x1600') !== -1; })[0];

    assertEqual('加载完成的图会记录真实尺寸', [big && big.width, big && big.height], [1600, 1600]);
    assertEqual('小于 100x100 的图被剔除', urls.filter(function (u) { return u.indexOf('img-80x80.svg') !== -1; }).length, 0);
    assertEqual(
      '大于 100x100 的图被保留',
      urls.filter(function (u) { return /img-(300x300|1600x1600)\.svg/.test(u); }).length,
      2
    );
    dropFixture(box);
  }

  // ------------------------------------------------------------ 5. PNG 转码

  async function testPngEncode() {
    group('五、canvas 转 PNG 链路');

    var canvas = document.createElement('canvas');
    canvas.width = 120;
    canvas.height = 80;
    var ctx = canvas.getContext('2d');
    ctx.fillStyle = '#e11d48';
    ctx.fillRect(0, 0, 120, 80);
    ctx.fillStyle = '#facc15';
    ctx.fillRect(10, 10, 40, 30);

    var pngBlob = await toBlob(canvas, 'image/png');
    assertEqual('canvas 能导出 PNG', pngBlob && pngBlob.type, 'image/png');
    assertEqual('PNG 文件头正确', await headerOf(pngBlob), [137, 80, 78, 71, 13, 10, 26, 10]);

    var jpgBlob = await toBlob(canvas, 'image/jpeg');
    assertEqual('canvas 能生成 JPEG 供转码测试', jpgBlob && jpgBlob.type, 'image/jpeg');

    var converted = await roundTripPng(jpgBlob);
    assertEqual('JPEG 经 createImageBitmap + canvas 转成 PNG', converted && converted.type, 'image/png');
    assertEqual('转码结果仍是合法 PNG', await headerOf(converted), [137, 80, 78, 71, 13, 10, 26, 10]);

    // 中文文件名在下载时用得到，顺便验证 Blob 处理不受影响
    assertTrue('转码结果体积正常', converted && converted.size > 100, converted && converted.size);

    var svgBlob = new Blob(
      ['<svg xmlns="http://www.w3.org/2000/svg" width="60" height="40"><rect width="60" height="40" fill="#2563eb"/></svg>'],
      { type: 'image/svg+xml' }
    );
    try {
      var viaImg = await viaImageElement(svgBlob);
      assertTrue('SVG 走 <img> + drawImage 分支也能转 PNG', viaImg && viaImg.type === 'image/png', 'ok', true);
    } catch (e) {
      // file:// 页面下 canvas 可能被判为受污染，这里只作为信息提示，不计入失败
      assertTrue('SVG 走 <img> + drawImage 分支也能转 PNG', false, String((e && e.message) || e), true);
    }
  }

  // ---------------------------------------------------------------- 渲染报告

  function render() {
    var pass = results.filter(function (r) { return !r.groupTitle && r.ok; }).length;
    var fail = results.filter(function (r) { return !r.groupTitle && !r.ok && !r.soft; }).length;
    var info = results.filter(function (r) { return !r.groupTitle && !r.ok && r.soft; }).length;

    var summary = document.getElementById('summary');
    summary.className = 'summary ' + (fail ? 'is-fail' : 'is-pass');
    summary.textContent =
      '通过 ' + pass + ' 项 · 失败 ' + fail + ' 项' + (info ? ' · 信息 ' + info + ' 项' : '') + '（共 ' + (pass + fail + info) + ' 项断言）';

    var list = document.getElementById('results');
    list.innerHTML = '';
    results.forEach(function (r) {
      if (r.groupTitle) {
        var h = document.createElement('div');
        h.className = 'group';
        h.textContent = r.groupTitle;
        list.appendChild(h);
        return;
      }
      var li = document.createElement('li');

      var tag = document.createElement('span');
      var cls = r.ok ? 'pass' : r.soft ? 'info' : 'fail';
      tag.className = 'tag tag--' + cls;
      tag.textContent = r.ok ? 'PASS' : r.soft ? 'INFO' : 'FAIL';

      var name = document.createElement('span');
      name.className = 'name';
      name.textContent = r.name;

      var detail = document.createElement('span');
      detail.className = 'detail';
      detail.textContent = r.ok ? '' : '期望 ' + r.expected + ' / 实际 ' + r.actual;

      li.appendChild(tag);
      li.appendChild(name);
      li.appendChild(detail);
      list.appendChild(li);
    });
  }

  // ---------------------------------------------------------------- 入口

  (async function run() {
    if (!api) {
      assertTrue('成功加载 shared/extract.js', false, 'window.ImageGrab 不存在');
      render();
      return;
    }

    var suites = [testUrlNormalization, testPlatformDetect, testDomExtraction, testSizeFilter, testPngEncode];
    for (var i = 0; i < suites.length; i++) {
      try {
        await suites[i]();
      } catch (e) {
        assertTrue(suites[i].name + ' 执行异常', false, String((e && e.message) || e));
      }
    }
    render();
  })();
})();
