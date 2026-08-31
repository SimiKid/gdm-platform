#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  copyFile,
  mkdir,
  readdir,
  readFile,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const resultDir = path.resolve(process.argv[2] || process.env.LOADTEST_RESULT_DIR || "");
if (!process.argv[2] && !process.env.LOADTEST_RESULT_DIR) {
  throw new Error("Usage: node loadtest/scripts/report.mjs <result-directory>");
}

const profiles = await readJson(path.join(scriptDir, "..", "profiles.json"), {});
const metadata = await readJson(path.join(resultDir, "run-metadata.json"), {});
const k6Summary = await readJson(path.join(resultDir, "summary.json"), {});
const snapshots = await readJsonLines(path.join(resultDir, "server-metrics.jsonl"));
if (snapshots.length === 0) {
  throw new Error(`No server metrics found in ${resultDir}`);
}

const profileName = metadata.profile || process.env.LOADTEST_PROFILE || "unknown";
const profile = profiles[profileName] ?? {};
const targets = holdTargets(profile, snapshots);
const stages = targets.map((target) => summarizeStage(target, snapshots, k6Summary));
const containers = targets.flatMap((target) =>
  summarizeEntities(target, snapshots, "containers", (item) => item.name),
);
const processes = targets.flatMap((target) => summarizeProcesses(target, snapshots));
const disks = targets.flatMap((target) =>
  summarizeEntities(target, snapshots, "disks", (item) => item.name),
);
const cores = targets.flatMap((target) => summarizeCores(target, snapshots));
const databases = targets.flatMap((target) => summarizeDatabases(target, snapshots));
const observations = buildObservations(stages, containers, processes, disks);
const canaryFiles = (await readdir(resultDir)).filter((name) =>
  /^browser-canary-\d+\.log$/.test(name),
);
const canaryResults = await Promise.all(
  canaryFiles.map(async (name) => {
    const contents = await readFile(path.join(resultDir, name), "utf8");
    return {
      name,
      passed: /\b\d+ passed\b/.test(contents) && !/\b\d+ failed\b/.test(contents),
    };
  }),
);
const report = {
  generatedAt: new Date().toISOString(),
  run: {
    id: path.basename(resultDir),
    profile: profileName,
    target: metadata.baseUrl ?? "unknown",
    conditionId: metadata.condition?.id ?? "unknown",
    startedAt: snapshots[0]?.timestamp,
    endedAt: snapshots.at(-1)?.timestamp,
    samples: snapshots.length,
    monitorIntervalSeconds: median(
      snapshots.slice(1).map((snapshot, index) =>
        (Date.parse(snapshot.timestamp) - Date.parse(snapshots[index].timestamp)) / 1000,
      ),
    ),
    hostCores: max(snapshots.map((snapshot) => snapshot.host?.cpuCount)),
    hostMemoryMiB: max(snapshots.map((snapshot) => snapshot.host?.memoryTotalMiB)),
    browserCanaries: {
      runs: canaryResults.length,
      passed: canaryResults.filter((item) => item.passed).length,
      failed: canaryResults.filter((item) => !item.passed).length,
    },
  },
  stages,
  containers,
  processes,
  disks,
  cores,
  databases,
  observations,
};

await writeFile(
  path.join(resultDir, "diagnostic-summary.json"),
  `${JSON.stringify(report, null, 2)}\n`,
);
await writeCsv(path.join(resultDir, "stage-summary.csv"), stages);
await writeCsv(path.join(resultDir, "container-summary.csv"), containers);
await writeCsv(path.join(resultDir, "process-summary.csv"), processes);
await writeCsv(path.join(resultDir, "disk-summary.csv"), disks);
await writeCsv(path.join(resultDir, "cpu-core-summary.csv"), cores);
await writeCsv(path.join(resultDir, "database-summary.csv"), databases);

const markdown = renderMarkdown(report);
const html = renderHtml(report);
await writeFile(path.join(resultDir, "diagnostic-report.md"), markdown);
await writeFile(path.join(resultDir, "diagnostic-report.html"), html);
await prepareShareBundle(resultDir);

process.stdout.write(`Diagnostic report written to ${resultDir}\n`);

