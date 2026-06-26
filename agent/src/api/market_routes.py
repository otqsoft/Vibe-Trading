"""Market Analysis API routes — TradingView Datafeed compatible.

These endpoints replicate the Flask routes from the market-analysis project's
``cl_app/__init__.py`` so the TradingView Charting Library can fetch market
data directly from the Vibe-Trading FastAPI server.

The ``chanlun`` package from the market-analysis project must be importable
(via sys.path or editable install).
"""

from __future__ import annotations

import datetime
import json
import logging
import os
import sys
import time
import traceback
from pathlib import Path
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Form, Query, Request
from fastapi.responses import JSONResponse

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/tv", tags=["market-analysis"])

# ---------------------------------------------------------------------------
# Ensure chanlun is importable
# ---------------------------------------------------------------------------
# chanlun lives at agent/src/chanlun/ and its internal imports use
# ``from chanlun.xxx``, so we need the *parent* of chanlun on sys.path.
# In Docker: /app/agent/src/chanlun  → add /app/agent/src
# Local dev: agent/src/chanlun      → add agent/src (relative to cwd)
# ---------------------------------------------------------------------------

def _setup_chanlun_path():
    # 1. Explicit env var pointing to market-analysis project root
    ma_src = os.getenv("MARKET_ANALYSIS_SRC", "")
    if ma_src:
        candidate = str(Path(ma_src) / "src")
        if os.path.isdir(candidate):
            sys.path.insert(0, candidate)
            return

    # 2. chanlun already importable (e.g. pip install -e)
    try:
        import chanlun  # noqa: F401
        return
    except ImportError:
        pass

    # 3. Local copy at agent/src/chanlun — add agent/src to sys.path
    #    Try both absolute Docker path and relative path from cwd
    for base in ["/app/agent/src", str(Path.cwd() / "agent" / "src")]:
        if os.path.isdir(base) and base not in sys.path:
            sys.path.insert(0, base)
            return

    # 4. Windows dev fallback
    win_path = r"D:\work\trunk\git\market-analysis\src"
    if os.path.isdir(win_path) and win_path not in sys.path:
        sys.path.insert(0, win_path)

_setup_chanlun_path()

# ---------------------------------------------------------------------------
# Lazy imports — chanlun may not be installed in all environments
# ---------------------------------------------------------------------------
_frequency_maps: Dict[str, str] = {
    "10s": "10S", "30s": "30S",
    "1m": "1", "2m": "2", "3m": "3", "5m": "5", "10m": "10",
    "15m": "15", "30m": "30", "60m": "60", "120m": "120",
    "3h": "180", "4h": "240",
    "d": "1D", "2d": "2D", "w": "1W", "m": "1M", "y": "12M",
}
_resolution_maps: Dict[str, str] = {v: k for k, v in _frequency_maps.items()}

_market_types = {
    "a": "stock", "hk": "stock", "fx": "stock", "us": "stock",
    "futures": "futures", "ny_futures": "futures",
    "currency": "crypto", "currency_spot": "crypto",
}

_market_session = {k: "24x7" for k in _market_types}

_market_timezone = {
    "a": "Asia/Shanghai", "hk": "Asia/Shanghai", "fx": "Asia/Shanghai",
    "us": "America/New_York", "futures": "Asia/Shanghai",
    "ny_futures": "Asia/Shanghai",
    "currency": "Asia/Shanghai", "currency_spot": "Asia/Shanghai",
}

# Cache for market metadata (populated lazily)
_market_frequencys: Dict[str, List[str]] = {}
_market_default_codes: Dict[str, str] = {}
_chanlun_available = False


def _ensure_chanlun():
    """Try importing chanlun; return True if available."""
    global _chanlun_available
    if _chanlun_available:
        return True
    try:
        from chanlun.base import Market  # noqa: F401
        from chanlun.exchange import get_exchange  # noqa: F401
        _chanlun_available = True
        return True
    except ImportError:
        logger.warning("chanlun package not importable — market analysis data will be unavailable")
        return False


def _init_market_metadata():
    """Lazily populate market frequency and default code maps."""
    if _market_frequencys:
        return
    if not _ensure_chanlun():
        return
    try:
        from chanlun.base import Market
        from chanlun.exchange import get_exchange

        for market_val, market_enum in [
            ("a", Market.A), ("hk", Market.HK), ("fx", Market.FX),
            ("us", Market.US), ("futures", Market.FUTURES),
            ("ny_futures", Market.NY_FUTURES),
            ("currency", Market.CURRENCY), ("currency_spot", Market.CURRENCY_SPOT),
        ]:
            try:
                ex = get_exchange(market_enum)
                _market_frequencys[market_val] = list(ex.support_frequencys().keys())
                _market_default_codes[market_val] = ex.default_code()
            except Exception:
                _market_frequencys[market_val] = ["d"]
                _market_default_codes[market_val] = ""
    except Exception:
        logger.warning("Failed to init market metadata")


