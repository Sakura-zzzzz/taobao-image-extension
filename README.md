# 电商图片提取下载（Chrome 扩展 · Manifest V3）

在淘宝、天猫、京东、拼多多的商品详情页一键提取页面内所有商品图片，集中展示、勾选，批量转成 PNG 下载到浏览器默认下载目录。

## 一、文件结构

```
image-grab/
├─ manifest.json          MV3 清单：权限、内容脚本注册、Service Worker
├─ background.js          Service Worker：消息路由、暂存图片列表、打开画廊页、工具栏兜底注入
├─ content.js             悬浮按钮 + 自动滚动触发懒加载 + 调用提取器 + 发送消息
├─ content.css            悬浮按钮 / 提示气泡样式
├─ shared/
│   └─ extract.js         提取器（纯函数）：URL 归一化、平台缩略图还原、过滤、去重
├─ gallery.html           画廊页骨架（网格、工具栏、进度、结果报告）
├─ gallery.js             画廊逻辑：渲染、勾选、转 PNG、批量下载
├─ gallery.css            画廊样式（响应式网格，自适应深浅色）
├─ demo/
│   ├─ demo.html          本地模拟商品详情页，覆盖各平台懒加载写法
│   └─ img-*.svg          图片夹具（大图 / 小图 / 1x1 / logo / icon）
├─ test/
│   ├─ selftest.html      自测页（一键跑断言）
│   └─ selftest.js        断言集：URL 归一化、DOM 提取、尺寸过滤、PNG 转码
└─ README.md
```

## 二、安装

1. 打开 `chrome://extensions`，右上角开启「开发者模式」。
2. 点击「加载已解压的扩展程序」，选择本目录（含 `manifest.json` 的那一层）。
3. 想在本地 HTML 文件（`file://`）上测试，需要进入扩展详情页打开「允许访问文件网址」。
   （用 `http://localhost:8000/...` 这种本地服务访问则不需要。）

扩展没有配置图标，工具栏上会显示 Chrome 默认的拼图图标，这不影响功能。

## 三、使用

1. 打开任一平台（淘宝 / 天猫 / 京东 / 拼多多 / 拼多多商家版）的**商品详情页**，页面右下角会出现蓝色圆角按钮「获取图片」。
2. 点击后按钮会依次显示「扫描中 0%…100%」：扩展会自动滚一遍页面触发懒加载，再回到原位置。
3. 扫描完成按钮变成「已找到 N 张」，并自动打开一个新的画廊标签页，网格展示所有提取到的图片。
4. 在画廊页勾选需要的图（默认已自动勾选尺寸合格的图），点「下载选中」。
5. 下载过程中顶部显示进度与成功/失败统计，结束后底部给出结果清单，可一键「复制结果」。

按钮没出现的页面（例如平台改版导致详情页 URL 判定失效），可以直接点工具栏上的扩展图标，扩展会往当前页注入并立即执行一次提取。

## 四、工具栏操作

| 操作 | 说明 |
| --- | --- |
| 「全选」 | 勾选所有未加载失败的图片 |
| 「反选」 | 反转当前勾选状态 |
| 「仅选大图」 | 只勾选满足「最小尺寸」阈值的图 |
| 「最小尺寸」 | 默认 100，改这个值会重新判断哪些图算小图 |
| 「显示小图」 | 小于阈值的图默认置灰并取消勾选，勾上这个才显示出来 |
| 「下载选中」 | 批量下载，并发 3 |

## 五、下载规则

- 文件名固定为 `商品图_001.png`、`商品图_002.png`，序号按勾选顺序补零到 3 位。
- 原图不是 PNG（jpg / webp / avif 等）时，用 `fetch` 拉取 → `createImageBitmap` → canvas 重绘 → `toBlob('image/png')` 转码；`createImageBitmap` 处理不了的格式（如 SVG）会回退到 `<img>` + `drawImage`。
- 原图本身就是 PNG 时直接保存原始字节，不做二次编码（避免画质损失和体积膨胀）。
- 转码失败会**回退为按原格式下载**（文件名改成 `商品图_001.jpg` 等），并在结果里标注原因，不会静默丢图。
- 文件名冲突时自动加序号（`conflictAction: 'uniquify'`），不覆盖已有文件。

## 六、权限说明

| 权限 | 用途 |
| --- | --- |
| `activeTab` + `scripting` | 点工具栏图标时向当前页注入提取脚本 |
| `downloads` | 保存文件到默认下载目录 |
| `storage` | 用 `chrome.storage.session` 把图片列表从内容脚本传给画廊页 |
| `host_permissions`（三个平台域名） | 内容脚本注入范围 |
| `host_permissions`（alicdn / tbcdn / 360buyimg / pddpic） | 跨域 `fetch` 图片并转 PNG；浏览器直接下载原图本来不需要这项权限 |
| `optional_host_permissions`（`https://*/*`、`http://*/*`） | 遇到没预料到的第三方 CDN 时，由你在画廊页点「授权」按域名单独申请 |

## 七、平台差异是怎么处理的

