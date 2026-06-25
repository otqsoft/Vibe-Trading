import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ExternalLink, AlertCircle } from "lucide-react";

const MARKET_ANALYSIS_URL = "http://localhost:9900";

export function MarketAnalysis() {
  const { t } = useTranslation();
  const [iframeError, setIframeError] = useState(false);

  if (iframeError) {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen p-8">
        <div className="max-w-md text-center space-y-4">
          <AlertCircle className="h-12 w-12 text-muted-foreground mx-auto" />
          <h2 className="text-xl font-semibold">{t("marketAnalysis.unavailableTitle")}</h2>
          <p className="text-muted-foreground">{t("marketAnalysis.unavailableDesc")}</p>
          <a
            href={MARKET_ANALYSIS_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 px-4 py-2 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:opacity-90 transition"
          >
            {t("marketAnalysis.openInNewTab")} <ExternalLink className="h-4 w-4" />
          </a>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      <iframe
        src={MARKET_ANALYSIS_URL}
        className="flex-1 w-full border-0"
        title={t("marketAnalysis.title")}
        onError={() => setIframeError(true)}
        sandbox="allow-scripts allow-same-origin allow-popups allow-forms"
      />
    </div>
  );
}
