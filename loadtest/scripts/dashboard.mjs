#!/usr/bin/env node

import { appendFile, mkdir, readFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

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
const trafficStartFile =
  process.env.LOADTEST_TRAFFIC_START_FILE ||
  path.join(resultDir, "traffic-started-at.txt");
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const profiles = JSON.parse(
  await readFile(path.join(scriptDir, "..", "profiles.json"), "utf8"),
);
const history = [];
let previousRaw = null;
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
    const raw = parseRawSnapshot(output);
    latest = deriveSnapshot(raw, previousRaw);
    previousRaw = raw;
    latest.stage = await currentStage(latest.timestamp);
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

function parseRawSnapshot(output) {
  const snapshot = {
    timestamp: new Date().toISOString(),
    host: {},
    containers: [],
    processes: [],
    disks: [],
    networkInterfaces: [],
    fileDescriptors: {},
    databases: {},
    databaseWaits: {},
    meta: {},
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
          memoryAvailableMiB: number(parts[9]),
          buffersMiB: number(parts[10]),
          cachedMiB: number(parts[11]),
          dirtyMiB: number(parts[12]),
          swapTotalMiB: number(parts[13]),
        };
        break;
      case "META":
        snapshot.meta = {
          clockTicks: number(parts[1]),
          cpuCount: number(parts[2]),
          defaultNetworkInterface: parts[3] || "",
        };
        break;
      case "CPU":
        snapshot.host.cpuRaw ??= {};
        snapshot.host.cpuRaw[parts[1]] = parts.slice(2, 10).map(number);
        break;
      case "PSI":
        snapshot.host.pressure ??= {};
        snapshot.host.pressure[parts[1]] ??= {};
        snapshot.host.pressure[parts[1]][parts[2]] = {
          avg10: number(parts[3]),
          avg60: number(parts[4]),
          avg300: number(parts[5]),
          totalMicros: number(parts[6]),
        };
        break;
      case "DISK":
        snapshot.disks.push({
          name: parts[1],
          raw: parts.slice(2, 13).map(number),
        });
        break;
      case "NET":
        snapshot.networkInterfaces.push({
          name: parts[1],
          rxBytes: number(parts[2]),
          txBytes: number(parts[3]),
        });
        break;
      case "CONTAINER":
        snapshot.containers.push({
          name: parts[1],
          cpuPercent: number(parts[2]),
          memory: parts[3],
          memoryPercent: number(parts[4]),
          netIo: parts[5],
          blockIo: parts[6],
          pids: number(parts[7]),
        });
        break;
      case "PROC":
        snapshot.processes.push({
          pid: number(parts[1]),
          startTicks: number(parts[2]),
          ppid: number(parts[3]),
          container: parts[4] || "host",
          name: parts[5]?.trim() || "unknown",
          rssKiB: number(parts[6]),
          readBytes: number(parts[7]),
          writeBytes: number(parts[8]),
          cpuTicks: number(parts[9]) + number(parts[10]),
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
          longestActiveSeconds: number(parts[5]),
          trackIoTiming: parts[6] === "on",
        };
        break;
      case "DBSTAT":
        snapshot.databases[parts[1]] ??= {};
        snapshot.databases[parts[1]].raw = {
          commits: number(parts[2]),
          rollbacks: number(parts[3]),
          blocksRead: number(parts[4]),
          blocksHit: number(parts[5]),
          tempFiles: number(parts[6]),
          tempBytes: number(parts[7]),
          deadlocks: number(parts[8]),
          blockReadMs: number(parts[9]),
          blockWriteMs: number(parts[10]),
        };
        break;
      case "DBWAIT":
        snapshot.databaseWaits[parts[1]] ??= [];
        snapshot.databaseWaits[parts[1]].push({
          type: parts[2],
          event: parts[3],
          count: number(parts[4]),
        });
        break;
    }
  }
  return snapshot;
}