# Rate-limit counter for history requests
_history_req_counter: Dict[str, Dict[str, Any]] = {}


# ---------------------------------------------------------------------------
# TV Datafeed API endpoints
# ---------------------------------------------------------------------------

@router.get("/config")
def tv_config():
    """TradingView datafeed configuration."""
    _init_market_metadata()
    frequencys: set[str] = set()
    for freqs in _market_frequencys.values():
        frequencys.update(freqs)
    supported_resolutions = [v for k, v in _frequency_maps.items() if k in frequencys]
    if not supported_resolutions:
        supported_resolutions = ["1", "5", "15", "30", "60", "1D", "1W", "1M"]
    return {
        "supports_search": True,
        "supports_group_request": False,
        "supported_resolutions": supported_resolutions,
        "supports_marks": True,
        "supports_timescale_marks": True,
        "supports_time": False,
        "exchanges": [
            {"value": "a", "name": "沪深", "desc": "沪深A股"},
            {"value": "hk", "name": "港股", "desc": "港股"},
            {"value": "fx", "name": "外汇", "desc": "外汇"},
            {"value": "us", "name": "美股", "desc": "美股"},
            {"value": "futures", "name": "国内期货", "desc": "国内期货"},
            {"value": "ny_futures", "name": "纽约期货", "desc": "纽约期货"},
            {"value": "currency", "name": "数字货币(Futures)", "desc": "数字货币（合约）"},
            {"value": "currency_spot", "name": "数字货币(Spot)", "desc": "数字货币（现货）"},
        ],
        "default_codes": _market_default_codes,
    }


@router.get("/symbol_info")
def tv_symbol_info(group: str = Query(...)):
    """Symbol info for a group (exchange)."""
    if not _ensure_chanlun():
        return {"symbol": [], "description": []}
    from chanlun.base import Market
    from chanlun.exchange import get_exchange

    try:
        ex = get_exchange(Market(group))
        all_symbols = ex.all_stocks()
    except Exception as e:
        logger.error(f"tv_symbol_info: failed for group={group}: {e}")
        return {"symbol": [], "description": []}

    return {
        "symbol": [s["code"] for s in all_symbols],
        "description": [s["name"] for s in all_symbols],
        "exchange-listed": group,
        "exchange-traded": group,
    }


def _normalize_code(market: str, code: str) -> str:
    """Normalize a stock code to the format expected by chanlun exchanges.

    TDX-based exchanges use ``SH.000001`` style codes.  If the incoming
    *code* is a plain 6-digit number (e.g. ``000001``), prepend the market
    prefix based on the first digit convention used in A-share / HK markets.
    """
    if not code:
        return code
    # Already prefixed (e.g. SH.000001, SZ.000001, BJ.000001, KH.00700)
    if "." in code:
        return code
    # A-share: 6xx = SH, 0xx/3xx = SZ, 4xx/8xx = BJ
    if market == "a":
        if code.startswith("6"):
            return f"SH.{code}"
        elif code.startswith(("0", "3")):
            return f"SZ.{code}"
        elif code.startswith(("4", "8")):
            return f"BJ.{code}"
    # HK
    elif market == "hk":
        return f"KH.{code}"
    return code