function summarizeStage(target, allSnapshots, summary) {
  const rows = stableRows(target, allSnapshots);
  const host = (selector) => rows.map((row) => selector(row.host ?? {}));
  const cpuBusy = host((item) => item.cpu?.busyPercent);
  const ioWait = host((item) => item.cpu?.ioWaitPercent);
  const maximumCore = rows.map((row) =>
    max((row.host?.perCore ?? []).map((core) => core.busyPercent)),
  );
  const maximumCoreIoWait = rows.map((row) =>
    max((row.host?.perCore ?? []).map((core) => core.ioWaitPercent)),
  );
  const containerCpu = rows.map((row) =>
    sum((row.containers ?? []).map((item) => item.cpuPercent)),
  );
  const maximumDiskUtilization = rows.map((row) =>
    max((row.disks ?? []).map((item) => item.utilizationPercent)),
  );
  const maximumDiskAwait = rows.map((row) =>
    max(
      (row.disks ?? []).flatMap((item) => [item.readAwaitMs, item.writeAwaitMs]),
    ),
  );
  const fdRatios = rows.flatMap((row) =>
    Object.values(row.fileDescriptors ?? {}).map((item) =>
      item.limit > 0 ? (100 * item.used) / item.limit : 0,
    ),
  );
  const databaseRows = rows.flatMap((row) => Object.values(row.databases ?? {}));
  const tagged = (name) => summary.metrics?.[`${name}{load_target:${target}}`] ?? {};
  return {
    targetParticipants: target,
    samples: rows.length,
    observedMinutes: round(durationMinutes(rows), 2),
    loadAverage: round(average(host((item) => item.load1)), 2),
    loadP95: round(percentile(host((item) => item.load1), 95), 2),
    loadMax: round(max(host((item) => item.load1)), 2),
    cpuBusyAveragePercent: round(average(cpuBusy), 2),
    cpuBusyP95Percent: round(percentile(cpuBusy, 95), 2),
    cpuBusyMaxPercent: round(max(cpuBusy), 2),
    cpuIoWaitAveragePercent: round(average(ioWait), 2),
    cpuIoWaitP95Percent: round(percentile(ioWait, 95), 2),
    cpuIoWaitMaxPercent: round(max(ioWait), 2),
    busiestCoreP95Percent: round(percentile(maximumCore, 95), 2),
    busiestCoreMaxPercent: round(max(maximumCore), 2),
    busiestCoreIoWaitP95Percent: round(percentile(maximumCoreIoWait, 95), 2),
    memoryUsedAverageMiB: round(average(host((item) => item.memoryUsedMiB)), 1),
    memoryUsedMaxMiB: round(max(host((item) => item.memoryUsedMiB)), 1),
    memoryUsedMaxPercent: round(
      max(
        rows.map((row) =>
          row.host?.memoryTotalMiB
            ? (100 * row.host.memoryUsedMiB) / row.host.memoryTotalMiB
            : 0,
        ),
      ),
      2,
    ),
    swapUsedMaxMiB: round(max(host((item) => item.swapUsedMiB)), 1),
    cpuPressureSomeP95: round(
      percentile(host((item) => item.pressure?.cpu?.some?.avg10), 95),
      2,
    ),
    ioPressureSomeP95: round(
      percentile(host((item) => item.pressure?.io?.some?.avg10), 95),
      2,
    ),
    ioPressureFullP95: round(
      percentile(host((item) => item.pressure?.io?.full?.avg10), 95),
      2,
    ),
    memoryPressureSomeP95: round(
      percentile(host((item) => item.pressure?.memory?.some?.avg10), 95),
      2,
    ),
    containerCpuAveragePercent: round(average(containerCpu), 2),
    containerCpuP95Percent: round(percentile(containerCpu, 95), 2),
    containerCpuMaxPercent: round(max(containerCpu), 2),
    diskUtilizationP95Percent: round(percentile(maximumDiskUtilization, 95), 2),
    diskUtilizationMaxPercent: round(max(maximumDiskUtilization), 2),
    diskAwaitP95Ms: round(percentile(maximumDiskAwait, 95), 2),
    networkReceiveP95MiBPerSecond: round(
      percentile(host((item) => item.networkRxBytesPerSecond), 95) / 1024 ** 2,
      3,
    ),
    networkTransmitP95MiBPerSecond: round(
      percentile(host((item) => item.networkTxBytesPerSecond), 95) / 1024 ** 2,
      3,
    ),
    tcpEstablishedMax: max(host((item) => item.tcpEstablished)),
    fileDescriptorMaxPercent: round(max(fdRatios), 2),
    databaseActiveConnectionsMax: max(databaseRows.map((item) => item.active)),
    databaseTotalConnectionsMax: max(databaseRows.map((item) => item.total)),
    sessionOpenP95Ms: metricNumber(tagged("session_open_ms"), "p(95)"),
    groupReadyP95Ms: metricNumber(tagged("group_ready_ms"), "p(95)"),
    matrixSendAckP95Ms: metricNumber(tagged("matrix_send_ack_ms"), "p(95)"),
    matrixSendAckP99Ms: metricNumber(tagged("matrix_send_ack_ms"), "p(99)"),
    matrixPeerDeliveryP95Ms: metricNumber(
      tagged("matrix_peer_delivery_ms"),
      "p(95)",
    ),
    matrixPeerDeliveryP99Ms: metricNumber(
      tagged("matrix_peer_delivery_ms"),
      "p(99)",
    ),
    protocolFailureRatePercent: round(
      100 * metricNumber(tagged("protocol_failure_rate"), "value"),
      3,
    ),
  };
}