function deriveSnapshot(raw, previous) {
  const elapsedSeconds = previous
    ? Math.max(0.001, (Date.parse(raw.timestamp) - Date.parse(previous.timestamp)) / 1000)
    : null;
  const snapshot = {
    timestamp: raw.timestamp,
    host: { ...raw.host },
    containers: [],
    processes: [],
    disks: [],
    networkInterfaces: [],
    fileDescriptors: raw.fileDescriptors,
    databases: Object.fromEntries(
      Object.entries(raw.databases).map(([name, database]) => [
        name,
        { ...database },
      ]),
    ),
    databaseWaits: raw.databaseWaits,
  };
  delete snapshot.host.cpuRaw;

  const cpuRows = Object.entries(raw.host.cpuRaw ?? {}).map(([name, values]) => {
    const before = previous?.host.cpuRaw?.[name];
    return cpuPercentages(name, values, before);
  });
  snapshot.host.cpu = cpuRows.find((item) => item.name === "cpu") ?? null;
  snapshot.host.cpuCount = raw.meta.cpuCount || cpuRows.filter((item) => item.name !== "cpu").length;
  snapshot.host.perCore = cpuRows.filter((item) => item.name !== "cpu");

  snapshot.disks = raw.disks.map((disk) => {
    const before = previous?.disks.find((item) => item.name === disk.name);
    return diskRates(disk, before, elapsedSeconds);
  });
  snapshot.networkInterfaces = raw.networkInterfaces.map((item) => {
    const before = previous?.networkInterfaces.find((entry) => entry.name === item.name);
    return {
      ...item,
      rxBytesPerSecond: rate(item.rxBytes, before?.rxBytes, elapsedSeconds),
      txBytesPerSecond: rate(item.txBytes, before?.txBytes, elapsedSeconds),
    };
  });
  const externalNetwork = snapshot.networkInterfaces.find(
    (item) => item.name === raw.meta.defaultNetworkInterface,
  );
  snapshot.host.defaultNetworkInterface = raw.meta.defaultNetworkInterface;
  snapshot.host.networkRxBytesPerSecond = externalNetwork?.rxBytesPerSecond ?? 0;
  snapshot.host.networkTxBytesPerSecond = externalNetwork?.txBytesPerSecond ?? 0;

  snapshot.containers = raw.containers.map((item) => {
    const before = previous?.containers.find((entry) => entry.name === item.name);
    const [memoryUsedBytes, memoryLimitBytes] = parseIoPair(item.memory);
    const [networkRxBytes, networkTxBytes] = parseIoPair(item.netIo);
    const [blockReadBytes, blockWriteBytes] = parseIoPair(item.blockIo);
    const [beforeNetworkRx, beforeNetworkTx] = parseIoPair(before?.netIo);
    const [beforeBlockRead, beforeBlockWrite] = parseIoPair(before?.blockIo);
    return {
      ...item,
      memoryUsedBytes,
      memoryLimitBytes,
      networkRxBytesPerSecond: rate(networkRxBytes, beforeNetworkRx, elapsedSeconds),
      networkTxBytesPerSecond: rate(networkTxBytes, beforeNetworkTx, elapsedSeconds),
      blockReadBytesPerSecond: rate(blockReadBytes, beforeBlockRead, elapsedSeconds),
      blockWriteBytesPerSecond: rate(blockWriteBytes, beforeBlockWrite, elapsedSeconds),
    };
  });

  const priorProcesses = new Map(
    (previous?.processes ?? []).map((item) => [processKey(item), item]),
  );
  const processes = raw.processes.map((item) => {
    const before = priorProcesses.get(processKey(item));
    const cpuPercent =
      before && elapsedSeconds
        ? (100 * Math.max(0, item.cpuTicks - before.cpuTicks)) /
          raw.meta.clockTicks /
          elapsedSeconds
        : null;
    return {
      pid: item.pid,
      ppid: item.ppid,
      startTicks: item.startTicks,
      container: item.container,
      name: item.name,
      cpuPercent,
      rssMiB: item.rssKiB / 1024,
      readBytesPerSecond: rate(item.readBytes, before?.readBytes, elapsedSeconds),
      writeBytesPerSecond: rate(item.writeBytes, before?.writeBytes, elapsedSeconds),
    };
  }).filter((item) => !(item.name === "sh" && item.ppid === 0));
  const selectedProcessKeys = new Set();
  for (const field of ["cpuPercent", "rssMiB", "readBytesPerSecond", "writeBytesPerSecond"]) {
    [...processes]
      .sort((a, b) => number(b[field]) - number(a[field]))
      .slice(0, 15)
      .forEach((item) => selectedProcessKeys.add(processKey(item)));
  }
  snapshot.processes = processes.filter((item) =>
    selectedProcessKeys.has(processKey(item)),
  );

  for (const [name, database] of Object.entries(snapshot.databases)) {
    const before = previous?.databases?.[name]?.raw;
    const current = database.raw;
    if (!current) continue;
    database.transactionsPerSecond = rate(
      current.commits + current.rollbacks,
      before ? before.commits + before.rollbacks : null,
      elapsedSeconds,
    );
    database.blocksReadPerSecond = rate(
      current.blocksRead,
      before?.blocksRead,
      elapsedSeconds,
    );
    database.tempBytesPerSecond = rate(
      current.tempBytes,
      before?.tempBytes,
      elapsedSeconds,
    );
    database.cacheHitPercent =
      current.blocksHit + current.blocksRead > 0
        ? (100 * current.blocksHit) / (current.blocksHit + current.blocksRead)
        : 100;
    delete database.raw;
  }
  return snapshot;
}

