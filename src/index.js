/**
 * atoolne storage —— 你自己的文件仓库
 *
 * 这个 Worker 是你和你的存储之间唯一的门。
 * 密钥（UPLOAD_KEY）由浏览器直接发给这个 Worker，不会进入 atoolne 的服务器。
 *
 * 存储有两种，部署时绑了哪个就用哪个，**同一份代码**：
 *   · R2（binding 叫 BUCKET）—— 空间大，但开通 R2 要绑一张能在境外付款的卡
 *   · KV（binding 叫 FILES）  —— 免绑卡，免费额度 1 GB、单个文件 25 MB
 * 对 atoolne 来说两者完全一样：接口、链接、读写方式都不变。
 *
 *   GET    /                 健康检查
 *   GET    /_ping            带 x-upload-key 时顺便告诉你口令对不对
 *   GET    /f/<名字>          公开读取（不需要口令，链接就是靠这个）
 *   PUT    /<名字>            上传（需要 x-upload-key）
 *   DELETE /<名字>            删除（需要 x-upload-key）
 */

const VERSION = '1.2.0';

/* 保命用的：万一有人把这个 Worker 绑到了存帐号记录的私有桶上，
   这些前缀一律拒绝读写，别让公开的 GET 把帐号记录漏出去。 */
const RESERVED = ['acct/', 'map/', 'qq/'];
function reserved(key) {
  return RESERVED.some(p => key === p.slice(0, -1) || key.startsWith(p));
}

/* ---------- 两种存储，包成同一个样子 ---------- */

function r2Store(bucket) {
  return {
    kind: 'r2',
    capMB: Infinity,                       // R2 自己的上限远大于 MAX_MB，交给 MAX_MB 管
    async get(key) {
      const obj = await bucket.get(key);
      if (!obj) return null;
      const h = new Headers();
      obj.writeHttpMetadata(h);
      h.set('etag', obj.httpEtag);
      return { body: obj.body, headers: h };
    },
    async put(key, body, type) {
      await bucket.put(key, body, { httpMetadata: { contentType: type } });
    },
    async del(key) { await bucket.delete(key); },
  };
}

/* ⚠️ KV 的几条硬限制（Cloudflare 免费版）：
     · 单个值最大 25 MiB → 所以这里的上限封顶 25，不管 MAX_MB 写多少
     · key 最长 512 字节 → 很长的中文文件名会超，上传时先拦
     · 每天 1000 次写入、1000 次删除、10 万次读取
     · 刚写进去的值，在**别的地区**最多要约 60 秒才读得到（最终一致）
   ⚠️ 读的时候**不加 cacheTtl**。加了读得快一点，但删掉的文件会在边缘节点
   继续被读出来一段时间 —— 「删了还能打开」比「慢几十毫秒」糟得多。 */
function kvStore(ns) {
  return {
    kind: 'kv',
    capMB: 25,
    async get(key) {
      const { value, metadata } = await ns.getWithMetadata(key, { type: 'stream' });
      if (value === null) return null;
      const h = new Headers();
      h.set('content-type', (metadata && metadata.type) || 'application/octet-stream');
      if (metadata && metadata.etag) h.set('etag', `"${metadata.etag}"`);
      return { body: value, headers: h };
    },
    async put(key, body, type) {
      /* 直接把请求体的流交给 KV，不先读进内存 ——
         免费版 Worker 每次请求只有 10ms CPU，25MB 在 JS 里拷一遍很可能超。 */
      await ns.put(key, body === null ? '' : body, {
        metadata: { type: String(type).slice(0, 200), etag: crypto.randomUUID().slice(0, 12) },
      });
    },
    async del(key) { await ns.delete(key); },
  };
}

function storeOf(env) {
  if (env.BUCKET) return r2Store(env.BUCKET);
  if (env.FILES) return kvStore(env.FILES);
  return null;
}

/* ---------- 小工具 ---------- */

function corsHeaders(env) {
  return {
    'Access-Control-Allow-Origin': env.ALLOW_ORIGIN || '*',
    'Access-Control-Allow-Methods': 'GET,HEAD,PUT,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'x-upload-key,content-type',
    'Access-Control-Max-Age': '86400',
  };
}

function json(obj, status, cors) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...cors, 'content-type': 'application/json; charset=utf-8' },
  });
}

