"""Bo lap lich quet: moi domain co lich rieng (khong quet theo lo).

Cach nay quan trong voi interval 15s + 200 domain: neu quet theo lo, ca 200
request se dap cung mot luc moi 15 giay. Voi lich rieng + jitter, tai duoc trai
deu ra -> nhe cho relay va it bi rate-limit hon nhieu.
"""
from __future__ import annotations

import asyncio
import logging
import random
from datetime import datetime, timedelta, timezone

from .checker import Observation, apply_error, evaluate, interpret
from .config import settings
from .db import Database, iso, utcnow
from .relay import RelayPool

log = logging.getLogger("scheduler")


class Monitor:
    def __init__(self, db: Database, pool: RelayPool):
        self.db = db
        self.pool = pool
        self.sem = asyncio.Semaphore(settings.max_concurrency)
        self._tasks: set[asyncio.Task] = set()
        self._running = False
        self._loop_task: asyncio.Task | None = None
        self._health_task: asyncio.Task | None = None
        self._purge_task: asyncio.Task | None = None
        self._vantage_task: asyncio.Task | None = None
        self.stats = {"checks": 0, "errors": 0, "changes": 0, "started_at": iso(utcnow())}
        self._inflight: set[int] = set()
        # Diem phu = moi diem khai bao TRU diem chinh. Chung khong bao gio duoc
        # dung de ket luan trang thai hay ban canh bao — chi de doi chieu.
        self.secondary_vantages = [
            v for v in settings.vantages if v and v != settings.primary_vantage
        ]

    async def start(self) -> None:
        self._running = True
        await self._stagger_startup()
        self._loop_task = asyncio.create_task(self._tick_loop(), name="tick-loop")
        self._health_task = asyncio.create_task(self._health_loop(), name="health-loop")
        self._purge_task = asyncio.create_task(self._purge_loop(), name="purge-loop")
        if self.secondary_vantages:
            self._vantage_task = asyncio.create_task(self._vantage_loop(), name="vantage-loop")
            log.info(
                "Giam sat da diem: chinh=%s, doi chieu=%s moi %ds",
                settings.primary_vantage or "(mac dinh cua relay)",
                ",".join(self.secondary_vantages), settings.vantage_compare_sec,
            )
        log.info(
            "Monitor khoi dong: concurrency=%d, interval mac dinh=%ds",
            settings.max_concurrency, settings.default_interval_sec,
        )

    async def _stagger_startup(self) -> None:
        """Trai deu lan quet dau tien ra trong mot chu ky.

        Khong co buoc nay, khi khoi dong lai TAT CA domain deu den han cung luc
        -> 200 request dap ngay lap tuc, event loop nghen, dashboard treo vai giay
        va relay bi dot bien tai. Trai ra thi tai vao dung nhip ngay tu dau.
        """
        rows = await self.db.fetchall("SELECT id, interval_sec FROM domains WHERE enabled=1 ORDER BY id")
        if not rows:
            return
        now = utcnow()
        n = len(rows)
        for idx, r in enumerate(rows):
            interval = max(settings.min_interval_sec, int(r["interval_sec"] or settings.default_interval_sec))
            offset = interval * (idx / n)
            await self.db.set_next_check(r["id"], now + timedelta(seconds=offset))
        log.info("Da trai %d domain ra trong chu ky dau tien", n)

    async def stop(self) -> None:
        self._running = False
        for t in (self._loop_task, self._health_task, self._purge_task, self._vantage_task):
            if t:
                t.cancel()
        for t in list(self._tasks):
            t.cancel()
        await asyncio.gather(*self._tasks, return_exceptions=True)

    # ---------------- vong lap chinh ----------------

    async def _tick_loop(self) -> None:
        while self._running:
            try:
                now = utcnow()
                due = await self.db.due_domains(now)
                for d in due:
                    if d["id"] in self._inflight:
                        continue
                    # Dat lich ke tiep NGAY, truoc khi chay, de khong bi lap.
                    interval = max(settings.min_interval_sec, int(d["interval_sec"] or settings.default_interval_sec))
                    jitter = interval * settings.jitter_pct / 100.0
                    delay = interval + random.uniform(-jitter, jitter)
                    await self.db.set_next_check(d["id"], now + timedelta(seconds=max(1.0, delay)))

                    self._inflight.add(d["id"])
                    task = asyncio.create_task(self._run_check(d), name=f"check-{d['id']}")
                    self._tasks.add(task)
                    task.add_done_callback(self._tasks.discard)
            except asyncio.CancelledError:
                raise
            except Exception:  # noqa: BLE001
                log.exception("tick loop loi")
            await asyncio.sleep(1.0)

    async def _run_check(self, domain: dict) -> None:
        try:
            async with self.sem:
                await self.check_domain(domain)
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001
            log.exception("check domain %s loi", domain.get("url"))
        finally:
            self._inflight.discard(domain["id"])

    # ---------------- mot lan quet ----------------

    async def check_domain(self, domain: dict) -> Observation:
        domain_id = domain["id"]
        url = domain["url"]
        mode = domain.get("mode") or "auto"

        result = await self.pool.fetch(url, mode=mode, via=settings.primary_vantage or None)
        obs = interpret(result)
        if settings.primary_vantage:
            await self._save_vantage(domain_id, settings.primary_vantage, obs)
        now = utcnow()
        self.stats["checks"] += 1

        state = await self.db.get_state(domain_id)

        if not obs.ok:
            self.stats["errors"] += 1
            new_state = apply_error(state, obs, now=now)
            await self.db.save_state(domain_id, new_state)
            if int(new_state.get("consecutive_errors") or 0) <= settings.error_threshold:
                await self.db.log_error(domain_id, obs.error_kind or "unknown", obs.error_detail, obs.relay_node)
            await self.db.bump_hourly(domain_id, ok=False, redirect=False, blocked=False, ms=obs.latency_ms)
            return obs

        # QUAN TRONG: ket qua tu fallback DIRECT khong di qua IP Viet Nam, nen
        # khong duoc dung de ket luan trang thai. Neu dung, moi lan relay chet
        # cac site chan theo dia ly se "bong dung 403" va he thong ban canh bao
        # gia. Ta chi ghi nhan lien lac, giu nguyen trang thai da xac nhan.
        if obs.source == "direct" and self.pool.has_nodes:
            degraded = dict(state or {})
            degraded["updated_at"] = iso(now)
            degraded["latency_ms"] = obs.latency_ms
            degraded["relay_node"] = "direct-fallback (khong tin cay)"
            degraded["consecutive_errors"] = 0
            await self.db.save_state(domain_id, degraded)
            await self.db.bump_hourly(
                domain_id, ok=True, redirect=obs.is_redirect,
                blocked=bool(obs.block_kind and obs.block_kind != "none"), ms=obs.latency_ms,
            )
            return obs

        # "Bi chan" nghia la KHONG NHIN THAY, khong phai "khong co redirect".
        #
        # Neu de mot lan 403 ghi de len trang thai redirect da biet, chuoi su kien
        # se la: 301->dich  =>  403 (2 lan) => ghi nhan "da doi"  =>  browser vao
        # duoc lai => ghi nhan "doi nguoc". Nhay qua lai vo tan, toan bo la gia.
        # Da tung dinh dung kieu nay voi loi 5xx cua proxy.
        #
        # Chi ap dung khi TRUOC DO da co trang thai khong bi chan. Domain bi chan
        # ngay tu lan quet dau van duoc ghi nhan binh thuong, de con hien ra tren
        # dashboard thay vi im lang.
        # Dieu kien phai bam vao "co mat thong tin redirect khong", chu khong phai
        # "trang thai cu co bi chan khong". Vi du that: dintol.com.co = 301 sang
        # go88club9.com, ma chinh go88club9.com lai bi chan -> trang thai duoc luu
        # kem block_kind. Neu chi xet block_kind thi lan 403 sau se ghi de mat cai
        # 301 da biet, dung thu can bao ve nhat.
        blocked_now = (
            bool(obs.block_kind and obs.block_kind != "none")
            and obs.redirect_type is None
        )
        old_observable = bool(state) and (
            state.get("redirect_type") is not None
            or not (state.get("block_kind") and state.get("block_kind") != "none")
        )
        if blocked_now and old_observable:
            self.stats["errors"] += 1
            degraded = dict(state)
            degraded["updated_at"] = iso(now)
            degraded["latency_ms"] = obs.latency_ms
            degraded["last_error"] = f"bi chan ({obs.block_kind}) - khong quan sat duoc"
            degraded["last_error_at"] = iso(now)
            degraded["consecutive_errors"] = int(state.get("consecutive_errors") or 0) + 1
            await self.db.save_state(domain_id, degraded)
            if int(degraded["consecutive_errors"]) <= settings.error_threshold:
                await self.db.log_error(
                    domain_id, f"blocked_{obs.block_kind}",
                    "; ".join(obs.block_evidence or [])[:300], obs.relay_node,
                )
            await self.db.bump_hourly(
                domain_id, ok=False, redirect=False, blocked=True, ms=obs.latency_ms
            )
            return obs

        new_state, change = evaluate(
            state, obs, now=now, confirm_threshold=settings.confirm_threshold
        )
        await self.db.save_state(domain_id, new_state)
        await self.db.bump_hourly(
            domain_id,
            ok=True,
            redirect=obs.is_redirect,
            blocked=bool(obs.block_kind and obs.block_kind != "none"),
            ms=obs.latency_ms,
        )

        if change:
            await self.db.record_change(domain_id, change)
            self.stats["changes"] += 1
            log.info(
                "THAY DOI [%s] %s: %s (bat dinh %ds)",
                domain_id, url, change["change_kind"], change["uncertainty_sec"],
            )
        return obs

    async def check_now(self, domain_id: int) -> dict:
        """Quet ngay lap tuc (dung cho nut 'Kiem tra ngay' tren dashboard)."""
        d = await self.db.fetchone("SELECT * FROM domains WHERE id=?", (domain_id,))
        if not d:
            raise ValueError("Khong tim thay domain")
        obs = await self.check_domain(dict(d))
        return {
            "ok": obs.ok,
            "status_code": obs.status_code,
            "redirect_type": obs.redirect_type,
            "target_url": obs.target_url,
            "final_url": obs.final_url,
            "final_status": obs.final_status,
            "block_kind": obs.block_kind,
            "block_evidence": obs.block_evidence,
            "relay_node": obs.relay_node,
            "source": obs.source,
            "mode_used": obs.mode_used,
            "latency_ms": obs.latency_ms,
            "error": obs.error_detail or None,
            "chain": obs.chain,
        }

    # ---------------- cac vong phu ----------------

    async def _health_loop(self) -> None:
        while self._running:
            try:
                infos = await self.pool.health_check()
                for i in infos:
                    await self.db.save_relay_health(i["name"], i)
                bad = [i for i in infos if not i["ok"]]
                if bad:
                    # Tinh trang relay van duoc luu vao DB va hien tren dashboard;
                    # dong log nay de nguoi van hanh thay duoc ma khong can mo trinh duyet.
                    log.warning(
                        "RELAY KHONG PHAN HOI: %s — ket qua quet co the sai "
                        "(khong con di qua IP Viet Nam)",
                        ", ".join(i["name"] for i in bad),
                    )
            except asyncio.CancelledError:
                raise
            except Exception:  # noqa: BLE001
                log.exception("health loop loi")
            await asyncio.sleep(60)

    # ---------------- doi chieu da diem ----------------

    async def _save_vantage(self, domain_id: int, vantage: str, obs: Observation) -> None:
        row = {
            "state_key": obs.state_key() if obs.ok else None,
            "status_code": obs.status_code,
            "redirect_type": obs.redirect_type,
            "target_url": obs.target_url,
            "final_url": obs.final_url,
            "final_status": obs.final_status,
            "block_kind": obs.block_kind,
            "error_kind": obs.error_kind,
            "error_detail": (obs.error_detail or "")[:300] or None,
            "latency_ms": obs.latency_ms,
            "checked_at": iso(utcnow()),
        }
        await self.db.save_vantage(domain_id, vantage, row)

    async def _vantage_loop(self) -> None:
        """Quet lai moi domain tu cac diem PHU, cham hon nhip chinh rat nhieu.

        Muc dich la tra loi "cung mot domain, tu cho khac co thay khac khong" —
        phat hien cloaking theo vung va chan o tang nha mang. Day khong phai
        canh bao tuc thi nen khong can quet day.
        """
        # Lech pha voi vong quet chinh de khong dap cung luc.
        await asyncio.sleep(15)
        while self._running:
            try:
                rows = await self.db.fetchall(
                    "SELECT id, url, mode FROM domains WHERE enabled=1 ORDER BY id"
                )
                for r in rows:
                    if not self._running:
                        break
                    for v in self.secondary_vantages:
                        try:
                            async with self.sem:
                                res = await self.pool.fetch(
                                    r["url"], mode=(r["mode"] or "auto"), via=v
                                )
                            obs = interpret(res)
                            # Ket qua fallback direct khong di qua diem da chon ->
                            # ghi vao se lam sai lech chinh cai dang muon so sanh.
                            if obs.source == "direct":
                                continue
                            await self._save_vantage(r["id"], v, obs)
                        except asyncio.CancelledError:
                            raise
                        except Exception:  # noqa: BLE001
                            log.exception("doi chieu %s tai diem %s loi", r["url"], v)
                        await asyncio.sleep(0.2)
            except asyncio.CancelledError:
                raise
            except Exception:  # noqa: BLE001
                log.exception("vantage loop loi")
            await asyncio.sleep(max(60, settings.vantage_compare_sec))

    async def _purge_loop(self) -> None:
        ticks = 0
        while self._running:
            await asyncio.sleep(300)
            ticks += 1
            try:
                # Cat ngan WAL moi 5 phut (ghi lien tuc nen WAL phinh rat nhanh).
                await self.db.checkpoint()
                # Don du lieu cu moi 6 tieng.
                if ticks % 72 == 0:
                    await self.db.purge_old(settings.retention_days)
            except Exception:  # noqa: BLE001
                log.exception("purge/checkpoint loi")
