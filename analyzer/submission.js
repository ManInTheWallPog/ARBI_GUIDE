(function () {
  "use strict";

  const ENDPOINT = "/api/analyzer/spawns";
  // v11 intentionally gets a fresh browser cache so previously accepted runs
  // can reconcile the arbi-analyzer-run/v3 rotation, wave and enemy-composition
  // series under the same canonical hash when their logs are analyzed again.
  const CACHE_KEY = "arbi-analyzer-accepted-run-hashes-v11";
  const CACHE_LIMIT = 5000;
  // Mirrors MAX_ENEMY_TYPES in parser.js.
  const MAX_ENEMY_TYPES = 60;
  // No real run has this many rotations or waves; the cap only bounds the body.
  const MAX_SERIES_LENGTH = 400;
  const MAX_ENEMY_TYPE_NAME = 120;
  const PRODUCTION_HOSTS = new Set(["arbi.guide"]);

  function isProductionHost(hostname = globalThis.location?.hostname || "") {
    return PRODUCTION_HOSTS.has(String(hostname).toLowerCase());
  }

  function acceptedHashes(storage = globalThis.localStorage) {
    if (!storage) return [];
    try {
      const value = JSON.parse(storage.getItem(CACHE_KEY) || "[]");
      return Array.isArray(value) ? value.filter((item) => /^[a-f0-9]{64}$/.test(item)).slice(-CACHE_LIMIT) : [];
    } catch (_) {
      return [];
    }
  }

  function rememberAccepted(runHash, storage = globalThis.localStorage) {
    if (!storage || !/^[a-f0-9]{64}$/.test(runHash)) return;
    const hashes = acceptedHashes(storage).filter((value) => value !== runHash);
    hashes.push(runHash);
    try { storage.setItem(CACHE_KEY, JSON.stringify(hashes.slice(-CACHE_LIMIT))); } catch (_) { /* private mode/quota */ }
  }

  function isNonNegativeSeries(value) {
    return Array.isArray(value)
      && value.length <= MAX_SERIES_LENGTH
      && value.every((entry) => Number.isFinite(entry) && entry >= 0);
  }

  function isCountSeries(value) {
    return Array.isArray(value)
      && value.length <= MAX_SERIES_LENGTH
      && value.every((entry) => Number.isInteger(entry) && entry >= 0);
  }

  function total(values) {
    return values.reduce((sum, entry) => sum + entry, 0);
  }

  // Unit-type counts arrive as a plain object; reject anything carrying a
  // prototype or non-own keys so the Worker never sees a surprising shape.
  function isEnemyComposition(value, enemySpawns) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    if (Object.getPrototypeOf(value) !== Object.prototype) return false;
    const names = Object.keys(value);
    if (names.length > MAX_ENEMY_TYPES) return false;
    let sum = 0;
    for (const name of names) {
      if (!name || name.length > MAX_ENEMY_TYPE_NAME) return false;
      const count = value[name];
      if (!Number.isInteger(count) || count < 1 || count > 100000000) return false;
      sum += count;
    }
    return sum <= enemySpawns;
  }

  function isValidPayload(payload) {
    const metrics = payload?.run_metrics;
    return Boolean(
      payload
      && payload.schema === "arbi-analyzer-run/v3"
      && /^(?:SolNode|ClanNode|SettlementNode)\d+$/.test(payload.sol_node || "")
      && typeof payload.mission_type === "string"
      && payload.mission_type.length > 0
      && payload.mission_type.length <= 40
      && /^[a-f0-9]{64}$/.test(payload.run_hash || "")
      && Number.isFinite(payload.run_offset_seconds)
      && payload.run_offset_seconds >= 0
      && Number.isInteger(payload.observed_spawn_events)
      && payload.observed_spawn_events >= 0
      && Array.isArray(payload.spawn_points)
      && metrics
      && Number.isFinite(metrics.mission_seconds)
      && metrics.mission_seconds > 0
      && Number.isFinite(metrics.active_seconds)
      && metrics.active_seconds >= 0
      && metrics.active_seconds <= metrics.mission_seconds + 0.01
      && Number.isInteger(metrics.drone_kills)
      && metrics.drone_kills >= 0
      && Number.isInteger(metrics.blessed_drone_kills)
      && metrics.blessed_drone_kills >= 0
      && metrics.blessed_drone_kills <= metrics.drone_kills
      && Number.isInteger(metrics.enemy_spawns)
      && metrics.enemy_spawns >= 0
      && Number.isFinite(metrics.high_enemy_seconds)
      && metrics.high_enemy_seconds >= 0
      && Number.isFinite(metrics.enemy_telemetry_seconds)
      && metrics.enemy_telemetry_seconds >= metrics.high_enemy_seconds
      && metrics.enemy_telemetry_seconds <= metrics.mission_seconds + 0.01
      && Array.isArray(metrics.enemy_count_seconds)
      && metrics.enemy_count_seconds.length === 52
      && metrics.enemy_count_seconds.every((seconds) => Number.isFinite(seconds) && seconds >= 0)
      && Math.abs(metrics.enemy_count_seconds.reduce((sum, seconds) => sum + seconds, 0)
        - metrics.enemy_telemetry_seconds) <= 0.05
      && Number.isFinite(metrics.drone_dry_seconds)
      && metrics.drone_dry_seconds >= 0
      && Number.isFinite(metrics.drone_cadence_seconds)
      && metrics.drone_cadence_seconds >= metrics.drone_dry_seconds
      && Number.isFinite(metrics.drone_interval_span_seconds)
      && metrics.drone_interval_span_seconds >= 0
      && metrics.drone_interval_span_seconds <= metrics.mission_seconds + 0.01
      && Number.isInteger(metrics.drone_interval_count)
      && metrics.drone_interval_count <= Math.max(0, metrics.drone_kills - 1)
      && (metrics.drone_interval_count > 0 || metrics.drone_interval_span_seconds === 0)
      && Number.isInteger(metrics.reward_cycles)
      && metrics.reward_cycles >= 0
      && Number.isInteger(metrics.defense_waves)
      && metrics.defense_waves >= 0
      // v3 series. Completed rotations are reward-to-reward active seconds, so
      // they cannot outlast the pause-filtered active window. Per-rotation
      // drone counts come from the same phases, hence the matching length, and
      // may be absent when the log carries no reward or drone timestamps.
      && isNonNegativeSeries(metrics.rotation_seconds)
      && total(metrics.rotation_seconds) <= metrics.active_seconds + 0.05
      && isCountSeries(metrics.rotation_drones)
      && (metrics.rotation_drones.length === 0
        || metrics.rotation_drones.length === metrics.rotation_seconds.length)
      && total(metrics.rotation_drones) <= metrics.drone_kills
      && isNonNegativeSeries(metrics.wave_seconds)
      && total(metrics.wave_seconds) <= metrics.mission_seconds + 0.05
      && isEnemyComposition(metrics.enemy_type_counts, metrics.enemy_spawns)
      && typeof metrics.four_member_majority === "boolean"
    );
  }

  async function postPayload(payload, options = {}) {
    const storage = options.storage === undefined ? globalThis.localStorage : options.storage;
    const fetchImpl = options.fetchImpl || globalThis.fetch;
    const cached = new Set(acceptedHashes(storage));
    if (!options.force && cached.has(payload.run_hash)) return { status: "cached", run_hash: payload.run_hash };

    const controller = typeof AbortController === "undefined" ? null : new AbortController();
    const timer = controller ? setTimeout(() => controller.abort(), options.timeoutMs || 10000) : null;
    try {
      const response = await fetchImpl(ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        credentials: "omit",
        cache: "no-store",
        signal: controller?.signal,
      });
      let result = null;
      try { result = await response.json(); } catch (_) { /* handled below */ }
      if (!response.ok || !["accepted", "duplicate"].includes(result?.status)) {
        throw new Error(result?.error || `metrics endpoint returned ${response.status}`);
      }
      rememberAccepted(payload.run_hash, storage);
      return { status: result.status, run_hash: payload.run_hash };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async function submitRuns(runs, buildContribution, options = {}) {
    const summary = { accepted: 0, duplicate: 0, cached: 0, ineligible: 0, failed: 0 };
    if (!isProductionHost(options.hostname)) return { ...summary, disabled: true };

    const payloads = [];
    const seen = new Set();
    for (const run of runs) {
      try {
        const payload = await buildContribution(run);
        if (!isValidPayload(payload) || seen.has(payload.run_hash)) {
          summary.ineligible += 1;
          continue;
        }
        seen.add(payload.run_hash);
        payloads.push(payload);
      } catch (_) {
        summary.ineligible += 1;
      }
    }

    // A small fixed worker pool avoids flooding the endpoint for a very large
    // EE.log while still letting normal multi-run logs finish promptly.
    let cursor = 0;
    const worker = async () => {
      while (cursor < payloads.length) {
        const payload = payloads[cursor++];
        try {
          const result = await postPayload(payload, options);
          summary[result.status] += 1;
        } catch (_) {
          summary.failed += 1;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(3, payloads.length) }, worker));
    return summary;
  }

  const api = { ENDPOINT, CACHE_KEY, MAX_ENEMY_TYPES, isProductionHost, acceptedHashes, rememberAccepted, isValidPayload, postPayload, submitRuns };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  globalThis.ArbitrationSpawnSubmission = api;
})();