@router.get("/symbols")
def tv_symbols(symbol: str = Query(...)):
    """Resolve a single symbol."""
    if not _ensure_chanlun():
        return JSONResponse({"error": "chanlun not available"}, status_code=503)
    from chanlun.base import Market
    from chanlun.exchange import get_exchange

    parts = symbol.split(":")
    market = parts[0].lower()
    code = parts[1] if len(parts) > 1 else ""
    code = _normalize_code(market, code)

    ex = None
    try:
        _init_market_metadata()
        ex = get_exchange(Market(market))
        stocks = ex.stock_info(code)
    except Exception as e:
        err_msg = str(e)
        logger.error(f"tv_symbols: failed for symbol={symbol} code={code}: {err_msg}")
        traceback.print_exc()
        # TDX "calling function error" means connection to TDX server failed
        if "calling function" in err_msg.lower() or "function call" in err_msg.lower():
            return JSONResponse(
                {"error": "TDX server connection failed, please retry later"},
                status_code=503,
            )
        return JSONResponse({"error": err_msg}, status_code=500)

    # If still not found, try fuzzy match against all_stocks
    if stocks is None and ex is not None:
        try:
            all_stocks = ex.all_stocks()
            matches = [s for s in all_stocks if s["code"].endswith(code)]
            if matches:
                stocks = matches[0]
                code = stocks["code"]
        except Exception as e2:
            logger.warning(f"tv_symbols: fuzzy match failed: {e2}")

    if stocks is None:
        return JSONResponse({"error": f"symbol {symbol} not found"}, status_code=404)

    sector = ""
    industry = ""
    if market == "a":
        try:
            gnbk = ex.stock_owner_plate(code)
            sector = " / ".join([_g["name"] for _g in gnbk.get("GN", [])])
            industry = " / ".join([_h["name"] for _h in gnbk.get("HY", [])])
        except Exception:
            pass

    return {
        "name": stocks["code"],
        "ticker": f"{market}:{stocks['code']}",
        "full_name": f"{market}:{stocks['code']}",
        "description": stocks["name"],
        "exchange": market,
        "type": _market_types.get(market, "stock"),
        "session": _market_session.get(market, "24x7"),
        "timezone": _market_timezone.get(market, "Asia/Shanghai"),
        "pricescale": stocks.get("precision", 1000),
        "visible_plots_set": "ohlcv",
        "supported_resolutions": [
            v for k, v in _frequency_maps.items()
            if k in _market_frequencys.get(market, ["d"])
        ],
        "intraday_multipliers": ["1", "2", "3", "5", "10", "15", "20", "30", "60", "120", "240"],
        "seconds_multipliers": ["1", "2", "3", "5", "10", "15", "20", "30", "40", "50", "60"],
        "daily_multipliers": ["1", "2"],
        "minmov": 1,
        "minmov2": 0,
        "has_intraday": True,
        "has_seconds": market in ["futures", "ny_futures"],
        "has_daily": True,
        "has_weekly_and_monthly": True,
        "sector": sector,
        "industry": industry,
    }


@router.get("/search")
def tv_search(
    query: str = Query(...),
    type: str = Query(""),
    exchange: str = Query("a"),
    limit: int = Query(30),
):
    """Symbol search."""
    if not _ensure_chanlun():
        return []
    from chanlun.base import Market
    from chanlun.exchange import get_exchange

    try:
        _init_market_metadata()
        ex = get_exchange(Market(exchange))
        all_stocks = ex.all_stocks()
    except Exception as e:
        logger.error(f"tv_search: failed to get stocks for exchange={exchange}: {e}")
        traceback.print_exc()
        return []

    if exchange in ["currency", "currency_spot"]:
        res_stocks = [s for s in all_stocks if query.lower() in s["code"].lower()]
    else:
        # Pinyin initial matching (optional — graceful fallback)
        def _pinyin_initials(name: str) -> str:
            try:
                import pinyin as _pinyin
                return "".join([_pinyin.get_initial(p)[0] for p in name]).lower()
            except Exception:
                return ""

        res_stocks = [
            s for s in all_stocks
            if query.lower() in s["code"].lower()
            or query.lower() in s["name"].lower()
            or query.lower() in _pinyin_initials(s["name"])
        ]
    res_stocks = res_stocks[:limit]

    return [
        {
            "symbol": s["code"],
            "name": s["code"],
            "full_name": f"{exchange}:{s['code']}",
            "description": s["name"],
            "exchange": exchange,
            "ticker": f"{exchange}:{s['code']}",
            "type": type,
            "session": _market_session.get(exchange, "24x7"),
            "timezone": _market_timezone.get(exchange, "Asia/Shanghai"),
            "supported_resolutions": [
                v for k, v in _frequency_maps.items()
                if k in _market_frequencys.get(exchange, ["d"])
            ],
        }
        for s in res_stocks
    ]