function cpuPercentages(name, current, previous) {
  if (!previous) return { name };
  const delta = current.map((value, index) => Math.max(0, value - (previous[index] ?? 0)));
  const total = sum(delta);
  const pct = (value) => (total > 0 ? (100 * value) / total : 0);
  const userPercent = pct(delta[0] + delta[1]);
  const systemPercent = pct(delta[2] + delta[5] + delta[6]);
  const idlePercent = pct(delta[3]);
  const ioWaitPercent = pct(delta[4]);
  const stealPercent = pct(delta[7]);
  return {
    name,
    busyPercent: Math.max(0, 100 - idlePercent - ioWaitPercent),
    userPercent,
    systemPercent,
    ioWaitPercent,
    idlePercent,
    stealPercent,
  };
}

function diskRates(disk, before, elapsedSeconds) {
  const current = disk.raw;
  const prior = before?.raw;
  const reads = difference(current[0], prior?.[0]);
  const sectorsRead = difference(current[2], prior?.[2]);
  const readMs = difference(current[3], prior?.[3]);
  const writes = difference(current[4], prior?.[4]);
  const sectorsWritten = difference(current[6], prior?.[6]);
  const writeMs = difference(current[7], prior?.[7]);
  const ioMs = difference(current[9], prior?.[9]);
  const weightedIoMs = difference(current[10], prior?.[10]);
  return {
    name: disk.name,
    readBytesPerSecond: elapsedSeconds ? (sectorsRead * 512) / elapsedSeconds : null,
    writeBytesPerSecond: elapsedSeconds
      ? (sectorsWritten * 512) / elapsedSeconds
      : null,
    readIops: elapsedSeconds ? reads / elapsedSeconds : null,
    writeIops: elapsedSeconds ? writes / elapsedSeconds : null,
    readAwaitMs: reads > 0 ? readMs / reads : 0,
    writeAwaitMs: writes > 0 ? writeMs / writes : 0,
    utilizationPercent: elapsedSeconds ? (100 * ioMs) / (elapsedSeconds * 1000) : null,
    averageQueueSize: elapsedSeconds ? weightedIoMs / (elapsedSeconds * 1000) : null,
  };
}

