import { useEffect, useRef, useState, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { AlertCircle, ExternalLink, RotateCw } from "lucide-react";

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

export function MarketAnalysis() {
  const { t } = useTranslation();
  const containerRef = useRef<HTMLDivElement>(null);
  const widgetRef = useRef<TVWidget | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [currentMarket, setCurrentMarket] = useState(() => getLocalData("market", "a"));
  const [currentCode, setCurrentCode] = useState(() =>
    getLocalData(`${getLocalData("market", "a")}_code`, DEFAULT_CODES[getLocalData("market", "a")] || "SH.000001")
  );
  const [scriptsReady, setScriptsReady] = useState(false);
  const serverDefaults = useRef<Record<string, string>>({});

  // Fetch server-side default codes from /tv/config
  useEffect(() => {
    fetch("/tv/config")
      .then((r) => r.json())
      .then((data) => {
        if (data.default_codes) {
          serverDefaults.current = data.default_codes;
          // Update DEFAULT_CODES with server values
          for (const [k, v] of Object.entries(data.default_codes)) {
            if (v && !(k in (JSON.parse(localStorage.getItem("tv_chart") || "{}") as Record<string, string>))) {
              DEFAULT_CODES[k] = v as string;
            }
          }
        }
      })
      .catch(() => { /* ignore — will use hardcoded defaults */ });
  }, []);

  // Load TradingView scripts once
  useEffect(() => {
    let cancelled = false;
    Promise.all([
      loadScript(TV_SCRIPT_ID, "/charting_library/charting_library.standalone.js"),
      loadScript(DF_SCRIPT_ID, "/datafeeds/udf/dist/bundle.js"),
    ])
      .then(() => {
        if (!cancelled) setScriptsReady(true);
      })
      .catch((err) => {
        if (!cancelled) setError(err.message);
      });
    return () => { cancelled = true; };
  }, []);

  const initWidget = useCallback(() => {
    if (!scriptsReady || !containerRef.current || !window.TradingView || !window.Datafeeds) return;

    // Remove existing widget
    if (widgetRef.current) {
      try { widgetRef.current.remove(); } catch { /* ignore */ }
      widgetRef.current = null;
    }
    containerRef.current.innerHTML = "";

    const market = getLocalData("market", "a");
    const code = getLocalData(`${market}_code`, DEFAULT_CODES[market] || "SH.000001");
    setCurrentMarket(market);
    setCurrentCode(code);

    const interval = getLocalData(`${market}_interval_1`, "1D");
    const theme = document.documentElement.classList.contains("dark") ? "Dark" : "Light";

    try {
      const datafeed = new window.Datafeeds.UDFCompatibleDatafeed("/tv", 30000);

      const widget = new window.TradingView.widget({
        debug: false,
        autosize: true,
        fullscreen: false,
        container: containerRef.current,
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
        client_id: `market_pro_${market}_1`,
        user_id: "999",
        load_last_chart: true,
      });

      widgetRef.current = widget;
      setLoading(false);

      widget.onChartReady(() => {
        const chart = widget.activeChart();
        if (!chart) return;

        chart.onSymbolChanged().subscribe(null, () => {
          try {
            const si = widget.symbolInterval();
            if (si?.symbol) {
              const [m, c] = si.symbol.split(":");
              if (m && c) {
                setLocalData("market", m.toLowerCase());
                setLocalData(`${m.toLowerCase()}_code`, c);
                setCurrentMarket(m.toLowerCase());
                setCurrentCode(c);
              }
            }
          } catch { /* ignore */ }
        });

        chart.onIntervalChanged().subscribe(null, (interval: string) => {
          if (interval) {
            const m = getLocalData("market", "a");
            setLocalData(`${m}_interval_1`, interval);
          }
        });
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setLoading(false);
    }
  }, [scriptsReady]);

  // Initialize / reinitialize widget
  useEffect(() => {
    if (scriptsReady) initWidget();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scriptsReady]);

  // Reinit on theme change
  useEffect(() => {
    const observer = new MutationObserver(() => {
      // Theme changed — reinit widget to pick up new theme
      if (widgetRef.current) initWidget();
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scriptsReady]);

  const handleMarketChange = (market: string) => {
    setLocalData("market", market);
    if (!getLocalData(`${market}_code`, "")) {
      setLocalData(`${market}_code`, DEFAULT_CODES[market] || "");
    }
    // Reload to reinitialize the widget with new market
    window.location.reload();
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
              onClick={() => { setError(null); setLoading(true); initWidget(); }}
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
      <div className="flex items-center gap-2 px-3 py-1.5 border-b bg-card shrink-0">
        <select
          value={currentMarket}
          onChange={(e) => handleMarketChange(e.target.value)}
          className="h-8 rounded-md border bg-background px-2 text-sm"
        >
          {MARKETS.map((m) => (
            <option key={m.value} value={m.value}>{m.label}</option>
          ))}
        </select>
        <span className="text-sm text-muted-foreground">
          {currentCode}
        </span>
      </div>

      {/* Chart container */}
      <div className="relative flex-1">
        {loading && (
          <div className="absolute inset-0 flex items-center justify-center bg-background/80 z-10">
            <div className="flex items-center gap-2 text-muted-foreground">
              <RotateCw className="h-5 w-5 animate-spin" />
              <span>{t("marketAnalysis.loading")}</span>
            </div>
          </div>
        )}
        <div ref={containerRef} className="w-full h-full" />
      </div>
    </div>
  );
}
