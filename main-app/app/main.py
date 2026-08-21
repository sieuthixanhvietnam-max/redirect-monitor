"""FastAPI app: API + dashboard."""
from __future__ import annotations

import csv
import io
import json
import logging
import secrets
from contextlib import asynccontextmanager
from datetime import datetime, timedelta
from pathlib import Path

from fastapi import Depends, FastAPI, HTTPException, Query, Request, Response
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, JSONResponse, PlainTextResponse
from fastapi.security import HTTPBasic, HTTPBasicCredentials
from pydantic import BaseModel, Field

from .checker import normalize_input_url, summarize_vantages
from .config import VN_TZ, settings
from .db import Database, iso, parse_iso, utcnow
from .relay import RelayPool
from .scheduler import Monitor

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s [%(name)s] %(message)s",
)
log = logging.getLogger("app")

STATIC_DIR = Path(__file__).parent / "static"
# Giao dien React/MUI do vite build ra. Neu chua build thi tu dong quay ve
# giao dien cu trong static/ — de he thong khong bao gio chet vi thieu buoc build.
WEBUI_DIR = Path(__file__).parent / "webui"

db = Database(settings.db_path)
pool = RelayPool()
monitor = Monitor(db, pool)


@asynccontextmanager
async def lifespan(app: FastAPI):
    await db.connect()
    await pool.start()
    if not pool.has_nodes:
        log.warning(
            "CHUA cau hinh relay VN (RELAY_URL/RELAY_API_KEY hoac RELAY_NODES). "
            "He thong se quet truc tiep tu server nay - IP KHONG phai Viet Nam."
        )
    await monitor.start()
    yield
    await monitor.stop()
    await pool.close()
    await db.close()


app = FastAPI(title="Redirect Monitor", version="1.0.0", lifespan=lifespan)

# ---------------- auth ----------------
security = HTTPBasic(auto_error=False)


def require_auth(credentials: HTTPBasicCredentials | None = Depends(security)):
    if not settings.dashboard_password:
        return True  # chua dat mat khau -> mo (chi nen dung khi test local)
    if credentials is None:
        raise HTTPException(401, "Can dang nhap", headers={"WWW-Authenticate": "Basic"})
    ok_u = secrets.compare_digest(credentials.username, settings.dashboard_user)
    ok_p = secrets.compare_digest(credentials.password, settings.dashboard_password)
    if not (ok_u and ok_p):
        raise HTTPException(401, "Sai tai khoan", headers={"WWW-Authenticate": "Basic"})
    return True


# ---------------- models ----------------
class DomainIn(BaseModel):
    url: str
    label: str = ""
    interval_sec: int = Field(default=0, ge=0, le=86400)
    mode: str = "auto"
    notes: str = ""


class DomainPatch(BaseModel):
    label: str | None = None
    interval_sec: int | None = Field(default=None, ge=5, le=86400)
    mode: str | None = None
    enabled: bool | None = None
    notes: str | None = None


class BulkIn(BaseModel):
    text: str
    interval_sec: int = 0
    mode: str = "auto"


# ---------------- helpers ----------------
def to_vn(ts: str | None) -> str | None:
    dt = parse_iso(ts)
    return dt.astimezone(VN_TZ).isoformat(timespec="seconds") if dt else None


def decorate(d: dict) -> dict:
    d = dict(d)
    for k in ("state_since", "last_confirmed_at", "last_error_at", "state_updated_at", "updated_at", "next_check_at"):
        if k in d:
            d[k + "_vn"] = to_vn(d.get(k))
    for k in ("chain_json", "ips_json"):
        if d.get(k):
            try:
                d[k.replace("_json", "")] = json.loads(d[k])
            except (json.JSONDecodeError, TypeError):
                d[k.replace("_json", "")] = []
            d.pop(k, None)
        else:
            d[k.replace("_json", "")] = []
            d.pop(k, None)
    return d


def decorate_change(c: dict) -> dict:
    c = dict(c)
    for k in ("window_start", "window_end", "confirmed_at", "created_at"):
        c[k + "_vn"] = to_vn(c.get(k))
    for k in ("from_state_json", "to_state_json"):
        try:
            c[k.replace("_json", "")] = json.loads(c.get(k) or "null")
        except (json.JSONDecodeError, TypeError):
            c[k.replace("_json", "")] = None
        c.pop(k, None)
    return c


