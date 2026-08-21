
const VN_TZ = 'Asia/Ho_Chi_Minh';

export async function api(path, opts) {
  const r = await fetch(path, {
    headers: { 'content-type': 'application/json' },
    ...opts,
  });
  if (!r.ok) throw new Error(`${r.status} ${await r.text().catch(() => '')}`.slice(0, 200));
  return r.json();
}

/** Gio Viet Nam, luon hien thi tuyet doi — khong bao gio de nguoi doc phai doan mui gio. */
export function fmtVN(iso, withDate = true) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d)) return '—';
  return d.toLocaleString('vi-VN', {
    timeZone: VN_TZ,
    hour12: false,
    ...(withDate ? { day: '2-digit', month: '2-digit', year: 'numeric' } : {}),
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

/**
 * Ban gon cho bang: "20/08 12:57".
 * Bo nam va giay co chu y — trong bang 17 dong, nam luon giong nhau va giay
 * khong mang thong tin gi, chung chi an cot va lam mat doc cham hon.
 */
export function fmtVNShort(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d)) return '—';
  return d.toLocaleString('vi-VN', {
    timeZone: VN_TZ, hour12: false,
    day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
  });
}

export function fmtClock(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleTimeString('vi-VN', { timeZone: VN_TZ, hour12: false });
}

/** Khoang cach tuong doi, doc nhanh hon moc tuyet doi khi luot bang. */
export function ago(iso) {
  if (!iso) return '';
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (isNaN(s)) return '';
  if (s < 60) return `${s}s trước`;
  if (s < 3600) return `${Math.floor(s / 60)}m trước`;
  if (s < 86400) return `${Math.floor(s / 3600)}h trước`;
  return `${Math.floor(s / 86400)} ngày trước`;
}

/**
 * Do rong khoang bat dinh. Day la DO CHINH XAC cua moc thoi gian, phai hien ro:
 * quet 60 giay mot lan thi khong the biet 301 xay ra dung giay nao.
 * Khoang rong bat thuong khong co nghia su kien keo dai — no co nghia he thong
 * mat dau trong quang do (relay chet, may tat...).
 */
export function fmtUnc(sec) {
  if (sec == null) return '';
  if (sec < 90) return `sai số ±${Math.round(sec)} giây`;
  if (sec < 5400) return `sai số ±${Math.round(sec / 60)} phút`;
  return `sai số ±${(sec / 3600).toFixed(1)} giờ`;
}

/**
 * Thoi gian phan hoi. Duoi 1 giay thi mili giay la don vi tu nhien; tren 1 giay
 * thi "7452ms" bat nguoi doc tu chia nham — doi sang giay cho doc duoc ngay.
 */