/** 逐字符全比一遍，不因为前缀相同就提前返回 */
function sameKey(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function authed(req, env) {
  return !!env.UPLOAD_KEY && sameKey(req.headers.get('x-upload-key') || '', env.UPLOAD_KEY);
}

/** 把路径还原成对象名，顺手挡掉穿越和奇怪字符 */
function keyOf(pathname, strip) {
  let k = pathname;
  if (strip && k.startsWith(strip)) k = k.slice(strip.length);
  k = k.replace(/^\/+/, '');
  try { k = decodeURIComponent(k); } catch (_) {}
  if (!k || k.includes('..') || k.startsWith('/')) return '';
  return k;
}

export default {
  async fetch(req, env) {
    const cors = corsHeaders(env);
    const url = new URL(req.url);

    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    const store = storeOf(env);
    if (!store) {
      return json({ ok: false, error: '存储没绑上（R2 的 binding 应该叫 BUCKET，KV 的叫 FILES）' }, 500, cors);
    }
    const maxMB = Math.min(Number(env.MAX_MB) || 25, store.capMB);
    const maxBytes = maxMB * 1024 * 1024;

    /* ---------- 健康检查 / 口令自检 ---------- */
    if ((req.method === 'GET' || req.method === 'HEAD') &&
        (url.pathname === '/' || url.pathname === '/_ping')) {
      // service 是现有网站与旧私人仓库共用的内部识别值，暂时保持兼容。
      const body = { ok: true, service: 'atne-storage', version: VERSION, backend: store.kind, maxMB };
      if (url.pathname === '/_ping') {
        body.hasKey = !!env.UPLOAD_KEY;
        body.auth = authed(req, env);
      }
      return json(body, 200, cors);
    }

    /* ---------- 公开读 ---------- */
    if (req.method === 'GET' || req.method === 'HEAD') {
      const key = keyOf(url.pathname, '/f');
      if (!key) return json({ ok: false, error: '路径不对' }, 400, cors);
      if (reserved(key)) return json({ ok: false, error: '这个路径不对外' }, 403, cors);

      const got = await store.get(key);
      if (!got) return json({ ok: false, error: '文件不存在' }, 404, cors);

      const h = new Headers(cors);
      got.headers.forEach((v, k) => h.set(k, v));
      // 名字里带随机串，内容不会变，可以放心长缓存
      h.set('cache-control', 'public, max-age=31536000, immutable');
      if (req.method === 'HEAD') {
        try { await got.body.cancel(); } catch (_) {}
        return new Response(null, { headers: h });
      }
      return new Response(got.body, { headers: h });
    }

    /* ---------- 上传 ---------- */
    if (req.method === 'PUT') {
      if (!env.UPLOAD_KEY) return json({ ok: false, error: '这个 Worker 还没设置 UPLOAD_KEY' }, 500, cors);
      if (!authed(req, env)) return json({ ok: false, error: '口令不对' }, 403, cors);

      const key = keyOf(url.pathname);
      if (!key) return json({ ok: false, error: '要给文件起个名字' }, 400, cors);
      if (reserved(key)) return json({ ok: false, error: '这个路径是保留的' }, 403, cors);
      if (store.kind === 'kv' && new TextEncoder().encode(key).length > 512) {
        return json({ ok: false, error: '文件名太长了，改短一点再传' }, 400, cors);
      }

      const len = Number(req.headers.get('content-length') || 0);
      if (len > maxBytes) {
        return json({ ok: false, error: `文件超过 ${maxMB}MB 上限` }, 413, cors);
      }

      try {
        await store.put(key, req.body, req.headers.get('content-type') || 'application/octet-stream');
      } catch (e) {
        /* KV 超过 25MB、或者当天写入次数用完，都会走到这里 */
        const msg = String(e && e.message || e);
        const tooBig = /too large|exceed|size/i.test(msg);
        return json({ ok: false, error: tooBig ? `文件超过 ${maxMB}MB 上限` : '存储写入失败：' + msg },
                    tooBig ? 413 : 500, cors);
      }
      return json({ ok: true, pathname: key, url: `${url.origin}/f/${encodeURI(key)}` }, 200, cors);
    }

    /* ---------- 删除 ---------- */
    if (req.method === 'DELETE') {
      if (!authed(req, env)) return json({ ok: false, error: '口令不对' }, 403, cors);
      const key = keyOf(url.pathname);
      if (!key) return json({ ok: false, error: '路径不对' }, 400, cors);
      if (reserved(key)) return json({ ok: false, error: '这个路径是保留的' }, 403, cors);
      await store.del(key);
      return json({ ok: true }, 200, cors);
    }

    return json({ ok: false, error: '不支持这个方法' }, 405, cors);
  },
};
