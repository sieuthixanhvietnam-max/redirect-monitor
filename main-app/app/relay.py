"""Client goi toi cac VN relay node, co round-robin + circuit breaker + fallback."""
from __future__ import annotations

import asyncio
import itertools
import logging
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone

import httpx

from .config import RelayNode, settings

log = logging.getLogger("relay")


@dataclass
class NodeRuntime:
    node: RelayNode
    failures: int = 0
    open_until: datetime | None = None
    last_ok: datetime | None = None
    egress_ip: str | None = None
    country: str | None = None
    egress_checked_at: datetime | None = None
    last_error: str | None = None

    def healthy(self, now: datetime) -> bool:
        if self.open_until and now < self.open_until:
            return False
        return True


class RelayPool:
    """Chon relay theo vong tron, tu dong mo circuit khi node loi lien tuc."""

    FAIL_THRESHOLD = 3
    OPEN_SECONDS = 30
    # Bao lau thi hoi lai IP thoat cua relay (giay).
    EGRESS_TTL_SEC = 300

    def __init__(self, nodes: list[RelayNode] | None = None):
        self.runtimes: list[NodeRuntime] = [NodeRuntime(node=n) for n in (nodes or settings.relays)]
        self._cycle = itertools.cycle(range(len(self.runtimes))) if self.runtimes else None
        self._client: httpx.AsyncClient | None = None
        self._direct_client: httpx.AsyncClient | None = None
        self._lock = asyncio.Lock()

    async def start(self) -> None:
        limits = httpx.Limits(max_connections=200, max_keepalive_connections=100)
        self._client = httpx.AsyncClient(timeout=settings.request_timeout_sec + 15, limits=limits)
        self._direct_client = httpx.AsyncClient(
            timeout=settings.request_timeout_sec,
            follow_redirects=False,
            limits=limits,
            headers={
                "user-agent": (
                    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                    "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
                )
            },
        )

    async def close(self) -> None:
        if self._client:
            await self._client.aclose()
        if self._direct_client:
            await self._direct_client.aclose()

    @property
    def has_nodes(self) -> bool:
        return bool(self.runtimes)

    def _pick(self) -> NodeRuntime | None:
        if not self.runtimes:
            return None
        now = datetime.now(timezone.utc)
        for _ in range(len(self.runtimes)):
            rt = self.runtimes[next(self._cycle)]
            if rt.node.enabled and rt.healthy(now):
                return rt
        return None

    def _mark_fail(self, rt: NodeRuntime, err: str) -> None:
        rt.failures += 1
        rt.last_error = err[:300]
        if rt.failures >= self.FAIL_THRESHOLD:
            rt.open_until = datetime.now(timezone.utc) + timedelta(seconds=self.OPEN_SECONDS)
            log.warning("Relay %s mo circuit %ss sau %d loi: %s", rt.node.name, self.OPEN_SECONDS, rt.failures, err)

    def _mark_ok(self, rt: NodeRuntime) -> None:
        rt.failures = 0
        rt.open_until = None
        rt.last_ok = datetime.now(timezone.utc)
        rt.last_error = None

    async def fetch(
        self, url: str, mode: str = "auto", timeout_sec: int | None = None,
        via: str | None = None,
    ) -> dict:
        """Tra ve dict ket qua chuan hoa, luon co khoa 'source'."""
        timeout_sec = timeout_sec or settings.request_timeout_sec
        tried: list[str] = []

        for _ in range(max(1, len(self.runtimes))):
            rt = self._pick()
            if rt is None:
                break
            tried.append(rt.node.name)
            try:
                resp = await self._client.post(
                    f"{rt.node.url}/fetch",
                    json={
                        "url": url,
                        "mode": mode,
                        "timeoutMs": timeout_sec * 1000,
                        **({"via": via} if via else {}),
                    },
                    headers={"x-api-key": rt.node.api_key},
                )
                if resp.status_code == 401:
                    self._mark_fail(rt, "relay_unauthorized (sai RELAY_API_KEY)")
                    continue
                resp.raise_for_status()
                data = resp.json()
                self._mark_ok(rt)
                data["source"] = "relay"
                data.setdefault("node", rt.node.name)
                return data
            except Exception as e:  # noqa: BLE001
                self._mark_fail(rt, f"{type(e).__name__}: {e}")
                continue

        if settings.allow_direct_fallback:
            log.warning("Tat ca relay khong dung duoc (%s) -> fallback DIRECT (IP KHONG phai VN)", tried)
            return await self._fetch_direct(url, timeout_sec)

        return {
            "source": "none",
            "node": None,
            "startUrl": url,
            "chain": [],
            "finalUrl": url,
            "finalStatus": None,
            "error": "all_relays_down",
            "block": None,
            "hops": 0,
            "totalMs": 0,
            "mode": "none",
        }

    async def _fetch_direct(self, url: str, timeout_sec: int) -> dict:
        """Fallback: goi thang tu server nay. IP khong phai VN -> ket qua co the sai."""
        chain: list[dict] = []
        current = url
        seen: set[str] = set()
        t0 = datetime.now(timezone.utc)
        err = None
        for _ in range(10):
            if current in seen:
                break
            seen.add(current)
            try:
                r = await self._direct_client.get(current, timeout=timeout_sec)
            except Exception as e:  # noqa: BLE001
                err = f"network:{type(e).__name__}"
                chain.append({"url": current, "error": err})
                break
            loc = r.headers.get("location")
            rec = {
                "url": current,
                "status": r.status_code,
                "headers": {
                    k: v for k, v in r.headers.items()
                    if k.lower() in {"location", "server", "content-type", "cf-ray"}
                },
                "ms": int(r.elapsed.total_seconds() * 1000),
            }
            if 300 <= r.status_code < 400 and loc:
                nxt = str(httpx.URL(current).join(loc))
                rec["redirectType"] = "http"
                rec["location"] = nxt
                chain.append(rec)
                current = nxt
                continue
            chain.append(rec)
            break
        last = chain[-1] if chain else {}
        return {
            "source": "direct",
            "node": "direct-fallback",
            "startUrl": url,
            "chain": chain,
            "finalUrl": last.get("url", url),
            "finalStatus": last.get("status"),
            "error": err,
            "block": None,
            "hops": len(chain),
            "totalMs": int((datetime.now(timezone.utc) - t0).total_seconds() * 1000),
            "mode": "http-direct",
        }

    async def health_check(self) -> list[dict]:
        out = []
        for rt in self.runtimes:
            info = {
                "name": rt.node.name,
                "url": rt.node.url,
                "ok": False,
                "egress_ip": rt.egress_ip,
                "country": rt.country,
                "last_ok_at": rt.last_ok.isoformat() if rt.last_ok else None,
                "last_error": rt.last_error,
                "circuit_open": bool(rt.open_until and datetime.now(timezone.utc) < rt.open_until),
            }
            try:
                r = await self._client.get(
                    f"{rt.node.url}/health", headers={"x-api-key": rt.node.api_key}, timeout=8
                )
                r.raise_for_status()
                j = r.json()
                info["ok"] = bool(j.get("ok"))
                info["browser"] = bool(j.get("browser"))
                self._mark_ok(rt)
                info["last_ok_at"] = rt.last_ok.isoformat()
                info["last_error"] = None

                # Phai hoi lai dinh ky, KHONG duoc cache vinh vien: proxy chet,
                # VPN rot hay doi RELAY_PROXY deu lam IP thoat doi. Neu giu ket qua
                # cu thi dashboard van bao "VN" trong khi thuc te da di ra bang IP
                # khac — va moi ket luan ve site chan theo dia ly deu sai am tham.
                now_ = datetime.now(timezone.utc)
                stale = (
                    rt.egress_checked_at is None
                    or (now_ - rt.egress_checked_at).total_seconds() > self.EGRESS_TTL_SEC
                )
                if not rt.egress_ip or stale:
                    try:
                        r2 = await self._client.get(
                            f"{rt.node.url}/egress-ip", headers={"x-api-key": rt.node.api_key}, timeout=10
                        )
                        j2 = r2.json()
                        # Dich vu tra IP (ipinfo/ipapi) hay bi rate-limit 429; khi do
                        # relay tra ip=null. Tuyet doi khong ghi de gia tri cu bang
                        # null: se hien "—" tren dashboard nhu the mat dau vet, trong
                        # khi thuc te chi la khong hoi duoc. Giu gia tri cu va thu lai
                        # o lan health-check sau (khong dong dau thoi gian).
                        if j2.get("ip"):
                            rt.egress_ip = j2.get("ip")
                            rt.country = j2.get("country")
                            rt.egress_checked_at = now_
                            info["egress_ip"] = rt.egress_ip
                            info["country"] = rt.country
                    except Exception:  # noqa: BLE001
                        pass
            except Exception as e:  # noqa: BLE001
                info["last_error"] = f"{type(e).__name__}: {e}"[:300]
                self._mark_fail(rt, info["last_error"])
            out.append(info)
        return out
