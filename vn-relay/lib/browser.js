// Browser mode: dung Chromium that de vuot bot-protection va bat JS redirect.
// playwright-core la optionalDependency -> neu khong cai, relay van chay binh thuong
// va tra ve loi 'browser_unavailable' cho request nao yeu cau mode=browser.

let chromiumPromise = null;
let browser = null;
let lastUse = 0;
let idleTimer = null;
let uaPromise = null;

const IDLE_SHUTDOWN_MS = Number(process.env.BROWSER_IDLE_MS || 120_000);

async function loadChromium() {
  if (!chromiumPromise) {
    chromiumPromise = import('playwright-core')
      .then((m) => m.chromium)
      .catch(() => null);
  }
  return chromiumPromise;
}

export async function browserAvailable() {
  return (await loadChromium()) !== null;
}

async function getBrowser() {
  if (browser && browser.isConnected()) return browser;
  const chromium = await loadChromium();
  if (!chromium) throw new Error('browser_unavailable');

  const launchOpts = {
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
      '--disable-gpu',
    ],
  };
  const exe = process.env.CHROMIUM_PATH || process.env.PLAYWRIGHT_CHROMIUM_PATH;
  if (exe) launchOpts.executablePath = exe;
  else if (process.env.CHROME_CHANNEL) launchOpts.channel = process.env.CHROME_CHANNEL;

  browser = await chromium.launch(launchOpts);
  return browser;
}

/**
 * Chrome headless tu khai "HeadlessChrome/xxx" ngay trong User-Agent — day la
 * dau hieu bot de nhan nhat, kiem tra dau tien o moi he thong chong bot.
 *
 * Khong duoc thay bang mot UA cung (vi du Chrome/131 tren Windows): da do thuc te
 * thay Playwright van gui sec-ch-ua theo phien ban THAT cua binary, nen UA cung
 * se lech phien ban voi client hints — con de bi phat hien hon ca HeadlessChrome.
 * Cach an toan la lay dung UA cua chinh binary roi bo moi chu "Headless":
 * phien ban, platform va client hints deu khop tuyet doi.
 */
async function defaultUserAgent(b) {
  if (!uaPromise) {
    uaPromise = (async () => {
      const ctx = await b.newContext();
      try {
        const page = await ctx.newPage();
        const ua = await page.evaluate(() => navigator.userAgent);
        return ua ? ua.replace(/Headless/g, '') : null;
      } catch {
        return null;
      } finally {
        await ctx.close().catch(() => {});
      }
    })();
  }
  return uaPromise;
}

function scheduleIdleShutdown() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(async () => {
    if (browser && Date.now() - lastUse >= IDLE_SHUTDOWN_MS) {
      try {
        await browser.close();
      } catch {
        /* ignore */
      }
      browser = null;
      uaPromise = null;
    }
  }, IDLE_SHUTDOWN_MS + 1000);
  idleTimer.unref?.();
}

/**
 * Mo URL bang Chromium that, ghi lai toan bo chain (ke ca JS redirect).
 */
export async function fetchWithBrowser(startUrl, opts = {}) {
  const { timeoutMs = 30000, userAgent, waitMs = 2500, via } = opts;
  const t0 = Date.now();
  const b = await getBrowser();
  lastUse = Date.now();

  const ua = userAgent || (await defaultUserAgent(b));
  // Proxy dat o muc CONTEXT chu khong phai luc launch: mot browser duy nhat
  // phuc vu duoc moi diem quan sat, khong phai mo moi diem mot Chromium.
  const { browserProxy } = await import('./proxy.js');
  const proxy = browserProxy(via);
  const ctx = await b.newContext({
    ...(proxy ? { proxy } : {}),
    userAgent: ua || undefined,
    locale: 'vi-VN',
    timezoneId: 'Asia/Ho_Chi_Minh',
    viewport: { width: 1366, height: 768 },
    ignoreHTTPSErrors: true,
    extraHTTPHeaders: { 'accept-language': 'vi-VN,vi;q=0.9,en;q=0.8' },
  });

  const chain = [];
  const page = await ctx.newPage();
  // Header cua response tai lieu cuoi cung. Truoc day classifyBlock duoc goi voi
  // {} nen moi dau hieu nam o header (cf-mitigated, x-datadome, x-iinfo...) deu
  // bi mat -> browser mode phan loai kem han han http mode.
  let lastDocHeaders = {};

  page.on('response', (res) => {
    try {
      const req = res.request();
      if (req.resourceType() !== 'document') return;
      const status = res.status();
      const headers = res.headers();
      lastDocHeaders = headers;
      const rec = { url: res.url(), status, ms: null, headers: {} };
      for (const k of ['location', 'server', 'content-type', 'cf-ray', 'cf-mitigated']) {
        if (headers[k]) rec.headers[k] = headers[k];
      }
      if (status >= 300 && status < 400 && headers['location']) {
        rec.redirectType = 'http';
        try {
          rec.location = new URL(headers['location'], res.url()).toString();
        } catch {
          rec.location = headers['location'];
        }
      }
      chain.push(rec);
    } catch {
      /* ignore */
    }
  });

  let navError = null;
  let finalUrl = startUrl;
  let finalStatus = null;
  let bodySnippet = '';

  try {
    const resp = await page.goto(startUrl, {
      waitUntil: 'domcontentloaded',
      timeout: timeoutMs,
    });
    finalStatus = resp ? resp.status() : null;
    // Cho them mot chut de bat JS redirect / challenge resolve.
    await page.waitForTimeout(waitMs);
    finalUrl = page.url();
    finalStatus =
      chain.filter((c) => c.url === finalUrl).slice(-1)[0]?.status ?? finalStatus;
    bodySnippet = (await page.content()).slice(0, 200_000);
  } catch (err) {
    navError = err?.message?.includes('Timeout') ? 'timeout' : `browser:${err?.message || 'unknown'}`;
    try {
      finalUrl = page.url();
    } catch {
      /* ignore */
    }
  } finally {
    await ctx.close().catch(() => {});
    lastUse = Date.now();
    scheduleIdleShutdown();
  }

  // Neu URL cuoi khac URL dau ma chain khong ghi duoc hop HTTP nao -> JS redirect.
  const httpHops = chain.filter((c) => c.redirectType === 'http').length;
  if (finalUrl !== startUrl && httpHops === 0) {
    chain.unshift({
      url: startUrl,
      status: chain[0]?.status ?? null,
      redirectType: 'js',
      location: finalUrl,
      headers: {},
    });
  }

  const { classifyBlock } = await import('./classify.js');
  const block = finalStatus
    ? classifyBlock(finalStatus, lastDocHeaders, bodySnippet)
    : { blocked: false, kind: 'none', evidence: [] };

  return {
    startUrl,
    chain,
    finalUrl,
    finalStatus,
    error: navError,
    block: block.blocked ? block : null,
    jsRedirectHint: null,
    loopDetected: false,
    truncated: false,
    hops: chain.length,
    totalMs: Date.now() - t0,
    via,
    mode: 'browser',
  };
}

export async function closeBrowser() {
  if (browser) {
    try {
      await browser.close();
    } catch {
      /* ignore */
    }
    browser = null;
    uaPromise = null;
  }
}
