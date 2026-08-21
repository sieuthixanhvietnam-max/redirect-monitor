import dns from 'node:dns/promises';
// Phai lay fetch tu chinh goi undici, KHONG dung fetch toan cuc cua Node.
// fetch toan cuc chay bang ban undici NHUNG DINH KEM trong Node, con ProxyAgent
// o duoi lai den tu undici cai qua npm. Hai ban khac nhau thi giao dien handler
// noi bo cung khac nhau, va Node se tu choi dispatcher la:
//     InvalidArgumentError: invalid onRequestStart method
// Loi chi lo ra khi ban Node cua may chay lech ban undici trong package.json —
// chay tot tren may dev Node 26, chet tren VPS Node 22. Lay ca hai tu cung mot
// goi thi khong con phu thuoc vao ban Node nua.
import { fetch } from 'undici';
import { classifyBlock, findMetaRefresh, sniffJsRedirect } from './classify.js';
import { httpDispatcher, DIRECT } from './proxy.js';

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const BASE_HEADERS = {
  'user-agent': DEFAULT_UA,
  accept:
    'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'accept-language': 'vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7',
  'accept-encoding': 'gzip, deflate, br',
  'cache-control': 'no-cache',
  pragma: 'no-cache',
  'upgrade-insecure-requests': '1',
  'sec-fetch-dest': 'document',
  'sec-fetch-mode': 'navigate',
  'sec-fetch-site': 'none',
  'sec-fetch-user': '?1',
};

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const dnsCache = new Map(); // host -> {ips, at}
const DNS_TTL_MS = 60_000;

async function resolveIps(host) {
  const now = Date.now();
  const hit = dnsCache.get(host);
  if (hit && now - hit.at < DNS_TTL_MS) return hit.ips;
  try {
    const recs = await dns.lookup(host, { all: true });
    const ips = recs.map((r) => r.address);
    dnsCache.set(host, { ips, at: now });
    return ips;
  } catch {
    dnsCache.set(host, { ips: [], at: now });
    return [];
  }
}

function headersToObject(h) {
  const out = {};
  for (const [k, v] of h.entries()) out[k] = v;
  return out;
}

function pickHeaders(obj, keys) {
  const out = {};
  for (const k of keys) if (obj[k] !== undefined) out[k] = obj[k];
  return out;
}

const KEEP_HEADERS = [
  'location',
  'server',
  'content-type',
  'cf-ray',
  'cf-cache-status',
  'cf-mitigated',
  'x-powered-by',
  'x-sucuri-id',
  'x-iinfo',
  'x-datadome',
  'set-cookie',
  'retry-after',
  'strict-transport-security',
];

