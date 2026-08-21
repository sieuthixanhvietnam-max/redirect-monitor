"""Dien giai ket qua relay -> trang thai, va phat hien thay doi that su.

Diem cot loi cua toan bo he thong nam o day: THOI DIEM 301 khong bao gio biet
chinh xac tuyet doi khi dung polling. Ta chi biet no nam trong khoang:

    [last_confirmed_at cua trang thai CU]  ....  [lan dau tien thay trang thai MOI]

Do dai khoang do = do bat dinh (uncertainty), xap xi bang interval quet.
He thong luu ca hai moc va bao cao trung thuc thay vi doan mot con so.
"""
from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from datetime import datetime, timezone
from urllib.parse import urlsplit, urlunsplit

from .db import iso, parse_iso, utcnow

REDIRECT_STATUSES = {301, 302, 303, 307, 308}
PERMANENT = {301, 308}

# Query param rac thuong gap, bo di khi so sanh de tranh bao dong gia.
NOISE_PARAMS = {
    "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "utm_id",
    "gclid", "fbclid", "msclkid", "_ga", "ref", "referrer", "yclid", "igshid",
}


def normalize_url(url: str | None, *, drop_noise: bool = True) -> str:
    """Chuan hoa URL de so sanh: bo fragment, ha host ve chu thuong, bo param rac."""
    if not url:
        return ""
    try:
        p = urlsplit(url.strip())
    except ValueError:
        return url.strip()
    scheme = (p.scheme or "http").lower()
    host = (p.hostname or "").lower()
    port = p.port
    if port and not ((scheme == "http" and port == 80) or (scheme == "https" and port == 443)):
        host = f"{host}:{port}"
    path = p.path or "/"
    if len(path) > 1 and path.endswith("/"):
        path = path.rstrip("/") or "/"
    query = p.query
    if drop_noise and query:
        kept = []
        for part in query.split("&"):
            k = part.split("=", 1)[0].lower()
            if k not in NOISE_PARAMS:
                kept.append(part)
        query = "&".join(sorted(kept))
    return urlunsplit((scheme, host, path, query, ""))


_HOSTNAME_RE = re.compile(
    r"^(?=.{1,253}$)(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))*$"
)
_IPV4_RE = re.compile(r"^(\d{1,3}\.){3}\d{1,3}$")


def normalize_input_url(raw: str) -> str:
    """Chuan hoa URL nguoi dung nhap vao (them https:// neu thieu). Raise neu khong hop le."""
    raw = (raw or "").strip()
    if not raw:
        raise ValueError("URL rong")
    if any(ch in raw for ch in (" ", "\t", "\n", "\r")):
        raise ValueError("URL khong duoc chua khoang trang")
    if "://" not in raw:
        raw = "https://" + raw
    try:
        p = urlsplit(raw)
    except ValueError as e:
        raise ValueError("URL khong hop le") from e
    if p.scheme not in ("http", "https"):
        raise ValueError("Chi ho tro http/https")
    if not p.hostname:
        raise ValueError("Thieu ten mien")

    host = p.hostname.lower()
    # Ho tro ten mien tieng Viet / unicode -> chuyen sang punycode
    try:
        host = host.encode("idna").decode("ascii")
    except (UnicodeError, UnicodeDecodeError):
        pass

    if _IPV4_RE.match(host):
        if any(int(o) > 255 for o in host.split(".")):
            raise ValueError("Dia chi IP khong hop le")
    elif not _HOSTNAME_RE.match(host):
        raise ValueError(f"Ten mien khong hop le: {host}")
    elif "." not in host and host != "localhost":
        raise ValueError(f"Ten mien thieu phan mo rong (vd .com): {host}")

    try:
        port = p.port
    except ValueError as e:
        raise ValueError("Cong khong hop le") from e
    port_s = f":{port}" if port else ""
    path = p.path or "/"
    return urlunsplit((p.scheme, host + port_s, path, p.query, ""))


