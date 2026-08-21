"""Cau hinh doc tu bien moi truong."""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from zoneinfo import ZoneInfo

VN_TZ = ZoneInfo("Asia/Ho_Chi_Minh")


def _env_bool(key: str, default: bool = False) -> bool:
    v = os.getenv(key)
    if v is None:
        return default
    return v.strip().lower() in {"1", "true", "yes", "on"}


def _env_int(key: str, default: int) -> int:
    try:
        return int(os.getenv(key, str(default)))
    except ValueError:
        return default


@dataclass
class RelayNode:
    name: str
    url: str
    api_key: str
    enabled: bool = True


def _parse_relays() -> list[RelayNode]:
    """
    RELAY_NODES = "ten1|https://relay1.example.com|apikey1 , ten2|https://relay2...|apikey2"
    Hoac dung cap don gian: RELAY_URL + RELAY_API_KEY
    """
    raw = os.getenv("RELAY_NODES", "").strip()
    nodes: list[RelayNode] = []
    if raw:
        for chunk in raw.split(","):
            chunk = chunk.strip()
            if not chunk:
                continue
            parts = [p.strip() for p in chunk.split("|")]
            if len(parts) < 3:
                continue
            nodes.append(RelayNode(name=parts[0], url=parts[1].rstrip("/"), api_key=parts[2]))
    else:
        url = os.getenv("RELAY_URL", "").strip().rstrip("/")
        key = os.getenv("RELAY_API_KEY", "").strip()
        if url and key:
            nodes.append(RelayNode(name=os.getenv("RELAY_NAME", "vn-relay-1"), url=url, api_key=key))
    return nodes


@dataclass
class Settings:
    db_path: str = field(default_factory=lambda: os.getenv("DB_PATH", "./data/monitor.db"))

    relays: list[RelayNode] = field(default_factory=_parse_relays)
    # Cho phep fallback ra IP cua chinh server (khong phai VN) khi tat ca relay chet.
    allow_direct_fallback: bool = field(default_factory=lambda: _env_bool("ALLOW_DIRECT_FALLBACK", True))

    default_interval_sec: int = field(default_factory=lambda: _env_int("DEFAULT_INTERVAL_SEC", 15))
    min_interval_sec: int = field(default_factory=lambda: _env_int("MIN_INTERVAL_SEC", 10))
    jitter_pct: int = field(default_factory=lambda: _env_int("JITTER_PCT", 15))
    max_concurrency: int = field(default_factory=lambda: _env_int("MAX_CONCURRENCY", 24))
    request_timeout_sec: int = field(default_factory=lambda: _env_int("REQUEST_TIMEOUT_SEC", 20))

    # So lan xac nhan lien tiep truoc khi ghi nhan la thay doi that (chong bao dong gia)
    confirm_threshold: int = field(default_factory=lambda: _env_int("CONFIRM_THRESHOLD", 2))
    # So lan loi lien tiep truoc khi coi la "down" va bao
    error_threshold: int = field(default_factory=lambda: _env_int("ERROR_THRESHOLD", 3))

    dashboard_user: str = field(default_factory=lambda: os.getenv("DASHBOARD_USER", "admin"))
    dashboard_password: str = field(default_factory=lambda: os.getenv("DASHBOARD_PASSWORD", "").strip())

    # ---- Giam sat da diem (multi-vantage) ----
    # Ten cac diem quan sat khai bao ben relay (RELAY_PROXIES + 'direct').
    # VANTAGES rong = tat, he thong chay y het truoc day.
    vantages: list[str] = field(
        default_factory=lambda: [
            v.strip() for v in os.getenv("VANTAGES", "").split(",") if v.strip()
        ]
    )
    # Diem quyet dinh trang thai va canh bao. Cac diem con lai chi de doi chieu.
    primary_vantage: str = field(default_factory=lambda: os.getenv("PRIMARY_VANTAGE", "").strip())
    # Nhip doi chieu cac diem phu (giay). Thua hon nhip quet chinh rat nhieu:
    # muc dich la phat hien cloaking / chan theo vung, khong phai canh bao tuc thi.
    vantage_compare_sec: int = field(default_factory=lambda: _env_int("VANTAGE_COMPARE_SEC", 300))

    retention_days: int = field(default_factory=lambda: _env_int("RETENTION_DAYS", 365))


settings = Settings()