| 平台 | 差异点 | 处理方式 |
| --- | --- | --- |
| 通用 | 懒加载属性命名五花八门 | 同时读 `data-src`、`data-lazy-src`、`data-original`、`data-original-src`、`data-actualsrc`、`data-ks-lazyload`、`data-lazyload`、`data-echo`、`data-url`、`data-image`、`data-img` |
| 通用 | 图片藏在背景图里 | 先读内联 `style.background-image`，再读 `getComputedStyle` 的 `background-image`（元素超过 6000 个时降级为只扫类名像图片容器的元素，避免卡顿） |
| 通用 | `<picture>` / `srcset` | 支持 `srcset`、`data-srcset`、`<source srcset>`，按 `w` / `x` 描述符挑最大的一张 |
| 淘宝 / 天猫 | `xxx.jpg_430x430q90.jpg`、`xxx.jpg_.webp`、`xxx.jpg_q75.jpg` | 反复剥离尺寸/质量后缀还原原图 |
| 京东 | `/n5/` 档位、`s81x81_` 前缀、`!q70.dpg` 后缀 | 档位改 `/n0/`，去掉缩略前缀与 `!` 后缀，`.dpg` 还原成 `.jpg` |
| 拼多多 | `?imageMogr2/thumbnail/400x`、`_400x400.jpg` | 处理型查询串整段去掉，尺寸后缀剥离 |
| 淘宝 / 天猫 / 拼多多 | 详情页 URL 规则各不相同 | 每个平台维护一份正则白名单（`item.htm`、`item.jd.com/\d+.html`、`goods.html`、`mms.pinduoduo.com/goods/` 等） |

过滤规则（剔除不下载）：

- URL 命中 `logo`、`icon`、`sprite`、`avatar`、`placeholder`、`blank`、`spacer`、`transparent`、`qrcode`、`watermark`、`loading`、`1x1` 等关键词；
- `data:` / `blob:` 地址（占位图）；
- 扫描时已加载完成、且任一边小于 100px 的图；
- 扫描时还没加载完的图先保留，画廊里量到真实尺寸后再自动取消勾选并置灰。

## 八、自测

### 1. 断言自测页

打开 `test/selftest.html`（双击直接打开，或本地起服务后访问）。页面会加载与内容脚本完全相同的 `shared/extract.js`，在内存夹具上跑 35+ 条断言，并打印 PASS / FAIL / INFO：

- URL 归一化：相对路径、协议相对地址、http→https、`data:` / `blob:` 拒绝；
- 平台缩略图还原：淘宝 4 种后缀、京东档位与 `!` 后缀、拼多多参数与后缀；
- 平台识别与详情页判定：7 个正例 + 反例；
- DOM 提取：去重、5 种懒加载属性、内联与计算样式背景图、`video poster`、`a[href]`、垃圾图过滤、srcset 取最大；
- 尺寸过滤：真实加载 `demo/img-300x300.svg` 与 `demo/img-80x80.svg`，验证小于 100px 被剔除；
- PNG 链路：canvas 导出 PNG 并校验文件头 `89 50 4E 47`，JPEG → PNG 完整转码，SVG 走 `<img>` 回退分支。

`file://` 下如果 SVG 那条显示 INFO，属于浏览器对本地文件的 canvas 污染限制，用 `http://localhost` 打开即可通过，不影响扩展本身（扩展页面有独立来源，不受此限制）。

### 2. 本地全链路测试

打开 `demo/demo.html`（打开扩展的「允许访问文件网址」，或用本地服务）：

```bash
# 在项目根目录执行任意一种
python -m http.server 8000
# 或
npx serve -l 8000
```

然后访问 `http://localhost:8000/demo/demo.html`，点右下角「获取图片」。预期：画廊里正好 4 张图（1600×1600、800×800、600×900、300×300），且每张的尺寸文字与文件一致；`img-1x1.svg`、`logo-shop.svg`、`icon-cart.svg`、`img-80x80.svg` 都不应出现。勾选后下载，文件名应为 `商品图_001.png` … `商品图_004.png`。

### 3. 手动验收清单

- [ ] 淘宝 / 天猫 / 京东 / 拼多多详情页右下角出现「获取图片」按钮；首页、搜索页、购物车页不出现按钮。
- [ ] 点击后按钮有「扫描中」进度，结束后显示「已找到 N 张」。
- [ ] 画廊页网格展示缩略图、`宽 × 高`、来源域名；重复地址只出现一次。
- [ ] jpg / webp 图片下载后是真正的 PNG（用图片查看器确认扩展名为 .png 且能打开）。
- [ ] 文件名按 `商品图_001.png` 补零，下载目录里没有覆盖已有文件。
- [ ] 小图（小于阈值）默认不被勾选；勾上「显示小图」后能看到并被置灰。
- [ ] 缺少域名权限的图会显示「授权 …」按钮，授权后能重试成功。
- [ ] 转码失败的图会回退成原格式并出现在结果清单里。

## 九、常见问题

**按钮不出现**：确认是商品详情页（不是首页/搜索页），或直接点工具栏图标注入；平台改版导致 URL 规则失配时，改 `shared/extract.js` 里的 `DETAIL_PATTERNS` 即可。

**下载出来还是 webp**：说明这张图的域名没在 `host_permissions` 里，`fetch` 被拦了，于是走了原格式回退。结果清单里会写明原因，点卡片上的「授权 …」按钮按域名授权后重试，或者把该 CDN 域名补进 `manifest.json` 的 `host_permissions`。

**部分图缺失**：平台把详情长图放在 iframe 里，或者需要滚动到底才渲染。当前版本只注入顶层文档（`all_frames: false`），可以先手动滚到页面底部再点「获取图片」。

**画廊页没有数据**：`chrome.storage.session` 里的数据在浏览器完全退出后清空，重新提取一次即可。

**超大图转 PNG 很慢或失败**：canvas 有尺寸上限（一般 16384px / 面积上限），超限会走原格式回退，属预期行为。

## 十、已知限制

- 只注入顶层文档，不处理 iframe 内的图片。
- 提取以 DOM 中已存在（或滚动后出现）的图片为准，不解析接口返回的图片列表。
- 画廊不做图片编辑，只做勾选与下载；不支持打包成 zip。