async function currentStage(timestamp) {
  let trafficStart;
  try {
    trafficStart = Date.parse((await readFile(trafficStartFile, "utf8")).trim());
  } catch {
    return { phase: "preflight", targetVus: 0, estimatedVus: 0 };
  }
  if (!Number.isFinite(trafficStart)) {
    return { phase: "preflight", targetVus: 0, estimatedVus: 0 };
  }
  const stages = profiles[profile]?.stages ?? [];
  let elapsed = Math.max(0, (Date.parse(timestamp) - trafficStart) / 1000);
  let previousTarget = 0;
  for (let index = 0; index < stages.length; index += 1) {
    const stage = stages[index];
    const durationSeconds = parseDurationSeconds(stage.duration);
    if (elapsed <= durationSeconds) {
      const phase = stage.target === previousTarget
        ? "hold"
        : stage.target > previousTarget
          ? "ramp-up"
          : "ramp-down";
      const ratio = durationSeconds > 0 ? elapsed / durationSeconds : 1;
      return {
        index,
        phase,
        targetVus: stage.target,
        estimatedVus: Math.round(
          phase === "hold"
            ? stage.target
            : previousTarget + (stage.target - previousTarget) * ratio,
        ),
        elapsedSeconds: Math.round((Date.parse(timestamp) - trafficStart) / 1000),
      };
    }
    elapsed -= durationSeconds;
    previousTarget = stage.target;
  }
  return {
    phase: "complete",
    targetVus: previousTarget,
    estimatedVus: previousTarget,
    elapsedSeconds: Math.round((Date.parse(timestamp) - trafficStart) / 1000),
  };
}

function parseDurationSeconds(value) {
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h)$/.exec(String(value));
  if (!match) return 0;
  const factor = { ms: 0.001, s: 1, m: 60, h: 3600 }[match[2]];
  return Number(match[1]) * factor;
}

function parseIoPair(value) {
  const [left = "0", right = "0"] = String(value ?? "").split(" / ");
  return [parseByteSize(left), parseByteSize(right)];
}

function parseByteSize(value) {
  const match = /^([\d.]+)\s*([kmgtpe]?i?b)?$/i.exec(String(value).trim());
  if (!match) return 0;
  const units = {
    b: 1,
    kb: 1e3,
    mb: 1e6,
    gb: 1e9,
    tb: 1e12,
    kib: 1024,
    mib: 1024 ** 2,
    gib: 1024 ** 3,
    tib: 1024 ** 4,
  };
  return Number(match[1]) * (units[(match[2] || "b").toLowerCase()] ?? 1);
}

function rate(current, previous, elapsedSeconds) {
  if (!elapsedSeconds || !Number.isFinite(previous)) return null;
  return Math.max(0, current - previous) / elapsedSeconds;
}

function difference(current, previous) {
  return Number.isFinite(previous) ? Math.max(0, current - previous) : 0;
}

function sum(values) {
  return values.reduce((total, value) => total + (Number(value) || 0), 0);
}