function summarizeEntities(target, allSnapshots, collection, identity) {
  const rows = stableRows(target, allSnapshots);
  const names = [
    ...new Set(rows.flatMap((row) => (row[collection] ?? []).map(identity))),
  ];
  return names.map((name) => {
    const values = rows
      .map((row) => (row[collection] ?? []).find((item) => identity(item) === name))
      .filter(Boolean);
    if (collection === "containers") {
      return {
        targetParticipants: target,
        container: name,
        cpuAveragePercent: round(average(values.map((item) => item.cpuPercent)), 2),
        cpuP95Percent: round(percentile(values.map((item) => item.cpuPercent), 95), 2),
        cpuMaxPercent: round(max(values.map((item) => item.cpuPercent)), 2),
        memoryMaxMiB: round(max(values.map((item) => item.memoryUsedBytes)) / 1024 ** 2, 2),
        memoryMaxPercent: round(max(values.map((item) => item.memoryPercent)), 2),
        blockReadP95MiBPerSecond: round(
          percentile(values.map((item) => item.blockReadBytesPerSecond), 95) /
            1024 ** 2,
          3,
        ),
        blockWriteP95MiBPerSecond: round(
          percentile(values.map((item) => item.blockWriteBytesPerSecond), 95) /
            1024 ** 2,
          3,
        ),
        networkReceiveP95MiBPerSecond: round(
          percentile(values.map((item) => item.networkRxBytesPerSecond), 95) /
            1024 ** 2,
          3,
        ),
        networkTransmitP95MiBPerSecond: round(
          percentile(values.map((item) => item.networkTxBytesPerSecond), 95) /
            1024 ** 2,
          3,
        ),
        pidsMax: max(values.map((item) => item.pids)),
      };
    }
    return {
      targetParticipants: target,
      device: name,
      utilizationAveragePercent: round(
        average(values.map((item) => item.utilizationPercent)),
        2,
      ),
      utilizationP95Percent: round(
        percentile(values.map((item) => item.utilizationPercent), 95),
        2,
      ),
      utilizationMaxPercent: round(
        max(values.map((item) => item.utilizationPercent)),
        2,
      ),
      readP95MiBPerSecond: round(
        percentile(values.map((item) => item.readBytesPerSecond), 95) / 1024 ** 2,
        3,
      ),
      writeP95MiBPerSecond: round(
        percentile(values.map((item) => item.writeBytesPerSecond), 95) / 1024 ** 2,
        3,
      ),
      readIopsP95: round(percentile(values.map((item) => item.readIops), 95), 2),
      writeIopsP95: round(percentile(values.map((item) => item.writeIops), 95), 2),
      readAwaitP95Ms: round(
        percentile(values.map((item) => item.readAwaitMs), 95),
        2,
      ),
      writeAwaitP95Ms: round(
        percentile(values.map((item) => item.writeAwaitMs), 95),
        2,
      ),
      queueSizeP95: round(
        percentile(values.map((item) => item.averageQueueSize), 95),
        3,
      ),
    };
  });
}

function summarizeProcesses(target, allSnapshots) {
  const rows = stableRows(target, allSnapshots);
  const identities = [
    ...new Set(
      rows.flatMap((row) =>
        (row.processes ?? []).map((item) => `${item.container}|${item.name}`),
      ),
    ),
  ];
  return identities.map((identity) => {
    const [container, process] = identity.split("|");
    const samples = rows.map((row) => {
      const matching = (row.processes ?? []).filter(
        (item) => item.container === container && item.name === process,
      );
      return {
        cpu: sum(matching.map((item) => item.cpuPercent)),
        // Individual PostgreSQL processes share memory pages, so summing RSS
        // would overstate use. Container memory remains the authoritative
        // total; here we report the largest process instance in the group.
        memory: max(matching.map((item) => item.rssMiB)),
        read: sum(matching.map((item) => item.readBytesPerSecond)),
        write: sum(matching.map((item) => item.writeBytesPerSecond)),
        instances: matching.length,
      };
    });
    return {
      targetParticipants: target,
      container,
      process,
      cpuAveragePercent: round(average(samples.map((item) => item.cpu)), 2),
      cpuP95Percent: round(percentile(samples.map((item) => item.cpu), 95), 2),
      cpuMaxPercent: round(max(samples.map((item) => item.cpu)), 2),
      memoryMaxMiB: round(max(samples.map((item) => item.memory)), 2),
      readP95MiBPerSecond: round(
        percentile(samples.map((item) => item.read), 95) / 1024 ** 2,
        3,
      ),
      writeP95MiBPerSecond: round(
        percentile(samples.map((item) => item.write), 95) / 1024 ** 2,
        3,
      ),
      instancesMax: max(samples.map((item) => item.instances)),
    };
  });
}