@dataclass
class Observation:
    """Ket qua mot lan quet, da duoc dien giai."""

    ok: bool
    error_kind: str | None = None
    error_detail: str = ""
    status_code: int | None = None          # status cua hop DAU TIEN (chinh domain duoc theo doi)
    redirect_type: str | None = None        # http | meta | js | None
    target_url: str | None = None           # dich cua hop dau tien
    final_url: str | None = None
    final_status: int | None = None
    hops: int = 0
    chain: list[dict] = field(default_factory=list)
    ips: list[str] = field(default_factory=list)
    block_kind: str | None = None
    block_evidence: list[str] = field(default_factory=list)
    relay_node: str | None = None
    source: str = "relay"                   # relay | direct | none
    mode_used: str = "http"
    latency_ms: int = 0
    loop_detected: bool = False

    @property
    def is_redirect(self) -> bool:
        return bool(self.redirect_type)

    @property
    def is_permanent(self) -> bool:
        return self.status_code in PERMANENT

    def state_key(self) -> str:
        """Chu ky trang thai. Doi chu ky = coi la thay doi."""
        parts = []
        for hop in self.chain:
            st = hop.get("status")
            loc = normalize_url(hop.get("location"))
            parts.append(f"{st}>{loc}" if loc else f"{st}")
        return "|".join(parts) + f"#final={self.final_status}:{normalize_url(self.final_url)}"

    def to_state_dict(self) -> dict:
        return {
            "status_code": self.status_code,
            "redirect_type": self.redirect_type,
            "target_url": self.target_url,
            "final_url": self.final_url,
            "final_status": self.final_status,
            "hops": self.hops,
            "block_kind": self.block_kind,
            "chain": [
                {
                    "url": h.get("url"),
                    "status": h.get("status"),
                    "location": h.get("location"),
                    "type": h.get("redirectType"),
                }
                for h in self.chain
            ],
        }


def interpret(result: dict) -> Observation:
    """Chuyen JSON tho tu relay thanh Observation."""
    chain = result.get("chain") or []
    node = result.get("node")
    source = result.get("source", "relay")
    mode_used = result.get("mode", "http")
    latency = int(result.get("totalMs") or 0)

    # Loi mang / relay chet -> khong phai trang thai, chi la loi.
    err = result.get("error")
    if err and not chain:
        return Observation(
            ok=False, error_kind=str(err).split(":")[0], error_detail=str(err),
            relay_node=node, source=source, latency_ms=latency, mode_used=mode_used,
        )
    if err and all(h.get("error") for h in chain):
        return Observation(
            ok=False, error_kind=str(err).split(":")[0], error_detail=str(err),
            relay_node=node, source=source, latency_ms=latency, mode_used=mode_used, chain=chain,
        )

    first = chain[0] if chain else {}
    if first.get("error"):
        return Observation(
            ok=False, error_kind=str(first["error"]).split(":")[0], error_detail=str(first["error"]),
            relay_node=node, source=source, latency_ms=latency, mode_used=mode_used, chain=chain,
        )

    block = result.get("block") or {}

    # 5xx = su co tam thoi cua server HOAC cua proxy — khong phai cau hinh redirect.
    # Da gap that: proxy 4G tra ve trang loi 500 cua chinh no, he thong coi do la
    # "quan sat hop le, khong co redirect" -> ghi redirect_removed, roi lan sau
    # proxy chay lai thi ghi new_redirect. Lap vo tan, toan bo la bao dong gia.
    # Xu ly nhu loi mang: dem vao consecutive_errors, KHONG dung de ket luan.
    # Ngoai le: neu classifyBlock tim duoc bang chung day la trang chan that
    # (vd Cloudflare challenge tra 503) thi van giu nguyen lam trang thai.
    st = first.get("status")
    if isinstance(st, int) and st >= 500 and not block.get("blocked"):
        return Observation(
            ok=False,
            error_kind=f"http_{st}",
            error_detail=f"HTTP {st} tai {first.get('url')} (may chu hoac proxy loi)",
            relay_node=node, source=source, latency_ms=latency, mode_used=mode_used, chain=chain,
        )

    obs = Observation(
        ok=True,
        status_code=first.get("status"),
        redirect_type=first.get("redirectType"),
        target_url=first.get("location"),
        final_url=result.get("finalUrl"),
        final_status=result.get("finalStatus"),
        hops=len(chain),
        chain=chain,
        ips=first.get("ips") or [],
        block_kind=block.get("kind") if block else None,
        block_evidence=block.get("evidence") or [],
        relay_node=node,
        source=source,
        mode_used=mode_used,
        latency_ms=latency,
        loop_detected=bool(result.get("loopDetected")),
    )
    return obs