@router.get("/history")
def tv_history(
    symbol: str = Query(...),
    from_: int = Query(..., alias="from"),
    to: int = Query(..., alias="to"),
    resolution: str = Query(...),
    firstDataRequest: str = Query("false"),
):
    """K-line history data."""
    if not _ensure_chanlun():
        return {"s": "error", "errmsg": "chanlun not available"}

    from chanlun import fun
    from chanlun.base import Market
    from chanlun.exchange import get_exchange

    key = f"{symbol}_{resolution}"
    now_time = time.time()

    s = "ok"
    if from_ < 0 and to < 0:
        s = "no_data"

    # Rate limiting for non-first requests
    if firstDataRequest == "false":
        if key not in _history_req_counter:
            _history_req_counter[key] = {"counter": 0, "tm": now_time}
        else:
            cnt = _history_req_counter[key]
            if cnt["counter"] >= 5:
                _history_req_counter[key] = {"counter": 0, "tm": now_time}
                s = "no_data"
            elif now_time - cnt["tm"] <= 5:
                cnt["counter"] += 1
                cnt["tm"] = now_time
            else:
                _history_req_counter[key] = {"counter": 0, "tm": now_time}

    market = symbol.split(":")[0].lower()
    code = symbol.split(":")[1] if ":" in symbol else ""
    code = _normalize_code(market, code)

    try:
        ex = get_exchange(Market(market))

        # Check if market is currently trading
        if firstDataRequest == "false" and not ex.now_trading():
            return {"s": "no_data", "nextTime": int(now_time + 600)}

        frequency = _resolution_maps.get(resolution, "d")
        klines = ex.klines(code, frequency)

        if klines is None or len(klines) == 0:
            return {"s": "no_data"}

        # If requested time range is before available data
        if int(to) < fun.datetime_to_int(klines.iloc[0]["date"]):
            return {"s": "no_data"}

        t_list, c_list, o_list, h_list, l_list, v_list = [], [], [], [], [], []
        for _, k in klines.iterrows():
            t_list.append(fun.datetime_to_int(k["date"]))
            c_list.append(float(k["close"]))
            o_list.append(float(k["open"]))
            h_list.append(float(k["high"]))
            l_list.append(float(k["low"]))
            v_list.append(float(k["volume"]))

        if firstDataRequest == "false":
            _t, _c, _o, _h, _l, _v = t_list[-10:], c_list[-10:], o_list[-10:], h_list[-10:], l_list[-10:], v_list[-10:]
        else:
            _t, _c, _o, _h, _l, _v = t_list, c_list, o_list, h_list, l_list, v_list

        return {
            "s": s,
            "t": _t, "c": _c, "o": _o, "h": _h, "l": _l, "v": _v,
            "update": firstDataRequest != "true",
        }
    except Exception as e:
        logger.error(f"tv_history error: {e}")
        traceback.print_exc()
        return {"s": "error", "errmsg": str(e)}


@router.get("/time")
def tv_time():
    """Server time."""
    return int(time.time())


@router.get("/timescale_marks")
def tv_timescale_marks(
    symbol: str = Query(...),
    from_: int = Query(..., alias="from"),
    to: int = Query(..., alias="to"),
    resolution: str = Query(...),
):
    """Timescale marks (orders & custom marks)."""
    # Requires chanlun DB — return empty for now
    return []


@router.get("/marks")
def tv_marks(
    symbol: str = Query(...),
    from_: int = Query(..., alias="from"),
    to: int = Query(..., alias="to"),
    resolution: str = Query(...),
):
    """Price marks."""
    return []


@router.post("/del_marks")
def tv_del_marks(symbol: str = Form(...)):
    """Delete all marks for a symbol."""
    return {"status": "ok"}


@router.get("/{version}/charts")
def tv_charts_list(version: str, client: str = Query(...), user: str = Query(...)):
    """List saved charts."""
    return {"status": "ok", "data": []}


@router.get("/{version}/study_templates")
def tv_study_templates_list(version: str, client: str = Query(...), user: str = Query(...)):
    """List study templates."""
    return {"status": "ok", "data": []}


# ---------------------------------------------------------------------------
# Tick data (for watchlist updates)
# ---------------------------------------------------------------------------

@router.post("/../ticks")
def ticks(market: str = Form(...), codes: str = Form(...)):
    """Get tick data for watchlist."""
    if not _ensure_chanlun():
        return {"now_trading": False, "ticks": []}
    from chanlun.base import Market
    from chanlun.exchange import get_exchange

    try:
        code_list = json.loads(codes)
        ex = get_exchange(Market(market))
        stock_ticks = ex.ticks(code_list)
        now_trading = ex.now_trading()
        res_ticks = [
            {"code": c, "price": t.last, "rate": round(float(t.rate), 2)}
            for c, t in stock_ticks.items()
        ]
        return {"now_trading": now_trading, "ticks": res_ticks}
    except Exception:
        traceback.print_exc()
        return {"now_trading": False, "ticks": []}


# ---------------------------------------------------------------------------
# Registration helper
# ---------------------------------------------------------------------------

def register_market_routes(app):
    """Register all market analysis routes on the FastAPI app.

    This includes both /tv/* (datafeed) and top-level endpoints like /ticks.
    """
    app.include_router(router)
    # Also register the /ticks endpoint at root level
    from fastapi import APIRouter as _AR

    ticks_router = _AR(tags=["market-analysis"])
    # /ticks is already handled via the /tv/../ticks path above,
    # but we add a clean /ticks route as well for the frontend.
    @ticks_router.post("/ticks")
    def ticks_root(market: str = Form(...), codes: str = Form(...)):
        return ticks(market=market, codes=codes)

    app.include_router(ticks_router)