function summarizeCores(target, allSnapshots) {
  const rows = stableRows(target, allSnapshots);
  const names = [
    ...new Set(rows.flatMap((row) => (row.host?.perCore ?? []).map((core) => core.name))),
  ];
  return names.map((name) => {
    const values = rows
      .map((row) => (row.host?.perCore ?? []).find((core) => core.name === name))
      .filter(Boolean);
    return {
      targetParticipants: target,
      core: name,
      busyAveragePercent: round(average(values.map((item) => item.busyPercent)), 2),
      busyP95Percent: round(percentile(values.map((item) => item.busyPercent), 95), 2),
      busyMaxPercent: round(max(values.map((item) => item.busyPercent)), 2),
      ioWaitP95Percent: round(percentile(values.map((item) => item.ioWaitPercent), 95), 2),
      stealP95Percent: round(percentile(values.map((item) => item.stealPercent), 95), 2),
    };
  });
}

function summarizeDatabases(target, allSnapshots) {
  const rows = stableRows(target, allSnapshots);
  const names = [
    ...new Set(rows.flatMap((row) => Object.keys(row.databases ?? {}))),
  ];
  return names.map((name) => {
    const values = rows.map((row) => row.databases?.[name]).filter(Boolean);
    const waits = rows.flatMap((row) => row.databaseWaits?.[name] ?? []);
    const waitTotals = new Map();
    for (const wait of waits) {
      const key = `${wait.type}/${wait.event}`;
      waitTotals.set(key, Math.max(waitTotals.get(key) ?? 0, wait.count));
    }
    const topWait = [...waitTotals.entries()].sort((a, b) => b[1] - a[1])[0];
    return {
      targetParticipants: target,
      database: name,
      activeConnectionsMax: max(values.map((item) => item.active)),
      totalConnectionsMax: max(values.map((item) => item.total)),
      configuredMaxConnections: max(values.map((item) => item.max)),
      longestActiveQueryMaxSeconds: round(
        max(values.map((item) => item.longestActiveSeconds)),
        3,
      ),
      transactionsP95PerSecond: round(
        percentile(values.map((item) => item.transactionsPerSecond), 95),
        2,
      ),
      blocksReadP95PerSecond: round(
        percentile(values.map((item) => item.blocksReadPerSecond), 95),
        2,
      ),
      tempWriteP95MiBPerSecond: round(
        percentile(values.map((item) => item.tempBytesPerSecond), 95) / 1024 ** 2,
        3,
      ),
      cacheHitMinimumPercent: round(
        min(values.map((item) => item.cacheHitPercent)),
        3,
      ),
      topWaitEvent: topWait?.[0] ?? "none",
      topWaitCountMax: topWait?.[1] ?? 0,
      ioTimingEnabled: values.some((item) => item.trackIoTiming),
    };
  });
}

function stableRows(target, allSnapshots) {
  const rows = allSnapshots.filter(
    (snapshot) =>
      snapshot.stage?.phase === "hold" && snapshot.stage?.targetVus === target,
  );
  if (rows.length < 8) return rows;
  const settledAt = Date.parse(rows[0].timestamp) + 20_000;
  const settled = rows.filter((row) => Date.parse(row.timestamp) >= settledAt);
  return settled.length >= 4 ? settled : rows;
}

function holdTargets(selectedProfile, allSnapshots) {
  const observed = new Set(
    allSnapshots
      .filter((snapshot) => snapshot.stage?.phase === "hold")
      .map((snapshot) => snapshot.stage.targetVus)
      .filter((target) => target > 0),
  );
  const configured = [];
  let previousTarget = 0;
  for (const stage of selectedProfile.stages ?? []) {
    if (stage.target > 0 && stage.target === previousTarget) configured.push(stage.target);
    previousTarget = stage.target;
  }
  if (configured.length > 0) {
    return [...new Set(configured)].filter((target) => observed.has(target));
  }
  return [...observed];
}

