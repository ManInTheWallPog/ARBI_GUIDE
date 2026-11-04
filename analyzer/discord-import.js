// Handoff: /analyzer/#discordLog=<encoded log url>&run=<index from newest> (query form also supported).
// GET the log straight from Discord's CDN, which serves attachments with
// Access-Control-Allow-Origin: *. Nothing is uploaded and no new endpoint is
// involved: this is a read of a log the user already attached to a Discord
// message, parsed locally by the same path as the file picker.
//
// The pointer rides in the fragment, so the signed attachment URL is never
// sent to this server or written to its logs. Only the browser resolves it.
// The ArbiGoons bot builds these links in cogs/arbi_logs.py.
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.ArbitrationDiscordImport = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const LOG_KEY = "discordLog";
  const RUN_KEY = "run";
  const MAX_BYTES = 2 * 1024 * 1024 * 1024;
  const TIMEOUT_MS = 120000;
  // Only Discord's own attachment hosts. Without this the link would be a way
  // to make the Analyzer fetch any URL an attacker chose.
  const DISCORD_HOSTS = new Set(["cdn.discordapp.com", "media.discordapp.net"]);
  const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
  let generation = 0;
  let activeController = null;
  let controls = null;

  function servedLocally() {
    return LOCAL_HOSTS.has(globalThis.location?.hostname || "");
  }

  // Discord hosts always. A local fixture host is accepted only while the
  // Analyzer itself is served from localhost, so this cannot widen anything
  // on the deployed site.
  function hostAllowed(url) {
    if (DISCORD_HOSTS.has(url.hostname) && url.protocol === "https:") return true;
    if (!servedLocally()) return false;
    return LOCAL_HOSTS.has(url.hostname) && (url.protocol === "https:" || url.protocol === "http:");
  }

  function readLink(href) {
    const url = new URL(href);
    const query = url.searchParams;
    const fragment = new URLSearchParams(url.hash.slice(1));
    const hasKeys = (params) => params.has(LOG_KEY) || params.has(RUN_KEY);
    if (!hasKeys(query) && !hasKeys(fragment)) return null;
    if (hasKeys(query) && hasKeys(fragment)) throw new Error("The Discord link contains conflicting import parameters. Open the run again from Discord.");
    const params = hasKeys(fragment) ? fragment : query;
    const rawLog = params.get(LOG_KEY) || "";
    const rawRun = params.get(RUN_KEY) || "0";
    if (params.getAll(LOG_KEY).length !== 1
      || params.getAll(RUN_KEY).length > 1
      || !/^\d{1,3}$/.test(rawRun)) {
      throw new Error("The Discord link is invalid. Run /analyze again, or choose your EE.log directly.");
    }
    let endpoint;
    try { endpoint = new URL(rawLog); }
    catch (_) { throw new Error("The Discord link is invalid. Run /analyze again, or choose your EE.log directly."); }
    if (!hostAllowed(endpoint)) {
      throw new Error("This link does not point at a Discord attachment. The Analyzer only imports logs from Discord's own CDN.");
    }
    params.delete(LOG_KEY);
    params.delete(RUN_KEY);
    if (params === fragment) url.hash = fragment.toString();
    const name = decodeURIComponent(endpoint.pathname.split("/").pop() || "") || "EE.log";
    return {
      endpoint: endpoint.href,
      runIndexFromNewest: Number(rawRun),
      filename: /\.(log|txt|gz)$/i.test(name) ? name : `${name || "EE"}.log`,
      cleanUrl: url.href,
    };
  }

  function removeControls() {
    controls?.remove();
    controls = null;
  }

  function cancel() {
    generation += 1;
    activeController?.abort();
    activeController = null;
    removeControls();
  }

  function setStatus(message, error = false) {
    const status = document.querySelector("#parseStatus");
    if (!status) return;
    status.className = `parse-status${error ? " error" : ""}`;
    status.textContent = message;
  }

  function showControl(label, action) {
    removeControls();
    const status = document.querySelector("#parseStatus");
    if (!status) return;
    controls = document.createElement("div");
    controls.id = "discordImportControls";
    const button = document.createElement("button");
    button.className = "secondary-button";
    button.type = "button";
    button.textContent = label;
    button.addEventListener("click", action);
    controls.append(button);
    status.after(controls);
  }

  async function download(link, signal, progress = () => {}, fetchImpl = globalThis.fetch) {
    const response = await fetchImpl(link.endpoint, {
      method: "GET",
      mode: "cors",
      credentials: "omit",
      cache: "no-store",
      redirect: "follow",
      referrerPolicy: "no-referrer",
      headers: { Accept: "text/plain" },
      signal,
    });
    // A redirect must not walk the request off Discord's CDN.
    if (response.url) {
      let landed = null;
      try { landed = new URL(response.url); } catch (_) { landed = null; }
      if (!landed || !hostAllowed(landed)) throw new Error("This log redirected off Discord's CDN and was not imported.");
    }
    if (response.status === 404 || response.status === 403) {
      throw new Error("This link has expired. Discord attachment links are only valid for about a day - run /analyze again, or choose your EE.log directly.");
    }
    if (!response.ok) throw new Error(`Discord could not return this log (HTTP ${response.status}). Try again, or choose your EE.log directly.`);
    const type = (response.headers.get("Content-Type") || "").split(";", 1)[0].trim().toLowerCase();
    if (type && !["text/plain", "application/octet-stream", "application/gzip", "application/x-gzip"].includes(type)) {
      throw new Error("That attachment is not a log file. The Analyzer needs the original EE.log as plain text or .gz.");
    }
    const length = Number(response.headers.get("Content-Length")) || 0;
    if (length > MAX_BYTES) throw new Error("This log exceeds 2 GB. Choose the file directly instead.");
    const chunks = [];
    let bytes = 0;
    if (response.body?.getReader) {
      const reader = response.body.getReader();
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          if (signal.aborted) throw new DOMException("Import cancelled", "AbortError");
          bytes += value.byteLength;
          if (bytes > MAX_BYTES) throw new Error("This log exceeds 2 GB. Choose the file directly instead.");
          chunks.push(value);
          progress(bytes);
        }
      } catch (error) {
        await reader.cancel().catch(() => {});
        throw error;
      } finally { reader.releaseLock(); }
    } else {
      const blob = await response.blob();
      bytes = blob.size;
      if (bytes > MAX_BYTES) throw new Error("This log exceeds 2 GB. Choose the file directly instead.");
      chunks.push(blob);
    }
    if (signal.aborted) throw new DOMException("Import cancelled", "AbortError");
    if (!bytes) throw new Error("Discord returned an empty log. Run /analyze again.");
    return new File(chunks, link.filename, { type: "text/plain" });
  }

  // The Analyzer lists runs oldest-first; the link counts from the newest, the
  // same way the Discord run picker does. Out-of-range falls back to the
  // newest run, since the log may have been trimmed since the link was made.
  function selectRun(runIndexFromNewest) {
    const buttons = Array.from(document.querySelectorAll("#runList .run-button"));
    if (buttons.length < 2) return;
    const wanted = buttons.length - 1 - runIndexFromNewest;
    const target = buttons.find((button) => Number(button.dataset.index) === wanted)
      || buttons[buttons.length - 1];
    if (!target.classList.contains("active")) target.click();
  }

  async function load(link, importFile) {
    cancel();
    const current = generation;
    const controller = new AbortController();
    activeController = controller;
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, TIMEOUT_MS);
    setStatus("Fetching your log from Discord...");
    showControl("Cancel import", () => {
      cancel();
      setStatus("Discord import cancelled. You can still choose a log file.");
    });
    try {
      const file = await download(link, controller.signal, (bytes) => {
        if (generation === current) setStatus(`Receiving log from Discord... ${(bytes / 1000000).toFixed(1)} MB`);
      });
      if (generation !== current) return;
      clearTimeout(timer);
      activeController = null;
      removeControls();
      const imported = await importFile(file, true, "discord");
      if (generation !== current) return;
      if (imported === false) showControl("Retry Discord import", () => { void load(); });
      else selectRun(link.runIndexFromNewest);
    } catch (error) {
      controller.abort();
      if (generation !== current) return;
      const message = timedOut
        ? "Discord did not respond in time. Retry, or choose your EE.log directly."
        : error instanceof TypeError || error.name === "AbortError"
          ? "Could not reach Discord to fetch this log. Check your connection, then retry or choose your EE.log directly."
          : error.message || "Could not import this run from Discord. Try again, or choose your EE.log directly.";
      setStatus(message, true);
      showControl("Retry Discord import", () => { void load(link, importFile); });
    } finally {
      clearTimeout(timer);
      if (activeController === controller) activeController = null;
    }
  }

  async function consume(importFile) {
    let link;
    try { link = readLink(globalThis.location.href); }
    catch (error) { setStatus(error.message, true); return; }
    if (!link) return;
    // Keep the signed attachment URL out of later page URLs and referrers.
    // replaceState does not fire hashchange, so this cannot re-enter.
    try { history.replaceState(history.state, "", link.cleanUrl); } catch (_) {}
    await load(link, importFile);
  }

  // Opening a second Discord link while the Analyzer is already open changes
  // only the fragment, which does not reload the page. AlecaFrame avoids this
  // by handing over in the query string; the log URL is signed, so it stays in
  // the fragment here and the hash is watched instead.
  let listening = false;

  async function start(importFile) {
    if (!listening) {
      listening = true;
      globalThis.addEventListener("hashchange", () => { void consume(importFile); });
    }
    await consume(importFile);
  }

  return { readLink, download, selectRun, start, cancel };
});
