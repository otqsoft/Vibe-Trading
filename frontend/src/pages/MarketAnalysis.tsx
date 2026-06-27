import { useEffect, useRef, useState, useCallback } from "react";
import { useTranslation } from "react-i18next";
import {
  AlertCircle,
  ExternalLink,
  RotateCw,
  Star,
  Plus,
  Trash2,
  FolderOpen,
  ChevronDown,
  X,
  LayoutGrid,
  Columns2,
  Rows2,
  Grid2x2,
  LayoutDashboard,
  List,
} from "lucide-react";

// TradingView widget type declared on window
interface TVChart {
  setSymbol: (s: string) => void;
  resetData: () => void;
  onSymbolChanged: () => { subscribe: (id: null, cb: (symbol?: unknown) => void) => void };
  onIntervalChanged: () => { subscribe: (id: null, cb: (interval: string) => void) => void };
}

interface TVWidget {
  activeChart: () => TVChart;
  headerReady: () => Promise<void>;
  onChartReady: (cb: () => void) => void;
  symbolInterval: () => { symbol: string };
  subscribe: (event: string, cb: () => void) => void;
  createButton: () => HTMLDivElement;
  resetCache: () => void;
  remove: () => void;
}

interface TVWidgetConstructor {
  widget: new (config: Record<string, unknown>) => TVWidget;
}

interface UDFDatafeedConstructor {
  UDFCompatibleDatafeed: new (url: string, refreshInterval?: number) => unknown;
}

declare global {
  interface Window {
    TradingView?: TVWidgetConstructor;
    Datafeeds?: { UDFCompatibleDatafeed: UDFDatafeedConstructor["UDFCompatibleDatafeed"] };
  }
}

const TV_SCRIPT_ID = "tv-charting-library-script";
const DF_SCRIPT_ID = "tv-datafeed-bundle-script";

const MARKETS = [
  { value: "a", label: "沪深A股" },
  { value: "hk", label: "港股" },
  { value: "futures", label: "国内期货" },
  { value: "ny_futures", label: "纽约期货" },
  { value: "fx", label: "外汇" },
  { value: "us", label: "美股" },
  { value: "currency", label: "数字货币(合约)" },
  { value: "currency_spot", label: "数字货币(现货)" },
] as const;

const DEFAULT_CODES: Record<string, string> = {
  a: "SH.000001",
  hk: "KH.00700",
  fx: "FX.USDEUR",
  us: "AAPL",
  futures: "QS.RBL8",
  ny_futures: "CO.GC00W",
  currency: "BTC/USDT",
  currency_spot: "BTC/USDT",
};

// Layout types
type ChartLayout = "single" | "vertical-2" | "horizontal-2" | "horizontal-73" | "three" | "four";
const CHART_LAYOUTS: { value: ChartLayout; labelKey: string; icon: typeof LayoutGrid; count: number }[] = [
  { value: "single", labelKey: "marketAnalysis.layoutSingle", icon: LayoutGrid, count: 1 },
  { value: "horizontal-2", labelKey: "marketAnalysis.layoutH2", icon: Rows2, count: 2 },
  { value: "vertical-2", labelKey: "marketAnalysis.layoutV2", icon: Columns2, count: 2 },
  { value: "horizontal-73", labelKey: "marketAnalysis.layoutH73", icon: LayoutDashboard, count: 2 },
  { value: "three", labelKey: "marketAnalysis.layoutThree", icon: LayoutDashboard, count: 3 },
  { value: "four", labelKey: "marketAnalysis.layoutFour", icon: Grid2x2, count: 4 },
];

// Watchlist storage helpers
const WL_STORAGE_KEY = "tv_watchlists";

interface WatchlistGroup {
  name: string;
  codes: string[];
}

