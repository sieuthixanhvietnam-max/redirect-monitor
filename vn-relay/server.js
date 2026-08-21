import Fastify from 'fastify';
// Cung ly do nhu trong lib/fetcher.js: fetch va ProxyAgent phai den tu cung mot
// ban undici, neu khong Node se tu choi dispatcher.
import { fetch } from 'undici';
import { fetchChain } from './lib/fetcher.js';
import { fetchWithBrowser, browserAvailable, closeBrowser } from './lib/browser.js';
import {
  httpDispatcher, listVantages, knownVantage, defaultVantage, proxyErrors, DIRECT,
} from './lib/proxy.js';

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '0.0.0.0';
const API_KEY = process.env.RELAY_API_KEY || '';
const MAX_CONCURRENCY = Number(process.env.RELAY_CONCURRENCY || 24);
const BROWSER_CONCURRENCY = Number(process.env.RELAY_BROWSER_CONCURRENCY || 2);
const NODE_NAME = process.env.RELAY_NODE_NAME || 'vn-relay-1';

if (!API_KEY) {
  console.error('[FATAL] Thieu bien moi truong RELAY_API_KEY. Relay khong duoc phep chay mo.');
  process.exit(1);
}
if (API_KEY.length < 24) {
  console.error('[FATAL] RELAY_API_KEY qua ngan (can >= 24 ky tu).');
  process.exit(1);
}
// Khai bao proxy sai ma van chay = relay am tham di ra bang IP that, trong khi
// dashboard van bao "co proxy". Tha chet han con hon chay sai.
for (const e of proxyErrors()) console.error(`[FATAL] ${e}`);
if (proxyErrors().length) process.exit(1);

const app = Fastify({ logger: { level: process.env.LOG_LEVEL || 'info' } });

// ---- Semaphore don gian ----
function makeSemaphore(n) {
  let active = 0;
  const queue = [];
  const release = () => {
    active--;
    const next = queue.shift();
    if (next) {
      active++;
      next();
    }
  };
  return {
    async acquire() {
      if (active < n) {
        active++;
        return release;
      }
      await new Promise((resolve) => queue.push(resolve));
      return release;
    },
    stats: () => ({ active, queued: queue.length, limit: n }),
  };
}

const httpSem = makeSemaphore(MAX_CONCURRENCY);
const browserSem = makeSemaphore(BROWSER_CONCURRENCY);

const stats = {
  startedAt: new Date().toISOString(),
  requests: 0,
  httpRequests: 0,
  browserRequests: 0,
  errors: 0,
};

// ---- Auth ----
app.addHook('onRequest', async (req, reply) => {
  if (req.url === '/health' || req.url === '/') return;
  const key = req.headers['x-api-key'];
  if (key !== API_KEY) {
    stats.errors++;
    reply.code(401).send({ error: 'unauthorized' });
  }
});

app.get('/', async () => ({ service: 'vn-redirect-relay', node: NODE_NAME }));

app.get('/health', async () => ({
  ok: true,
  node: NODE_NAME,
  vantages: listVantages(),
  browser: await browserAvailable(),
  http: httpSem.stats(),
  browserPool: browserSem.stats(),
  stats,
  now: new Date().toISOString(),
}));

// Xem IP thoat that su cua relay (de xac nhan dung la IP Viet Nam)
app.get('/egress-ip', async (req) => {
  const via = req.query?.via || defaultVantage();
  const out = { via, ip: null, country: null, isp: null, source: null, error: null };
  if (!knownVantage(via)) return { ...out, error: `khong co diem quan sat "${via}"` };
  const sources = [
    { url: 'https://ipinfo.io/json', map: (j) => ({ ip: j.ip, country: j.country, isp: j.org }) },
    { url: 'https://ipapi.co/json/', map: (j) => ({ ip: j.ip, country: j.country_code, isp: j.org }) },
  ];
  for (const s of sources) {
    try {
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(), 6000);
      const dispatcher = httpDispatcher(via);
      const r = await fetch(s.url, dispatcher ? { signal: ac.signal, dispatcher } : { signal: ac.signal });
      clearTimeout(t);
      if (!r.ok) continue;
      const j = await r.json();
      Object.assign(out, s.map(j), { source: s.url });
      return out;
    } catch (e) {
      out.error = String(e?.message || e);
    }
  }
  return out;
});

/**
 * POST /fetch
 * body: {
 *   url: string (bat buoc),
 *   mode?: 'http' | 'browser' | 'auto'   (mac dinh 'auto')
 *   timeoutMs?: number,
 *   userAgent?: string,
 *   maxHops?: number,
 *   method?: 'GET' | 'HEAD'
 * }
 */
