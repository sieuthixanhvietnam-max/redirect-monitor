"""Lop truy cap SQLite (WAL) — thiet ke de KHONG phinh du lieu.

Nguyen tac luu tru:
  * domain_state : 1 dong / domain, update tai cho moi lan check  -> khong tang.
  * state_changes: chi ghi KHI trang thai thay doi that su          -> vai chuc dong/thang.
  * hourly_stats : rollup theo gio de ve bieu do lich su            -> 24 dong/domain/ngay.
  * check_errors : chi ghi loi, co retention                        -> nho.
Nho vay 200 domain x 15 giay (~1.15 trieu request/ngay) van chi ton vai MB/nam.
"""
from __future__ import annotations

import json
import logging
import os
import sqlite3
from datetime import datetime, timedelta, timezone
from typing import Any, Iterable

import aiosqlite

log = logging.getLogger("db")

SCHEMA = """
PRAGMA journal_mode=WAL;
PRAGMA synchronous=NORMAL;
PRAGMA busy_timeout=5000;
PRAGMA foreign_keys=ON;
-- Checkpoint som de file -wal khong phinh (ghi lien tuc 14 lan/giay).
PRAGMA wal_autocheckpoint=400;

CREATE TABLE IF NOT EXISTS domains (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    url           TEXT NOT NULL UNIQUE,
    label         TEXT NOT NULL DEFAULT '',
    interval_sec  INTEGER NOT NULL DEFAULT 15,
    mode          TEXT NOT NULL DEFAULT 'auto',      -- auto | http | browser
    enabled       INTEGER NOT NULL DEFAULT 1,
    notes         TEXT NOT NULL DEFAULT '',
    created_at    TEXT NOT NULL,
    next_check_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_domains_next ON domains(enabled, next_check_at);

CREATE TABLE IF NOT EXISTS domain_state (
    domain_id          INTEGER PRIMARY KEY REFERENCES domains(id) ON DELETE CASCADE,
    state_key          TEXT,
    status_code        INTEGER,
    redirect_type      TEXT,          -- http | meta | js | NULL
    target_url         TEXT,          -- dich cua hop dau tien
    final_url          TEXT,
    final_status       INTEGER,
    hops               INTEGER,
    chain_json         TEXT,
    ips_json           TEXT,
    block_kind         TEXT,          -- none|bot|geo|ratelimit|auth|unknown
    relay_node         TEXT,
    mode_used          TEXT,
    latency_ms         INTEGER,
    -- moc thoi gian dung de tinh cua so bat dinh cua thoi diem 301
    state_since        TEXT,          -- lan dau trang thai nay duoc xac nhan
    last_confirmed_at  TEXT,          -- lan gan nhat trang thai nay con dung
    -- ung vien dang cho du so lan xac nhan
    pending_key        TEXT,
    pending_json       TEXT,
    pending_count      INTEGER NOT NULL DEFAULT 0,
    pending_first_at   TEXT,
    consecutive_errors INTEGER NOT NULL DEFAULT 0,
    last_error         TEXT,
    last_error_at      TEXT,
    updated_at         TEXT
);

CREATE TABLE IF NOT EXISTS state_changes (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    domain_id         INTEGER NOT NULL REFERENCES domains(id) ON DELETE CASCADE,
    from_state_json   TEXT,
    to_state_json     TEXT,
    -- Thoi diem thay doi that su nam trong khoang [window_start, window_end]
    window_start      TEXT NOT NULL,   -- lan cuoi con thay trang thai cu
    window_end        TEXT NOT NULL,   -- lan dau tien thay trang thai moi
    confirmed_at      TEXT NOT NULL,   -- luc du so lan xac nhan
    uncertainty_sec   INTEGER NOT NULL,
    change_kind       TEXT NOT NULL,   -- new_redirect | redirect_target_changed | redirect_removed | status_changed | first_seen
    created_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_changes_domain ON state_changes(domain_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_changes_created ON state_changes(created_at DESC);

CREATE TABLE IF NOT EXISTS check_errors (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    domain_id  INTEGER NOT NULL REFERENCES domains(id) ON DELETE CASCADE,
    at         TEXT NOT NULL,
    kind       TEXT NOT NULL,
    detail     TEXT NOT NULL DEFAULT '',
    relay_node TEXT
);
CREATE INDEX IF NOT EXISTS idx_errors_domain ON check_errors(domain_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_errors_at ON check_errors(at);

CREATE TABLE IF NOT EXISTS hourly_stats (
    domain_id   INTEGER NOT NULL REFERENCES domains(id) ON DELETE CASCADE,
    hour_utc    TEXT NOT NULL,
    checks      INTEGER NOT NULL DEFAULT 0,
    ok_count    INTEGER NOT NULL DEFAULT 0,
    err_count   INTEGER NOT NULL DEFAULT 0,
    redirect_count INTEGER NOT NULL DEFAULT 0,
    blocked_count  INTEGER NOT NULL DEFAULT 0,
    total_ms    INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (domain_id, hour_utc)
);

-- Quan sat tu tung DIEM QUAN SAT (vantage point).
-- Kich thuoc CO DINH = so domain x so diem, khong phinh theo thoi gian —
-- cung nguyen tac voi domain_state. Bang nay KHONG dieu khien canh bao;
-- canh bao van chi do diem chinh quyet dinh (xem scheduler), de toan bo co che
-- chong bao dong gia hien co khong bi anh huong.
CREATE TABLE IF NOT EXISTS vantage_state (
    domain_id    INTEGER NOT NULL REFERENCES domains(id) ON DELETE CASCADE,
    vantage      TEXT NOT NULL,
    state_key    TEXT,
    status_code  INTEGER,
    redirect_type TEXT,
    target_url   TEXT,
    final_url    TEXT,
    final_status INTEGER,
    block_kind   TEXT,
    error_kind   TEXT,
    error_detail TEXT,
    latency_ms   INTEGER,
    checked_at   TEXT,
    PRIMARY KEY (domain_id, vantage)
);
CREATE INDEX IF NOT EXISTS idx_vantage_domain ON vantage_state(domain_id);

CREATE TABLE IF NOT EXISTS relay_health (
    node        TEXT PRIMARY KEY,
    url         TEXT,
    ok          INTEGER NOT NULL DEFAULT 0,
    egress_ip   TEXT,
    country     TEXT,
    last_ok_at  TEXT,
    last_error  TEXT,
    checked_at  TEXT
);

CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT
);
"""


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def iso(dt: datetime | None) -> str | None:
    if dt is None:
        return None
    return dt.astimezone(timezone.utc).isoformat(timespec="milliseconds")


