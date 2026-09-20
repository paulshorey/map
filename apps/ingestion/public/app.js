const $ = (id) => document.getElementById(id);
const esc = (s) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const label = (s) => String(s ?? "unknown").replaceAll("_", " ");
const number = (n) => Number(n ?? 0).toLocaleString();
const date = (s) =>
  s
    ? new Date(s).toLocaleString([], {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "No recorded activity";
const badge = (s) => `<span class="badge ${esc(s)}">${esc(label(s))}</span>`;
let snapshot,
  view = "all",
  currentId = null,
  selectedRun = null,
  dirty = false,
  loading = false,
  detailEpoch = 0,
  runEpoch = 0;
let errorTimer;
async function api(path, method = "GET", data) {
  const response = await fetch(path, {
    method,
    headers:
      method === "GET"
        ? {}
        : {
            "Content-Type": "application/json",
            "X-Ingestion-Client": "dashboard",
          },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
  const result = await response.json();
  if (!response.ok)
    throw new Error(result.error || `Request failed (${response.status})`);
  return result;
}
function error(e) {
  $("error").textContent = e.message || String(e);
  $("error").hidden = false;
}
function toast(text) {
  $("toast").textContent = text;
  $("toast").hidden = false;
  clearTimeout(errorTimer);
  errorTimer = setTimeout(() => ($("toast").hidden = true), 3500);
}
function isUnfinished(f) {
  return ["partial", "ready_to_verify"].includes(f.coverage);
}
function chooseView(next) {
  view = next;
  render();
}
function render() {
  if (!snapshot) return;
  const files = snapshot.files;
  $("nav-count").textContent = number(files.length);
  $("attention-count").textContent = number(
    files.filter((f) => f.attention).length,
  );
  $("stat-total").textContent = number(files.length);
  $("stat-complete").textContent = number(
    files.filter((f) => f.coverage === "complete").length,
  );
  $("stat-partial").textContent = number(files.filter(isUnfinished).length);
  $("stat-unstarted").textContent = number(
    files.filter((f) => f.coverage === "unstarted").length,
  );
  document
    .querySelectorAll(".tabs [data-view]")
    .forEach((b) => b.classList.toggle("selected", b.dataset.view === view));
  $("all-nav").classList.toggle("active", view !== "attention");
  $("attention-nav").classList.toggle("active", view === "attention");
  const counts = new Map();
  for (const f of files) {
    const cat = f.category_slug || "unassigned";
    const c = counts.get(cat) || { total: 0, complete: 0 };
    c.total++;
    if (f.coverage === "complete") c.complete++;
    counts.set(cat, c);
  }
  $("category-nav").innerHTML = [...counts]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(
      ([cat, c]) =>
        `<button class="category-button ${$("category").value === cat ? "active" : ""}" data-category="${esc(cat)}"><span>${esc(label(cat))}</span><small>${c.complete}/${c.total}</small></button>`,
    )
    .join("");
  const categoryValue = $("category").value;
  $("category").innerHTML =
    '<option value="">All categories</option>' +
    [...counts.keys()]
      .sort()
      .map((cat) => `<option value="${esc(cat)}">${esc(label(cat))}</option>`)
      .join("");
  $("category").value = categoryValue;
  const search = $("search").value.trim().toLowerCase();
  const filtered = files.filter((f) => {
    if (
      search &&
      ![f.logical_path, f.source_slug, f.notes, f.category_slug]
        .join(" ")
        .toLowerCase()
        .includes(search)
    )
      return false;
    if (categoryValue && (f.category_slug || "unassigned") !== categoryValue)
      return false;
    if ($("disposition").value && f.disposition !== $("disposition").value)
      return false;
    return (
      view === "all" ||
      (view === "attention" && f.attention) ||
      (view === "unfinished" && isUnfinished(f)) ||
      (view === "review" && f.disposition === "needs_review") ||
      f.coverage === view
    );
  });
  $("filtered-count").textContent = number(filtered.length);
  $("table-caption").textContent =
    `${number(files.filter((f) => f.disposition === "needs_review").length)} files need classification · Counts reflect current file versions`;
  $("files").innerHTML = filtered.length
    ? filtered
        .map((f) => {
          const poi = f.records - f.excluded;
          const stages = [
            ["Extraction", f.extraction_complete ? 1 : 0, 1],
            ["Normalization", f.normalized, f.records],
            ["Coordinates", f.coordinates, poi],
            ["Embedding", f.embedded, poi],
            ["Linked", f.linked, poi],
            ["Verified", f.verified, f.records],
          ];
          const stageBars = stages
            .map(
              ([name, n, total]) =>
                `<span class="stage-segment ${total > 0 && n >= total ? "done" : n > 0 ? "some" : ""}" title="${name}: ${number(n)} / ${number(total)}"></span>`,
            )
            .join("");
          const filename = f.logical_path.split("/").at(-1),
            folder = f.logical_path
              .replace(/^docs\/poi\//, "")
              .split("/")
              .slice(0, -1)
              .join(" / ");
          return `<tr><td><button class="file-button" data-file="${f.id}" title="${esc(f.logical_path)}">${f.priority ? "↑ " : ""}${esc(filename)}</button><span class="subtext">${esc(folder)}</span><span class="subtext">${esc(f.source_slug || "Source not resolved")} · ${esc(label(f.category_slug || "unassigned"))}</span></td><td>${badge(f.coverage)}<span class="subtext">${f.freshness === "current" ? esc(label(f.disposition)) : esc(label(f.freshness))}</span></td><td><div class="stages" aria-label="${esc(stages.map(([n, x, t]) => `${n}: ${x}/${t}`).join("; "))}">${stageBars}</div><span class="stage-caption">${number(f.verified)} / ${f.total === null ? "?" : number(f.total)} verified</span></td><td>${f.latest_run ? badge(f.execution) : '<span class="subtext">No tracked runs</span>'}<span class="subtext">${f.last_commit_at ? date(f.last_commit_at) : f.latest_run ? date(f.latest_run.execution_started_at) : "—"}</span></td><td><div class="next-action">${esc(f.next)}</div><button class="text-button" data-file="${f.id}">Inspect file ↗</button></td></tr>`;
        })
        .join("")
    : '<tr><td colspan="5" class="empty">' +
      (files.length
        ? "No files match these filters."
        : "Discover your raw dumps with “Scan source files.”") +
      "</td></tr>";
  $("scanned").textContent = files.length
    ? "Inventory scanned " +
      date(files.reduce((a, f) => (f.scanned_at > a ? f.scanned_at : a), ""))
    : "No scan yet";
  $("updated").textContent = "Evidence checked " + date(snapshot.inspectedAt);
  $("connection").textContent = snapshot.refreshing
    ? "Scanning source files…"
    : "Auto-refresh · 10s";
  $("scan").disabled = snapshot.refreshing;
  $("scan").textContent = snapshot.refreshing
    ? "Scanning…"
    : "↻  Scan source files";
  if (snapshot.refreshError) {
    error(new Error("Inventory scan failed: " + snapshot.refreshError));
  } else if (snapshot.refreshResult) {
    $("notice").textContent =
      `Last scan: ${snapshot.refreshResult.discovered} files discovered · ${snapshot.refreshResult.missing} missing · ${snapshot.refreshResult.errors.length} scan errors. No ingestion was started.`;
    $("notice").hidden = false;
  }
}
async function refresh() {
  if (loading) return;
  loading = true;
  try {
    snapshot = await api("/api/inventory");
    $("error").hidden = true;
    render();
    if (currentId) updateSummary();
  } catch (e) {
    error(e);
    $("connection").textContent = "Refresh failed · showing last evidence";
  } finally {
    loading = false;
  }
}
function summary(f) {
  return `<div class="detail-path">${esc(f.logical_path)}</div><div class="detail-badges">${badge(f.coverage)}${badge(f.execution)}${badge(f.freshness)}</div><p>${esc(f.next)}</p>
  <div class="detail-grid">${[
    ["Observed", f.records],
    ["Normalized", f.normalized],
    ["Coordinates", f.coordinates],
    ["Embedded", f.embedded],
    ["Linked", f.linked],
    ["Published", f.published],
    ["Excluded", f.excluded],
    ["Verified", f.verified],
  ]
    .map(
      ([k, n]) => `<div><strong>${number(n)}</strong><span>${k}</span></div>`,
    )
    .join("")}</div>
  <p class="muted-note">${f.extraction_complete ? `Full extraction recorded. ${number(f.source_rows)} source rows; ${number(f.records)} distinct records.` : "Full extraction has not been established. The total is unknown; observed records may be a sample."} ${f.degraded ? `${number(f.degraded)} degraded normalizations need quality review.` : ""} ${f.invalid ? `${number(f.invalid)} pinned inputs have changed or disappeared.` : ""}</p>
  <p class="muted-note">SHA-256 <code>${esc(f.file_sha256 || "not available")}</code><br>Last successful unit: ${date(f.last_commit_at)}${f.scan_error ? "<br>" + esc(f.scan_error) : ""}</p>`;
}
function commands(f) {
  return (
    Object.entries(f.commands)
      .filter(([, cmd]) => cmd)
      .map(
        ([key, cmd]) =>
          `<div class="command"><code><label>${esc({ start: "Start whole file (manual)", resume: "Resume original scope (manual)", verify: "Verify current outputs (manual)", status: "Inspect run evidence" }[key])}</label>${esc(cmd)}</code><button class="small-button" data-copy="${esc(cmd)}">Copy</button></div>`,
      )
      .join("") ||
    "<p>Classify this file and choose a category to get an ingestion command. Unsupported or missing files need attention first.</p>"
  );
}
function updateSummary() {
  const f = snapshot.files.find((f) => f.id === currentId);
  if (f && $("file-summary")) {
    $("file-summary").innerHTML = summary(f);
    $("file-commands").innerHTML = commands(f);
  }
}
async function openFile(id) {
  const epoch = ++detailEpoch;
  runEpoch++;
  currentId = id;
  selectedRun = null;
  dirty = false;
  const f = snapshot.files.find((f) => f.id === id);
  if (!f) return;
  let editVersion = f.updated_at;
  $("detail-name").textContent = f.logical_path.split("/").at(-1);
  $("detail-body").innerHTML =
    `<section class="detail-section" id="file-summary">${summary(f)}</section>
  <section class="detail-section"><h3>Pick up the work</h3><div id="file-commands">${commands(f)}</div><p class="muted-note">Run these in the repository root. Resume preserves the original scope, including sample limits. A new full-file run is needed to process the rest.</p></section>
  <section class="detail-section"><h3>Operator notes & classification</h3><form id="file-form"><div class="form-grid"><label>Category<select name="category"><option value="">Choose explicitly…</option>${snapshot.categories.map((c) => `<option value="${esc(c)}" ${f.category_slug === c ? "selected" : ""}>${esc(label(c))}</option>`).join("")}</select></label><label>Disposition<select name="disposition">${["needs_review", "import", "alternate", "supporting", "ignored"].map((d) => `<option value="${d}" ${f.disposition === d ? "selected" : ""}>${esc(label(d))}</option>`).join("")}</select></label><label>Priority<select name="priority">${[0, 1, 2, 3].map((n) => `<option value="${n}" ${f.priority === n ? "selected" : ""}>${["Normal", "Low", "Medium", "High"][n]}</option>`).join("")}</select></label></div><label class="notes-label">Next step, decisions, or reason to exclude<textarea name="notes" maxlength="10000" placeholder="Leave a clear next step for yourself or an agent…">${esc(f.notes)}</textarea></label><div class="form-actions"><span id="save-state" class="muted-note">Notes persist across scans.</span><span><button class="small-button" type="button" id="discard-draft">Discard draft</button> <button class="primary" type="submit">Save notes</button></span></div></form></section>
  <section class="detail-section"><h3>Recorded runs</h3><div id="runs">Loading runs…</div></section>
  <section class="detail-section"><h3>Attempt evidence</h3><div id="run-evidence">Select a run to inspect attempts.</div></section>
  <section class="detail-section"><h3>File history & provider usage</h3><div id="history">Loading history…</div></section>`;
  if (!$("detail").open) $("detail").showModal();
  $("discard-draft").onclick = () => {
    dirty = false;
    closeDetail();
  };
  $("file-form").addEventListener("input", () => {
    dirty = true;
    $("save-state").textContent = "Unsaved changes";
  });
  $("file-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = new FormData(event.target);
    const submit = event.target.querySelector("button[type=submit]");
    submit.disabled = true;
    try {
      const saved = await api(`/api/files/${id}`, "PATCH", {
        category_slug: form.get("category") || null,
        disposition: form.get("disposition"),
        priority: Number(form.get("priority")),
        notes: form.get("notes"),
        expected_updated_at: editVersion,
      });
      editVersion = saved.updated_at;
      dirty = false;
      $("save-state").textContent = "Saved";
      toast("Notes and classification saved");
      await refresh();
    } catch (e) {
      $("save-state").textContent = e.message;
    } finally {
      submit.disabled = false;
    }
  });
  try {
    const detail = await api(`/api/files/${id}`);
    if (epoch !== detailEpoch) return;
    $("runs").innerHTML = detail.runs.length
      ? detail.runs
          .map(
            (r) =>
              `<div class="run-card"><button class="small-button" data-run="${r.id}">Inspect</button>${badge(r.status)} <span class="subtext">${r.scope_records} fixed records · ${r.managed ? "managed" : "legacy evidence"} · ${esc(r.current_stage || "planned")}</span><code>${r.id}</code><p>${date(r.last_execution_at || r.created_at)} · ${esc(r.stop_reason || "No stop reason recorded")}</p>${r.fatal_error ? `<p class="error-text">${esc(r.fatal_error)}</p>` : ""}</div>`,
          )
          .join("")
      : "<p>No tracked runs. Older direct imports cannot be attributed from file history.</p>";
    const m = detail.metrics;
    $("history").innerHTML =
      `<p>${number(m.requests)} attributed normalization requests · ${number(m.failed_requests)} failed · ${number(m.repair_requests)} repair requests · $${Number(m.cost_usd || 0).toFixed(4)} recorded cost${m.mean_seconds ? " · " + Number(m.mean_seconds).toFixed(1) + "s mean latency" : ""}</p><p class="muted-note">All tracked runs for this path. Legacy unattributed calls and matching/fusion costs are not included.</p><table><thead><tr><th>STAGE</th><th>ATTEMPTS</th><th>FAILED</th><th>REUSED</th><th>MEAN TIME</th></tr></thead><tbody>${detail.stageMetrics.map((s) => `<tr><td>${esc(s.stage)}</td><td>${number(s.attempts)}</td><td>${number(s.failed)}</td><td>${number(s.reused)}</td><td>${Number(s.mean_seconds || 0).toFixed(1)}s</td></tr>`).join("")}</tbody></table><p class="muted-note">Historical attempts include retries and resolved failures; reused attempts measure cache reuse, not provider requests avoided across all resumes.</p><h3 class="json-summary">${detail.discoveredVersions.length} discovered content version(s)</h3><table><thead><tr><th>HASH</th><th>SIZE</th><th>LAST SEEN</th></tr></thead><tbody>${detail.discoveredVersions.map((v) => `<tr><td><code title="${v.file_sha256}">${v.file_sha256.slice(0, 12)}</code></td><td>${number(v.byte_size)} B</td><td>${date(v.last_seen_at)}</td></tr>`).join("")}</tbody></table><details class="json-summary"><summary>Extraction versions & operator edit history (bounded)</summary><pre>${esc(JSON.stringify({ versions: detail.versions, edits: detail.edits }, null, 2))}</pre></details>`;
    if (detail.runs[0]) await openRun(detail.runs[0].id);
  } catch (e) {
    if (epoch === detailEpoch) $("runs").textContent = e.message;
  }
}
async function openRun(id, quiet = false) {
  const epoch = ++runEpoch;
  selectedRun = id;
  const container = $("run-evidence");
  if (!container) return;
  if (!quiet) container.textContent = "Loading attempt history…";
  try {
    const d = await api(`/api/runs/${id}`);
    if (epoch !== runEpoch || !$("detail").open) return;
    const r = d.run;
    const attempts = [
      ...new Map(
        [...d.attemptProblems, ...d.recentAttempts].map((a) => [a.id, a]),
      ).values(),
    ];
    container.innerHTML = `<button class="small-button" data-run="${esc(id)}">Refresh attempt evidence</button><p class="muted-note">Snapshot: ${date(r.inspected_at)}</p><p><code>${esc(id)}</code></p><p class="muted-note">${esc(r.stop_reason || r.status)} · Scope: ${d.scopeRecords} records · Verified: ${date(r.verified_at)}</p>
    ${r.managed && r.status === "running" ? `<button class="small-button" data-pause="${r.id}">${r.stop_requested ? "Pause already requested" : "Request graceful pause"}</button>` : ""}
    <div class="detail-badges">${d.attempts.map((a) => badge(a.stage + ": " + a.status + " " + a.targets)).join("")}</div>
    ${d.executions.map((e) => `<p class="muted-note">${esc(e.host)}:${e.pid} · ${esc(e.status)} · heartbeat ${date(e.heartbeat_at)}${e.heartbeat_stale ? " · suspected interrupted" : ""}</p>`).join("")}
    ${!r.managed ? `<p class="muted-note">Legacy run: immutable attempt history is unavailable. Inspect legacy jobs and source-wide evidence below.</p>` : ""}
    ${attempts.map((a) => `<details class="attempt-card"><summary>${esc(a.stage)} · ${esc(a.source_record_id || a.target_key)} · ${esc(a.status)}</summary><p>${date(a.started_at)} → ${date(a.finished_at)}</p>${a.error?.message ? `<p class="error-text">${esc(a.error.message)}</p>` : ""}<pre>${esc(JSON.stringify({ input: a.input, output: a.output, error: a.error }, null, 2))}</pre>${a.source_record_id && r.source ? `<button class="small-button" data-copy="${esc("pnpm --filter @lib/db-map ingest:trace --source " + quote(r.source) + " --record " + quote(a.source_record_id))}">Copy record trace command</button>` : ""}</details>`).join("")}
    <details class="json-summary"><summary>Full diagnostic snapshot (includes legacy evidence)</summary><pre>${esc(JSON.stringify(d, null, 2))}</pre></details><p class="muted-note">Latest 10 entries per diagnostic section. Attempt history remains in PostgreSQL; samples are not the full history. A stale heartbeat does not prove why a process stopped.</p>`;
  } catch (e) {
    if (epoch === runEpoch) container.textContent = e.message;
  }
}
function quote(s) {
  return "'" + String(s).replaceAll("'", "'\\''") + "'";
}
function closeDetail() {
  if (dirty) {
    toast("Save your notes or choose Discard draft before closing.");
    return;
  }
  $("detail").close();
  currentId = null;
  selectedRun = null;
  detailEpoch++;
  runEpoch++;
  dirty = false;
}
$("close-detail").onclick = closeDetail;
$("detail").addEventListener("cancel", (e) => {
  e.preventDefault();
  closeDetail();
});
$("all-nav").onclick = () => chooseView("all");
$("attention-nav").onclick = () => chooseView("attention");
$("search").oninput = render;
$("category").onchange = render;
$("disposition").onchange = render;
$("refresh-data").onclick = async () => {
  await refresh();
  if (selectedRun) await openRun(selectedRun, true);
};
$("scan").onclick = async () => {
  try {
    $("scan").disabled = true;
    await api("/api/refresh", "POST", {});
    toast("Scanning local files. No ingestion or provider calls.");
    await refresh();
  } catch (e) {
    error(e);
    $("scan").disabled = false;
  }
};
document.addEventListener("click", async (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  if (b.dataset.view) chooseView(b.dataset.view);
  if (b.dataset.category) {
    $("category").value = b.dataset.category;
    render();
  }
  if (b.dataset.file) await openFile(b.dataset.file);
  if (b.dataset.run) await openRun(b.dataset.run);
  if (b.dataset.copy) {
    try {
      await navigator.clipboard.writeText(b.dataset.copy);
      toast("Command copied");
    } catch {
      toast("Clipboard unavailable. Select and copy the command.");
    }
  }
  if (b.dataset.pause) {
    try {
      b.disabled = true;
      await api(`/api/runs/${b.dataset.pause}/pause`, "POST", {});
      toast("Pause requested; the current unit may still be finishing.");
      await openRun(b.dataset.pause);
      await refresh();
    } catch (e) {
      toast(e.message);
      b.disabled = false;
    }
  }
});
window.addEventListener("beforeunload", (e) => {
  if (dirty) {
    e.preventDefault();
    e.returnValue = "";
  }
});
setInterval(() => {
  if (!document.hidden) void refresh();
}, 10000);
void refresh();
