/**
 * First-run consent page. Server-rendered so a stale UI bundle can never skip
 * it. After the user authorizes, the page navigates to the SPA at
 * `/?token=<token>#/`.
 */
export function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]);
}

export function renderConsentPage({ repositoryName, roots }) {
  const rows = roots.map((root) => `<li><span>read only</span><strong>${escapeHtml(root)}</strong></li>`).join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><title>Authorize ContextScope</title>
<style>
:root{--bg:#f4f6f9;--panel:#fff;--line:#dfe4eb;--ink:#182230;--muted:#667386;--accent:#225fd1;--ok:#14705e;--okbg:#effaf7}
@media(prefers-color-scheme:dark){:root{--bg:#0f1318;--panel:#171c24;--line:#2a323d;--ink:#e6ebf2;--muted:#98a4b5;--accent:#6ea0ff;--ok:#5fd3b3;--okbg:#12241f}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Inter,sans-serif}
.shell{width:min(880px,calc(100% - 32px));margin:8vh auto}.brand{display:flex;align-items:center;gap:10px;margin-bottom:20px}
.brand i{width:34px;height:34px;border-radius:9px;display:grid;place-items:center;background:var(--accent);color:#fff;font-style:normal;font-weight:800}
.card{display:grid;grid-template-columns:minmax(0,1fr) 320px;border:1px solid var(--line);border-radius:14px;background:var(--panel);overflow:hidden}
.copy{padding:clamp(28px,5vw,52px)}.scope{padding:28px;border-left:1px solid var(--line)}
.eyebrow{color:var(--accent);font:800 10px ui-monospace,monospace;letter-spacing:.1em;text-transform:uppercase}
h1{font-size:clamp(30px,5vw,46px);line-height:1.05;letter-spacing:-.04em;margin:10px 0 16px}p{color:var(--muted);max-width:520px}
.note{display:flex;gap:9px;margin-top:24px;padding:12px;border-radius:8px;background:var(--okbg);color:var(--ok);font-size:12px}
ul{list-style:none;margin:16px 0 22px;padding:0}li{padding:10px 0;border-top:1px solid var(--line)}li span{display:block;color:var(--ok);font:800 9px ui-monospace,monospace;text-transform:uppercase}
li strong{display:block;margin-top:3px;font-size:12px;overflow-wrap:anywhere}
button{width:100%;border:1px solid var(--accent);border-radius:8px;padding:12px;background:var(--accent);color:#fff;font-weight:700;cursor:pointer}button:disabled{opacity:.55}
small{display:block;color:var(--muted);margin-top:12px;font-size:11px;text-align:center}
@media(max-width:720px){.card{grid-template-columns:1fr}.scope{border-left:0;border-top:1px solid var(--line)}}
</style></head>
<body><main class="shell"><div class="brand"><i>C</i><strong>ContextScope</strong></div><div class="card">
<section class="copy"><span class="eyebrow">First-run authorization</span><h1>Private by default.<br>Useful immediately.</h1>
<p>ContextScope found the standard locations it can inspect for <strong>${escapeHtml(repositoryName)}</strong>. Approve one bounded, read-only scan to index your sessions and build the context review. The index stores sizes, hashes, tool names and token counts only.</p>
<div class="note"><span>Transcript contents stay on this computer. No credentials or arbitrary home folders are inspected. Nothing is uploaded.</span></div></section>
<aside class="scope"><span class="eyebrow">Approved scan scope</span><ul>${rows}</ul><button id="authorize">Authorize read-only scan</button><small>You can stop ContextScope at any time with Ctrl+C.</small></aside>
</div></main>
<script>
const button=document.querySelector('#authorize');
button.addEventListener('click',async()=>{button.disabled=true;button.textContent='Starting the index…';
const token=new URLSearchParams(location.search).get('token')||'';
try{const response=await fetch('/api/authorize',{method:'POST',headers:{authorization:'Bearer '+token}});
if(response.ok){location.replace('/?token='+encodeURIComponent(token)+'#/');return;}}catch{}
button.disabled=false;button.textContent='Try again';});
</script></body></html>`;
}
