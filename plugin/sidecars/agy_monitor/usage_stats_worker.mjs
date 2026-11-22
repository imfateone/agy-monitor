import { parentPort, workerData } from 'node:worker_threads';
import { createUsageStatsCollector } from './usage_stats.mjs';

const collector = createUsageStatsCollector(workerData || {});

parentPort?.on('message', (msg) => {
  const id = msg?.id;
  try {
    const data = collector.readStats({
      nowMs: msg?.nowMs ?? Date.now(),
      forceRefresh: Boolean(msg?.forceRefresh),
    });
    parentPort.postMessage({ id, ok: true, data });
  } catch (err) {
    parentPort.postMessage({ id, ok: false, error: String(err?.message || err) });
  }
});
