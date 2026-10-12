/* Seedance Studio frontend. Talks only to the local backend (/api/*). */
(() => {
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  const state = {
    config: null,
    mode: "text-to-video",
    modelInfo: {},        // mode -> { pricing, fields }
    media: { startFrame: null, endFrame: null, refImages: [], refVideos: [], refAudios: [] },
    jobs: [],
    filter: "",
    pollTimer: null,
    estimateTimer: null,
  };

  const LS_KEY = "seedance-studio:mode";

  // ------------------------------------------------------------------ utils
  const fmtMoney = (n) => (n === null || n === undefined || Number.isNaN(n) ? "—" : `$${Number(n).toFixed(n < 1 ? 3 : 2)}`);
  const fmtElapsed = (ms) => {
    const s = Math.max(0, Math.floor(ms / 1000));
    const m = Math.floor(s / 60);
    return m ? `${m}m ${String(s % 60).padStart(2, "0")}s` : `${s}s`;
  };
  const fmtDate = (ts) => new Date(ts).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  function toast(msg, ms = 2200) {
    const el = document.createElement("div");
    el.className = "toast";
    el.textContent = msg;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), ms);
  }

  function errorText(err) {
    if (!err) return "Unknown error";
    const parts = [];
    if (err.message) parts.push(err.message);
    if (err.detail && err.detail !== err.message) parts.push(err.detail);
    return parts.join("\n") || "Unknown error";
  }

  async function api(path, opts = {}) {
    const res = await fetch(path, { headers: opts.body && !(opts.body instanceof FormData) ? { "Content-Type": "application/json" } : {}, ...opts });
    let data = null;
    try { data = await res.json(); } catch { /* empty */ }
    if (!res.ok) {
      const e = new Error(data?.error?.message || `HTTP ${res.status}`);
      e.payload = data?.error || { message: e.message };
      throw e;
    }
    return data;
  }

  function showBanner(text, isError = false) {
    const b = $("#banner");
    b.textContent = text;
    b.classList.toggle("error", isError);
    b.classList.remove("hidden");
  }

  // ------------------------------------------------------------------ setup
  async function init() {
    state.config = await api("/api/config");
    $("#providerName").textContent = state.config.provider;
    if (!state.config.apiKeyConfigured) showBanner("PROVIDER_API_KEY is not set. Copy .env.example to .env, add your Oxen.ai API key and restart the server.", true);
    else if (!state.config.uploadsConfigured) showBanner("Uploads are disabled because OXEN_UPLOAD_NAMESPACE is not set. You can still paste public media URLs.");

    const { limits } = state.config;
    fill($("#aspect_ratio"), limits.aspectRatios);
    fill($("#resolution"), limits.resolutions);
    fill($("#output_format"), limits.outputFormats);
    $("#duration").min = limits.duration.min;
    $("#duration").max = limits.duration.max;

    const tabs = $("#modeTabs");
    const filter = $("#filterMode");
    for (const m of state.config.modes) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "tab";
      b.role = "tab";
      b.dataset.mode = m.id;
      b.textContent = m.label;
      b.addEventListener("click", () => setMode(m.id));
      tabs.appendChild(b);
      const o = document.createElement("option");
      o.value = m.id;
      o.textContent = m.label;
      filter.appendChild(o);
    }

    const saved = localStorage.getItem(LS_KEY);
    setMode(state.config.modes.some((m) => m.id === saved) ? saved : "text-to-video", true);

    bindForm();
    await refreshJobs();
    refreshSpend();
    startPolling();
  }

  function fill(select, values) {
    select.innerHTML = "";
    for (const v of values) {
      const o = document.createElement("option");
      o.value = v;
      o.textContent = v;
      select.appendChild(o);
    }
  }

  function modeSpec(id = state.mode) { return state.config.modes.find((m) => m.id === id); }

  function setMode(id, initial = false) {
    state.mode = id;
    localStorage.setItem(LS_KEY, id);
    const spec = modeSpec(id);
    $$("#modeTabs .tab").forEach((t) => t.setAttribute("aria-selected", String(t.dataset.mode === id)));
    $("#modeDesc").textContent = spec.description;

    // Controls visibility
    const c = spec.controls;
    toggleEl('[data-control="aspectRatio"]', c.aspectRatio);
    toggleEl('[data-control="duration"]', c.duration);
    toggleEl('[data-control="resolution"]', c.resolution);
    toggleEl('[data-control="outputFormat"]', c.outputFormat);
    toggleEl('[data-control="audio"]', c.audio);
    toggleEl('[data-control="watermark"]', c.watermark);
    toggleEl('[data-control="draft"]', c.draft);
    toggleEl('[data-media="startFrame"]', Boolean(spec.media.startFrame));
    toggleEl('[data-media="refs"]', Boolean(spec.media.refImages));
    $("#seedField").classList.add("hidden");

    // Defaults
    const d = spec.defaults;
    if (d.aspect_ratio) $("#aspect_ratio").value = d.aspect_ratio;
    $("#resolution").value = d.resolution;
    $("#output_format").value = d.output_format;
    $("#generate_audio").checked = d.generate_audio !== false;
    $("#draft").checked = false;
    $("#watermark").checked = Boolean(d.watermark);
    $("#durationMode").value = "auto";
    $("#duration").classList.add("hidden");

    $("#promptHint").textContent = spec.media.refImages
      ? "Reference media in the prompt as @Image1, @Video1, @Audio1 (the Oxen workbench writes [Image 1], [Video 1], [Audio 1]). Media marked as containing faces is indexed first within its type."
      : "";

    renderMediaSlots();
    hideFormError();
    loadModelInfo(id);
    scheduleEstimate();
  }

  function toggleEl(sel, show) { $$(sel).forEach((el) => el.classList.toggle("hidden", !show)); }

  async function loadModelInfo(mode) {
    if (!state.config.apiKeyConfigured) return;
    try {
      const info = state.modelInfo[mode] || (state.modelInfo[mode] = await api(`/api/models/${mode}`));
      if (state.mode === mode) {
        // Show the seed control only when the model's live request_schema lists it.
        $("#seedField").classList.toggle("hidden", !(info.fields || []).includes("seed"));
        scheduleEstimate();
      }
    } catch (e) {
      $("#estimate").textContent = `Could not load model info: ${errorText(e.payload)}`;
    }
  }

  // ------------------------------------------------------------------ form
  function bindForm() {
    const prompt = $("#prompt");
    const updateCount = () => { $("#promptCount").textContent = `${prompt.value.length.toLocaleString()} chars`; };
    prompt.addEventListener("input", updateCount);
    updateCount();

    $("#durationMode").addEventListener("change", (e) => {
      $("#duration").classList.toggle("hidden", e.target.value !== "fixed");
      scheduleEstimate();
    });
    ["#duration", "#resolution", "#generate_audio", "#draft"].forEach((s) => $(s).addEventListener("change", scheduleEstimate));
    $("#draft").addEventListener("change", (e) => { $("#resolution").disabled = e.target.checked; });

    $("#genForm").addEventListener("submit", onSubmit);
    $("#resetBtn").addEventListener("click", () => { $("#prompt").value = ""; updateCount(); clearMedia(); setMode(state.mode); });
    $("#filterMode").addEventListener("change", (e) => { state.filter = e.target.value; renderJobs(); });
    $("#refreshSpend").addEventListener("click", refreshSpend);
  }

  function scheduleEstimate() {
    clearTimeout(state.estimateTimer);
    state.estimateTimer = setTimeout(updateEstimate, 150);
  }

  async function updateEstimate() {
    if (!state.config.apiKeyConfigured) { $("#estimate").textContent = "Cost estimate unavailable without an API key."; return; }
    const p = readParams();
    try {
      const est = await api("/api/estimate", { method: "POST", body: JSON.stringify({ mode: state.mode, duration: p.duration, resolution: p.resolution, generate_audio: p.generate_audio, draft: p.draft }) });
      if (est.min === null) { $("#estimate").textContent = `Cost estimate: ${est.basis}`; return; }
      const range = est.min === est.max ? `<strong>${fmtMoney(est.min)}</strong>` : `<strong>${fmtMoney(est.min)} to ${fmtMoney(est.max)}</strong>`;
      $("#estimate").innerHTML = `Estimated cost ${range} <span class="muted">(${fmtMoney(est.perSecond)}/s, ${esc(est.basis)})</span>`;
    } catch (e) {
      $("#estimate").textContent = `Cost estimate unavailable: ${errorText(e.payload)}`;
    }
  }

  function readParams() {
    const spec = modeSpec();
    const p = { prompt: $("#prompt").value };
    if (spec.controls.aspectRatio) p.aspect_ratio = $("#aspect_ratio").value;
    p.duration = $("#durationMode").value === "fixed" ? Number($("#duration").value) : "auto";
    p.resolution = $("#resolution").value;
    p.generate_audio = $("#generate_audio").checked;
    p.output_format = $("#output_format").value;
    p.watermark = $("#watermark").checked;
    p.draft = $("#draft").checked;
    if (!$("#seedField").classList.contains("hidden") && $("#seed").value !== "") p.seed = Number($("#seed").value);
    if (spec.media.startFrame) {
      p.startFrame = state.media.startFrame;
      p.endFrame = state.media.endFrame;
    }
    if (spec.media.refImages) {
      p.refImages = state.media.refImages;
      p.refVideos = state.media.refVideos;
      p.refAudios = state.media.refAudios;
    }
    return p;
  }

  function validate(p) {
    const spec = modeSpec();
    const L = state.config.limits;
    if (!p.prompt.trim()) return "Prompt cannot be empty.";
    if (p.duration !== "auto" && (!Number.isInteger(p.duration) || p.duration < L.duration.min || p.duration > L.duration.max)) return `Duration must be between ${L.duration.min} and ${L.duration.max} seconds.`;
    if (p.seed !== undefined && !Number.isInteger(p.seed)) return "Seed must be an integer.";
    if (spec.media.startFrame && !p.startFrame) return "Add a start frame image.";
    if (spec.media.refImages) {
      if (p.refImages.length > L.media.referenceImagesMax) return `At most ${L.media.referenceImagesMax} reference images.`;
      if (p.refVideos.length > L.media.video.maxCount) return `At most ${L.media.video.maxCount} reference videos.`;
      if (p.refAudios.length > L.media.audio.maxCount) return `At most ${L.media.audio.maxCount} reference audio clips.`;
      if (spec.media.videoRequired && p.refVideos.length === 0) return `${spec.label} needs at least one reference video.`;
      const minVid = state.mode === "video-edit" ? L.media.video.minSecEdit : L.media.video.minSec;
      let vt = 0, at = 0;
      for (const v of p.refVideos) if (typeof v.durationSec === "number") { if (v.durationSec < minVid || v.durationSec > L.media.video.maxSec) return `Reference videos must be ${minVid} to ${L.media.video.maxSec} s (${v.name} is ${v.durationSec.toFixed(1)} s).`; vt += v.durationSec; }
      for (const a of p.refAudios) if (typeof a.durationSec === "number") { if (a.durationSec < L.media.audio.minSec || a.durationSec > L.media.audio.maxSec) return `Reference audio must be ${L.media.audio.minSec} to ${L.media.audio.maxSec} s (${a.name} is ${a.durationSec.toFixed(1)} s).`; at += a.durationSec; }
      if (vt > L.media.video.maxCombinedSec) return `Combined reference video duration must be at most ${L.media.video.maxCombinedSec} s (currently ${vt.toFixed(1)} s).`;
      if (at > L.media.audio.maxCombinedSec) return `Combined reference audio duration must be at most ${L.media.audio.maxCombinedSec} s (currently ${at.toFixed(1)} s).`;
    }
    const uploading = $$(".media-item.uploading").length;
    if (uploading) return "Wait for uploads to finish.";
    return null;
  }

  function showFormError(text) { const el = $("#formError"); el.textContent = text; el.classList.remove("hidden"); }
  function hideFormError() { $("#formError").classList.add("hidden"); }

  async function onSubmit(e) {
    e.preventDefault();
    hideFormError();
    const params = readParams();
    const problem = validate(params);
    if (problem) return showFormError(problem);
    await submitJob(state.mode, params);
  }

  async function submitJob(mode, params) {
    const btn = $("#submitBtn");
    btn.disabled = true;
    btn.textContent = "Submitting…";
    try {
      const job = await api("/api/jobs", { method: "POST", body: JSON.stringify({ mode, params }) });
      state.jobs.unshift(job);
      renderJobs();
      toast("Job queued");
      startPolling();
    } catch (err) {
      showFormError(errorText(err.payload));
    } finally {
      btn.disabled = false;
      btn.textContent = "Generate";
    }
  }

  // ------------------------------------------------------------------ media
  function clearMedia() { state.media = { startFrame: null, endFrame: null, refImages: [], refVideos: [], refAudios: [] }; }

  function renderMediaSlots() {
    const spec = modeSpec();
    if (spec.media.startFrame) {
      renderSlot($("#slot-startFrame"), { key: "startFrame", label: "Start frame", required: true, kind: "image", note: "JPEG, PNG or WebP, max 30 MB. The output keeps this image's aspect ratio." });
      renderSlot($("#slot-endFrame"), { key: "endFrame", label: "End frame (optional)", required: false, kind: "image", note: "The video transitions from the start frame to this frame." });
    }
    if (spec.media.refImages) {
      const L = state.config.limits.media;
      const minVid = state.mode === "video-edit" ? L.video.minSecEdit : L.video.minSec;
      renderList($("#list-refVideos"), { key: "refVideos", label: "Reference videos", required: Boolean(spec.media.videoRequired), kind: "video", note: `Up to ${L.video.maxCount} MP4/MOV clips, each ${minVid} to ${L.video.maxSec} s, combined at most ${L.video.maxCombinedSec} s. Prompt as @Video1, @Video2…` });
      renderList($("#list-refImages"), { key: "refImages", label: "Reference images", required: false, kind: "image", note: `Up to ${L.referenceImagesMax} JPEG/PNG/WebP images, max 30 MB each. Prompt as @Image1, @Image2…` });
      renderList($("#list-refAudios"), { key: "refAudios", label: "Reference audio", required: false, kind: "audio", note: `Up to ${L.audio.maxCount} MP3/WAV clips, each ${L.audio.minSec} to ${L.audio.maxSec} s, combined at most ${L.audio.maxCombinedSec} s. Audio-only input is supported. Prompt as @Audio1…` });
    }
  }

  function mediaHeader(opts) {
    return `<div class="media-head"><span>${esc(opts.label)} ${opts.required ? '<span class="req">required</span>' : ""}</span></div>`;
  }

  function addControls(kind, multiple) {
    const accept = { image: ".jpg,.jpeg,.png,.webp,image/jpeg,image/png,image/webp", video: ".mp4,.mov,video/mp4,video/quicktime", audio: ".mp3,.wav,audio/mpeg,audio/wav" }[kind];
    const uploadDisabled = !state.config.uploadsConfigured ? "disabled" : "";
    return `<div class="media-add">
      <button type="button" class="ghost small file-btn" ${uploadDisabled} title="${uploadDisabled ? "Set OXEN_UPLOAD_NAMESPACE to enable uploads" : "Upload from this computer"}">Upload<input type="file" accept="${accept}" ${multiple ? "multiple" : ""} ${uploadDisabled} data-role="file"></button>
      <input type="url" placeholder="…or paste a public URL" data-role="url">
      <button type="button" class="ghost small" data-role="addurl">Add</button>
    </div>`;
  }

  function mediaItem(m, idx, kind) {
    const thumb = kind === "image" ? `<img class="thumb" src="${esc(m.previewUrl || m.url)}" alt="">`
      : kind === "video" ? `<video class="thumb" src="${esc(m.previewUrl || m.url)}" muted preload="metadata"></video>`
      : `<div class="thumb audio">♪</div>`;
    const dur = typeof m.durationSec === "number" ? `<span class="tag">${m.durationSec.toFixed(1)}s</span>` : "";
    const face = kind !== "audio" ? `<label class="face" title="Turn on when this ${kind} shows a real human face, person or character. Content filters may block the request otherwise."><input type="checkbox" data-role="face" data-idx="${idx}" ${m.hasFace ? "checked" : ""}> face</label>` : "";
    return `<div class="media-item ${m.uploading ? "uploading" : ""}" data-idx="${idx}">${thumb}${dur}<button type="button" class="rm" data-role="rm" data-idx="${idx}" title="Remove">×</button><span class="name" title="${esc(m.name || m.url)}">${esc(m.name || m.url)}</span>${face}</div>`;
  }

  function renderSlot(root, opts) {
    const m = state.media[opts.key];
    root.innerHTML = mediaHeader(opts) + (m ? `<div class="media-items">${mediaItem(m, 0, opts.kind)}</div>` : addControls(opts.kind, false)) + `<p class="media-note">${esc(opts.note)}</p>`;
    wireMedia(root, opts, false);
  }

  function renderList(root, opts) {
    const arr = state.media[opts.key];
    root.innerHTML = mediaHeader(opts) + addControls(opts.kind, true) + (arr.length ? `<div class="media-items">${arr.map((m, i) => mediaItem(m, i, opts.kind)).join("")}</div>` : "") + `<p class="media-note">${esc(opts.note)}</p>`;
    wireMedia(root, opts, true);
  }

  function wireMedia(root, opts, multiple) {
    const set = (val) => { if (multiple) state.media[opts.key] = val; else state.media[opts.key] = val; renderMediaSlots(); };
    const get = () => state.media[opts.key];
    root.querySelector('[data-role="file"]')?.addEventListener("change", async (e) => {
      const files = Array.from(e.target.files || []);
      if (!files.length) return;
      for (const f of files) await addFile(f, opts, multiple);
    });
    const urlInput = root.querySelector('[data-role="url"]');
    const addUrl = () => {
      const url = urlInput.value.trim();
      if (!url) return;
      try { new URL(url); } catch { return showFormError("Enter a valid http(s) URL."); }
      const item = { url, name: url.split("/").pop() || url, kind: opts.kind };
      if (multiple) set([...get(), item]); else set(item);
    };
    root.querySelector('[data-role="addurl"]')?.addEventListener("click", addUrl);
    urlInput?.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); addUrl(); } });
    root.querySelectorAll('[data-role="rm"]').forEach((b) => b.addEventListener("click", () => {
      const i = Number(b.dataset.idx);
      if (multiple) set(get().filter((_, k) => k !== i)); else set(null);
    }));
    root.querySelectorAll('[data-role="face"]').forEach((c) => c.addEventListener("change", () => {
      const i = Number(c.dataset.idx);
      if (multiple) get()[i].hasFace = c.checked; else get().hasFace = c.checked;
    }));
  }

  function probeDuration(file, kind) {
    return new Promise((resolve) => {
      if (kind === "image") return resolve(undefined);
      const el = document.createElement(kind === "video" ? "video" : "audio");
      const url = URL.createObjectURL(file);
      el.preload = "metadata";
      el.onloadedmetadata = () => { URL.revokeObjectURL(url); resolve(Number.isFinite(el.duration) ? el.duration : undefined); };
      el.onerror = () => { URL.revokeObjectURL(url); resolve(undefined); };
      el.src = url;
    });
  }

  async function addFile(file, opts, multiple) {
    hideFormError();
    const L = state.config.limits.media;
    if (opts.kind === "image" && file.size > L.image.maxBytes) return showFormError(`${file.name} is ${(file.size / 1048576).toFixed(1)} MB; images must be at most 30 MB.`);
    const durationSec = await probeDuration(file, opts.kind);
    const placeholder = { url: "", name: file.name, kind: opts.kind, uploading: true, durationSec, previewUrl: URL.createObjectURL(file) };
    if (multiple) state.media[opts.key] = [...state.media[opts.key], placeholder]; else state.media[opts.key] = placeholder;
    renderMediaSlots();
    try {
      const fd = new FormData();
      fd.append("files", file);
      const res = await api("/api/upload", { method: "POST", body: fd });
      const up = res.files[0];
      const item = { url: up.url, previewUrl: up.previewUrl, name: up.name, kind: up.kind, durationSec, hasFace: false };
      if (multiple) state.media[opts.key] = state.media[opts.key].map((m) => (m === placeholder ? item : m)); else state.media[opts.key] = item;
    } catch (err) {
      if (multiple) state.media[opts.key] = state.media[opts.key].filter((m) => m !== placeholder); else state.media[opts.key] = null;
      showFormError(`Upload failed: ${errorText(err.payload)}`);
    }
    renderMediaSlots();
  }

  // ------------------------------------------------------------------ jobs
  async function refreshJobs() {
    try {
      const { jobs } = await api("/api/jobs");
      state.jobs = jobs;
      renderJobs();
    } catch (e) {
      console.error(e);
    }
  }

  function hasActive() { return state.jobs.some((j) => j.status === "queued" || j.status === "running"); }

  function startPolling() {
    clearInterval(state.pollTimer);
    // Local poll of our own backend; the backend does the provider polling with backoff and survives refreshes.
    state.pollTimer = setInterval(async () => {
      if (hasActive()) await refreshJobs();
      else renderJobs(); // keep elapsed timers current
    }, 3000);
    setInterval(() => { if (hasActive()) renderElapsed(); }, 1000);
  }

  function renderElapsed() {
    $$(".job[data-id]").forEach((el) => {
      const j = state.jobs.find((x) => x.id === el.dataset.id);
      if (j) el.querySelector(".elapsed").textContent = elapsedFor(j);
    });
  }

  function elapsedFor(j) {
    const end = j.completedAt || Date.now();
    return `${fmtElapsed(end - j.createdAt)} · ${fmtDate(j.createdAt)}`;
  }

  function paramSummary(j) {
    const p = j.params || {};
    const r = j.request || {};
    const bits = [];
    if (r.resolution) bits.push(j.isFinal ? "1080p" : r.resolution);
    if (r.duration !== undefined) bits.push(r.duration === "auto" ? "auto length" : `${r.duration}s`);
    if (r.aspect_ratio) bits.push(r.aspect_ratio);
    bits.push(r.generate_audio === false ? "no audio" : "audio");
    if (r.output_format) bits.push(r.output_format);
    if (r.seed !== undefined) bits.push(`seed ${r.seed}`);
    if (r.omni_reference_task_type && r.omni_reference_task_type !== "auto") bits.push(r.omni_reference_task_type);
    const media = [];
    if (p.startFrame) media.push("start frame");
    if (p.endFrame) media.push("end frame");
    if (p.refImages?.length) media.push(`${p.refImages.length} img`);
    if (p.refVideos?.length) media.push(`${p.refVideos.length} vid`);
    if (p.refAudios?.length) media.push(`${p.refAudios.length} audio`);
    if (media.length) bits.push(media.join(", "));
    return bits.join(" · ");
  }

  function renderJobs() {
    const root = $("#jobs");
    const list = state.jobs.filter((j) => !state.filter || j.mode === state.filter);
    $("#jobsEmpty").classList.toggle("hidden", list.length > 0);
    $("#jobCount").textContent = list.length ? `${list.length} job${list.length === 1 ? "" : "s"}` : "";
    const existing = new Map($$(".job[data-id]", root).map((el) => [el.dataset.id, el]));
    const frag = document.createDocumentFragment();
    for (const j of list) {
      const prev = existing.get(j.id);
      const el = renderJob(j, prev);
      frag.appendChild(el);
    }
    root.replaceChildren(frag);
  }

  function renderJob(j, prev) {
    // Reuse the element when nothing visible changed, so the <video> keeps playing.
    const sig = JSON.stringify([j.status, j.localUrl, j.resultUrl, j.error, j.cost, j.draftTaskId, j.prompt]);
    if (prev && prev.dataset.sig === sig) { prev.querySelector(".elapsed").textContent = elapsedFor(j); return prev; }
    const el = $("#tplJob").content.firstElementChild.cloneNode(true);
    el.dataset.id = j.id;
    el.dataset.sig = sig;
    el.querySelector(".mode").textContent = modeSpec(j.mode)?.label || j.mode;
    const st = el.querySelector(".status");
    st.textContent = j.status === "running" ? "running" : j.status;
    st.dataset.status = j.status;
    el.querySelector(".draft").classList.toggle("hidden", !j.isDraft);
    el.querySelector(".final").classList.toggle("hidden", !j.isFinal);
    el.querySelector(".elapsed").textContent = elapsedFor(j);
    el.querySelector(".cost").textContent = j.cost ? `${fmtMoney(Number(j.cost))}` : "";
    const promptEl = el.querySelector(".job-prompt");
    promptEl.textContent = j.prompt;
    promptEl.addEventListener("click", () => promptEl.classList.toggle("expanded"));
    el.querySelector(".job-params").textContent = paramSummary(j);

    const media = el.querySelector(".job-media");
    if (j.status === "done" && (j.localUrl || j.resultUrl)) {
      media.innerHTML = `<video controls playsinline preload="metadata" src="${esc(j.localUrl || j.resultUrl)}"></video>`;
    } else if (j.status === "queued" || j.status === "running") {
      media.innerHTML = `<div class="placeholder"><div class="spinner"></div><span>${j.status === "queued" ? "Queued at provider" : "Rendering…"}</span></div>`;
    } else {
      media.innerHTML = `<div class="placeholder"><span>${j.status === "failed" ? "Failed" : "Cancelled"}</span></div>`;
    }

    if (j.error) {
      const e = el.querySelector(".job-error");
      const meta = [j.error.source && `source: ${j.error.source}`, j.error.provider && `provider: ${j.error.provider}`, j.error.provider_code && `code: ${j.error.provider_code}`, j.error.retryable === true && "retryable", j.error.type && `type: ${j.error.type}`].filter(Boolean).join(" · ");
      e.innerHTML = `${esc(errorText(j.error))}${meta ? `<span class="meta">${esc(meta)}</span>` : ""}`;
      e.classList.remove("hidden");
    }

    const actions = el.querySelector(".job-actions");
    const btn = (label, cls, fn, title = "") => { const b = document.createElement("button"); b.type = "button"; b.className = `ghost small ${cls}`; b.textContent = label; b.title = title; b.addEventListener("click", fn); actions.appendChild(b); return b; };
    if (j.status === "done") {
      if (j.localUrl) { const a = document.createElement("a"); a.href = j.localUrl; a.download = `${j.mode}-${j.id.slice(0, 8)}.${j.localUrl.split(".").pop()}`; a.className = "ghost small"; a.textContent = "Download"; a.setAttribute("role", "button"); actions.appendChild(a); }
      else if (j.resultUrl) { const a = document.createElement("a"); a.href = j.resultUrl; a.target = "_blank"; a.rel = "noopener"; a.className = "ghost small"; a.textContent = "Open provider URL (may expire)"; actions.appendChild(a); }
      if (j.isDraft && j.draftTaskId) {
        const expired = j.draftExpiresAt && new Date(j.draftExpiresAt).getTime() <= Date.now();
        const b = btn(expired ? "Draft expired" : "Render 1080p final", "", () => renderFinal(j), expired ? `Expired at ${j.draftExpiresAt}` : `Renders the same shot at 1080p. Settings are locked to the draft. Draft valid until ${j.draftExpiresAt ? new Date(j.draftExpiresAt).toLocaleString() : "7 days after creation"}.`);
        b.disabled = Boolean(expired);
      }
    }
    if (j.status === "queued" || j.status === "running") btn("Cancel", "danger", () => cancel(j));
    btn("Copy settings", "", () => copySettings(j), "Copies mode, parameters and the exact provider request as JSON");
    if (!j.isFinal) {
      btn("Load settings", "", () => loadSettings(j), "Loads this job's settings into the form");
      btn("Regenerate", "", () => regenerate(j), "Submits a new job with the same settings");
    }
    btn("Delete", "danger", () => remove(j));
    return el;
  }

  async function cancel(j) {
    try { await api(`/api/jobs/${j.id}/cancel`, { method: "POST" }); await refreshJobs(); toast("Cancelled"); } catch (e) { toast(`Cancel failed: ${errorText(e.payload)}`, 4000); }
  }
  async function remove(j) {
    if (!confirm("Delete this job and its downloaded video?")) return;
    try { await api(`/api/jobs/${j.id}`, { method: "DELETE" }); state.jobs = state.jobs.filter((x) => x.id !== j.id); renderJobs(); } catch (e) { toast(`Delete failed: ${errorText(e.payload)}`, 4000); }
  }
  async function renderFinal(j) {
    try { const job = await api(`/api/jobs/${j.id}/final`, { method: "POST" }); state.jobs.unshift(job); renderJobs(); toast("Final render queued"); } catch (e) { toast(`Final failed: ${errorText(e.payload)}`, 5000); }
  }
  async function copySettings(j) {
    const payload = { mode: j.mode, model: j.model, params: j.params, request: j.request };
    try { await navigator.clipboard.writeText(JSON.stringify(payload, null, 2)); toast("Settings copied"); } catch { toast("Clipboard unavailable"); }
  }
  function loadSettings(j) {
    setMode(j.mode);
    const p = j.params || {};
    $("#prompt").value = p.prompt || j.prompt || "";
    $("#prompt").dispatchEvent(new Event("input"));
    if (p.aspect_ratio) $("#aspect_ratio").value = p.aspect_ratio;
    if (p.duration === "auto" || p.duration === undefined) { $("#durationMode").value = "auto"; $("#duration").classList.add("hidden"); }
    else { $("#durationMode").value = "fixed"; $("#duration").value = p.duration; $("#duration").classList.remove("hidden"); }
    if (p.resolution) $("#resolution").value = p.resolution;
    if (p.output_format) $("#output_format").value = p.output_format;
    $("#generate_audio").checked = p.generate_audio !== false;
    $("#draft").checked = Boolean(p.draft);
    $("#resolution").disabled = Boolean(p.draft);
    $("#watermark").checked = Boolean(p.watermark);
    $("#seed").value = p.seed ?? "";
    state.media = { startFrame: p.startFrame || null, endFrame: p.endFrame || null, refImages: p.refImages || [], refVideos: p.refVideos || [], refAudios: p.refAudios || [] };
    renderMediaSlots();
    scheduleEstimate();
    window.scrollTo({ top: 0, behavior: "smooth" });
    toast("Settings loaded");
  }
  async function regenerate(j) {
    await submitJob(j.mode, j.params);
  }

  // ------------------------------------------------------------------ spend
  async function refreshSpend() {
    if (!state.config.apiKeyConfigured) { $("#spendValue").textContent = "—"; return; }
    try {
      const s = await api("/api/spend");
      $("#spendValue").textContent = s.total_cost === null ? "$0.00" : fmtMoney(Number(s.total_cost));
      $("#spend").title = `Total charged for ${s.total_entries} video generation(s) in ${s.namespace || "your"} namespace, from GET /api/ai/generations. The provider exposes no credits-balance endpoint.`;
    } catch (e) {
      $("#spendValue").textContent = "n/a";
      $("#spend").title = `Could not load spend: ${errorText(e.payload)}`;
    }
  }

  init().catch((e) => showBanner(`Failed to initialise: ${e.message}`, true));
})();