function loadWatchlists(): WatchlistGroup[] {
  try {
    const raw = localStorage.getItem(WL_STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch { /* ignore */ }
  return [{ name: "默认自选", codes: ["a:SH.000001", "a:SZ.000002", "hk:KH.00700"] }];
}

function saveWatchlists(groups: WatchlistGroup[]): void {
  localStorage.setItem(WL_STORAGE_KEY, JSON.stringify(groups));
}

function loadScript(id: string, src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (document.getElementById(id)) {
      resolve();
      return;
    }
    const script = document.createElement("script");
    script.id = id;
    script.src = src;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error(`Failed to load ${src}`));
    document.head.appendChild(script);
  });
}

function getLocalData(key: string, fallback: string): string {
  try {
    const stored = localStorage.getItem("tv_chart");
    if (stored) {
      const data = JSON.parse(stored);
      if (data[key] !== undefined) return data[key];
    }
  } catch { /* ignore */ }
  return fallback;
}

function setLocalData(key: string, val: string): void {
  try {
    let data: Record<string, string> = {};
    const stored = localStorage.getItem("tv_chart");
    if (stored) data = JSON.parse(stored);
    data[key] = val;
    localStorage.setItem("tv_chart", JSON.stringify(data));
  } catch { /* ignore */ }
}

// Create a single TV widget for a given container and chart ID
function createTVWidget(
  container: HTMLDivElement,
  chartId: string,
  market: string,
  code: string,
  theme: string,
): TVWidget {
  const interval = getLocalData(`${market}_interval_${chartId}`, "1D");
  const datafeed = new window.Datafeeds!.UDFCompatibleDatafeed("/tv", 30000);

  const widget = new window.TradingView!.widget({
    debug: false,
    autosize: true,
    fullscreen: false,
    container,
    symbol: `${market}:${code}`,
    interval,
    datafeed,
    library_path: "/charting_library/",
    theme,
    numeric_formatting: { decimal_sign: "." },
    time_frames: [],
    timezone: "Asia/Shanghai",
    locale: "zh",
    symbol_search_request_delay: 100,
    auto_save_delay: 5,
    study_count_limit: 100,
    disabled_features: ["go_to_date", "header_chart_preview"],
    enabled_features: ["study_templates", "seconds_resolution"],
    saved_data_meta_info: { uid: 1, name: "default", description: "default" },
    charts_storage_url: "/tv",
    charts_storage_api_version: "1.1",
    client_id: `market_pro_${market}_${chartId}`,
    user_id: "999",
    load_last_chart: true,
  });

  return widget;
}