function processKey(item) {
  return `${item.container}:${item.pid}:${item.startTicks}`;
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

default_interface=$(ip route show default 2>/dev/null | awk 'NR == 1 {print $5}')
printf 'META|%s|%s|%s\n' "$(getconf CLK_TCK)" "$(nproc)" "$default_interface"

read -r load1 load5 load15 _ < /proc/loadavg
mem_total_kib=$(awk '/^MemTotal:/ {print $2}' /proc/meminfo)
mem_available_kib=$(awk '/^MemAvailable:/ {print $2}' /proc/meminfo)
buffers_kib=$(awk '/^Buffers:/ {print $2}' /proc/meminfo)
cached_kib=$(awk '/^Cached:/ {print $2}' /proc/meminfo)
dirty_kib=$(awk '/^Dirty:/ {print $2}' /proc/meminfo)
swap_total_kib=$(awk '/^SwapTotal:/ {print $2}' /proc/meminfo)
swap_free_kib=$(awk '/^SwapFree:/ {print $2}' /proc/meminfo)
mem_used_mib=$(( (mem_total_kib - mem_available_kib) / 1024 ))
mem_total_mib=$(( mem_total_kib / 1024 ))
mem_available_mib=$(( mem_available_kib / 1024 ))
swap_used_mib=$(( (swap_total_kib - swap_free_kib) / 1024 ))
swap_total_mib=$(( swap_total_kib / 1024 ))
disk_used=$(df -P /var | awk 'NR==2 {gsub("%","",$5); print $5}')
tcp_established=$(ss -Htan state established 2>/dev/null | wc -l | tr -d ' ')
printf 'HOST|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s\n' \
  "$load1" "$load5" "$load15" "$mem_used_mib" "$mem_total_mib" \
  "$swap_used_mib" "$disk_used" "$tcp_established" "$mem_available_mib" \
  "$((buffers_kib / 1024))" "$((cached_kib / 1024))" \
  "$((dirty_kib / 1024))" "$swap_total_mib"

awk '/^cpu/ {printf "CPU|%s|%s|%s|%s|%s|%s|%s|%s|%s\n",$1,$2,$3,$4,$5,$6,$7,$8,$9}' /proc/stat

for resource in cpu memory io; do
  if [ -r "/proc/pressure/$resource" ]; then
    while read -r scope avg10 avg60 avg300 total; do
      avg10=$(printf '%s' "$avg10" | cut -d= -f2)
      avg60=$(printf '%s' "$avg60" | cut -d= -f2)
      avg300=$(printf '%s' "$avg300" | cut -d= -f2)
      total=$(printf '%s' "$total" | cut -d= -f2)
      printf 'PSI|%s|%s|%s|%s|%s|%s\n' "$resource" "$scope" \
        "$avg10" "$avg60" "$avg300" "$total"
    done < "/proc/pressure/$resource"
  fi
done

for stat_file in /sys/block/*/stat; do
  device_dir=$(dirname "$stat_file")
  device=$(basename "$device_dir")
  case "$device" in loop*|ram*|sr*|fd*) continue ;; esac
  read -r reads read_merges read_sectors read_ms writes write_merges \
    write_sectors write_ms in_progress io_ms weighted_io_ms _ < "$stat_file"
  printf 'DISK|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s\n' \
    "$device" "$reads" "$read_merges" "$read_sectors" "$read_ms" \
    "$writes" "$write_merges" "$write_sectors" "$write_ms" \
    "$in_progress" "$io_ms" "$weighted_io_ms"
done

for interface_dir in /sys/class/net/*; do
  interface=$(basename "$interface_dir")
  [ "$interface" = "lo" ] && continue
  rx=$(cat "$interface_dir/statistics/rx_bytes" 2>/dev/null || printf 0)
  tx=$(cat "$interface_dir/statistics/tx_bytes" 2>/dev/null || printf 0)
  printf 'NET|%s|%s|%s\n' "$interface" "$rx" "$tx"
done

docker stats --no-stream --format \
  'CONTAINER|{{.Name}}|{{.CPUPerc}}|{{.MemUsage}}|{{.MemPerc}}|{{.NetIO}}|{{.BlockIO}}|{{.PIDs}}'

for container in $(docker ps --format '{{.Names}}'); do
  docker exec "$container" sh -c '
    container_name=$1
    for proc_dir in /proc/[0-9]*; do
      [ -r "$proc_dir/stat" ] || continue
      stat=$(cat "$proc_dir/stat" 2>/dev/null) || continue
      rest=$(printf "%s" "$stat" | sed "s/^.*) //")
      set -- $rest
      [ "$#" -ge 22 ] || continue
      pid=$(basename "$proc_dir")
      ppid=$2
      shift 11
      utime=$1
      stime=$2
      start_ticks=$9
      rss_kib=0
      while read -r status_key status_value _; do
        if [ "$status_key" = "VmRSS:" ]; then
          rss_kib=$status_value
          break
        fi
      done < "$proc_dir/status"
      [ "$rss_kib" -gt 0 ] 2>/dev/null || continue
      read_bytes=0
      write_bytes=0
      while read -r io_key io_value; do
        case "$io_key" in
          read_bytes:) read_bytes=$io_value ;;
          write_bytes:) write_bytes=$io_value ;;
        esac
      done < "$proc_dir/io"
      process_name=$(tr "|\\n" "  " < "$proc_dir/comm" 2>/dev/null)
      [ -n "$process_name" ] || process_name=unknown
      printf "PROC|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s\\n" \
        "$pid" "$start_ticks" "$ppid" "$container_name" "$process_name" \
        "$rss_kib" "$read_bytes" "$write_bytes" "$utime" "$stime"
    done
  ' collector "$container" 2>/dev/null || true
done

for container in infra-caddy-1 infra-synapse-1 infra-session-manager-1 infra-chat-service-1; do
  if docker inspect "$container" >/dev/null 2>&1; then
    used=$(docker exec "$container" sh -c 'ls /proc/1/fd 2>/dev/null | wc -l' | tr -d ' ')
    limit=$(docker exec "$container" sh -c 'ulimit -n' 2>/dev/null | tr -d ' ')
    printf 'FD|%s|%s|%s\n' "$container" "$used" "$limit"
  fi
done

collect_database() {
  label=$1
  container=$2
  database_user=$3
  database_name=$4
  connection=$(docker exec "$container" psql -U "$database_user" -d "$database_name" -AtF '|' -c \
    "select count(*) filter (where state = 'active'), count(*), current_setting('max_connections'), coalesce(max(extract(epoch from (clock_timestamp() - query_start))) filter (where state = 'active'), 0)::numeric(12,3), current_setting('track_io_timing') from pg_stat_activity;" \
    2>/dev/null || true)
  [ -n "$connection" ] && printf 'DB|%s|%s\n' "$label" "$connection"

  statistics=$(docker exec "$container" psql -U "$database_user" -d "$database_name" -AtF '|' -c \
    "select xact_commit, xact_rollback, blks_read, blks_hit, temp_files, temp_bytes, deadlocks, blk_read_time, blk_write_time from pg_stat_database where datname = current_database();" \
    2>/dev/null || true)
  [ -n "$statistics" ] && printf 'DBSTAT|%s|%s\n' "$label" "$statistics"

  docker exec "$container" psql -U "$database_user" -d "$database_name" -AtF '|' -c \
    "select coalesce(wait_event_type, 'CPU'), coalesce(wait_event, 'running'), count(*) from pg_stat_activity where pid <> pg_backend_pid() group by 1,2 order by 3 desc;" \
    2>/dev/null | while IFS= read -r wait; do
      [ -n "$wait" ] && printf 'DBWAIT|%s|%s\n' "$label" "$wait"
    done
}

collect_database research infra-research-db-1 gdm gdm_research
collect_database synapse infra-synapse-db-1 synapse synapse
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
    .grid { display:grid; grid-template-columns:repeat(6,minmax(0,1fr)); gap:12px; margin-bottom:12px; }
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
  <section class="split">
    <div class="panel"><h2>CPU per core</h2><div id="cores"></div></div>
    <div class="panel"><h2>Block devices</h2><div id="disks"></div></div>
  </section>
  <section class="panel"><h2>Containers</h2><div id="containers"></div></section>
  <section class="panel"><h2>Highest-resource processes</h2><div id="processes"></div></section>
</main>
<script>
const colors={cyan:"#49d6c7",blue:"#64a8ff",line:"#20344c",muted:"#8fa4ba"};
async function refresh(){
  const data=await fetch("/api/snapshots",{cache:"no-store"}).then(r=>r.json());
  const latest=data.history[data.history.length-1]||{};
  const stage=latest.stage||{};
  document.getElementById("meta").innerHTML =
    '<span class="status"><i class="dot"></i>'+esc(data.profile)+'</span> · '+esc(data.conditionId)+
    ' · '+esc(data.sshTarget)+' · '+esc(stage.phase||"preflight")+' '+fmt(stage.estimatedVus)+' VUs · '+
    (latest.timestamp?new Date(latest.timestamp).toLocaleTimeString():"waiting");
  document.getElementById("error").innerHTML=latest.error?'<p class="error">'+esc(latest.error)+'</p>':"";
  const h=latest.host||{}, db=latest.databases||{};
  cards([
    ["CPU busy",fmt(h.cpu?.busyPercent)+"%",pct(h.cpu?.busyPercent)],
    ["CPU I/O wait",fmt(h.cpu?.ioWaitPercent)+"%",pct(h.cpu?.ioWaitPercent)],
    ["Load 1 / "+fmt(h.cpuCount)+" cores",fmt(h.load1),pct((h.load1||0)/(h.cpuCount||1)*100)],
    ["Host memory",fmt(h.memoryUsedMiB)+" MiB",pct((h.memoryUsedMiB||0)/(h.memoryTotalMiB||1)*100)],
    ["Busiest disk",fmt(Math.max(0,...(latest.disks||[]).map(v=>v.utilizationPercent||0)))+"%",pct(Math.max(0,...(latest.disks||[]).map(v=>v.utilizationPercent||0)))],
    ["DB connections",fmt((db.research?.total||0)+(db.synapse?.total||0)),null]
  ]);
  renderFds(latest.fileDescriptors||{});
  renderCores(h.perCore||[]);
  renderDisks(latest.disks||[]);
  renderContainers(latest.containers||[]);
  renderProcesses(latest.processes||[]);
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
    '<td>'+fmt((v.memoryUsedBytes||0)/1048576)+' MiB</td><td>'+rate(v.networkRxBytesPerSecond)+' / '+rate(v.networkTxBytesPerSecond)+'</td><td>'+rate(v.blockReadBytesPerSecond)+' / '+rate(v.blockWriteBytesPerSecond)+'</td><td class="num">'+fmt(v.pids)+'</td></tr>');
  document.getElementById("containers").innerHTML='<table><thead><tr><th>Service</th><th>CPU</th><th>Memory</th><th>Network RX/TX</th><th>Block read/write</th><th>PIDs</th></tr></thead><tbody>'+
    rows.join("")+'</tbody></table>';
}
function renderCores(items){
  const rows=items.map(v=>'<tr><td>'+esc(v.name)+'</td><td>'+fmt(v.busyPercent)+'%</td><td>'+fmt(v.userPercent)+'%</td><td>'+fmt(v.systemPercent)+'%</td><td>'+fmt(v.ioWaitPercent)+'%</td><td>'+fmt(v.stealPercent)+'%</td></tr>');
  document.getElementById("cores").innerHTML='<table><thead><tr><th>Core</th><th>Busy</th><th>User</th><th>System</th><th>I/O wait</th><th>Steal</th></tr></thead><tbody>'+rows.join("")+'</tbody></table>';
}
function renderDisks(items){
  const rows=[...items].sort((a,b)=>(b.utilizationPercent||0)-(a.utilizationPercent||0)).map(v=>'<tr><td>'+esc(v.name)+'</td><td>'+fmt(v.utilizationPercent)+'%</td><td>'+rate(v.readBytesPerSecond)+'</td><td>'+rate(v.writeBytesPerSecond)+'</td><td>'+fmt(v.readAwaitMs)+' ms</td><td>'+fmt(v.writeAwaitMs)+' ms</td></tr>');
  document.getElementById("disks").innerHTML='<table><thead><tr><th>Device</th><th>Util</th><th>Read</th><th>Write</th><th>Read await</th><th>Write await</th></tr></thead><tbody>'+rows.join("")+'</tbody></table>';
}
function renderProcesses(items){
  const rows=[...items].sort((a,b)=>(b.cpuPercent||0)-(a.cpuPercent||0)).slice(0,20).map(v=>'<tr><td>'+short(v.container)+'</td><td>'+esc(v.name)+'</td><td>'+fmt(v.pid)+'</td><td>'+fmt(v.cpuPercent)+'%</td><td>'+fmt(v.rssMiB)+' MiB</td><td>'+rate(v.readBytesPerSecond)+'</td><td>'+rate(v.writeBytesPerSecond)+'</td></tr>');
  document.getElementById("processes").innerHTML='<table><thead><tr><th>Container</th><th>Process</th><th>PID</th><th>CPU</th><th>RAM</th><th>Read</th><th>Write</th></tr></thead><tbody>'+rows.join("")+'</tbody></table>';
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
function rate(v){const n=Number(v);if(!Number.isFinite(n))return "—";if(n>=1048576)return fmt(n/1048576)+" MiB/s";if(n>=1024)return fmt(n/1024)+" KiB/s";return fmt(n)+" B/s"}
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