if (WEBUI_DIR / "assets").is_dir():
    app.mount("/assets", StaticFiles(directory=WEBUI_DIR / "assets"), name="assets")


# ---------------- routes ----------------
@app.get("/", include_in_schema=False)
async def index(_: bool = Depends(require_auth)):
    ui = WEBUI_DIR / "index.html"
    return FileResponse(ui if ui.exists() else STATIC_DIR / "index.html")


@app.get("/legacy", include_in_schema=False)
async def index_legacy(_: bool = Depends(require_auth)):
    """Giao dien cu (HTML thuan). Giu lai de con duong lui khi UI moi co van de."""
    return FileResponse(STATIC_DIR / "index.html")


@app.get("/api/health")
async def health():
    return {
        "ok": True,
        "now_vn": datetime.now(VN_TZ).isoformat(timespec="seconds"),
        "stats": monitor.stats,
        "relays_configured": len(pool.runtimes),
        "direct_fallback": settings.allow_direct_fallback,
    }


@app.get("/api/relays")
async def relays(_: bool = Depends(require_auth)):
    stored = await db.relay_health()
    return {"configured": [r.node.name for r in pool.runtimes], "health": stored}


@app.post("/api/relays/check")
async def relays_check(_: bool = Depends(require_auth)):
    infos = await pool.health_check()
    for i in infos:
        await db.save_relay_health(i["name"], i)
    return {"health": infos}


@app.get("/api/domains")
async def list_domains(_: bool = Depends(require_auth)):
    rows = await db.list_domains()
    vmap = await db.all_vantages() if settings.vantages else {}
    out = []
    for r in rows:
        item = decorate(r)
        if vmap:
            item["vantage_summary"] = summarize_vantages(vmap.get(r["id"], []))
        out.append(item)
    return {"domains": out, "vantages": settings.vantages,
            "server_time_vn": datetime.now(VN_TZ).isoformat(timespec="seconds")}


@app.get("/api/sparklines")
async def sparklines(hours: int = 72, _: bool = Depends(require_auth)):
    """Chuoi theo gio cua moi domain, de ve dai hoat dong tren tung dong bang.

    Tach khoi /api/domains co chu y: bang tu lam moi vai giay, con du lieu theo gio
    chi doi moi khi sang gio moi. Nhet chung vao mot endpoint la bat nhip poll nhanh
    phai cong them hang nghin dong moi lan.
    """
    hours = max(1, min(hours, 168))
    return {"hours": hours, "series": await db.hourly_all(hours)}


@app.post("/api/domains")
async def add_domain(body: DomainIn, _: bool = Depends(require_auth)):
    try:
        url = normalize_input_url(body.url)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    exists = await db.fetchone("SELECT id FROM domains WHERE url=?", (url,))
    if exists:
        raise HTTPException(409, "Domain nay da co trong danh sach")
    interval = body.interval_sec or settings.default_interval_sec
    interval = max(settings.min_interval_sec, interval)
    did = await db.add_domain(url, body.label, interval, body.mode, body.notes)
    return {"id": did, "url": url}


@app.post("/api/domains/bulk")
async def add_bulk(body: BulkIn, _: bool = Depends(require_auth)):
    added, skipped, errors = [], [], []
    for raw_line in body.text.splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        parts = [p.strip() for p in line.split(",", 1)]
        raw_url, label = parts[0], (parts[1] if len(parts) > 1 else "")
        try:
            url = normalize_input_url(raw_url)
        except ValueError as e:
            errors.append({"line": line, "error": str(e)})
            continue
        if await db.fetchone("SELECT id FROM domains WHERE url=?", (url,)):
            skipped.append(url)
            continue
        interval = max(settings.min_interval_sec, body.interval_sec or settings.default_interval_sec)
        did = await db.add_domain(url, label, interval, body.mode)
        added.append({"id": did, "url": url})
    return {"added": added, "skipped": skipped, "errors": errors}


@app.patch("/api/domains/{domain_id}")
async def patch_domain(domain_id: int, body: DomainPatch, _: bool = Depends(require_auth)):
    fields = {k: v for k, v in body.model_dump(exclude_none=True).items()}
    if "enabled" in fields:
        fields["enabled"] = 1 if fields["enabled"] else 0
    if "interval_sec" in fields:
        fields["interval_sec"] = max(settings.min_interval_sec, int(fields["interval_sec"]))
    await db.update_domain(domain_id, **fields)
    return {"ok": True}