function buildObservations(stageRows, containerRows, processRows, diskRows) {
  const observations = [];
  for (const stage of stageRows) {
    const target = stage.targetParticipants;
    if (stage.memoryUsedMaxPercent < 70 && stage.swapUsedMaxMiB === 0) {
      observations.push(
        `${target} participants: RAM pressure was not indicated ` +
          `(maximum ${format(stage.memoryUsedMaxPercent)}%, no swap use).`,
      );
    } else {
      observations.push(
        `${target} participants: memory requires review ` +
          `(maximum ${format(stage.memoryUsedMaxPercent)}%, swap ${format(stage.swapUsedMaxMiB)} MiB).`,
      );
    }
    if (stage.cpuBusyP95Percent >= 85) {
      observations.push(
        `${target} participants: host CPU was saturated at p95 ` +
          `(${format(stage.cpuBusyP95Percent)}%).`,
      );
    } else if (stage.busiestCoreP95Percent >= 90) {
      observations.push(
        `${target} participants: at least one core was saturated at p95 ` +
          `(${format(stage.busiestCoreP95Percent)}%) while total host CPU p95 was ` +
          `${format(stage.cpuBusyP95Percent)}%; inspect single-process or worker scaling.`,
      );
    }
    if (
      stage.cpuIoWaitP95Percent >= 10 ||
      stage.diskUtilizationP95Percent >= 80 ||
      stage.ioPressureSomeP95 >= 10
    ) {
      observations.push(
        `${target} participants: storage/I/O pressure was visible ` +
          `(iowait p95 ${format(stage.cpuIoWaitP95Percent)}%, disk utilization p95 ` +
          `${format(stage.diskUtilizationP95Percent)}%, I/O PSI p95 ${format(stage.ioPressureSomeP95)}%).`,
      );
    } else {
      observations.push(
        `${target} participants: no sustained storage saturation was indicated ` +
          `(iowait p95 ${format(stage.cpuIoWaitP95Percent)}%, disk utilization p95 ` +
          `${format(stage.diskUtilizationP95Percent)}%).`,
      );
    }
    const topContainer = containerRows
      .filter((row) => row.targetParticipants === target)
      .sort((a, b) => b.cpuAveragePercent - a.cpuAveragePercent)[0];
    const topProcess = processRows
      .filter((row) => row.targetParticipants === target)
      .sort((a, b) => b.cpuAveragePercent - a.cpuAveragePercent)[0];
    const topDisk = diskRows
      .filter((row) => row.targetParticipants === target)
      .sort((a, b) => b.utilizationP95Percent - a.utilizationP95Percent)[0];
    if (topContainer) {
      observations.push(
        `${target} participants: highest average container CPU was ${topContainer.container} ` +
          `at ${format(topContainer.cpuAveragePercent)}% ` +
          `(p95 ${format(topContainer.cpuP95Percent)}%).`,
      );
    }
    if (topProcess) {
      observations.push(
        `${target} participants: highest average process group was ` +
          `${topProcess.container}/${topProcess.process} at ` +
          `${format(topProcess.cpuAveragePercent)}% CPU.`,
      );
    }
    if (topDisk) {
      observations.push(
        `${target} participants: busiest block device was ${topDisk.device} ` +
          `(${format(topDisk.utilizationP95Percent)}% utilization p95).`,
      );
    }
  }
  return observations;
}

