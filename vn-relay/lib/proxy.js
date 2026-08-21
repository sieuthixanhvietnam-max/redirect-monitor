// Nhieu "diem quan sat" (vantage point) trong CUNG mot relay.
//
// Vi sao can nhieu diem chu khong phai mot proxy tot nhat: da do duoc thuc te
// la cung mot domain cho ba ket qua khac nhau tuy IP di ra —
//   - IP nuoc ngoai        -> 403 (Cloudflare chan dai datacenter ngoai)
//   - IP datacenter VN     -> 200
//   - IP nha mang VN (4G)  -> dut o tang TLS (nha mang chan theo SNI)
// Khong diem nao trong ba la "dung"; moi diem tra loi mot cau hoi khac nhau.
// Vi vay relay phai quan sat duoc tu nhieu diem, khong phai chon lay mot.
//
// Khai bao:
//   RELAY_PROXIES=vn-4g|http://user:pass@host:port,vn-dc|http://host:port
//   RELAY_PROXY=http://...        (tuong thich nguoc — thanh profile ten 'default')
//
// Ten 'direct' luon ton tai san va co nghia la khong qua proxy.

import { ProxyAgent } from 'undici';

export const DIRECT = 'direct';

/** @type {Map<string,{name:string,origin:string,username:string,password:string,host:string}>} */
const profiles = new Map();
const errors = [];

function parseOne(name, raw) {
  try {
    const u = new URL(raw);
    if (!['http:', 'https:'].includes(u.protocol)) {
      errors.push(`proxy "${name}" dung giao thuc "${u.protocol}" — chi ho tro http/https`);
      return;
    }
    profiles.set(name, {
      name,
      origin: `${u.protocol}//${u.host}`,
      username: decodeURIComponent(u.username || ''),
      password: decodeURIComponent(u.password || ''),
      host: u.host,
    });
  } catch {
    errors.push(`proxy "${name}" khong phai URL hop le (dang dung: http://user:pass@host:port)`);
  }
}

const MULTI = (process.env.RELAY_PROXIES || '').trim();
const SINGLE = (process.env.RELAY_PROXY || '').trim();

if (MULTI) {
  for (const chunk of MULTI.split(',')) {
    const s = chunk.trim();
    if (!s) continue;
    const i = s.indexOf('|');
    if (i < 1) {
      errors.push(`muc "${s.slice(0, 40)}" sai dinh dang, can: ten|http://host:port`);
      continue;
    }
    const name = s.slice(0, i).trim();
    if (name === DIRECT) {
      errors.push(`khong duoc dat ten proxy la "${DIRECT}" — ten nay danh cho ket noi khong proxy`);
      continue;
    }
    parseOne(name, s.slice(i + 1).trim());
  }
}
if (SINGLE) parseOne('default', SINGLE);

const agents = new Map();

/** Ten mac dinh khi request khong chi ro `via`. */
export function defaultVantage() {
  if (profiles.has('default')) return 'default';
  const first = profiles.keys().next();
  return first.done ? DIRECT : first.value;
}

export function knownVantage(name) {
  return name === DIRECT || profiles.has(name);
}

export function listVantages() {
  return [
    { name: DIRECT, proxy: false },
    ...[...profiles.values()].map((p) => ({
      name: p.name,
      proxy: true,
      host: p.host,
      auth: !!(p.username || p.password),
    })),
  ];
}

/** Dispatcher cho fetch(). undefined = di thang. */
export function httpDispatcher(name) {
  const p = profiles.get(name);
  if (!p) return undefined;
  if (!agents.has(name)) {
    const opts = { uri: p.origin };
    if (p.username || p.password) {
      opts.token = 'Basic ' + Buffer.from(`${p.username}:${p.password}`).toString('base64');
    }
    agents.set(name, new ProxyAgent(opts));
  }
  return agents.get(name);
}

/** Cau hinh proxy cho browser.newContext(). undefined = di thang. */
export function browserProxy(name) {
  const p = profiles.get(name);
  if (!p) return undefined;
  const out = { server: p.origin };
  if (p.username) out.username = p.username;
  if (p.password) out.password = p.password;
  return out;
}

export function proxyErrors() {
  return errors;
}
