// Phan loai ly do bi chan: geo-block vs bot-protection vs khac.

const BOT_BODY_MARKERS = [
  'just a moment',
  'attention required',
  'checking your browser',
  'cf-browser-verification',
  'ddos protection by',
  'please enable javascript and cookies',
  '_incapsula_resource',
  'incapsula incident id',
  'access denied',
  'request unsuccessful. incapsula',
  'perimeterx',
  'px-captcha',
  'akamai reference',
  'reference #18.',
  'captcha',
  'are you a robot',
  'sucuri website firewall',
];

// Trang chan cung o tang edge (WAF rule / IP reputation / ban thu cong).
// Khac han challenge: trang nay tra ve TRUOC khi bat ky JS nao duoc chay,
// nen mo Chromium cung chi nhan lai dung cai 403 do -> khong duoc escalate.
// Nguyen nhan co the la IP, ASN hoac quoc gia; ca ba deu chi chua duoc bang
// cach doi IP, nen gop chung mot loai la du dung.
const WAF_BODY_MARKERS = [
  'sorry, you have been blocked',
  'you are unable to access',
  'you have been blocked',
];
const WAF_ERROR_CODE_RE = /error code:?\s*10\d\d/;

const GEO_BODY_MARKERS = [
  'not available in your country',
  'not available in your region',
  'khong kha dung tai quoc gia',
  'unavailable in your location',
  'geo-restricted',
  'geo restricted',
  'this content is not available in your',
  'access from your country',
  'blocked in your country',
  'vpn detected',
];

// Dau hieu challenge DOC LAP NGON NGU. Bat buoc phai co: trang challenge cua
// Cloudflare duoc dich theo locale cua trinh duyet, ma browser mode dat
// locale='vi-VN' nen tieu de la "Cho mot chut..." chu khong phai "Just a moment".
// Neu chi do chuoi tieng Anh thi moi ket qua tu browser mode deu roi vao 'unknown'.
const CHALLENGE_BODY_MARKERS = ['challenge-platform', 'cf_chl_opt', '__cf_chl'];

const BOT_HEADERS = [
  'cf-ray',
  'cf-mitigated',
  'x-sucuri-id',
  'x-iinfo',
  'x-datadome',
  'x-akamai-request-id',
];

/**
 * @param {number} status
 * @param {Record<string,string>} headers
 * @param {string} bodySnippet
 * @returns {{blocked:boolean, kind:'none'|'bot'|'waf'|'geo'|'ratelimit'|'auth'|'unknown', evidence:string[]}}
 */
export function classifyBlock(status, headers = {}, bodySnippet = '') {
  const evidence = [];
  const body = (bodySnippet || '').toLowerCase().slice(0, 20000);
  const h = {};
  for (const [k, v] of Object.entries(headers)) h[k.toLowerCase()] = String(v);

  if (status === 429) {
    return { blocked: true, kind: 'ratelimit', evidence: ['http 429'] };
  }
  if (status === 401 || status === 407) {
    return { blocked: true, kind: 'auth', evidence: [`http ${status}`] };
  }
  if (status !== 403 && status !== 503 && status !== 451) {
    return { blocked: false, kind: 'none', evidence: [] };
  }

  if (status === 451) {
    return { blocked: true, kind: 'geo', evidence: ['http 451 unavailable for legal reasons'] };
  }

  for (const m of GEO_BODY_MARKERS) {
    if (body.includes(m)) evidence.push(`body:"${m}"`);
  }
  if (evidence.length) return { blocked: true, kind: 'geo', evidence };

  // Challenge co dau hieu tuyet doi -> xet truoc moi heuristic khac.
  // 'cf-mitigated: challenge' chi xuat hien o trang challenge, khong bao gio
  // xuat hien o trang chan cung, nen khong so nham voi waf.
  if ((h['cf-mitigated'] || '').toLowerCase().includes('challenge')) {
    evidence.push('header:cf-mitigated=challenge');
  }
  for (const m of CHALLENGE_BODY_MARKERS) {
    if (body.includes(m)) evidence.push(`body:"${m}"`);
  }
  if (evidence.length) return { blocked: true, kind: 'bot', evidence };

  // Phai xet TRUOC bot: trang WAF cua Cloudflare cung co header cf-ray va
  // chuoi "attention required", nen neu de sau se bi phan loai nham thanh bot
  // roi escalate sang Chromium mot cach vo ich.
  for (const m of WAF_BODY_MARKERS) {
    if (body.includes(m)) evidence.push(`body:"${m}"`);
  }
  const codeHit = body.match(WAF_ERROR_CODE_RE);
  if (codeHit) evidence.push(`body:"${codeHit[0]}"`);
  if (evidence.length) return { blocked: true, kind: 'waf', evidence };

  for (const hk of BOT_HEADERS) {
    if (h[hk]) evidence.push(`header:${hk}`);
  }
  for (const m of BOT_BODY_MARKERS) {
    if (body.includes(m)) evidence.push(`body:"${m}"`);
  }
  const server = (h['server'] || '').toLowerCase();
  if (server.includes('cloudflare') || server.includes('sucuri') || server.includes('awselb')) {
    evidence.push(`server:${server}`);
  }

  if (evidence.length) return { blocked: true, kind: 'bot', evidence };
  return { blocked: true, kind: 'unknown', evidence: [`http ${status}`] };
}

const META_REFRESH_RE =
  /<meta[^>]+http-equiv\s*=\s*["']?refresh["']?[^>]*content\s*=\s*["']([^"']+)["']/i;
const META_REFRESH_RE_ALT =
  /<meta[^>]+content\s*=\s*["']([^"']+)["'][^>]*http-equiv\s*=\s*["']?refresh["']?/i;

/** Tim meta refresh redirect trong HTML. Tra ve URL dich hoac null. */
export function findMetaRefresh(html, baseUrl) {
  if (!html) return null;
  const m = html.match(META_REFRESH_RE) || html.match(META_REFRESH_RE_ALT);
  if (!m) return null;
  const content = m[1];
  const urlPart = content.split(/;/).slice(1).join(';');
  const um = urlPart.match(/url\s*=\s*['"]?([^'"\s]+)/i);
  if (!um) return null;
  try {
    return new URL(um[1].trim(), baseUrl).toString();
  } catch {
    return null;
  }
}

const JS_REDIRECT_PATTERNS = [
  /window\.location(?:\.href)?\s*=\s*["']([^"']+)["']/i,
  /window\.location\.replace\s*\(\s*["']([^"']+)["']/i,
  /window\.location\.assign\s*\(\s*["']([^"']+)["']/i,
  /document\.location(?:\.href)?\s*=\s*["']([^"']+)["']/i,
  /top\.location(?:\.href)?\s*=\s*["']([^"']+)["']/i,
];

/** Doan JS redirect (heuristic, chi dung de goi y bat browser mode). */
export function sniffJsRedirect(html, baseUrl) {
  if (!html) return null;
  // Chi quet phan dau tai lieu de tranh false positive tu analytics/widget.
  const head = html.slice(0, 60000);
  for (const re of JS_REDIRECT_PATTERNS) {
    const m = head.match(re);
    if (m && m[1] && !m[1].startsWith('#') && !m[1].startsWith('javascript:')) {
      try {
        return new URL(m[1], baseUrl).toString();
      } catch {
        /* ignore */
      }
    }
  }
  return null;
}