function renderMarkdown(data) {
  const stableTargets = participantTargetList(data.stages);
  const lines = [
    "# GDM Platform Diagnostic Load-Test Report",
    "",
    `Generated: ${data.generatedAt}`,
    "",
    "## Run metadata",
    "",
    `- Run: \`${data.run.id}\``,
    `- Profile: \`${data.run.profile}\``,
    `- Target: ${data.run.target}`,
    `- Observation window: ${data.run.startedAt} – ${data.run.endedAt}`,
    `- Host: ${format(data.run.hostCores)} CPU cores, ${format(data.run.hostMemoryMiB)} MiB RAM`,
    `- System samples: ${data.run.samples} at a median interval of ${format(data.run.monitorIntervalSeconds)} seconds`,
    `- Browser canaries: ${data.run.browserCanaries.runs} run(s), ${data.run.browserCanaries.passed} passed, ${data.run.browserCanaries.failed} failed`,
    "",
    "## Executive observations",
    "",
    ...data.observations.map((item) => `- ${item}`),
    "",
    "These observations identify measured pressure signals; they do not by themselves prove that a specific VM resize will resolve an application-level or single-process bottleneck.",
    "",
    "## Stage summary",
    "",
    markdownTable(
      [
        "Users",
        "CPU busy p95",
        "Busiest core p95",
        "I/O wait p95",
        "RAM max",
        "Swap max",
        "Disk util p95",
        "Load avg",
        "Peer delivery p95",
        "Failure rate",
      ],
      data.stages.map((stage) => [
        stage.targetParticipants,
        percent(stage.cpuBusyP95Percent),
        percent(stage.busiestCoreP95Percent),
        percent(stage.cpuIoWaitP95Percent),
        `${format(stage.memoryUsedMaxMiB)} MiB (${percent(stage.memoryUsedMaxPercent)})`,
        `${format(stage.swapUsedMaxMiB)} MiB`,
        percent(stage.diskUtilizationP95Percent),
        format(stage.loadAverage),
        milliseconds(stage.matrixPeerDeliveryP95Ms),
        percent(stage.protocolFailureRatePercent),
      ]),
    ),
    "",
    "## Highest-resource containers",
    "",
    markdownTable(
      ["Users", "Container", "CPU avg", "CPU p95", "CPU max", "RAM max", "Block write p95"],
      topPerTarget(data.containers, "cpuAveragePercent", 6).map((item) => [
        item.targetParticipants,
        item.container,
        percent(item.cpuAveragePercent),
        percent(item.cpuP95Percent),
        percent(item.cpuMaxPercent),
        `${format(item.memoryMaxMiB)} MiB`,
        `${format(item.blockWriteP95MiBPerSecond)} MiB/s`,
      ]),
    ),
    "",
    "## Highest-resource process groups",
    "",
    markdownTable(
      ["Users", "Container/process", "CPU avg", "CPU p95", "RAM max", "Read p95", "Write p95"],
      topPerTarget(data.processes, "cpuAveragePercent", 8).map((item) => [
        item.targetParticipants,
        `${item.container}/${item.process}`,
        percent(item.cpuAveragePercent),
        percent(item.cpuP95Percent),
        `${format(item.memoryMaxMiB)} MiB`,
        `${format(item.readP95MiBPerSecond)} MiB/s`,
        `${format(item.writeP95MiBPerSecond)} MiB/s`,
      ]),
    ),
    "",
    "## Disk and database evidence",
    "",
    markdownTable(
      ["Users", "Device", "Util p95", "Read p95", "Write p95", "Read await p95", "Write await p95"],
      topPerTarget(data.disks, "utilizationP95Percent", 6).map((item) => [
        item.targetParticipants,
        item.device,
        percent(item.utilizationP95Percent),
        `${format(item.readP95MiBPerSecond)} MiB/s`,
        `${format(item.writeP95MiBPerSecond)} MiB/s`,
        milliseconds(item.readAwaitP95Ms),
        milliseconds(item.writeAwaitP95Ms),
      ]),
    ),
    "",
    markdownTable(
      ["Users", "Database", "Connections", "TPS p95", "Cache hit min", "Top wait event"],
      data.databases.map((item) => [
        item.targetParticipants,
        item.database,
        `${item.totalConnectionsMax}/${item.configuredMaxConnections}`,
        format(item.transactionsP95PerSecond),
        percent(item.cacheHitMinimumPercent),
        `${item.topWaitEvent} (${item.topWaitCountMax})`,
      ]),
    ),
    "",
    "## Methodology and interpretation",
    "",
    "- k6 simulates participant enrollment, surveys, Matrix sync, typing, messages, reactions, cursor telemetry and ranking edits.",
    `- This profile ramps to and holds ${stableTargets} concurrent participants. Stage summaries exclude the first 20 seconds of each hold.`,
    "- Host and per-core CPU percentages are calculated from deltas in `/proc/stat`; I/O wait is reported separately from CPU busy time.",
    "- CPU, memory and disk I/O for application processes are calculated from `/proc` inside every running container.",
    "- Disk throughput, IOPS, utilization, queue size and await time are calculated from `/sys/block/*/stat` deltas. Device-mapper and backing-device rows can represent the same I/O path and must not be summed.",
    "- Pressure Stall Information comes from `/proc/pressure/{cpu,memory,io}` and indicates time workloads were delayed by resource contention.",
    "- PostgreSQL evidence includes connections, transaction rates, cache hit ratio, temporary writes and wait events.",
    "- PostgreSQL `ClientRead` and `Activity` waits normally represent idle clients/background workers, not storage contention; resource waits must be interpreted by wait type.",
    "- Process-group RAM is the largest individual RSS in that group because shared pages make summed PostgreSQL RSS misleading; container memory is authoritative for total use.",
    "- k6 latency rows tagged with a user target include that target's ramp and hold; system-resource summaries use only stable hold samples.",
    "- Full raw evidence and CSV tables are included in `share-with-admin/`.",
    "",
  ];
  return `${lines.join("\n")}\n`;
}