def classify_change(old: dict | None, new: dict) -> str:
    """Dat ten cho loai thay doi de hien thi va canh bao."""
    if not old or old.get("status_code") is None:
        return "first_seen"

    o_blocked = bool(old.get("block_kind")) and old.get("block_kind") != "none"
    n_blocked = bool(new.get("block_kind")) and new.get("block_kind") != "none"
    # Bi chan la tin hieu quan trong nhat -> uu tien hon moi phan loai khac.
    if n_blocked and not o_blocked:
        return "became_blocked"
    if o_blocked and not n_blocked:
        return "unblocked"

    o_red = bool(old.get("redirect_type"))
    n_red = bool(new.get("redirect_type"))
    if not o_red and n_red:
        return "new_redirect"
    if o_red and not n_red:
        return "redirect_removed"
    if o_red and n_red:
        if normalize_url(old.get("target_url")) != normalize_url(new.get("target_url")):
            return "redirect_target_changed"
        if old.get("redirect_type") != new.get("redirect_type"):
            return "redirect_method_changed"
        if old.get("status_code") != new.get("status_code"):
            return "redirect_code_changed"
        return "chain_changed"
    if old.get("status_code") != new.get("status_code"):
        return "status_changed"
    return "chain_changed"


def evaluate(
    state_row: dict | None, obs: Observation, *, now: datetime, confirm_threshold: int
) -> tuple[dict, dict | None]:
    """
    Cap nhat trang thai va tra ve (state_moi, change_hoac_None).

    Logic xac nhan:
      - Ket qua trung trang thai hien tai  -> chi cap nhat last_confirmed_at, xoa pending.
      - Ket qua khac                        -> tang pending_count. Du nguong -> chot thay doi.
      - Cua so bat dinh = [last_confirmed_at cu, pending_first_at] (lan DAU thay cai moi),
        khong phai luc confirm -> khong mat do chinh xac vi phai cho xac nhan.
    """
    st = dict(state_row or {})
    now_iso = iso(now)
    new_key = obs.state_key()
    new_state = obs.to_state_dict()

    st["updated_at"] = now_iso
    st["relay_node"] = obs.relay_node
    st["mode_used"] = obs.mode_used
    st["latency_ms"] = obs.latency_ms
    st["consecutive_errors"] = 0
    st["last_error"] = None

    current_key = st.get("state_key")

    if current_key == new_key:
        st["last_confirmed_at"] = now_iso
        st["pending_key"] = None
        st["pending_json"] = None
        st["pending_count"] = 0
        st["pending_first_at"] = None
        # refresh cac truong hien thi (IP, chain co the doi nhe)
        st["ips_json"] = json.dumps(obs.ips)
        st["chain_json"] = json.dumps(new_state["chain"], ensure_ascii=False)
        st["block_kind"] = obs.block_kind
        return st, None

    # --- trang thai khac voi hien tai ---
    if st.get("pending_key") == new_key:
        st["pending_count"] = int(st.get("pending_count") or 0) + 1
    else:
        st["pending_key"] = new_key
        st["pending_json"] = json.dumps(new_state, ensure_ascii=False)
        st["pending_count"] = 1
        st["pending_first_at"] = now_iso

    threshold = 1 if not current_key else max(1, confirm_threshold)
    if st["pending_count"] < threshold:
        return st, None

    # --- Chot: day la thay doi that ---
    old_state = None
    if current_key:
        try:
            old_state = {
                "status_code": st.get("status_code"),
                "redirect_type": st.get("redirect_type"),
                "target_url": st.get("target_url"),
                "final_url": st.get("final_url"),
                "final_status": st.get("final_status"),
                "hops": st.get("hops"),
                "block_kind": st.get("block_kind"),
                "chain": json.loads(st.get("chain_json") or "[]"),
            }
        except (json.JSONDecodeError, TypeError):
            old_state = None

    window_start = st.get("last_confirmed_at") or st.get("pending_first_at") or now_iso
    window_end = st.get("pending_first_at") or now_iso
    ws, we = parse_iso(window_start), parse_iso(window_end)
    uncertainty = int((we - ws).total_seconds()) if ws and we else 0

    change = None
    if current_key:  # khong bao "first_seen" nhu mot thay doi can canh bao
        change = {
            "from_state": old_state,
            "to_state": new_state,
            "window_start": window_start,
            "window_end": window_end,
            "confirmed_at": now_iso,
            "uncertainty_sec": max(0, uncertainty),
            "change_kind": classify_change(old_state, new_state),
        }
    else:
        change = {
            "from_state": None,
            "to_state": new_state,
            "window_start": window_end,
            "window_end": window_end,
            "confirmed_at": now_iso,
            "uncertainty_sec": 0,
            "change_kind": "first_seen",
        }

    st.update(
        {
            "state_key": new_key,
            "status_code": obs.status_code,
            "redirect_type": obs.redirect_type,
            "target_url": obs.target_url,
            "final_url": obs.final_url,
            "final_status": obs.final_status,
            "hops": obs.hops,
            "chain_json": json.dumps(new_state["chain"], ensure_ascii=False),
            "ips_json": json.dumps(obs.ips),
            "block_kind": obs.block_kind,
            "state_since": window_end,
            "last_confirmed_at": now_iso,
            "pending_key": None,
            "pending_json": None,
            "pending_count": 0,
            "pending_first_at": None,
        }
    )
    return st, change


