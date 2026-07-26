#!/usr/bin/env node

import { appendFile, mkdir } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";

const sshTarget = process.env.LOADTEST_SSH_TARGET || "";
const intervalSeconds = positiveNumber(
  process.env.LOADTEST_MONITOR_INTERVAL_SECONDS,
  5,
);
const port = positiveNumber(process.env.LOADTEST_SYSTEM_DASHBOARD_PORT, 5666);
const resultDir = process.env.LOADTEST_RESULT_DIR || path.resolve("results");
const runId = process.env.LOADTEST_RUN_ID || "load-test";
const profile = process.env.LOADTEST_PROFILE || "unknown";
const conditionId = process.env.LOADTEST_CONDITION_ID || "unknown";
const metricsPath = path.join(resultDir, "server-metrics.jsonl");
const history = [];
let latest = {
  timestamp: new Date().toISOString(),
  error: sshTarget ? "Waiting for the first server sample" : "SSH monitoring disabled",
};
let collecting = false;

await mkdir(resultDir, { recursive: true });

const server = http.createServer(async (request, response) => {
  if (request.url === "/api/snapshots") {
    return json(response, { runId, profile, conditionId, sshTarget, history });
  }
  if (request.url === "/api/latest") {
    return json(response, latest);
  }
  if (request.url === "/health") {
    return json(response, { ok: true });
  }
  if (request.url === "/" || request.url === "/index.html") {
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(dashboardHtml);
    return;
  }
  response.writeHead(404);
  response.end("Not found");
});

server.listen(port, "127.0.0.1", () => {
  process.stdout.write(`System dashboard: http://127.0.0.1:${port}\n`);
});

async function collect() {
  if (collecting) return;
  collecting = true;
  try {
    const output = await runRemote(sshTarget, remoteCollector);
    latest = parseSnapshot(output);
  } catch (error) {
    latest = {
      timestamp: new Date().toISOString(),
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    collecting = false;
  }

  history.push(latest);
  if (history.length > 720) history.shift();
  await appendFile(metricsPath, `${JSON.stringify(latest)}\n`).catch(() => undefined);
}

function runRemote(target, script) {
  return new Promise((resolve, reject) => {
    const child = spawn("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=5", target, "bash", "-s"], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`SSH monitor failed (${code}): ${stderr.trim()}`));
    });
    child.stdin.end(script);
  });
}

function parseSnapshot(output) {
  const snapshot = {
    timestamp: new Date().toISOString(),
    host: {},
    containers: [],
    fileDescriptors: {},
    databases: {},
  };
  for (const line of output.trim().split("\n")) {
    const parts = line.split("|");
    switch (parts[0]) {
      case "HOST":
        snapshot.host = {
          load1: number(parts[1]),
          load5: number(parts[2]),
          load15: number(parts[3]),
          memoryUsedMiB: number(parts[4]),
          memoryTotalMiB: number(parts[5]),
          swapUsedMiB: number(parts[6]),
          diskUsedPercent: number(parts[7]),
          tcpEstablished: number(parts[8]),
        };
        break;
      case "CONTAINER":
        snapshot.containers.push({
          name: parts[1],
          cpuPercent: number(parts[2]),
          memory: parts[3],
          netIo: parts[4],
          blockIo: parts[5],
          pids: number(parts[6]),
        });
        break;
      case "FD":
        snapshot.fileDescriptors[parts[1]] = {
          used: number(parts[2]),
          limit: number(parts[3]),
        };
        break;
      case "DB":
        snapshot.databases[parts[1]] = {
          active: number(parts[2]),
          total: number(parts[3]),
          max: number(parts[4]),
        };
        break;
    }
  }
  return snapshot;
}