export function fmtMs(ms) {
  if (ms == null) return '—';
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(1).replace('.', ',')} giây`;
}

/** Cham bat thuong = dau hieu phai mo trinh duyet that, dang de y. */
export const isSlow = (ms) => ms != null && ms >= 3000;

export function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return url || '';
  }
}

export function pathOf(url) {
  try {
    const u = new URL(url);
    return u.pathname === '/' && !u.search ? '' : u.pathname + u.search;
  } catch {
    return '';
  }
}

/**
 * Bay loai chan he thong co the sinh ra. Truoc day giao dien in thang ma noi bo
 * ra man hinh — "Bi chan (waf)" — nguoi doc khong biet nen lo hay khong.
 * Moi loai gio co mot cau tieng Viet noi ro chuyen gi da xay ra, va `huong`
 * noi nguoi doc co the lam gi (hien trong o chi tiet).
 */
export const BLOCK_KIND = {
  bot: {
    label: 'Bị chặn — nghi là máy quét',
    huong: 'Đổi cách kiểm tra sang "Trình duyệt thật" thường xem được.',
  },
  waf: {
    label: 'Bị tường lửa chặn',
    huong: 'Tường lửa của website chặn ở tầng ngoài, trước khi đến trang.',
  },
  geo: {
    label: 'Chặn theo quốc gia',
    huong: 'Website không phục vụ IP Việt Nam. Kết quả từ nơi khác sẽ khác.',
  },
  ratelimit: {
    label: 'Chặn vì truy cập quá dày',
    huong: 'Giãn nhịp quét thưa ra là hết.',
  },
  auth: {
    label: 'Yêu cầu đăng nhập',
    huong: 'Trang này cần tài khoản mới xem được.',
  },
  unknown: {
    label: 'Bị chặn — chưa rõ lý do',
    huong: 'Xem mục Đường đi bên dưới để biết chặn ở chặng nào.',
  },
};

export const blockLabel = (k) => BLOCK_KIND[k]?.label || `Bị chặn (${k})`;

/** Cach kiem tra — ten ky thuat cua relay doi sang ten noi duoc cong dung. */
export const MODE = {
  auto: { label: 'Tự động', giai: 'Thử cách nhanh trước, bị chặn thì tự chuyển sang trình duyệt thật.' },
  http: { label: 'Nhanh', giai: 'Chỉ gửi yêu cầu HTTP. Nhanh nhất, nhưng không thấy chuyển hướng bằng JavaScript.' },
  browser: { label: 'Trình duyệt thật', giai: 'Mở bằng Chromium thật. Chậm hơn nhiều nhưng thấy được nhiều nhất.' },
  head: { label: 'Siêu nhẹ', giai: 'Chỉ hỏi phần đầu trang. Nhẹ nhất, bỏ sót chuyển hướng bằng thẻ meta và JavaScript.' },
};
export const modeLabel = (m) => MODE[m]?.label || m || '—';

/**
 * Mot domain roi vao dung MOT tinh trang. Thu tu uu tien:
 *   tam dung > khong kiem tra duoc > chuyen huong > bi chan > binh thuong
 *
 * `label` tra loi "dieu nay nghia la gi voi toi"; ma so (301, 403...) tach ra
 * thanh `code` de hien nho ben canh chu khong chiem cho cua cau tra loi.
 */
export function domainState(d) {
  if (!d.enabled)
    return { key: 'idle', label: 'Tạm dừng', color: 'gray', code: null };

  if ((d.consecutive_errors || 0) >= 2)
    return {
      key: 'error', label: 'Không kiểm tra được', color: 'red', code: null,
      note: d.last_error ? 'lỗi mạng lặp lại' : null,
    };

  // Chuyen huong PHAI thang "bi chan". Ly do: block_kind mo ta chang CUOI cua
  // duong di, ma chang cuoi bi chan khong co nghia la ta khong biet domain
  // chuyen di dau. Vi du that: dintol.com.co = 301 -> go88club9.com, chinh
  // go88club9.com moi bi chan. Gan nhan "bi chan" cho dintol se giau mat dung
  // thu nguoi doc can biet.
  if (d.redirect_type)
    return {
      key: 'redirect',
      label: 'Chuyển hướng',
      color: 'violet',
      code: d.status_code,
      note:
        d.block_kind && d.block_kind !== 'none'
          ? 'nơi đến không cho xem'
          : d.final_status >= 400
          ? `nơi đến trả ${d.final_status}`
          : null,
    };

  if (d.block_kind && d.block_kind !== 'none')
    return {
      key: 'blocked', label: blockLabel(d.block_kind), color: 'orange',
      code: d.status_code,
    };

  return { key: 'ok', label: 'Bình thường', color: 'teal', code: d.status_code };
}

/**
 * Chuoi 72 o, moi o mot gio, xep cu -> moi va thang hang voi gio hien tai.
 * O khong co du lieu = null (chua theo doi den luc do), KHAC voi o co 0 luot quet.
 *
 * Mau = trang thai CHIEM DA SO trong gio, khong phai "co xuat hien".
 * Neu mot loi le cung to do ca gio thi bieu do se do ruc trong khi 59 luot con
 * lai deu doc duoc redirect binh thuong — do canh bao o cho khong co gi.
 * Gio co loi le nhung khong chiem da so duoc danh dau bang vach do tren dinh cot.
 */
export function last72(hourly, hours = 72) {
  const map = new Map();
  for (const h of hourly || []) map.set(new Date(h.hour_utc).getTime(), h);
  const cur = Math.floor(Date.now() / 3600e3) * 3600e3;
  const out = [];
  for (let i = hours - 1; i >= 0; i--) {
    const at = cur - i * 3600e3;
    const h = map.get(at);
    if (!h || !h.checks) {
      out.push(null);
      continue;
    }
    const half = h.checks / 2;
    // Luot co redirect cung duoc tinh la "ok", nen phai xet redirect TRUOC ok.
    const kind =
      h.err_count >= half ? 'error'
      : h.redirect_count >= half ? 'redirect'
      : h.blocked_count >= half ? 'blocked'
      : 'ok';
    out.push({
      ...h,
      kind,
      partial: h.err_count > 0 && kind !== 'error',
      at: new Date(at).toISOString(),
    });
  }
  return out;
}

/** Cot cao theo so luot quet, chuan hoa theo gio ban nhat cua CHINH domain do. */
export const peakOf = (bars) =>
  Math.max(1, ...bars.filter(Boolean).map((b) => b.checks));
export const barH = (b, peak) => Math.max(18, Math.round((b.checks / peak) * 100));

const KIND_VN = {
  ok: 'bình thường',
  redirect: 'có chuyển hướng',
  blocked: 'bị chặn',
  error: 'không kiểm tra được',
};

export function barTitle(b) {
  if (!b) return 'Chưa có dữ liệu ở giờ này';
  return (
    `${fmtVN(b.at)} — chủ yếu ${KIND_VN[b.kind]}\n` +
    `${b.checks} lượt quét · ${b.redirect_count} redirect · ` +
    `${b.blocked_count} chặn · ${b.err_count} lỗi`
  );
}

export const CHANGE_KIND = {
  first_seen: ['Bắt đầu theo dõi', 'gray'],
  // Chiem phan lon ban ghi that: duong di doi nhung NOI DEN thi khong.
  // Nhan phai noi thang dieu nguoi doc can biet — khong co gi quan trong.
  chain_changed: ['Thay đổi nhỏ — nơi đến không đổi', 'gray'],
  new_redirect: ['Bắt đầu chuyển hướng', 'violet'],
  redirect_target_changed: ['Đổi nơi đến', 'orange'],
  redirect_removed: ['Hết chuyển hướng', 'teal'],
  redirect_code_changed: ['Đổi mã chuyển hướng', 'gray'],
  redirect_method_changed: ['Đổi kiểu chuyển hướng', 'gray'],
  became_blocked: ['Bắt đầu bị chặn', 'red'],
  unblocked: ['Hết bị chặn', 'teal'],
  status_changed: ['Đổi mã phản hồi', 'gray'],
};

export const REDIRECT_KINDS = new Set([
  'new_redirect',
  'redirect_target_changed',
  'redirect_removed',
  'redirect_code_changed',
  'redirect_method_changed',
]);