export function MarketAnalysis() {
  const { t } = useTranslation();
  // Multiple chart container refs
  const containerRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const widgetRefs = useRef<Map<string, TVWidget>>(new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [currentMarket, setCurrentMarket] = useState(() => getLocalData("market", "a"));
  const [currentCode, setCurrentCode] = useState(() =>
    getLocalData(`${getLocalData("market", "a")}_code`, DEFAULT_CODES[getLocalData("market", "a")] || "SH.000001")
  );
  const [scriptsReady, setScriptsReady] = useState(false);
  const serverDefaults = useRef<Record<string, string>>({});

  // Layout state
  const [chartLayout, setChartLayout] = useState<ChartLayout>(
    () => (localStorage.getItem("tv_chart_layout") as ChartLayout) || "single"
  );
  const [showLayoutDropdown, setShowLayoutDropdown] = useState(false);
  const layoutButtonRef = useRef<HTMLDivElement>(null);

  // Watchlist state
  const [watchlists, setWatchlists] = useState<WatchlistGroup[]>(loadWatchlists);
  const [activeGroupIdx, setActiveGroupIdx] = useState(0);
  const [showWatchlist, setShowWatchlist] = useState(false);
  const [showGroupDropdown, setShowGroupDropdown] = useState(false);
  const [newGroupName, setNewGroupName] = useState("");
  const [showNewGroup, setShowNewGroup] = useState(false);
  const groupButtonRef = useRef<HTMLDivElement>(null);
  const watchlistRef = useRef<HTMLDivElement>(null);

  // Close dropdowns on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (groupButtonRef.current && !groupButtonRef.current.contains(e.target as Node)) {
        setShowGroupDropdown(false);
        setShowNewGroup(false);
      }
      if (watchlistRef.current && !watchlistRef.current.contains(e.target as Node)) {
        setShowWatchlist(false);
      }
      if (layoutButtonRef.current && !layoutButtonRef.current.contains(e.target as Node)) {
        setShowLayoutDropdown(false);
      }
    };
    document.addEventListener("pointerdown", handler);
    return () => document.removeEventListener("pointerdown", handler);
  }, []);

  // Fetch server-side default codes from /tv/config
  useEffect(() => {
    fetch("/tv/config")
      .then((r) => r.json())
      .then((data) => {
        if (data.default_codes) {
          serverDefaults.current = data.default_codes;
          for (const [k, v] of Object.entries(data.default_codes)) {
            if (v && !(k in (JSON.parse(localStorage.getItem("tv_chart") || "{}") as Record<string, string>))) {
              DEFAULT_CODES[k] = v as string;
            }
          }
        }
      })
      .catch(() => {});
  }, []);

  // Load TradingView scripts once
  useEffect(() => {
    let cancelled = false;
    Promise.all([
      loadScript(TV_SCRIPT_ID, "/charting_library/charting_library.standalone.js"),
      loadScript(DF_SCRIPT_ID, "/datafeeds/udf/dist/bundle.js"),
    ])
      .then(() => { if (!cancelled) setScriptsReady(true); })
      .catch((err) => { if (!cancelled) setError(err.message); });
    return () => { cancelled = true; };
  }, []);

  // Get chart count for current layout
  const getChartCount = useCallback((layout: ChartLayout) => {
    return CHART_LAYOUTS.find((l) => l.value === layout)?.count || 1;
  }, []);

  // Get the symbol for a specific chart pane
  const getPaneSymbol = useCallback((paneId: string): { market: string; code: string } => {
    const market = getLocalData("market", "a");
    // Chart 1 uses the primary symbol, others may have their own saved symbols
    if (paneId === "1") {
      const code = getLocalData(`${market}_code`, DEFAULT_CODES[market] || "SH.000001");
      return { market, code };
    }
    // For additional panes, check saved symbol or use default from watchlist
    const savedCode = getLocalData(`${market}_code_${paneId}`, "");
    if (savedCode) return { market, code: savedCode };
    // Fallback: use next symbols from default codes or watchlist
    const wl = loadWatchlists();
    const activeGroup = wl[0];
    const idx = parseInt(paneId) - 1;
    if (activeGroup && idx < activeGroup.codes.length) {
      const [m, c] = activeGroup.codes[idx].split(":");
      if (m && c) return { market: m, code: c };
    }
    return { market, code: DEFAULT_CODES[market] || "SH.000001" };
  }, []);

  // Initialize all widgets for the current layout
  const initWidgets = useCallback(() => {
    if (!scriptsReady || !window.TradingView || !window.Datafeeds) return;

    // Remove all existing widgets
    widgetRefs.current.forEach((w) => { try { w.remove(); } catch { /* ignore */ } });
    widgetRefs.current.clear();
    containerRefs.current.forEach((el) => { el.innerHTML = ""; });

    const count = getChartCount(chartLayout);
    const theme = document.documentElement.classList.contains("dark") ? "Dark" : "Light";

    // Need a small delay for containers to be in DOM
    requestAnimationFrame(() => {
      for (let i = 1; i <= count; i++) {
        const paneId = String(i);
        const container = containerRefs.current.get(paneId);
        if (!container) continue;

        const { market, code } = getPaneSymbol(paneId);
        if (i === 1) {
          setCurrentMarket(market);
          setCurrentCode(code);
        }

        try {
          const widget = createTVWidget(container, paneId, market, code, theme);
          widgetRefs.current.set(paneId, widget);

          widget.onChartReady(() => {
            const chart = widget.activeChart();
            if (!chart) return;

            // Apply chart style from localStorage
            const savedStyle = (localStorage.getItem("tv_chart_style") as "candles" | "line" | "area" | "bars") || "candles";
            const styleMap: Record<string, number> = { candles: 0, line: 1, area: 2, bars: 3 };
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (chart as any).setChartStyle?.(styleMap[savedStyle]);

            chart.onSymbolChanged().subscribe(null, () => {
              try {
                const si = widget.symbolInterval();
                if (si?.symbol) {
                  const [m, c] = si.symbol.split(":");
                  if (m && c) {
                    setLocalData("market", m.toLowerCase());
                    setLocalData(`${m.toLowerCase()}_code_${paneId}`, c);
                    if (paneId === "1") {
                      setLocalData(`${m.toLowerCase()}_code`, c);
                      setCurrentMarket(m.toLowerCase());
                      setCurrentCode(c);
                    }
                  }
                }
              } catch { /* ignore */ }
            });

            chart.onIntervalChanged().subscribe(null, (interval: string) => {
              if (interval) {
                const m = getLocalData("market", "a");
                setLocalData(`${m}_interval_${paneId}`, interval);
              }
            });
          });
        } catch (err) {
          if (i === 1) setError(err instanceof Error ? err.message : String(err));
        }
      }
      setLoading(false);
    });
  }, [scriptsReady, chartLayout, getChartCount, getPaneSymbol]);

  // Initialize widgets when scripts are ready
  useEffect(() => {
    if (scriptsReady) initWidgets();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scriptsReady, chartLayout]);

  // Reinit on theme change
  useEffect(() => {
    const observer = new MutationObserver(() => { initWidgets(); });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scriptsReady]);

  const handleMarketChange = (market: string) => {
    setLocalData("market", market);
    if (!getLocalData(`${market}_code`, "")) {
      setLocalData(`${market}_code`, DEFAULT_CODES[market] || "");
    }
    window.location.reload();
 };

  const handleLayoutChange = (layout: ChartLayout) => {
    setChartLayout(layout);
    localStorage.setItem("tv_chart_layout", layout);
    setShowLayoutDropdown(false);
    setLoading(true);
  };

  // --- Watchlist actions ---
  const activeGroup = watchlists[activeGroupIdx] || watchlists[0];

  const addSymbolToWatchlist = (marketCode: string) => {
    const updated = [...watchlists];
    const group = updated[activeGroupIdx];
    if (!group || group.codes.includes(marketCode)) return;
    group.codes = [...group.codes, marketCode];
    setWatchlists(updated);
    saveWatchlists(updated);
  };

  const removeSymbolFromWatchlist = (code: string) => {
    const updated = [...watchlists];
    const group = updated[activeGroupIdx];
    if (!group) return;
    group.codes = group.codes.filter((c) => c !== code);
    setWatchlists(updated);
    saveWatchlists(updated);
  };

  const addWatchlistGroup = (name: string) => {
    if (!name.trim()) return;
    const updated = [...watchlists, { name: name.trim(), codes: [] }];
    setWatchlists(updated);
    saveWatchlists(updated);
    setActiveGroupIdx(updated.length - 1);
    setShowNewGroup(false);
    setNewGroupName("");
  };

  const removeWatchlistGroup = (idx: number) => {
    if (watchlists.length <= 1) return;
    const updated = watchlists.filter((_, i) => i !== idx);
    setWatchlists(updated);
    saveWatchlists(updated);
    if (activeGroupIdx >= updated.length) setActiveGroupIdx(updated.length - 1);
    else if (activeGroupIdx > idx) setActiveGroupIdx(activeGroupIdx - 1);
    setShowGroupDropdown(false);
  };

  const switchToSymbol = (marketCode: string) => {
    const [m, c] = marketCode.split(":");
    if (m && c) {
      setLocalData("market", m.toLowerCase());
      setLocalData(`${m.toLowerCase()}_code`, c);
      setCurrentMarket(m.toLowerCase());
      setCurrentCode(c);
    }
    // Switch symbol in the first chart pane
    const widget = widgetRefs.current.get("1");
    if (widget) {
      try {
        widget.onChartReady(() => { widget.activeChart()?.setSymbol(marketCode); });
      } catch {
        window.location.reload();
      }
    }
  };

  const isCurrentInWatchlist = activeGroup?.codes.includes(`${currentMarket}:${currentCode}`);

  // Render chart panes based on layout
  const renderChartArea = () => {
    const bdr = "1px solid var(--border)";
    // Helper: absolute-positioned chart container
    const pane = (id: string, style: React.CSSProperties) => (
      <div
        key={id}
        ref={(el) => { if (el) containerRefs.current.set(id, el); }}
        style={{ position: "absolute", ...style }}
      />
    );

    switch (chartLayout) {
      case "single":
        return pane("1", { inset: 0 });

      case "vertical-2":
        return (
          <>
            {pane("1", { top: 0, bottom: 0, left: 0, width: "50%", borderRight: bdr })}
            {pane("2", { top: 0, bottom: 0, right: 0, width: "50%" })}
          </>
        );

      case "horizontal-2":
        return (
          <>
            {pane("1", { top: 0, left: 0, right: 0, height: "50%", borderBottom: bdr })}
            {pane("2", { bottom: 0, left: 0, right: 0, height: "50%" })}
          </>
        );

      case "horizontal-73":
        return (
          <>
            {pane("1", { top: 0, left: 0, right: 0, height: "70%", borderBottom: bdr })}
            {pane("2", { bottom: 0, left: 0, right: 0, height: "30%" })}
          </>
        );

      case "three":
        return (
          <>
            {pane("1", { top: 0, left: 0, width: "50%", height: "50%", borderRight: bdr, borderBottom: bdr })}
            {pane("2", { top: 0, right: 0, width: "50%", height: "50%", borderBottom: bdr })}
            {pane("3", { bottom: 0, left: 0, right: 0, height: "50%" })}
          </>
        );

      case "four":
        return (
          <>
            {pane("1", { top: 0, left: 0, width: "50%", height: "50%", borderRight: bdr, borderBottom: bdr })}
            {pane("2", { top: 0, right: 0, width: "50%", height: "50%", borderBottom: bdr })}
            {pane("3", { bottom: 0, left: 0, width: "50%", height: "50%", borderRight: bdr })}
            {pane("4", { bottom: 0, right: 0, width: "50%", height: "50%" })}
          </>
        );

      default:
        return pane("1", { inset: 0 });
    }
  };

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen p-8">
        <div className="max-w-md text-center space-y-4">
          <AlertCircle className="h-12 w-12 text-muted-foreground mx-auto" />
          <h2 className="text-xl font-semibold">{t("marketAnalysis.unavailableTitle")}</h2>
          <p className="text-muted-foreground">{t("marketAnalysis.unavailableDesc")}</p>
          <div className="flex gap-3 justify-center">
            <button
              onClick={() => { setError(null); setLoading(true); initWidgets(); }}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-md border text-sm font-medium hover:bg-muted transition"
            >
              <RotateCw className="h-4 w-4" /> {t("marketAnalysis.retry")}
            </button>
            <a
              href="http://localhost:9900"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 px-4 py-2 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:opacity-90 transition"
            >
              {t("marketAnalysis.openInNewTab")} <ExternalLink className="h-4 w-4" />
            </a>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar */}
      <div className="tv-toolbar relative z-50 flex items-center gap-2 px-3 py-1.5 border-b bg-card shrink-0">
        {/* Watchlist toggle - leftmost */}
        <button
          id="watchlist-toggle-btn"
          title={t("marketAnalysis.toggleWatchlist")}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => setShowWatchlist(!showWatchlist)}
          className={`h-8 w-8 flex items-center justify-center rounded-md border transition-colors ${
            showWatchlist ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground hover:bg-muted"
          }`}
        >
          <List className="h-4 w-4" />
        </button>

        {/* Market selector + current code */}
        <select
          value={currentMarket}
          onChange={(e) => handleMarketChange(e.target.value)}
          className="h-8 rounded-md border bg-background px-2 text-sm"
        >
          {MARKETS.map((m) => (
            <option key={m.value} value={m.value}>{m.label}</option>
          ))}
        </select>
        <span className="text-sm text-muted-foreground">{currentCode}</span>

        {/* Right: Layout + Chart style + Watchlist */}
        <div className="ml-auto flex items-center gap-1">
          {/* Layout switcher */}
          <div ref={layoutButtonRef} className="relative">
            <button
              title={t("marketAnalysis.chartLayout")}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => setShowLayoutDropdown(!showLayoutDropdown)}
              className="h-8 flex items-center gap-1 px-2 rounded-md border text-sm text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
            >
              {(() => {
                const layoutDef = CHART_LAYOUTS.find((l) => l.value === chartLayout);
                const LayoutIcon = layoutDef?.icon || LayoutGrid;
                return <LayoutIcon className="h-4 w-4" />;
              })()}
              <span className="hidden sm:inline">{t(CHART_LAYOUTS.find((l) => l.value === chartLayout)?.labelKey || "marketAnalysis.layoutSingle")}</span>
              <ChevronDown className="h-3 w-3" />
            </button>

            {showLayoutDropdown && (
              <div className="absolute right-0 top-full mt-1 z-[9999] w-44 bg-popover border rounded-lg shadow-lg py-1">
                {CHART_LAYOUTS.map((cl) => {
                  const Icon = cl.icon;
                  return (
                    <div
                      key={cl.value}
                      className={`flex items-center gap-2 px-3 py-1.5 cursor-pointer text-sm hover:bg-muted transition-colors ${
                        chartLayout === cl.value ? "bg-muted font-medium" : ""
                      }`}
                      onClick={() => handleLayoutChange(cl.value)}
                    >
                      <Icon className="h-4 w-4" />
                      <span className="flex-1">{t(cl.labelKey)}</span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Add to watchlist button */}
          <button
            title={isCurrentInWatchlist ? t("marketAnalysis.removeFromWatchlist") : t("marketAnalysis.addToWatchlist")}
            onClick={() => {
              const key = `${currentMarket}:${currentCode}`;
              if (isCurrentInWatchlist) removeSymbolFromWatchlist(key);
              else addSymbolToWatchlist(key);
            }}
            className={`h-8 w-8 flex items-center justify-center rounded-md border transition-colors ${
              isCurrentInWatchlist
                ? "text-yellow-500 hover:text-yellow-600"
                : "text-muted-foreground hover:text-foreground hover:bg-muted"
            }`}
          >
            <Star className={`h-4 w-4 ${isCurrentInWatchlist ? "fill-current" : ""}`} />
          </button>

          {/* Watchlist group manager */}
          <div ref={groupButtonRef} className="relative">
            <button
              title={t("marketAnalysis.watchlistGroups")}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => setShowGroupDropdown(!showGroupDropdown)}
              className="h-8 flex items-center gap-1 px-2 rounded-md border text-sm text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
            >
              <FolderOpen className="h-4 w-4" />
              <span className="max-w-[80px] truncate hidden sm:inline">{activeGroup?.name || ""}</span>
              <ChevronDown className="h-3 w-3" />
            </button>

            {showGroupDropdown && (
              <div className="absolute right-0 top-full mt-1 z-[9999] w-56 bg-popover border rounded-lg shadow-lg py-1">
                {watchlists.map((g, i) => (
                  <div
                    key={i}
                    className={`flex items-center gap-2 px-3 py-1.5 cursor-pointer text-sm hover:bg-muted transition-colors ${
                      i === activeGroupIdx ? "bg-muted font-medium" : ""
                    }`}
                    onClick={() => { setActiveGroupIdx(i); setShowGroupDropdown(false); }}
                  >
                    <span className="flex-1 truncate">{g.name}</span>
                    <span className="text-xs text-muted-foreground">{g.codes.length}</span>
                    {watchlists.length > 1 && (
                      <button
                        onClick={(e) => { e.stopPropagation(); removeWatchlistGroup(i); }}
                        className="text-muted-foreground hover:text-red-500 transition-colors"
                      >
                        <Trash2 className="h-3 w-3" />
                      </button>
                    )}
                  </div>
                ))}
                <div className="border-t mt-1 pt-1 px-3">
                  {showNewGroup ? (
                    <div className="flex items-center gap-1 py-1">
                      <input
                        autoFocus
                        value={newGroupName}
                        onChange={(e) => setNewGroupName(e.target.value)}
                        onKeyDown={(e) => { if (e.key === "Enter") addWatchlistGroup(newGroupName); if (e.key === "Escape") setShowNewGroup(false); }}
                        placeholder={t("marketAnalysis.groupName")}
                        className="flex-1 h-7 rounded border bg-background px-2 text-sm outline-none focus:ring-1 focus:ring-primary"
                      />
                      <button onClick={() => addWatchlistGroup(newGroupName)} className="h-7 px-2 text-xs bg-primary text-primary-foreground rounded hover:opacity-90">
                        {t("marketAnalysis.confirm")}
                      </button>
                    </div>
                  ) : (
                    <button
                      onClick={() => setShowNewGroup(true)}
                      className="flex items-center gap-1 py-1 text-sm text-primary hover:underline"
                    >
                      <Plus className="h-3 w-3" /> {t("marketAnalysis.addGroup")}
                    </button>
                  )}
                </div>
              </div>
            )}
          </div>

        </div>
      </div>

      <div className="flex flex-1 overflow-hidden">
        {/* Watchlist sidebar */}
        {showWatchlist && (
          <div ref={watchlistRef} className="w-56 border-r bg-card shrink-0 flex flex-col overflow-hidden">
            <div className="flex items-center justify-between px-3 py-2 border-b">
              <span className="text-sm font-medium truncate">{activeGroup?.name}</span>
              <span className="text-xs text-muted-foreground">{activeGroup?.codes.length || 0}</span>
            </div>
            <div className="flex-1 overflow-y-auto">
              {activeGroup?.codes.length === 0 && (
                <div className="px-3 py-6 text-center text-sm text-muted-foreground">
                  {t("marketAnalysis.emptyWatchlist")}
                </div>
              )}
              {activeGroup?.codes.map((mc) => {
                const [m, c] = mc.split(":");
                const isActive = m === currentMarket && c === currentCode;
                return (
                  <div
                    key={mc}
                    className={`flex items-center gap-2 px-3 py-1.5 cursor-pointer text-sm transition-colors group ${
                      isActive ? "bg-primary/10 text-primary font-medium" : "hover:bg-muted"
                    }`}
                    onClick={() => switchToSymbol(mc)}
                  >
                    <Star className="h-3 w-3 text-yellow-500 fill-yellow-500 shrink-0" />
                    <span className="flex-1 truncate">{c}</span>
                    <span className="text-xs text-muted-foreground">{m.toUpperCase()}</span>
                    <button
                      onClick={(e) => { e.stopPropagation(); removeSymbolFromWatchlist(mc); }}
                      className="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-red-500 transition-all"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Chart area */}
        <div className="tv-chart-area relative z-0 flex-1 overflow-hidden">
          {loading && (
            <div className="absolute inset-0 flex items-center justify-center bg-background/80 z-10">
              <div className="flex items-center gap-2 text-muted-foreground">
                <RotateCw className="h-5 w-5 animate-spin" />
                <span>{t("marketAnalysis.loading")}</span>
              </div>
            </div>
          )}
          {renderChartArea()}
        </div>
      </div>
    </div>
  );
}