function number(value) {
  const parsed = Number(String(value ?? "").replace("%", ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function positiveNumber(value, fallback) {
  const parsed = Number(value ?? fallback);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function json(response, body) {
  response.writeHead(200, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(body));
}

const remoteCollector = String.raw`
set -u

read -r load1 load5 load15 _ < /proc/loadavg
mem_total_kib=$(awk '/^MemTotal:/ {print $2}' /proc/meminfo)
mem_available_kib=$(awk '/^MemAvailable:/ {print $2}' /proc/meminfo)
swap_total_kib=$(awk '/^SwapTotal:/ {print $2}' /proc/meminfo)
swap_free_kib=$(awk '/^SwapFree:/ {print $2}' /proc/meminfo)
mem_used_mib=$(( (mem_total_kib - mem_available_kib) / 1024 ))
mem_total_mib=$(( mem_total_kib / 1024 ))
swap_used_mib=$(( (swap_total_kib - swap_free_kib) / 1024 ))
disk_used=$(df -P /var | awk 'NR==2 {gsub("%","",$5); print $5}')
tcp_established=$(ss -Htan state established 2>/dev/null | wc -l | tr -d ' ')
printf 'HOST|%s|%s|%s|%s|%s|%s|%s|%s\n' \
  "$load1" "$load5" "$load15" "$mem_used_mib" "$mem_total_mib" \
  "$swap_used_mib" "$disk_used" "$tcp_established"

docker stats --no-stream --format \
  'CONTAINER|{{.Name}}|{{.CPUPerc}}|{{.MemUsage}}|{{.NetIO}}|{{.BlockIO}}|{{.PIDs}}'

for container in infra-caddy-1 infra-synapse-1 infra-session-manager-1 infra-chat-service-1; do
  if docker inspect "$container" >/dev/null 2>&1; then
    used=$(docker exec "$container" sh -c 'ls /proc/1/fd 2>/dev/null | wc -l' | tr -d ' ')
    limit=$(docker exec "$container" sh -c 'ulimit -n' 2>/dev/null | tr -d ' ')
    printf 'FD|%s|%s|%s\n' "$container" "$used" "$limit"
  fi
done

research=$(docker exec infra-research-db-1 psql -U gdm -d gdm_research -Atc \
  "select count(*) filter (where state = 'active'), count(*), current_setting('max_connections') from pg_stat_activity;" \
  2>/dev/null || printf '0|0|0')
synapse=$(docker exec infra-synapse-db-1 psql -U synapse -d synapse -Atc \
  "select count(*) filter (where state = 'active'), count(*), current_setting('max_connections') from pg_stat_activity;" \
  2>/dev/null || printf '0|0|0')
printf 'DB|research|%s\n' "$research"
printf 'DB|synapse|%s\n' "$synapse"
`;

const dashboardHtml = String.raw`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>GDM load-test monitor</title>
  <style>
    :root { color-scheme: dark; --bg:#07111f; --panel:#0e1b2c; --line:#20344c;
      --text:#e7eef7; --muted:#8fa4ba; --cyan:#49d6c7; --blue:#64a8ff;
      --amber:#f6c453; --red:#ff6b7a; }
    * { box-sizing: border-box; }
    body { margin:0; font:14px/1.45 ui-sans-serif,system-ui,-apple-system,sans-serif;
      color:var(--text); background:radial-gradient(circle at 20% 0,#102842 0,var(--bg) 36%); }
    main { width:min(1440px,96vw); margin:0 auto; padding:28px 0 48px; }
    header { display:flex; align-items:flex-end; justify-content:space-between; gap:24px; margin-bottom:20px; }
    h1 { margin:0; font-size:25px; letter-spacing:-.02em; }
    h2 { margin:0 0 12px; color:var(--muted); font-size:12px; text-transform:uppercase; letter-spacing:.12em; }
    .meta,.muted { color:var(--muted); }
    .links { display:flex; gap:10px; }
    a { color:var(--cyan); text-decoration:none; border:1px solid var(--line); border-radius:8px; padding:7px 10px; }
    .grid { display:grid; grid-template-columns:repeat(5,minmax(0,1fr)); gap:12px; margin-bottom:12px; }
    .card,.panel { background:rgba(14,27,44,.92); border:1px solid var(--line); border-radius:12px;
      box-shadow:0 14px 34px rgba(0,0,0,.18); }
    .card { padding:16px; min-height:100px; }
    .value { font-size:27px; font-weight:700; margin:3px 0; font-variant-numeric:tabular-nums; }
    .panel { padding:16px; margin-top:12px; overflow:hidden; }
    .split { display:grid; grid-template-columns:1.5fr 1fr; gap:12px; }
    table { width:100%; border-collapse:collapse; }
    th,td { padding:9px 8px; border-bottom:1px solid var(--line); text-align:left; white-space:nowrap; }
    th { color:var(--muted); font-size:11px; text-transform:uppercase; letter-spacing:.08em; }
    td.num { font-variant-numeric:tabular-nums; }
    .bar { height:7px; background:#17283b; border-radius:999px; overflow:hidden; margin-top:7px; }
    .bar > i { display:block; height:100%; width:0; background:linear-gradient(90deg,var(--cyan),var(--blue)); }
    .warning .bar > i { background:var(--amber); }
    .danger .bar > i { background:var(--red); }
    canvas { width:100%; height:170px; display:block; background:#0a1625;
      border:1px solid var(--line); border-radius:8px; }
    .error { color:#ffd5da; background:#401823; border:1px solid #7f3040; padding:12px; border-radius:8px; }
    .status { display:inline-flex; align-items:center; gap:7px; }
    .dot { width:8px; height:8px; border-radius:50%; background:var(--cyan); box-shadow:0 0 10px var(--cyan); }
    @media(max-width:900px) { .grid{grid-template-columns:repeat(2,1fr)} .split{grid-template-columns:1fr} header{display:block}.links{margin-top:12px} }
  </style>
</head>
<body>
<main>
  <header>
    <div>
      <h1>GDM capacity monitor</h1>
      <div class="meta" id="meta">Connecting…</div>
    </div>
    <div class="links"><a href="http://127.0.0.1:5665" target="_blank">k6 traffic dashboard ↗</a></div>
  </header>
  <div id="error"></div>
  <section class="grid" id="cards"></section>
  <section class="split">
    <div class="panel"><h2>Host load history</h2><canvas id="chart"></canvas></div>
    <div class="panel"><h2>File descriptors</h2><div id="fds"></div></div>
  </section>
  <section class="panel"><h2>Containers</h2><div id="containers"></div></section>
</main>
<script>
const colors={cyan:"#49d6c7",blue:"#64a8ff",line:"#20344c",muted:"#8fa4ba"};
async function refresh(){
  const data=await fetch("/api/snapshots",{cache:"no-store"}).then(r=>r.json());
  const latest=data.history[data.history.length-1]||{};
  document.getElementById("meta").innerHTML =
    '<span class="status"><i class="dot"></i>'+esc(data.profile)+'</span> · '+esc(data.conditionId)+
    ' · '+esc(data.sshTarget)+' · '+(latest.timestamp?new Date(latest.timestamp).toLocaleTimeString():"waiting");
  document.getElementById("error").innerHTML=latest.error?'<p class="error">'+esc(latest.error)+'</p>':"";
  const h=latest.host||{}, db=latest.databases||{};
  cards([
    ["Load 1 / 4 cores",fmt(h.load1),pct((h.load1||0)/4*100)],
    ["Host memory",fmt(h.memoryUsedMiB)+" MiB",pct((h.memoryUsedMiB||0)/(h.memoryTotalMiB||1)*100)],
    ["/var disk",fmt(h.diskUsedPercent)+"%",pct(h.diskUsedPercent)],
    ["TCP established",fmt(h.tcpEstablished),null],
    ["DB connections",fmt((db.research?.total||0)+(db.synapse?.total||0)),null]
  ]);
  renderFds(latest.fileDescriptors||{});
  renderContainers(latest.containers||[]);
  draw(data.history.slice(-180));
}
function cards(items){
  document.getElementById("cards").innerHTML=items.map(([label,value,width])=>
    '<article class="card"><h2>'+label+'</h2><div class="value">'+value+'</div>'+
    (width===null?'':'<div class="bar"><i style="width:'+width+'"></i></div>')+'</article>').join("");
}
function renderFds(items){
  const rows=Object.entries(items).map(([name,v])=>{
    const ratio=v.limit?100*v.used/v.limit:0, cls=ratio>85?"danger":ratio>70?"warning":"";
    return '<div class="'+cls+'" style="margin-bottom:15px"><div><strong>'+short(name)+
      '</strong> <span class="muted">'+v.used+' / '+v.limit+'</span></div><div class="bar"><i style="width:'+pct(ratio)+'"></i></div></div>';
  });
  document.getElementById("fds").innerHTML=rows.join("")||'<span class="muted">No data</span>';
}
function renderContainers(items){
  const rows=items.map(v=>'<tr><td>'+short(v.name)+'</td><td class="num">'+fmt(v.cpuPercent)+'%</td>'+
    '<td>'+esc(v.memory)+'</td><td>'+esc(v.netIo)+'</td><td>'+esc(v.blockIo)+'</td><td class="num">'+fmt(v.pids)+'</td></tr>');
  document.getElementById("containers").innerHTML='<table><thead><tr><th>Service</th><th>CPU</th><th>Memory</th><th>Network</th><th>Block I/O</th><th>PIDs</th></tr></thead><tbody>'+
    rows.join("")+'</tbody></table>';
}
function draw(history){
  const canvas=document.getElementById("chart"), dpr=window.devicePixelRatio||1;
  const rect=canvas.getBoundingClientRect(); canvas.width=rect.width*dpr; canvas.height=rect.height*dpr;
  const c=canvas.getContext("2d"); c.scale(dpr,dpr); const w=rect.width,h=rect.height,p=22;
  c.clearRect(0,0,w,h); c.strokeStyle=colors.line; c.lineWidth=1;
  for(let i=0;i<4;i++){const y=p+(h-2*p)*i/3;c.beginPath();c.moveTo(p,y);c.lineTo(w-p,y);c.stroke();}
  const vals=history.map(x=>x.host?.load1||0), max=Math.max(4,...vals)*1.1;
  c.strokeStyle=colors.cyan;c.lineWidth=2;c.beginPath();
  vals.forEach((v,i)=>{const x=p+(w-2*p)*(i/Math.max(1,vals.length-1));const y=h-p-(h-2*p)*v/max;i?c.lineTo(x,y):c.moveTo(x,y)});c.stroke();
  c.fillStyle=colors.muted;c.font="11px system-ui";c.fillText("0",3,h-p+3);c.fillText(max.toFixed(1),3,p+3);
}
function fmt(v){return Number.isFinite(Number(v))?Number(v).toLocaleString(undefined,{maximumFractionDigits:1}):"—"}
function pct(v){return Math.max(0,Math.min(100,Number(v)||0)).toFixed(1)+"%"}
function short(v){return esc(String(v).replace(/^infra-/,"").replace(/-1$/,""))}
function esc(v){return String(v??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]))}
refresh().catch(console.error);setInterval(()=>refresh().catch(console.error),5000);addEventListener("resize",()=>refresh().catch(()=>{}));
</script>
</body>
</html>`;

if (sshTarget) {
  await collect();
  setInterval(() => void collect(), intervalSeconds * 1000);
}