def apply_error(state_row: dict | None, obs: Observation, *, now: datetime) -> dict:
    """Ket qua loi: KHONG dung de doi trang thai, chi dem loi lien tiep."""
    st = dict(state_row or {})
    st["consecutive_errors"] = int(st.get("consecutive_errors") or 0) + 1
    st["last_error"] = f"{obs.error_kind}: {obs.error_detail}"[:300]
    st["last_error_at"] = iso(now)
    st["updated_at"] = iso(now)
    st["relay_node"] = obs.relay_node
    st["latency_ms"] = obs.latency_ms
    return st


# ---------------- doi chieu giua cac diem quan sat ----------------

def summarize_vantages(rows: list[dict]) -> dict:
    """So sanh quan sat cua cung mot domain tu nhieu diem.

    Tra ve {kind, label, detail, targets}. `kind` la:
      no_data        - chua du du lieu (duoi 2 diem)
      agree          - moi diem thay giong nhau
      target_differs - dich redirect KHAC nhau giua cac diem -> dau hieu cloaking
      status_differs - trang thai khac nhau (vd 200 o cho nay, 403 o cho kia)
      partial_block  - co diem khong voi toi duoc, diem khac thi duoc
    Thu tu uu tien co chu y: 'dich khac nhau' quan trong hon 'co cho khong vao
    duoc', vi mot cai la site noi doi, cai kia chi la khong nhin thay.
    """
    usable = [r for r in rows if r.get("checked_at")]
    if len(usable) < 2:
        return {"kind": "no_data", "label": "chưa đủ dữ liệu", "detail": "", "targets": {}}

    ok = [r for r in usable if not r.get("error_kind")]
    bad = [r for r in usable if r.get("error_kind")]

    targets = {r["vantage"]: (r.get("target_url") or "") for r in ok}
    distinct_targets = {t for t in targets.values() if t}
    # Co diem thay redirect, diem khac thay khong redirect -> cung la khac dich.
    mixed_redirect = len({bool(t) for t in targets.values()}) > 1

    if len(distinct_targets) > 1 or (mixed_redirect and distinct_targets):
        return {
            "kind": "target_differs",
            "label": "đích khác nhau theo vị trí",
            "detail": "; ".join(f"{k}: {v or '(không redirect)'}" for k, v in targets.items()),
            "targets": targets,
        }

    statuses = {r["vantage"]: r.get("status_code") for r in ok}
    if len({v for v in statuses.values() if v is not None}) > 1:
        return {
            "kind": "status_differs",
            "label": "trạng thái khác nhau theo vị trí",
            "detail": "; ".join(f"{k}: {v}" for k, v in statuses.items()),
            "targets": targets,
        }

    if bad and ok:
        return {
            "kind": "partial_block",
            "label": "có nơi không vào được",
            "detail": "; ".join(f"{r['vantage']}: {r.get('error_kind')}" for r in bad),
            "targets": targets,
        }

    if bad and not ok:
        return {
            "kind": "all_blocked",
            "label": "không nơi nào vào được",
            "detail": "; ".join(f"{r['vantage']}: {r.get('error_kind')}" for r in bad),
            "targets": {},
        }

    return {"kind": "agree", "label": "mọi nơi giống nhau", "detail": "", "targets": targets}