def parse_iso(s: str | None) -> datetime | None:
    if not s:
        return None
    try:
        dt = datetime.fromisoformat(s)
        return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
    except ValueError:
        return None


class Database:
    def __init__(self, path: str):
        self.path = path
        self._conn: aiosqlite.Connection | None = None

    async def connect(self) -> None:
        os.makedirs(os.path.dirname(os.path.abspath(self.path)) or ".", exist_ok=True)
        self._conn = await aiosqlite.connect(self.path)
        self._conn.row_factory = aiosqlite.Row
        await self._conn.executescript(SCHEMA)
        await self._conn.commit()

    async def close(self) -> None:
        if self._conn:
            await self._conn.close()
            self._conn = None

    @property
    def conn(self) -> aiosqlite.Connection:
        if self._conn is None:
            raise RuntimeError("Database chua duoc connect()")
        return self._conn

    async def execute(self, sql: str, params: Iterable[Any] = ()) -> aiosqlite.Cursor:
        cur = await self.conn.execute(sql, tuple(params))
        await self.conn.commit()
        return cur

    async def fetchall(self, sql: str, params: Iterable[Any] = ()) -> list[aiosqlite.Row]:
        async with self.conn.execute(sql, tuple(params)) as cur:
            return list(await cur.fetchall())

    async def fetchone(self, sql: str, params: Iterable[Any] = ()) -> aiosqlite.Row | None:
        async with self.conn.execute(sql, tuple(params)) as cur:
            return await cur.fetchone()

    # ---------------- domains ----------------

    async def add_domain(
        self, url: str, label: str = "", interval_sec: int = 15, mode: str = "auto", notes: str = ""
    ) -> int:
        now = iso(utcnow())
        cur = await self.execute(
            "INSERT INTO domains (url,label,interval_sec,mode,enabled,notes,created_at,next_check_at)"
            " VALUES (?,?,?,?,1,?,?,?)",
            (url, label, interval_sec, mode, notes, now, now),
        )
        domain_id = cur.lastrowid
        await self.execute(
            "INSERT OR IGNORE INTO domain_state (domain_id,updated_at) VALUES (?,?)", (domain_id, now)
        )
        return int(domain_id)

    async def delete_domain(self, domain_id: int) -> None:
        await self.execute("DELETE FROM domains WHERE id=?", (domain_id,))

    async def update_domain(self, domain_id: int, **fields: Any) -> None:
        allowed = {"label", "interval_sec", "mode", "enabled", "notes", "url", "next_check_at"}
        sets, vals = [], []
        for k, v in fields.items():
            if k in allowed:
                sets.append(f"{k}=?")
                vals.append(v)
        if not sets:
            return
        vals.append(domain_id)
        await self.execute(f"UPDATE domains SET {','.join(sets)} WHERE id=?", vals)

    async def list_domains(self) -> list[dict]:
        rows = await self.fetchall(
            """
            SELECT d.*, s.state_key, s.status_code, s.redirect_type, s.target_url, s.final_url,
                   s.final_status, s.hops, s.chain_json, s.ips_json, s.block_kind, s.relay_node,
                   s.mode_used, s.latency_ms, s.state_since, s.last_confirmed_at,
                   s.pending_key, s.pending_count, s.consecutive_errors, s.last_error, s.last_error_at,
                   s.updated_at AS state_updated_at
            FROM domains d LEFT JOIN domain_state s ON s.domain_id = d.id
            ORDER BY d.id
            """
        )
        return [dict(r) for r in rows]

    async def get_domain(self, domain_id: int) -> dict | None:
        row = await self.fetchone(
            """
            SELECT d.*, s.* FROM domains d
            LEFT JOIN domain_state s ON s.domain_id = d.id WHERE d.id=?
            """,
            (domain_id,),
        )
        return dict(row) if row else None

    async def due_domains(self, now: datetime, limit: int = 500) -> list[dict]:
        rows = await self.fetchall(
            "SELECT * FROM domains WHERE enabled=1 AND (next_check_at IS NULL OR next_check_at<=?)"
            " ORDER BY next_check_at LIMIT ?",
            (iso(now), limit),
        )
        return [dict(r) for r in rows]

    async def set_next_check(self, domain_id: int, when: datetime) -> None:
        await self.execute("UPDATE domains SET next_check_at=? WHERE id=?", (iso(when), domain_id))

    # ---------------- state ----------------

    async def get_state(self, domain_id: int) -> dict | None:
        row = await self.fetchone("SELECT * FROM domain_state WHERE domain_id=?", (domain_id,))
        return dict(row) if row else None

    async def save_state(self, domain_id: int, state: dict) -> None:
        cols = [
            "state_key", "status_code", "redirect_type", "target_url", "final_url", "final_status",
            "hops", "chain_json", "ips_json", "block_kind", "relay_node", "mode_used", "latency_ms",
            "state_since", "last_confirmed_at", "pending_key", "pending_json", "pending_count",
            "pending_first_at", "consecutive_errors", "last_error", "last_error_at", "updated_at",
        ]
        vals = [state.get(c) for c in cols]
        try:
            await self.execute(
                f"INSERT INTO domain_state (domain_id,{','.join(cols)}) VALUES ({','.join(['?'] * (len(cols) + 1))})"
                f" ON CONFLICT(domain_id) DO UPDATE SET {','.join(f'{c}=excluded.{c}' for c in cols)}",
                [domain_id, *vals],
            )
        except sqlite3.IntegrityError:
            # Domain bi xoa trong luc lan quet cua no dang tren duong ve.
            # Khoa ngoai chan ghi lai trang thai cho mot domain khong con ton tai —
            # dung, va day khong phai loi: ket qua nay da vo nghia. Bo qua thay vi
            # de no noi len thanh HTTP 500 o nut "Quet ngay".
            log.info("Bo ket qua quet cua domain %s: domain da bi xoa giua chung", domain_id)

    async def record_change(self, domain_id: int, change: dict) -> int:
        cur = await self.execute(
            "INSERT INTO state_changes (domain_id,from_state_json,to_state_json,window_start,window_end,"
            "confirmed_at,uncertainty_sec,change_kind,created_at) VALUES (?,?,?,?,?,?,?,?,?)",
            (
                domain_id,
                json.dumps(change.get("from_state"), ensure_ascii=False),
                json.dumps(change.get("to_state"), ensure_ascii=False),
                change["window_start"],
                change["window_end"],
                change["confirmed_at"],
                change["uncertainty_sec"],
                change["change_kind"],
                iso(utcnow()),
            ),
        )
        return int(cur.lastrowid)

    async def list_changes(self, domain_id: int | None = None, limit: int = 200) -> list[dict]:
        if domain_id:
            rows = await self.fetchall(
                "SELECT c.*, d.url, d.label FROM state_changes c JOIN domains d ON d.id=c.domain_id"
                " WHERE c.domain_id=? ORDER BY c.id DESC LIMIT ?",
                (domain_id, limit),
            )
        else:
            rows = await self.fetchall(
                "SELECT c.*, d.url, d.label FROM state_changes c JOIN domains d ON d.id=c.domain_id"
                " ORDER BY c.id DESC LIMIT ?",
                (limit,),
            )
        return [dict(r) for r in rows]

    async def log_error(self, domain_id: int, kind: str, detail: str, relay_node: str | None) -> None:
        await self.execute(
            "INSERT INTO check_errors (domain_id,at,kind,detail,relay_node) VALUES (?,?,?,?,?)",
            (domain_id, iso(utcnow()), kind, detail[:500], relay_node),
        )

    async def list_errors(self, domain_id: int, limit: int = 100) -> list[dict]:
        rows = await self.fetchall(
            "SELECT * FROM check_errors WHERE domain_id=? ORDER BY id DESC LIMIT ?", (domain_id, limit)
        )
        return [dict(r) for r in rows]

    async def bump_hourly(
        self, domain_id: int, *, ok: bool, redirect: bool, blocked: bool, ms: int
    ) -> None:
        hour = utcnow().replace(minute=0, second=0, microsecond=0).isoformat(timespec="seconds")
        await self.execute(
            "INSERT INTO hourly_stats (domain_id,hour_utc,checks,ok_count,err_count,redirect_count,"
            "blocked_count,total_ms) VALUES (?,?,1,?,?,?,?,?)"
            " ON CONFLICT(domain_id,hour_utc) DO UPDATE SET"
            " checks=checks+1, ok_count=ok_count+excluded.ok_count, err_count=err_count+excluded.err_count,"
            " redirect_count=redirect_count+excluded.redirect_count,"
            " blocked_count=blocked_count+excluded.blocked_count, total_ms=total_ms+excluded.total_ms",
            (domain_id, hour, 1 if ok else 0, 0 if ok else 1, 1 if redirect else 0, 1 if blocked else 0, ms),
        )

    async def hourly_series(self, domain_id: int, hours: int = 168) -> list[dict]:
        since = (utcnow() - timedelta(hours=hours)).replace(minute=0, second=0, microsecond=0)
        rows = await self.fetchall(
            "SELECT * FROM hourly_stats WHERE domain_id=? AND hour_utc>=? ORDER BY hour_utc",
            (domain_id, since.isoformat(timespec="seconds")),
        )
        return [dict(r) for r in rows]

    async def hourly_all(self, hours: int = 72) -> dict[int, list[dict]]:
        """Chuoi theo gio cho TAT CA domain trong mot truy van.

        Bang danh sach can ve sparkline cho tung dong; goi hourly_series() 17 lan
        la 17 vong tuan tu qua sqlite. Mot truy van roi gom trong Python re hon nhieu.
        Chi tra ve cot ma bieu do can — khong keo total_ms/ok_count cho nhe duong truyen.
        """
        since = (utcnow() - timedelta(hours=hours)).replace(minute=0, second=0, microsecond=0)
        rows = await self.fetchall(
            "SELECT domain_id,hour_utc,checks,err_count,redirect_count,blocked_count "
            "FROM hourly_stats WHERE hour_utc>=? ORDER BY domain_id, hour_utc",
            (since.isoformat(timespec="seconds"),),
        )
        out: dict[int, list[dict]] = {}
        for r in rows:
            out.setdefault(r["domain_id"], []).append(dict(r))
        return out

    async def save_vantage(self, domain_id: int, vantage: str, data: dict) -> None:
        cols = ["state_key", "status_code", "redirect_type", "target_url", "final_url",
                "final_status", "block_kind", "error_kind", "error_detail", "latency_ms", "checked_at"]
        vals = [data.get(c) for c in cols]
        await self.execute(
            f"INSERT INTO vantage_state (domain_id, vantage, {','.join(cols)}) "
            f"VALUES (?,?,{','.join('?' * len(cols))}) "
            f"ON CONFLICT(domain_id, vantage) DO UPDATE SET "
            + ",".join(f"{c}=excluded.{c}" for c in cols),
            [domain_id, vantage, *vals],
        )

    async def get_vantages(self, domain_id: int) -> list[dict]:
        rows = await self.fetchall(
            "SELECT * FROM vantage_state WHERE domain_id=? ORDER BY vantage", (domain_id,)
        )
        return [dict(r) for r in rows]

    async def all_vantages(self) -> dict[int, list[dict]]:
        rows = await self.fetchall("SELECT * FROM vantage_state ORDER BY domain_id, vantage")
        out: dict[int, list[dict]] = {}
        for r in rows:
            out.setdefault(r["domain_id"], []).append(dict(r))
        return out

    async def save_relay_health(self, node: str, data: dict) -> None:
        await self.execute(
            "INSERT INTO relay_health (node,url,ok,egress_ip,country,last_ok_at,last_error,checked_at)"
            " VALUES (?,?,?,?,?,?,?,?)"
            " ON CONFLICT(node) DO UPDATE SET url=excluded.url, ok=excluded.ok,"
            " egress_ip=COALESCE(excluded.egress_ip,relay_health.egress_ip),"
            " country=COALESCE(excluded.country,relay_health.country),"
            " last_ok_at=COALESCE(excluded.last_ok_at,relay_health.last_ok_at),"
            " last_error=excluded.last_error, checked_at=excluded.checked_at",
            (
                node, data.get("url"), 1 if data.get("ok") else 0, data.get("egress_ip"),
                data.get("country"), data.get("last_ok_at"), data.get("last_error"),
                iso(utcnow()),
            ),
        )

    async def relay_health(self) -> list[dict]:
        rows = await self.fetchall("SELECT * FROM relay_health ORDER BY node")
        return [dict(r) for r in rows]

    async def checkpoint(self) -> None:
        """Ep gop WAL vao file chinh va cat ngan no lai."""
        try:
            await self.conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
            await self.conn.commit()
        except Exception:  # noqa: BLE001
            pass

    async def purge_old(self, retention_days: int) -> None:
        cutoff = iso(utcnow() - timedelta(days=retention_days))
        await self.execute("DELETE FROM check_errors WHERE at < ?", (cutoff,))
        await self.execute(
            "DELETE FROM hourly_stats WHERE hour_utc < ?",
            ((utcnow() - timedelta(days=retention_days)).isoformat(timespec="seconds"),),
        )