async function doFetch(url, method, headers, timeoutMs, via) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  const opts = { method, redirect: 'manual', signal: ac.signal, headers };
  const dispatcher = httpDispatcher(via);
  if (dispatcher) opts.dispatcher = dispatcher;
  try {
    return await fetch(url, opts);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Theo tung hop redirect thu cong, ghi lai toan bo chain.
 * Khong dung redirect:'follow' de kiem soat duoc tung hop mot.
 *
 * method='HEAD' nhe hon han (khong tai body), nhung DANH DOI:
 *   - khong bat duoc meta refresh va JS redirect (ca hai nam trong body)
 *   - classifyBlock chi con doc duoc header, khong doc duoc dau hieu trong body
 * Chi dung khi da biet chac domain do chi redirect bang HTTP 3xx.
 */
export async function fetchChain(startUrl, opts = {}) {
  const {
    maxHops = 10,
    timeoutMs = 15000,
    userAgent,
    extraHeaders = {},
    method = 'GET',
    via = DIRECT,
    readBody = true,
    bodyLimit = 200_000,
  } = opts;

  const headers = { ...BASE_HEADERS, ...extraHeaders };
  if (userAgent) headers['user-agent'] = userAgent;

  const chain = [];
  const seen = new Set();
  let url = startUrl;
  const t0 = Date.now();
  let loopDetected = false;
  let truncated = false;

  for (let hop = 0; hop < maxHops; hop++) {
    if (seen.has(url)) {
      loopDetected = true;
      break;
    }
    seen.add(url);

    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      chain.push({ url, error: 'invalid_url' });
      break;
    }

    const ips = await resolveIps(parsed.hostname);
    const hopStart = Date.now();

    let res;
    let hopMethod = method;
    try {
      res = await doFetch(url, hopMethod, headers, timeoutMs, via);
      // Kha nhieu server tu choi HEAD (405/501) du GET van chay binh thuong.
      // Lui ve GET cho rieng hop nay thay vi bao domain do bi loi.
      if (hopMethod === 'HEAD' && (res.status === 405 || res.status === 501)) {
        try {
          await res.body?.cancel();
        } catch {
          /* ignore */
        }
        hopMethod = 'GET';
        res = await doFetch(url, hopMethod, headers, timeoutMs, via);
      }
    } catch (err) {
      chain.push({
        url,
        ips,
        ms: Date.now() - hopStart,
        error: err?.name === 'AbortError' ? 'timeout' : `network:${err?.cause?.code || err?.message || 'unknown'}`,
      });
      break;
    }

    const allHeaders = headersToObject(res.headers);
    const status = res.status;
    const isRedirect = REDIRECT_STATUSES.has(status);

    let bodySnippet = '';
    const ctype = allHeaders['content-type'] || '';
    const wantBody =
      readBody &&
      hopMethod !== 'HEAD' &&
      !isRedirect &&
      (ctype.includes('html') || ctype.includes('text') || status >= 400);
    if (wantBody) {
      try {
        const buf = await res.arrayBuffer();
        bodySnippet = Buffer.from(buf).toString('utf8').slice(0, bodyLimit);
      } catch {
        bodySnippet = '';
      }
    } else {
      try {
        await res.body?.cancel();
      } catch {
        /* ignore */
      }
    }

    const hopRec = {
      url,
      status,
      ips,
      ms: Date.now() - hopStart,
      headers: pickHeaders(allHeaders, KEEP_HEADERS),
    };
    if (hopMethod !== 'GET') hopRec.method = hopMethod;
    else if (method === 'HEAD') hopRec.method = 'GET (HEAD bi tu choi)';

    if (isRedirect) {
      const loc = allHeaders['location'];
      if (!loc) {
        hopRec.error = 'redirect_without_location';
        chain.push(hopRec);
        break;
      }
      let next;
      try {
        next = new URL(loc, url).toString();
      } catch {
        hopRec.error = 'bad_location';
        chain.push(hopRec);
        break;
      }
      hopRec.redirectType = 'http';
      hopRec.location = next;
      chain.push(hopRec);
      url = next;
      if (hop === maxHops - 1) truncated = true;
      continue;
    }

    // Khong phai HTTP redirect -> kiem tra meta refresh / JS redirect.
    const block = classifyBlock(status, allHeaders, bodySnippet);
    if (block.blocked) {
      hopRec.block = block;
    }

    const meta = findMetaRefresh(bodySnippet, url);
    if (meta && meta !== url) {
      hopRec.redirectType = 'meta';
      hopRec.location = meta;
      chain.push(hopRec);
      url = meta;
      if (hop === maxHops - 1) truncated = true;
      continue;
    }

    const js = sniffJsRedirect(bodySnippet, url);
    if (js && js !== url) {
      hopRec.jsRedirectHint = js;
    }

    chain.push(hopRec);
    break;
  }

  const last = chain[chain.length - 1] || {};
  return {
    startUrl,
    chain,
    finalUrl: last.url || startUrl,
    finalStatus: last.status ?? null,
    error: last.error || null,
    block: last.block || null,
    jsRedirectHint: last.jsRedirectHint || null,
    loopDetected,
    truncated,
    hops: chain.length,
    totalMs: Date.now() - t0,
    via,
    mode: method === 'HEAD' ? 'head' : 'http',
  };
}