app.post('/fetch', async (req, reply) => {
  const body = req.body || {};
  const url = body.url;
  if (!url || typeof url !== 'string') {
    return reply.code(400).send({ error: 'missing_url' });
  }
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return reply.code(400).send({ error: 'invalid_url' });
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    return reply.code(400).send({ error: 'unsupported_protocol' });
  }

  const mode = body.mode || 'auto';
  const via = body.via || defaultVantage();
  if (!knownVantage(via)) {
    return reply.code(400).send({ error: 'unknown_vantage', detail: `khong co diem quan sat "${via}"` });
  }
  const timeoutMs = Math.min(Number(body.timeoutMs || 15000), 60000);
  // mode='head' la dang rut gon cua mode='http' + method='HEAD': nhe hon nhieu
  // nhung mat kha nang bat meta refresh / JS redirect (xem fetchChain).
  const opts = {
    timeoutMs,
    userAgent: body.userAgent,
    maxHops: Math.min(Number(body.maxHops || 10), 20),
    via,
    method: mode === 'head' || body.method === 'HEAD' ? 'HEAD' : 'GET',
  };

  stats.requests++;

  try {
    if (mode === 'browser') {
      const rel = await browserSem.acquire();
      try {
        stats.browserRequests++;
        const r = await fetchWithBrowser(url, { timeoutMs: Math.max(timeoutMs, 30000), userAgent: body.userAgent, via });
        return { node: NODE_NAME, ...r };
      } finally {
        rel();
      }
    }

    const rel = await httpSem.acquire();
    let result;
    try {
      stats.httpRequests++;
      result = await fetchChain(url, opts);
    } finally {
      rel();
    }

    // Auto-escalate sang browser khi bi chan, hoac khi nghi co JS redirect.
    //
    // 'waf' CO trong danh sach. Truoc day thi khong — ly do luc do la trang chan
    // cung tra ve truoc khi JS chay nen browser vo dung. Do lai thi thay sai:
    // tu mot IP DUNG, cai quyet dinh khong phai la JS ma la fingerprint TLS.
    // Da kiem chung tren dintol.com.co, cung mot proxy datacenter VN:
    //     undici + header gia Chrome -> 403 (phan loai 'waf')
    //     Chromium that              -> 301 -> go88club9.com
    // Neu khong escalate o 'waf' thi cai 301 do khong bao gio duoc nhin thay.
    //
    // 'geo' van KHONG escalate: chan theo quoc gia thi doi trinh duyet vo nghia,
    // chi doi duoc bang cach di ra tu nuoc khac.
    const shouldEscalate =
      mode === 'auto' &&
      ((result.block && ['bot', 'unknown', 'waf'].includes(result.block.kind)) ||
        !!result.jsRedirectHint);

    if (shouldEscalate && (await browserAvailable())) {
      const brel = await browserSem.acquire();
      try {
        stats.browserRequests++;
        const br = await fetchWithBrowser(url, {
          timeoutMs: Math.max(timeoutMs, 30000),
          userAgent: body.userAgent,
          via,
        });
        return {
          node: NODE_NAME,
          ...br,
          escalatedFrom: {
            mode: 'http',
            finalStatus: result.finalStatus,
            block: result.block,
            jsRedirectHint: result.jsRedirectHint,
          },
        };
      } catch (e) {
        return { node: NODE_NAME, ...result, escalationError: String(e?.message || e) };
      } finally {
        brel();
      }
    }

    return { node: NODE_NAME, ...result };
  } catch (err) {
    stats.errors++;
    req.log.error({ err, url }, 'fetch failed');
    return reply.code(500).send({ error: 'relay_failure', detail: String(err?.message || err) });
  }
});

/** POST /fetch-batch  body: { urls: string[], ...cungOptions } */
app.post('/fetch-batch', async (req, reply) => {
  const body = req.body || {};
  const urls = Array.isArray(body.urls) ? body.urls.slice(0, 100) : null;
  if (!urls || !urls.length) return reply.code(400).send({ error: 'missing_urls' });

  const results = await Promise.all(
    urls.map(async (u) => {
      try {
        const rel = await httpSem.acquire();
        try {
          return await fetchChain(u, {
            timeoutMs: Math.min(Number(body.timeoutMs || 15000), 60000),
            userAgent: body.userAgent,
            maxHops: Math.min(Number(body.maxHops || 10), 20),
          });
        } finally {
          rel();
        }
      } catch (e) {
        return { startUrl: u, error: String(e?.message || e), chain: [] };
      }
    })
  );
  return { node: NODE_NAME, results };
});

const shutdown = async (sig) => {
  app.log.info(`Nhan ${sig}, dang dong...`);
  await closeBrowser();
  await app.close();
  process.exit(0);
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

app.listen({ port: PORT, host: HOST }).then(() => {
  app.log.info(`VN relay "${NODE_NAME}" lang nghe tai ${HOST}:${PORT}`);
  const vs = listVantages();
  app.log.info(
    `${vs.length} diem quan sat: ${vs.map((v) => v.name + (v.proxy ? `(${v.host})` : '')).join(', ')}` +
      ` — mac dinh: ${defaultVantage()}`
  );
});
