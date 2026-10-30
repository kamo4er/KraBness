// Страница для WebView с диаграммой mermaid: та же библиотека и тема, что в вебе, только с CDN.
// Отвечает приложению одним сообщением: {h} — высота нарисованной диаграммы или {error, load}.
// Без top-level await и прочего нового синтаксиса в самой странице: на старом WebView (Chrome 68 на MEmu)
// он ронял скрипт молча, и карточка висела на «Рисую…». Сам mermaid там не грузится — тогда придёт ошибка загрузки.

export const MERMAID_URL = "https://cdn.jsdelivr.net/npm/mermaid@12.2.0/dist/mermaid.esm.min.mjs";

/** fit — в ленте: по ширине экрана, без зума; иначе натуральный размер, прокрутка и щипок */
export function mermaidPage(source: string, fit = true): string {
  // исходник — данными, а не разметкой: </script> внутри диаграммы не закроет скрипт
  const src = JSON.stringify(source).replace(/</g, "\\u003c");
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1${fit ? ",user-scalable=no" : ""}">
<style>html,body{margin:0;background:#111318;color:#e6e8ee;font:13px system-ui,sans-serif}#d{padding:8px;overflow-x:auto}#d svg{display:block;${fit ? "max-width:100%;height:auto" : "max-width:none"}}</style></head>
<body><div id="d"></div><script>
function post(m) { window.ReactNativeWebView.postMessage(JSON.stringify(m)); }
var loaded = false;
function fail(e, load) { post({ error: String((e && e.message) || e), load: load }); }
try {
  import(${JSON.stringify(MERMAID_URL)}).then(function (mod) {
    loaded = true;
    var mermaid = mod.default;
    mermaid.initialize({ startOnLoad: false, securityLevel: "strict", suppressErrorRendering: true, theme: "base", darkMode: true,
      themeVariables: { background: "#111318", primaryColor: "#1f232c", primaryTextColor: "#e6e8ee", primaryBorderColor: "#6aa2ff",
        secondaryColor: "#171a21", tertiaryColor: "#171a21", lineColor: "#8b93a5", textColor: "#e6e8ee", fontFamily: "system-ui, sans-serif" } });
    return mermaid.render("m", ${src});
  }).then(function (r) {
    var d = document.getElementById("d");
    d.innerHTML = r.svg;
    var s = d.querySelector("svg"), vb = s && s.viewBox.baseVal;
    // у svg свой инлайновый max-width от mermaid — перебиваем тоже инлайном
    if (vb && vb.width) { s.style.width = vb.width + "px"; s.style.maxWidth = ${fit ? "\"100%\"" : "\"none\""}; s.style.height = ${fit ? "\"auto\"" : "vb.height + \"px\""}; }
    post({ h: Math.ceil(d.getBoundingClientRect().height) });
  }, function (e) { fail(e, !loaded); });
} catch (e) { fail(e, true); }
</script></body></html>`;
}
