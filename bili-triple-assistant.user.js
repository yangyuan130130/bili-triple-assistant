// ==UserScript==
// @name         B站一键三连 · 智能分类收藏
// @namespace    https://github.com/yangyuan130130
// @version      1.0.0
// @description  主动点击后完成点赞、投币、收藏；根据标题和标签判断类型，自动选择或新建私密收藏夹
// @author       yangyuan130130
// @match        https://www.bilibili.com/video/*
// @icon         https://www.bilibili.com/favicon.ico
// @grant        GM_xmlhttpRequest
// @connect      api.bilibili.com
// @run-at       document-idle
// @noframes
// @license      MIT
// ==/UserScript==

(function () {
  'use strict';

  // ============================================================
  // 1. 配置与分类规则
  //    不写任何 Cookie / Token。登录态由浏览器自己携带。
  // ============================================================
  const CFG = {
    debug: false,
    requestTimeout: 20000,
    storageKey: 'bta:settings:v1',
    defaultCoinCount: 1,
    defaultFallbackFolder: '未分类',
  };

  // 规则按顺序参与竞争；同分时排在前面的优先。
  // name    面板显示的类型
  // folder  对应收藏夹名称；省略时使用 name
  // keywords 命中关键词；标签精确匹配权重最高，其次是标签包含、标题包含、分区包含
  // exclude 可选，命中后减分，用来排除容易混淆的视频
  // minScore 可选，默认 2 分才采用该分类
  const DEFAULT_RULES = [
    { name: '计算机考研', keywords: ['计算机考研', '王道考研', '王道', '408', '数据结构', '计算机组成原理', '组成原理', '操作系统', '计算机网络'] },
    { name: '编程开发', keywords: ['编程', '程序设计', 'python', 'javascript', 'typescript', 'java', 'c++', 'c语言', '前端', '后端', 'web开发', 'vue', 'react', 'node.js', 'git', 'docker', 'linux', 'mysql', '数据库', '算法'] },
    { name: '数学', keywords: ['考研数学', '高等数学', '高数', '线性代数', '线代', '概率论', '数理统计', '微积分', '数学分析', '数学'] },
    { name: '英语学习', folder: '英语学习', keywords: ['考研英语', '英语四六级', '四六级', '英语四级', '英语六级', '雅思', '托福', '英语口语', '英语听力', '背单词', '英语'] },
    { name: '考研政治', keywords: ['考研政治', '毛中特', '马原', '思修', '思想道德与法治', '中国近现代史纲要', '政治'] },
    { name: '公考考证', keywords: ['公务员', '国考', '省考', '行测', '申论', '事业编', '教师资格证', '教资', '注册会计师', 'cpa'] },
    { name: '设计剪辑', keywords: ['photoshop', 'ps教程', 'premiere', 'pr教程', 'after effects', 'ae教程', '剪映', '达芬奇', 'blender', 'c4d', '平面设计', 'ui设计', '视频剪辑'] },
    { name: '音乐学习', keywords: ['乐理', '钢琴', '吉他', '声乐', '唱歌教学', '编曲', '音乐制作'] },
    { name: '游戏', keywords: ['游戏攻略', '实况解说', '通关攻略', '原神', '崩坏', '星穹铁道', '绝区零', '王者荣耀', '英雄联盟', 'lol', '我的世界', 'minecraft', 'steam'] },
    { name: '知识科普', keywords: ['科普', '科学', '物理', '化学', '生物', '历史', '地理', '哲学', '心理学', '经济学'] },
    { name: '生活', keywords: ['美食', '烹饪', '健身', '减脂', '旅行', 'vlog', '手工', '收纳'] },
    { name: '影视动漫', keywords: ['电影解说', '影视解说', '动漫', '番剧', '漫画', '动画剪辑', 'mad', 'amv'] },
  ];

  const API_ROOT = 'https://api.bilibili.com';
  const EP = {
    nav: '/x/web-interface/nav',
    view: '/x/web-interface/view',
    tags: '/x/tag/archive/tags',
    folders: '/x/v3/fav/folder/created/list-all',
    folderAdd: '/x/v3/fav/folder/add',
    hasLike: '/x/web-interface/archive/has/like',
    coins: '/x/web-interface/archive/coins',
    like: '/x/web-interface/archive/like',
    coinAdd: '/x/web-interface/coin/add',
    favDeal: '/x/v3/fav/resource/deal',
  };

  function num(v) {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }

  function str(v) {
    return v === null || v === undefined ? '' : String(v);
  }

  function norm(v) {
    let s = str(v);
    try { s = s.normalize('NFKC'); } catch (e) { /* 老浏览器忽略 */ }
    return s.toLowerCase().replace(/\s+/g, ' ').trim();
  }

  function clock() {
    return new Date().toLocaleTimeString('zh-CN', { hour12: false });
  }

  function cleanFolderName(v) {
    return str(v).replace(/[\r\n\t]/g, ' ').replace(/\s+/g, ' ').trim();
  }

  // ============================================================
  // 2. 纯逻辑：分类、收藏夹匹配、三连流程
  //    这一段不依赖 DOM，便于独立测试。
  // ============================================================
  function validateRules(input) {
    if (!Array.isArray(input)) throw new Error('规则必须是 JSON 数组');
    if (input.length > 50) throw new Error('规则最多 50 条');
    const out = [];
    input.forEach((r, i) => {
      if (!r || typeof r !== 'object' || Array.isArray(r)) throw new Error('第 ' + (i + 1) + ' 条规则不是对象');
      const name = cleanFolderName(r.name);
      const folder = cleanFolderName(r.folder || r.name);
      if (!name || !folder) throw new Error('第 ' + (i + 1) + ' 条规则缺少 name / folder');
      if (!Array.isArray(r.keywords) || !r.keywords.length) throw new Error('「' + name + '」缺少 keywords');
      if (r.keywords.length > 50) throw new Error('「' + name + '」的关键词最多 50 个');
      const keywords = r.keywords.map(norm).filter(Boolean);
      if (!keywords.length) throw new Error('「' + name + '」没有有效关键词');
      const exclude = Array.isArray(r.exclude) ? r.exclude.map(norm).filter(Boolean) : [];
      out.push({
        name: name,
        folder: folder,
        keywords: Array.from(new Set(keywords)),
        exclude: Array.from(new Set(exclude)),
        minScore: Number.isFinite(Number(r.minScore)) ? Math.max(1, Number(r.minScore)) : 2,
      });
    });
    return out;
  }

  /**
   * 标签精确命中 +5；标签包含 +3；标题包含 +2；分区包含 +1。
   * 同一个关键词只取最高权重，不会在标题和标签里重复加分。
   */
  function classify(video, tags, rules, fallbackFolder) {
    const title = norm(video && video.title);
    const section = norm(video && video.tname);
    const tagNames = (Array.isArray(tags) ? tags : [])
      .map((t) => norm(typeof t === 'string' ? t : (t && (t.tag_name || t.name))))
      .filter(Boolean);
    const safeRules = Array.isArray(rules) ? rules : [];
    let best = null;

    safeRules.forEach((rule, order) => {
      let score = 0;
      let tagScore = 0;
      const evidence = [];
      (rule.keywords || []).forEach((raw) => {
        const kw = norm(raw);
        if (!kw) return;
        let add = 0;
        let label = '';
        if (tagNames.some((t) => t === kw)) {
          add = 5; label = '标签「' + kw + '」';
        } else if (tagNames.some((t) => t.includes(kw))) {
          add = 3; label = '相关标签「' + kw + '」';
        } else if (title.includes(kw)) {
          add = 2; label = '标题「' + kw + '」';
        } else if (section && section.includes(kw)) {
          add = 1; label = '分区「' + kw + '」';
        }
        if (add > 0) {
          score += add;
          if (add >= 3) tagScore += add;
          if (evidence.length < 5 && !evidence.includes(label)) evidence.push(label);
        }
      });
      (rule.exclude || []).forEach((raw) => {
        const kw = norm(raw);
        if (kw && (title.includes(kw) || tagNames.some((t) => t.includes(kw)))) {
          score -= 4;
          if (evidence.length < 5) evidence.push('排除「' + kw + '」');
        }
      });
      const threshold = num(rule.minScore) || 2;
      if (score < threshold) return;
      const candidate = {
        matched: true,
        type: str(rule.name),
        folder: cleanFolderName(rule.folder || rule.name),
        score: score,
        tagScore: tagScore,
        evidence: evidence,
        order: order,
      };
      if (!best || score > best.score || (score === best.score && tagScore > best.tagScore)) best = candidate;
    });

    if (best) return best;
    return {
      matched: false,
      type: '未可靠识别',
      folder: cleanFolderName(fallbackFolder) || '未分类',
      score: 0,
      tagScore: 0,
      evidence: [],
      order: -1,
    };
  }

  /** 只按完整名称匹配（忽略首尾空格、大小写与全半角），不做模糊收藏夹匹配。 */
  function findFolder(folders, targetName) {
    const list = Array.isArray(folders) ? folders : [];
    const raw = cleanFolderName(targetName);
    const wanted = norm(raw);
    return list.find((f) => cleanFolderName(f && f.title) === raw)
      || list.find((f) => norm(f && f.title) === wanted)
      || null;
  }

  function apiMessage(body, fallback) {
    if (!body) return fallback || '接口未返回内容';
    return str(body.message || body.msg || (body.code !== undefined ? 'code ' + body.code : fallback));
  }

  function fatalCode(body) {
    return !!body && [-101, -102, -111].includes(num(body.code));
  }

  function unknownResult(err) {
    return { status: 'unknown', text: '请求异常：' + ((err && err.message) || err) + '；请刷新状态后核对' };
  }

  function skippedResult(reason) {
    return { status: 'skipped', text: reason || '未执行' };
  }

  /**
   * 真正执行三连。所有写操作只尝试一次，不做自动重试。
   * io.preflight 必须先返回最新的点赞、投币、收藏夹状态。
   * io.assertActive 用于页面切换后的过期任务保护。
   */
  async function executeTriple(task, io) {
    const video = task.video;
    const targetName = cleanFolderName(task.targetName);
    const out = {
      targetName: targetName,
      folder: null,
      folderCreated: false,
      like: { status: 'pending', text: '等待' },
      coin: { status: 'pending', text: '等待' },
      favorite: { status: 'pending', text: '等待' },
    };
    if (!targetName) throw new Error('收藏夹名称不能为空');

    const pre = await io.preflight(video);
    let folder = findFolder(pre.folders, targetName);
    out.folder = folder;
    let stop = false;

    async function guard() {
      if (typeof io.assertActive === 'function') await io.assertActive();
    }

    function applyFailure(step, body) {
      step.status = 'failed';
      step.text = apiMessage(body, '操作失败') + (body && body.code !== undefined ? '（code ' + body.code + '）' : '');
      if (fatalCode(body)) stop = true;
    }

    // 点赞
    if (pre.liked) {
      out.like = { status: 'already', text: '此前已点赞' };
    } else if (stop) {
      out.like = skippedResult('登录态失效，未执行');
    } else {
      try {
        await guard();
        const body = await io.like(video);
        if (num(body.code) === 0) out.like = { status: 'success', text: '点赞成功' };
        else if (num(body.code) === 65006) out.like = { status: 'already', text: '此前已点赞' };
        else applyFailure(out.like, body);
      } catch (e) {
        if (e && e.code === 'STALE') throw e;
        out.like = unknownResult(e);
      }
    }

    // 投币：只要此前投过，就不擅自补到 2 枚，避免重复操作。
    if (num(pre.coins) > 0) {
      out.coin = { status: 'already', text: '此前已投 ' + num(pre.coins) + ' 枚' };
    } else if (stop) {
      out.coin = skippedResult('登录态失效，未执行');
    } else {
      try {
        await guard();
        const body = await io.coin(video, task.coinCount);
        if (num(body.code) === 0) out.coin = { status: 'success', text: '投币成功 · ' + task.coinCount + ' 枚' };
        else applyFailure(out.coin, body);
      } catch (e) {
        if (e && e.code === 'STALE') throw e;
        out.coin = unknownResult(e);
      }
    }

    // 收藏夹不存在时才新建，privacy=1 明确指定私密。
    if (!folder && !stop) {
      try {
        await guard();
        const body = await io.createFolder(targetName);
        if (num(body.code) === 0 && body.data && num(body.data.id) > 0) {
          folder = body.data;
          out.folderCreated = true;
        } else {
          // 另一个标签页可能同时建好了；只读重查一次，不重复提交创建。
          if (typeof io.refindFolder === 'function') folder = await io.refindFolder(targetName);
          if (!folder) applyFailure(out.favorite, body);
        }
      } catch (e) {
        if (e && e.code === 'STALE') throw e;
        // 网络异常时也可能其实已创建成功，先只读核对。
        try {
          if (typeof io.refindFolder === 'function') folder = await io.refindFolder(targetName);
        } catch (ignore) { /* 保留下面的未知状态 */ }
        if (!folder) out.favorite = unknownResult(e);
      }
      out.folder = folder;
    }

    // 加入目标收藏夹，不移出其他收藏夹。
    if (out.favorite.status === 'failed' || out.favorite.status === 'unknown') {
      // 建夹步骤已给出错误，不再提交收藏。
    } else if (folder && num(folder.fav_state) === 1) {
      out.favorite = { status: 'already', text: '已在「' + cleanFolderName(folder.title) + '」中' };
    } else if (!folder) {
      out.favorite = skippedResult(stop ? '登录态失效，未收藏' : '目标收藏夹不可用，未收藏');
    } else if (stop) {
      out.favorite = skippedResult('登录态失效，未收藏');
    } else {
      try {
        await guard();
        const body = await io.favorite(video, folder.id);
        if (num(body.code) === 0) {
          out.favorite = { status: 'success', text: '已收藏到「' + cleanFolderName(folder.title || targetName) + '」' };
        } else if (num(body.code) === 11201) {
          out.favorite = { status: 'already', text: '已在目标收藏夹中' };
        } else applyFailure(out.favorite, body);
      } catch (e) {
        if (e && e.code === 'STALE') throw e;
        out.favorite = unknownResult(e);
      }
    }

    return out;
  }

  // ============================================================
  // 3. 设置存储与网络层
  // ============================================================
  function loadSettings() {
    const base = {
      coinCount: CFG.defaultCoinCount,
      fallbackFolder: CFG.defaultFallbackFolder,
      rules: validateRules(DEFAULT_RULES),
    };
    try {
      const raw = localStorage.getItem(CFG.storageKey);
      if (!raw) return base;
      const saved = JSON.parse(raw);
      const count = num(saved.coinCount) === 2 ? 2 : 1;
      return {
        coinCount: count,
        fallbackFolder: cleanFolderName(saved.fallbackFolder) || base.fallbackFolder,
        rules: validateRules(saved.rules || base.rules),
      };
    } catch (e) {
      console.warn('[BiliTriple] 设置读取失败，使用默认值：', e);
      return base;
    }
  }

  let settings = loadSettings();

  function saveSettings() {
    try { localStorage.setItem(CFG.storageKey, JSON.stringify(settings)); } catch (e) { /* 隐私模式忽略 */ }
  }

  function getCsrf() {
    const m = document.cookie.match(/(?:^|;\s*)bili_jct=([^;]+)/);
    if (!m) return '';
    try { return decodeURIComponent(m[1]); } catch (e) { return m[1]; }
  }

  function makeQuery(params) {
    const q = new URLSearchParams();
    Object.keys(params || {}).forEach((k) => {
      if (params[k] !== undefined && params[k] !== null) q.set(k, String(params[k]));
    });
    return q.toString();
  }

  function request(method, path, params, form) {
    const query = makeQuery(params);
    const url = API_ROOT + path + (query ? '?' + query : '');
    const body = form ? makeQuery(form) : undefined;
    const headers = {};
    if (form) headers['Content-Type'] = 'application/x-www-form-urlencoded;charset=UTF-8';

    if (typeof GM_xmlhttpRequest === 'function') {
      return new Promise((resolve, reject) => {
        GM_xmlhttpRequest({
          method: method,
          url: url,
          headers: Object.assign({ Referer: location.href }, headers),
          data: body,
          anonymous: false,
          timeout: CFG.requestTimeout,
          onload: (res) => {
            let json;
            try { json = JSON.parse(res.responseText); } catch (e) {
              reject(new Error(path + ' 返回的不是 JSON（HTTP ' + res.status + '）'));
              return;
            }
            if (res.status < 200 || res.status >= 300) {
              reject(new Error(path + ' HTTP ' + res.status + '：' + apiMessage(json, '请求失败')));
              return;
            }
            resolve(json);
          },
          onerror: () => reject(new Error(path + ' 网络请求失败')),
          ontimeout: () => reject(new Error(path + ' 请求超时')),
        });
      });
    }

    // 兼容支持跨域 fetch 的环境；Tampermonkey 走上面的 GM 请求。
    return fetch(url, {
      method: method,
      credentials: 'include',
      headers: headers,
      body: body,
    }).then(async (res) => {
      const json = await res.json();
      if (!res.ok) throw new Error(path + ' HTTP ' + res.status);
      return json;
    });
  }

  function unwrap(body, path) {
    if (!body || num(body.code) !== 0) {
      const err = new Error((path || '接口') + '：' + apiMessage(body, '请求失败') + '（code ' + (body ? body.code : '未知') + '）');
      err.apiCode = body ? num(body.code) : null;
      throw err;
    }
    return body.data;
  }

  function videoParams(video) {
    return video.bvid ? { bvid: video.bvid } : { aid: video.aid };
  }

  // ============================================================
  // 4. 只读预览与真实 IO
  // ============================================================
  const logs = [];
  let uiLog = null;

  function log(message) {
    const line = clock() + '  ' + str(message);
    logs.push(line);
    if (logs.length > 60) logs.shift();
    if (uiLog) uiLog.textContent = logs.slice(-16).join('\n');
    if (CFG.debug) console.log('[BiliTriple]', message);
  }

  function currentVideoId() {
    const m = location.pathname.match(/\/video\/(BV[0-9a-z]+|av\d+)/i);
    if (!m) return null;
    return /^av/i.test(m[1]) ? { aid: m[1].slice(2), bvid: '' } : { aid: 0, bvid: m[1] };
  }

  async function readPreview(id) {
    const view = unwrap(await request('GET', EP.view, videoParams(id)), EP.view);
    const video = {
      aid: num(view.aid),
      bvid: str(view.bvid || id.bvid),
      title: str(view.title),
      tname: str(view.tname),
      owner: str(view.owner && view.owner.name),
    };

    let login = false;
    let mid = 0;
    const navBody = await request('GET', EP.nav);
    if (num(navBody.code) === 0 && navBody.data) {
      login = !!navBody.data.isLogin;
      mid = num(navBody.data.mid);
    } else if (num(navBody.code) !== -101) {
      unwrap(navBody, EP.nav);
    }

    let tags = [];
    let tagError = '';
    try {
      const data = unwrap(await request('GET', EP.tags, videoParams(video)), EP.tags);
      tags = (Array.isArray(data) ? data : []).map((t) => str(t.tag_name)).filter(Boolean);
    } catch (e) {
      tagError = (e && e.message) || str(e);
      log('标签读取失败，已降级为标题/分区：' + tagError);
    }

    let folders = [];
    if (login) {
      const data = unwrap(await request('GET', EP.folders, { up_mid: mid, type: 2, rid: video.aid }), EP.folders);
      folders = Array.isArray(data && data.list) ? data.list : [];
    }

    return {
      video: video,
      tags: tags,
      tagError: tagError,
      login: login,
      mid: mid,
      folders: folders,
      classification: classify(video, tags, settings.rules, settings.fallbackFolder),
    };
  }

  function makeIO(my) {
    function assertActive() {
      if (my !== seq) {
        const e = new Error('页面已切换，停止后续操作');
        e.code = 'STALE';
        throw e;
      }
    }

    async function preflight(video) {
      const csrf = getCsrf();
      if (!csrf) throw new Error('没有读取到 bili_jct，无法通过 CSRF 校验。请确认已登录后刷新页面');
      const nav = unwrap(await request('GET', EP.nav), EP.nav);
      if (!nav || !nav.isLogin || !(num(nav.mid) > 0)) throw new Error('账号未登录或登录态已失效');
      const mid = num(nav.mid);
      const [folderBody, likeBody, coinBody] = await Promise.all([
        request('GET', EP.folders, { up_mid: mid, type: 2, rid: video.aid }),
        request('GET', EP.hasLike, videoParams(video)),
        request('GET', EP.coins, videoParams(video)),
      ]);
      const folderData = unwrap(folderBody, EP.folders);
      const liked = unwrap(likeBody, EP.hasLike);
      const coinData = unwrap(coinBody, EP.coins);
      log('预检完成：点赞=' + (num(liked) ? '是' : '否') + '，已投币=' + num(coinData && coinData.multiply) + '，收藏夹=' + ((folderData.list || []).length));
      return {
        mid: mid,
        folders: Array.isArray(folderData.list) ? folderData.list : [],
        liked: num(liked) === 1,
        coins: num(coinData && coinData.multiply),
      };
    }

    async function refindFolder(name) {
      const nav = unwrap(await request('GET', EP.nav), EP.nav);
      const data = unwrap(await request('GET', EP.folders, { up_mid: num(nav.mid), type: 2 }), EP.folders);
      return findFolder(data && data.list, name);
    }

    function post(path, form) {
      const csrf = getCsrf();
      if (!csrf) throw new Error('CSRF 凭据为空，请刷新页面');
      return request('POST', path, null, Object.assign({}, form, { csrf: csrf }));
    }

    return {
      preflight: preflight,
      assertActive: assertActive,
      refindFolder: refindFolder,
      like: (video) => {
        log('提交点赞（只提交一次）');
        return post(EP.like, Object.assign(videoParams(video), { like: 1 }));
      },
      coin: (video, count) => {
        log('提交投币 ' + count + ' 枚（只提交一次）');
        return post(EP.coinAdd, Object.assign(videoParams(video), { multiply: count, select_like: 0 }));
      },
      createFolder: (name) => {
        log('目标收藏夹不存在，提交新建私密收藏夹「' + name + '」');
        return post(EP.folderAdd, {
          title: name,
          intro: '由 B站一键三连·智能分类收藏 创建',
          privacy: 1,
          cover: '',
        });
      },
      favorite: (video, folderId) => {
        log('提交加入收藏夹 ' + folderId + '（不移出其他收藏夹）');
        return post(EP.favDeal, {
          rid: video.aid,
          type: 2,
          add_media_ids: folderId,
          del_media_ids: '',
        });
      },
    };
  }

  // ============================================================
  // 5. Shadow DOM 面板
  // ============================================================
  const HOST_ID = 'bili-triple-assistant-host';
  const CSS = `
:host {
  --bg: #fff; --panel: #f7f8fa; --text: #18191c; --muted: #757a85;
  --line: #e5e7eb; --accent: #fb7299; --accent2: #e75d86;
  --ok: #18a058; --warn: #b26a00; --bad: #d03050;
  all: initial;
}
* { box-sizing: border-box; }
.card {
  width: 330px; overflow: hidden; border: 1px solid var(--line); border-radius: 12px;
  background: var(--bg); color: var(--text); box-shadow: 0 8px 30px rgba(0,0,0,.18);
  font: 12px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif;
}
.head { display:flex; align-items:center; gap:8px; padding:10px 12px; font-size:13px; font-weight:600; }
.head .name { flex:1; }
button, select, input, textarea { font: inherit; color: inherit; }
button { cursor:pointer; }
.icon { width:25px; height:25px; border:0; border-radius:6px; background:transparent; color:var(--muted); }
.icon:hover { background:var(--panel); color:var(--text); }
.body { padding:0 12px 11px; }
.video { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:var(--muted); margin-bottom:8px; }
.status { padding:7px 9px; border-radius:7px; background:var(--panel); margin-bottom:8px; }
.status.warn { color:var(--warn); }
.kind { display:flex; align-items:center; gap:6px; margin:7px 0 2px; }
.badge { padding:2px 7px; border-radius:5px; background:rgba(251,114,153,.12); color:var(--accent2); font-weight:600; }
.evidence { color:var(--muted); font-size:11px; margin:3px 0 9px; word-break:break-all; }
.label { display:block; color:var(--muted); margin:7px 0 4px; }
.target {
  width:100%; height:32px; padding:0 9px; border:1px solid var(--line); border-radius:7px;
  outline:none; background:var(--bg);
}
.target:focus { border-color:var(--accent); }
.folderHint { min-height:18px; color:var(--muted); font-size:11px; margin:4px 0 8px; }
.actions { display:flex; gap:7px; align-items:center; }
.primary {
  flex:1; height:34px; border:0; border-radius:8px; background:var(--accent); color:#fff;
  font-weight:600; font-size:13px;
}
.primary:hover { background:var(--accent2); }
.primary:disabled { cursor:not-allowed; opacity:.45; }
.secondary { height:32px; padding:0 10px; border:1px solid var(--line); border-radius:7px; background:var(--bg); }
.results { margin-top:9px; border-top:1px solid var(--line); padding-top:7px; }
.result { display:flex; gap:7px; padding:3px 0; }
.result .k { flex:none; width:42px; color:var(--muted); }
.result .v { flex:1; word-break:break-all; }
.result.success .v, .result.already .v { color:var(--ok); }
.result.failed .v, .result.unknown .v { color:var(--bad); }
.result.skipped .v { color:var(--warn); }
.summary { margin-top:5px; font-weight:600; }
.settings { margin-top:10px; padding-top:9px; border-top:1px solid var(--line); }
.row { display:flex; gap:8px; align-items:center; margin:6px 0; }
.row > span { flex:none; width:76px; color:var(--muted); }
.row input, .row select { flex:1; min-width:0; height:29px; border:1px solid var(--line); border-radius:6px; background:var(--bg); padding:0 6px; }
.rules { width:100%; height:145px; resize:vertical; border:1px solid var(--line); border-radius:7px; background:var(--panel); padding:7px; font:10.5px/1.45 Consolas,monospace; }
.settingsMsg { min-height:17px; color:var(--warn); margin-top:4px; }
details { margin-top:8px; color:var(--muted); }
summary { cursor:pointer; }
pre { max-height:145px; overflow:auto; white-space:pre-wrap; word-break:break-all; background:var(--panel); padding:7px; border-radius:6px; font:10px/1.5 Consolas,monospace; }
.foot { margin-top:8px; color:var(--muted); font-size:10.5px; }
.folded .body { display:none; }
:host([data-theme="dark"]) {
  --bg:#1f2023; --panel:#2a2c30; --text:#e8eaed; --muted:#a0a5ae; --line:#3c3f45;
  --accent2:#ff8bad; --ok:#55c98a; --warn:#e4ac55; --bad:#ff8095;
}
`;

  const HTML = `
<div class="card">
  <div class="head">
    <span class="name">一键三连 · 智能收藏</span>
    <button class="icon" data-act="fold" title="折叠">−</button>
  </div>
  <div class="body">
    <div class="video">正在读取视频…</div>
    <div class="status">正在读取登录态与标签…</div>
    <div class="kind"><span>判断类型</span><span class="badge">···</span></div>
    <div class="evidence"></div>
    <label class="label" for="target">收藏到（执行前可修改）</label>
    <input id="target" class="target" list="folderList" maxlength="40" autocomplete="off" />
    <datalist id="folderList"></datalist>
    <div class="folderHint"></div>
    <div class="actions">
      <button class="primary" data-act="run" disabled>一键三连</button>
      <button class="secondary" data-act="refresh" title="重新读取">刷新</button>
      <button class="secondary" data-act="settings">设置</button>
    </div>
    <div class="results" hidden></div>
    <section class="settings" hidden>
      <div class="row"><span>投币数量</span><select class="coin"><option value="1">1 枚</option><option value="2">2 枚</option></select></div>
      <div class="row"><span>未识别时</span><input class="fallback" maxlength="40" /></div>
      <label class="label">分类规则 JSON（保存后立即重新判断）</label>
      <textarea class="rules" spellcheck="false"></textarea>
      <div class="actions"><button class="secondary" data-act="saveSettings">保存设置</button><button class="secondary" data-act="resetRules">恢复默认规则</button></div>
      <div class="settingsMsg"></div>
    </section>
    <details><summary>诊断日志</summary><pre></pre></details>
    <div class="foot">只在点击按钮后执行 · 新收藏夹默认私密 · 不自动重试写操作</div>
  </div>
</div>`;

  const UI = (() => {
    let host = null;
    let shadow = null;
    let card = null;
    const r = {};

    function mount() {
      if (host && host.isConnected) return;
      host = document.createElement('div');
      host.id = HOST_ID;
      host.style.cssText = 'position:fixed;right:18px;bottom:110px;z-index:2147483000;';
      shadow = host.attachShadow({ mode: 'open' });
      const style = document.createElement('style');
      style.textContent = CSS;
      shadow.appendChild(style);
      const wrap = document.createElement('div');
      wrap.innerHTML = HTML;
      shadow.appendChild(wrap);
      document.documentElement.appendChild(host);
      card = shadow.querySelector('.card');
      ['video', 'status', 'badge', 'evidence', 'target', 'folderList', 'folderHint', 'results', 'settings', 'coin', 'fallback', 'rules', 'settingsMsg'].forEach((k) => {
        r[k] = shadow.querySelector('.' + k) || shadow.querySelector('#' + k);
      });
      r.run = shadow.querySelector('[data-act="run"]');
      uiLog = shadow.querySelector('pre');
      r.coin.value = String(settings.coinCount);
      r.fallback.value = settings.fallbackFolder;
      r.rules.value = JSON.stringify(settings.rules, null, 2);

      shadow.addEventListener('click', (e) => {
        const b = e.target.closest('[data-act]');
        if (!b) return;
        const act = b.dataset.act;
        if (act === 'fold') {
          card.classList.toggle('folded');
          b.textContent = card.classList.contains('folded') ? '+' : '−';
        } else if (act === 'refresh') {
          sync(true);
        } else if (act === 'settings') {
          r.settings.hidden = !r.settings.hidden;
        } else if (act === 'run') {
          onRun();
        } else if (act === 'saveSettings') {
          onSaveSettings();
        } else if (act === 'resetRules') {
          r.rules.value = JSON.stringify(validateRules(DEFAULT_RULES), null, 2);
          r.settingsMsg.textContent = '已填入默认规则，点击「保存设置」后生效';
        }
      });
      r.target.addEventListener('input', () => {
        targetDirty = true;
        updateFolderHint();
      });
      r.coin.addEventListener('change', () => {
        settings.coinCount = num(r.coin.value) === 2 ? 2 : 1;
        saveSettings();
      });
      applyTheme();
    }

    function applyTheme() {
      if (!host) return;
      const dark = document.documentElement.classList.contains('dark')
        || (document.body && document.body.classList.contains('dark'))
        || (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
      host.dataset.theme = dark ? 'dark' : 'light';
    }

    function show() { if (host) host.style.display = ''; }
    function hide() { if (host) host.style.display = 'none'; }
    function loading(text) {
      r.video.textContent = text || '正在读取…';
      r.status.textContent = '请稍候';
      r.run.disabled = true;
    }

    function render(preview) {
      r.video.textContent = preview.video.title || '(无标题)';
      r.video.title = preview.video.title || '';
      r.status.classList.toggle('warn', !preview.login);
      r.status.textContent = preview.login
        ? '已登录 · 读取到 ' + preview.folders.length + ' 个收藏夹'
        : '未登录或登录态未读取到，请先在此浏览器登录 B 站';
      const c = preview.classification;
      r.badge.textContent = c.matched ? c.type + ' · ' + c.score + ' 分' : '未可靠识别';
      const ev = [];
      if (c.evidence.length) ev.push('依据：' + c.evidence.slice(0, 3).join('、'));
      else ev.push('没有规则达到阈值，将使用未识别收藏夹');
      if (preview.tagError) ev.push('标签读取失败，本次未使用标签');
      else ev.push('标签：' + (preview.tags.length ? preview.tags.slice(0, 6).join(' / ') : '无'));
      r.evidence.textContent = ev.join('；');
      if (!targetDirty) r.target.value = c.folder;
      r.folderList.textContent = '';
      preview.folders.forEach((f) => {
        const op = document.createElement('option');
        op.value = cleanFolderName(f.title);
        r.folderList.appendChild(op);
      });
      r.results.hidden = true;
      r.run.textContent = '一键三连';
      r.run.disabled = !preview.login || running;
      updateFolderHint();
    }

    function error(e) {
      r.status.classList.add('warn');
      r.status.textContent = '读取失败：' + ((e && e.message) || e);
      r.run.disabled = true;
    }

    function updateFolderHint() {
      if (!ctx || !r.target) return;
      const name = cleanFolderName(r.target.value);
      if (!name) {
        r.folderHint.textContent = '收藏夹名称不能为空';
        r.run.disabled = true;
        return;
      }
      const found = findFolder(ctx.folders, name);
      r.folderHint.textContent = found
        ? '将使用现有收藏夹 · 当前 ' + num(found.media_count) + ' 个内容'
        : '不存在同名收藏夹，将自动新建为「私密」';
      r.run.disabled = !ctx.login || running;
    }

    function busy() {
      r.run.disabled = true;
      r.run.textContent = '执行中…';
      r.results.hidden = false;
      r.results.textContent = '正在重新查询状态并逐项执行，请勿重复点击…';
    }

    function renderResult(out) {
      const rows = [
        ['点赞', out.like],
        ['投币', out.coin],
        ['收藏', out.favorite],
      ];
      r.results.textContent = '';
      const frag = document.createDocumentFragment();
      rows.forEach(([label, step]) => {
        const row = document.createElement('div');
        row.className = 'result ' + step.status;
        const k = document.createElement('span');
        k.className = 'k'; k.textContent = label;
        const v = document.createElement('span');
        v.className = 'v'; v.textContent = step.text;
        row.appendChild(k); row.appendChild(v); frag.appendChild(row);
      });
      const summary = document.createElement('div');
      const bad = rows.some(([, s]) => ['failed', 'unknown', 'skipped'].includes(s.status));
      summary.className = 'summary';
      summary.style.color = bad ? 'var(--warn)' : 'var(--ok)';
      summary.textContent = bad ? '流程结束，但有项目未成功，请逐项核对' : '三连流程完成';
      if (out.folderCreated) summary.textContent += ' · 已新建私密收藏夹';
      frag.appendChild(summary);
      r.results.appendChild(frag);
      r.run.textContent = '重新检查并三连';
      r.run.disabled = !ctx || !ctx.login;
      if (out.folder && !findFolder(ctx.folders, out.targetName)) ctx.folders.push(out.folder);
      updateFolderHint();
    }

    function readyAfterError() {
      r.run.textContent = '重新检查并三连';
      r.run.disabled = !ctx || !ctx.login;
    }

    return { mount, show, hide, loading, render, error, updateFolderHint, busy, renderResult, readyAfterError, applyTheme, refs: r };
  })();

  // ============================================================
  // 6. 主流程与单页路由
  // ============================================================
  let seq = 0;
  let lastKey = '';
  let ctx = null;
  let running = false;
  let targetDirty = false;

  async function sync(force) {
    const id = currentVideoId();
    const key = id ? (id.bvid || 'av' + id.aid) : '';
    if (!key) {
      seq++;
      ctx = null;
      UI.hide();
      lastKey = '';
      return;
    }
    if (!force && key === lastKey && ctx) return;
    if (running && key === lastKey) return;
    lastKey = key;
    const my = ++seq;
    ctx = null;
    targetDirty = false;
    UI.mount();
    UI.show();
    UI.loading('正在读取：' + key);
    log('读取视频 ' + key);
    try {
      const preview = await readPreview(id);
      if (my !== seq) return;
      ctx = preview;
      UI.render(preview);
      log('分类：' + preview.classification.type + ' → ' + preview.classification.folder + '；登录=' + preview.login);
    } catch (e) {
      if (my !== seq) return;
      log('预览失败：' + ((e && e.message) || e));
      UI.error(e);
    }
  }

  async function onRun() {
    if (!ctx || running) return;
    const targetName = cleanFolderName(UI.refs.target.value);
    if (!targetName) {
      UI.refs.folderHint.textContent = '请先填写收藏夹名称';
      return;
    }
    running = true;
    const my = seq;
    const currentCtx = ctx;
    UI.busy();
    try {
      const out = await executeTriple({
        video: currentCtx.video,
        targetName: targetName,
        coinCount: settings.coinCount,
      }, makeIO(my));
      if (my !== seq) return;
      UI.renderResult(out);
      log('流程结束：点赞=' + out.like.status + '，投币=' + out.coin.status + '，收藏=' + out.favorite.status);
    } catch (e) {
      if (my === seq) {
        log('流程中止：' + ((e && e.message) || e));
        UI.refs.results.hidden = false;
        UI.refs.results.textContent = '流程未执行或已中止：' + ((e && e.message) || e);
        UI.readyAfterError();
      }
    } finally {
      running = false;
      // 即使旧任务已过期，也要恢复新页面按钮；不能让它一直被旧任务禁用。
      if (ctx) UI.updateFolderHint();
    }
  }

  function onSaveSettings() {
    try {
      const rules = validateRules(JSON.parse(UI.refs.rules.value));
      const fallback = cleanFolderName(UI.refs.fallback.value) || CFG.defaultFallbackFolder;
      settings = { coinCount: settings.coinCount, fallbackFolder: fallback, rules: rules };
      saveSettings();
      UI.refs.settingsMsg.textContent = '设置已保存';
      if (ctx) {
        ctx.classification = classify(ctx.video, ctx.tags, settings.rules, settings.fallbackFolder);
        targetDirty = false;
        UI.render(ctx);
      }
      log('分类规则已更新，共 ' + rules.length + ' 条');
    } catch (e) {
      UI.refs.settingsMsg.textContent = '保存失败：' + ((e && e.message) || e);
    }
  }

  function hookHistory() {
    ['pushState', 'replaceState'].forEach((name) => {
      const old = history[name];
      if (typeof old !== 'function') return;
      history[name] = function () {
        const ret = old.apply(this, arguments);
        setTimeout(() => sync(false), 60);
        return ret;
      };
    });
    window.addEventListener('popstate', () => setTimeout(() => sync(false), 60));
    setInterval(() => sync(false), 1200);
    setInterval(() => UI.applyTheme(), 2500);
  }

  UI.mount();
  hookHistory();
  sync(true);
})();