@app.delete("/api/domains/{domain_id}")
async def delete_domain(domain_id: int, _: bool = Depends(require_auth)):
    await db.delete_domain(domain_id)
    return {"ok": True}


@app.post("/api/domains/{domain_id}/check")
async def check_domain_now(domain_id: int, _: bool = Depends(require_auth)):
    try:
        return await monitor.check_now(domain_id)
    except ValueError as e:
        raise HTTPException(404, str(e)) from e


@app.get("/api/domains/{domain_id}")
async def domain_detail(domain_id: int, _: bool = Depends(require_auth)):
    d = await db.get_domain(domain_id)
    if not d:
        raise HTTPException(404, "Khong tim thay")
    changes = await db.list_changes(domain_id, limit=100)
    errors = await db.list_errors(domain_id, limit=50)
    series = await db.hourly_series(domain_id, hours=168)
    vrows = await db.get_vantages(domain_id)
    return {
        "domain": decorate(d),
        "changes": [decorate_change(c) for c in changes],
        "errors": [{**e, "at_vn": to_vn(e["at"])} for e in errors],
        "hourly": series,
        "vantages": [{**v, "checked_at_vn": to_vn(v["checked_at"])} for v in vrows],
        "vantage_summary": summarize_vantages(vrows),
        "primary_vantage": settings.primary_vantage,
    }


@app.get("/api/vantages")
async def vantages(_: bool = Depends(require_auth)):
    """Danh sach diem quan sat + IP thoat that su cua tung diem."""
    out = []
    for v in settings.vantages:
        info = {"name": v, "primary": v == settings.primary_vantage, "ip": None,
                "country": None, "isp": None, "error": None}
        for rt in pool.runtimes:
            try:
                r = await pool._client.get(
                    f"{rt.node.url}/egress-ip", params={"via": v},
                    headers={"x-api-key": rt.node.api_key}, timeout=15,
                )
                j = r.json()
                info.update({"ip": j.get("ip"), "country": j.get("country"),
                             "isp": j.get("isp"), "error": j.get("error")})
                break
            except Exception as e:  # noqa: BLE001
                info["error"] = f"{type(e).__name__}: {e}"[:200]
        out.append(info)
    return {"vantages": out, "compare_sec": settings.vantage_compare_sec}


@app.get("/api/changes")
async def all_changes(limit: int = Query(200, le=1000), _: bool = Depends(require_auth)):
    rows = await db.list_changes(None, limit=limit)
    return {"changes": [decorate_change(c) for c in rows]}


@app.get("/api/export/changes.csv")
async def export_changes(_: bool = Depends(require_auth)):
    rows = await db.list_changes(None, limit=10000)
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow([
        "domain", "label", "loai_thay_doi", "truoc_status", "truoc_dich",
        "sau_status", "sau_dich", "tu_luc_VN", "den_luc_VN", "do_bat_dinh_giay", "xac_nhan_luc_VN",
    ])
    for r in rows:
        c = decorate_change(r)
        f, t = c.get("from_state") or {}, c.get("to_state") or {}
        w.writerow([
            c["url"], c.get("label", ""), c["change_kind"],
            f.get("status_code", ""), f.get("target_url", ""),
            t.get("status_code", ""), t.get("target_url", ""),
            c["window_start_vn"], c["window_end_vn"], c["uncertainty_sec"], c["confirmed_at_vn"],
        ])
    return Response(
        buf.getvalue().encode("utf-8-sig"),
        media_type="text/csv",
        headers={"Content-Disposition": 'attachment; filename="redirect-changes.csv"'},
    )


@app.get("/api/config")
async def get_config(_: bool = Depends(require_auth)):
    return {
        "default_interval_sec": settings.default_interval_sec,
        "min_interval_sec": settings.min_interval_sec,
        "confirm_threshold": settings.confirm_threshold,
        "max_concurrency": settings.max_concurrency,
        "allow_direct_fallback": settings.allow_direct_fallback,
        "relays": [{"name": r.node.name, "url": r.node.url} for r in pool.runtimes],
        "timezone": "Asia/Ho_Chi_Minh",
    }