function renderHtml(data) {
  const stableTargets = participantTargetList(data.stages);
  const observations = data.observations
    .map((item) => `<li>${escapeHtml(item)}</li>`)
    .join("");
  const tables = [
    htmlTable("Stage summary", data.stages, [
      ["Users", "targetParticipants"],
      ["CPU busy p95 %", "cpuBusyP95Percent"],
      ["Busiest core p95 %", "busiestCoreP95Percent"],
      ["I/O wait p95 %", "cpuIoWaitP95Percent"],
      ["RAM max MiB", "memoryUsedMaxMiB"],
      ["Swap max MiB", "swapUsedMaxMiB"],
      ["Disk util p95 %", "diskUtilizationP95Percent"],
      ["Load avg", "loadAverage"],
      ["Peer p95 ms", "matrixPeerDeliveryP95Ms"],
      ["Failure %", "protocolFailureRatePercent"],
    ]),
    htmlTable("Top containers", topPerTarget(data.containers, "cpuAveragePercent", 6), [
      ["Users", "targetParticipants"],
      ["Container", "container"],
      ["CPU avg %", "cpuAveragePercent"],
      ["CPU p95 %", "cpuP95Percent"],
      ["CPU max %", "cpuMaxPercent"],
      ["RAM max MiB", "memoryMaxMiB"],
      ["Block write p95 MiB/s", "blockWriteP95MiBPerSecond"],
    ]),
    htmlTable("Top process groups", topPerTarget(data.processes, "cpuAveragePercent", 8), [
      ["Users", "targetParticipants"],
      ["Container", "container"],
      ["Process", "process"],
      ["CPU avg %", "cpuAveragePercent"],
      ["CPU p95 %", "cpuP95Percent"],
      ["RAM max MiB", "memoryMaxMiB"],
      ["Read p95 MiB/s", "readP95MiBPerSecond"],
      ["Write p95 MiB/s", "writeP95MiBPerSecond"],
    ]),
    htmlTable("Disk evidence", topPerTarget(data.disks, "utilizationP95Percent", 6), [
      ["Users", "targetParticipants"],
      ["Device", "device"],
      ["Util p95 %", "utilizationP95Percent"],
      ["Read p95 MiB/s", "readP95MiBPerSecond"],
      ["Write p95 MiB/s", "writeP95MiBPerSecond"],
      ["Read await p95 ms", "readAwaitP95Ms"],
      ["Write await p95 ms", "writeAwaitP95Ms"],
    ]),
    htmlTable("Database evidence", data.databases, [
      ["Users", "targetParticipants"],
      ["Database", "database"],
      ["Active max", "activeConnectionsMax"],
      ["Connections max", "totalConnectionsMax"],
      ["Configured max", "configuredMaxConnections"],
      ["TPS p95", "transactionsP95PerSecond"],
      ["Cache hit min %", "cacheHitMinimumPercent"],
      ["Top wait", "topWaitEvent"],
    ]),
  ].join("\n");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>GDM diagnostic load-test report</title>
<style>body{font:14px/1.5 system-ui,sans-serif;color:#172033;max-width:1200px;margin:40px auto;padding:0 24px}h1{font-size:30px}h2{margin-top:34px;border-bottom:2px solid #dce4ef;padding-bottom:8px}li{margin:5px 0}code{background:#eef2f7;padding:2px 5px;border-radius:4px}table{border-collapse:collapse;width:100%;margin:12px 0 28px;font-size:12px}th,td{border:1px solid #d8e0ea;padding:7px 8px;text-align:right}th{background:#eef3f8}th:nth-child(2),td:nth-child(2){text-align:left}.note{background:#f5f8fc;border-left:4px solid #3977c3;padding:12px}@media print{body{margin:0;max-width:none}table{break-inside:avoid}h2{break-after:avoid}}</style>
</head><body>
<h1>GDM Platform Diagnostic Load-Test Report</h1>
<p>Generated ${escapeHtml(data.generatedAt)}</p>
<h2>Run metadata</h2>
<ul>
  <li>Run: <code>${escapeHtml(data.run.id)}</code></li>
  <li>Profile: <code>${escapeHtml(data.run.profile)}</code></li>
  <li>Target: ${escapeHtml(data.run.target)}</li>
  <li>Observation window: ${escapeHtml(data.run.startedAt)} – ${escapeHtml(data.run.endedAt)}</li>
  <li>Host: ${escapeHtml(format(data.run.hostCores))} CPU cores, ${escapeHtml(format(data.run.hostMemoryMiB))} MiB RAM</li>
  <li>System samples: ${escapeHtml(format(data.run.samples))} at a median ${escapeHtml(format(data.run.monitorIntervalSeconds))}-second interval</li>
  <li>Browser canaries: ${escapeHtml(format(data.run.browserCanaries.runs))} run(s), ${escapeHtml(format(data.run.browserCanaries.passed))} passed, ${escapeHtml(format(data.run.browserCanaries.failed))} failed</li>
</ul>
<h2>Executive observations</h2><ul>${observations}</ul>
<div class="note">These observations identify measured pressure signals. They do not by themselves prove that a specific VM resize will resolve an application-level or single-process bottleneck.</div>
${tables}
<h2>Methodology and interpretation</h2>
<ul>
  <li>k6 simulates participant enrollment, surveys, Matrix sync, typing, chat, reactions, cursor telemetry and ranking edits.</li>
  <li>Stable holds at ${escapeHtml(stableTargets)} concurrent participants are summarized after a 20-second settling interval.</li>
  <li>Host/per-core CPU and I/O wait come from <code>/proc/stat</code> counter deltas; process metrics come from <code>/proc</code> inside each container.</li>
  <li>Disk throughput, IOPS, utilization, queue and await derive from <code>/sys/block/*/stat</code>. Device-mapper and backing-device rows may describe the same I/O path and are not summed.</li>
  <li>Pressure Stall Information comes from <code>/proc/pressure</code>; PostgreSQL metrics include connections, transactions, cache hit, temporary writes and wait events.</li>
  <li><code>ClientRead</code> and <code>Activity</code> waits usually represent idle clients/background workers, not storage contention.</li>
  <li>Container memory is authoritative; process-group RAM is the largest individual RSS because PostgreSQL shared pages make summed RSS misleading.</li>
  <li>Raw evidence, derived JSON and detailed CSV tables are included in <code>share-with-admin/</code>.</li>
</ul>
</body></html>`;
}

async function prepareShareBundle(directory) {
  const bundle = path.join(directory, "share-with-admin");
  await mkdir(bundle, { recursive: true });
  const names = [
    "diagnostic-report.html",
    "diagnostic-report.md",
    "diagnostic-summary.json",
    "stage-summary.csv",
    "container-summary.csv",
    "process-summary.csv",
    "disk-summary.csv",
    "cpu-core-summary.csv",
    "database-summary.csv",
    "run-metadata.json",
    "summary.json",
    "server-metrics.jsonl",
    "k6-report.html",
    "k6.log",
    "file-descriptor-preflight.txt",
    "diagnostic-preflight.txt",
    "load-generator-preflight.txt",
    "system-dashboard.log",
    "traffic-started-at.txt",
  ];
  names.push(
    ...(await readdir(directory)).filter((name) =>
      /^browser-canary-\d+\.log$/.test(name),
    ),
  );
  const copied = [];
  for (const name of names) {
    try {
      await copyFile(path.join(directory, name), path.join(bundle, name));
      copied.push(name);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  const checksums = [];
  for (const name of copied) {
    const contents = await readFile(path.join(bundle, name));
    checksums.push(`${createHash("sha256").update(contents).digest("hex")}  ${name}`);
  }
  await writeFile(path.join(bundle, "SHA256SUMS.txt"), `${checksums.join("\n")}\n`);
  await writeFile(
    path.join(bundle, "README.txt"),
    [
      "GDM diagnostic load-test evidence bundle",
      "",
      "Start with diagnostic-report.html (or diagnostic-report.md).",
      "CSV files contain stage-level resource evidence.",
      "diagnostic-summary.json contains the complete derived summary.",
      "server-metrics.jsonl and summary.json are the raw system and k6 evidence.",
      "SHA256SUMS.txt allows verification that files were not changed after generation.",
      "",
    ].join("\n"),
  );
}

function htmlTable(title, rows, columns) {
  const head = columns.map(([label]) => `<th>${escapeHtml(label)}</th>`).join("");
  const body = rows
    .map(
      (row) =>
        `<tr>${columns
          .map(([, key]) => `<td>${escapeHtml(format(row[key]))}</td>`)
          .join("")}</tr>`,
    )
    .join("");
  return `<h2>${escapeHtml(title)}</h2><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

function markdownTable(headers, rows) {
  return [
    `| ${headers.join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.map((value) => String(value ?? "—")).join(" | ")} |`),
  ].join("\n");
}

function participantTargetList(stages) {
  const targets = stages.map((stage) => format(stage.targetParticipants));
  if (targets.length < 2) return targets[0] ?? "no configured targets";
  return `${targets.slice(0, -1).join(", ")} and ${targets.at(-1)}`;
}

function topPerTarget(rows, field, count) {
  return [...new Set(rows.map((row) => row.targetParticipants))].flatMap((target) =>
    rows
      .filter((row) => row.targetParticipants === target)
      .sort((a, b) => number(b[field]) - number(a[field]))
      .slice(0, count),
  );
}

async function writeCsv(file, rows) {
  if (rows.length === 0) {
    await writeFile(file, "");
    return;
  }
  const headers = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  const lines = [headers.map(csvCell).join(",")];
  for (const row of rows) lines.push(headers.map((key) => csvCell(row[key])).join(","));
  await writeFile(file, `${lines.join("\n")}\n`);
}

function csvCell(value) {
  const text = value === null || value === undefined ? "" : String(value);
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return fallback;
    throw error;
  }
}

async function readJsonLines(file) {
  const contents = await readFile(file, "utf8");
  return contents
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((row) => !row.error);
}

function durationMinutes(rows) {
  if (rows.length < 2) return 0;
  return (Date.parse(rows.at(-1).timestamp) - Date.parse(rows[0].timestamp)) / 60_000;
}

function metricNumber(metric, key) {
  return round(number(metric?.[key]), 3);
}

function percentile(values, requested) {
  const sorted = finite(values).sort((a, b) => a - b);
  if (sorted.length === 0) return 0;
  const index = ((sorted.length - 1) * requested) / 100;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
}

function median(values) {
  return percentile(values, 50);
}

function average(values) {
  const selected = finite(values);
  return selected.length > 0 ? sum(selected) / selected.length : 0;
}

function max(values) {
  const selected = finite(values);
  return selected.length > 0 ? Math.max(...selected) : 0;
}

function min(values) {
  const selected = finite(values);
  return selected.length > 0 ? Math.min(...selected) : 0;
}

function sum(values) {
  return finite(values).reduce((total, value) => total + value, 0);
}

function finite(values) {
  return values.map(number).filter(Number.isFinite);
}

function number(value) {
  if (value === null || value === undefined || value === "") return Number.NaN;
  return Number(value);
}

function round(value, digits = 2) {
  return Number.isFinite(value) ? Number(value.toFixed(digits)) : 0;
}

function format(value) {
  if (value === null || value === undefined || value === "") return "—";
  return typeof value === "number"
    ? value.toLocaleString("en-GB", { maximumFractionDigits: 3 })
    : String(value);
}

function percent(value) {
  return Number.isFinite(number(value)) ? `${format(value)}%` : "—";
}

function milliseconds(value) {
  return Number.isFinite(number(value)) && number(value) > 0
    ? `${format(value)} ms`
    : "—";
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character]);
}
