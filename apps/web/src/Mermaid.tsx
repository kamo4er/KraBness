import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { t } from "@kamharn/client";

type MermaidApi = typeof import("mermaid").default;

let mermaidLoader: Promise<MermaidApi> | undefined;

function loadMermaid(): Promise<MermaidApi> {
  mermaidLoader ??= import("mermaid").then(({ default: mermaid }) => {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      suppressErrorRendering: true,
      theme: "base",
      darkMode: true,
      themeVariables: {
        background: "#111318",
        primaryColor: "#1f232c",
        primaryTextColor: "#e6e8ee",
        primaryBorderColor: "#6aa2ff",
        secondaryColor: "#171a21",
        tertiaryColor: "#171a21",
        lineColor: "#8b93a5",
        textColor: "#e6e8ee",
        fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
      },
    });
    return mermaid;
  }).catch((reason: unknown) => {
    mermaidLoader = undefined;
    throw reason;
  });
  return mermaidLoader;
}

export function MermaidDiagram({ source }: { source: string }) {
  const reactId = useId();
  const id = `mermaid-${reactId.replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const [svg, setSvg] = useState("");
  const [error, setError] = useState<{ message: string; load: boolean }>();
  const [retry, setRetry] = useState(0);
  const container = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let active = true;
    let errorTimer: number | undefined;
    setSvg("");
    setError(undefined);
    const timer = window.setTimeout(() => {
      void (async () => {
        let mermaid: MermaidApi;
        try {
          mermaid = await loadMermaid();
        } catch (reason) {
          if (active) setError({ message: reason instanceof Error ? reason.message : String(reason), load: true });
          return;
        }
        try {
          const rendered = await mermaid.render(id, source);
          if (active) setSvg(rendered.svg);
        } catch (reason) {
          const message = reason instanceof Error ? reason.message : String(reason);
          errorTimer = window.setTimeout(() => {
            if (active) setError({ message, load: false });
          }, 1000);
        }
      })();
    }, 150);
    return () => {
      active = false;
      window.clearTimeout(timer);
      if (errorTimer !== undefined) window.clearTimeout(errorTimer);
    };
  }, [id, source, retry]);

  useLayoutEffect(() => {
    const diagram = container.current?.querySelector("svg");
    const viewBox = diagram?.getAttribute("viewBox")?.trim().split(/\s+/).map(Number);
    if (!diagram || !viewBox || viewBox.length !== 4 || !viewBox.every(Number.isFinite)) return;
    diagram.style.width = `${viewBox[2]}px`;
    diagram.style.maxWidth = "none";
  }, [svg]);

  if (error) {
    return (
      <div className="mermaid mermaid--error" data-mermaid-error>
        <pre className="mermaid__source"><code>{source}</code></pre>
        <p className="error">{error.load ? t("Не удалось загрузить Mermaid", "Could not load Mermaid") : t("Не удалось разобрать диаграмму", "Could not parse the diagram")}: {error.message}</p>
        {error.load && <button className="btn btn--small mermaid__retry" type="button" onClick={() => setRetry((value) => value + 1)}>{t("Повторить", "Retry")}</button>}
      </div>
    );
  }

  return (
    <div className="mermaid">
      {svg ? <div className="mermaid__diagram" data-mermaid-diagram ref={container} dangerouslySetInnerHTML={{ __html: svg }} /> : <span className="muted">{t("Рисую диаграмму…", "Drawing the diagram…")}</span>}
    </div>
  );
}
