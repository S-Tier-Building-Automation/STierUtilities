<script module>
  // Status pill is read synchronously by the shell (plugin-page header) and by
  // getSystemStatus, so it stays a plain exported function. It mirrors the
  // original renderStatusPill, derived purely from the live hm state passed in.
  export function statusPill(hm) {
    if (hm.busy) {
      const label = hm.progress
        ? `${hm.busyLabel} ${hm.progress.done}/${hm.progress.total}`
        : hm.busyLabel || "Working";
      return { label, cls: "pill-running" };
    }
    if (hm.files.length === 0) return { label: "No files", cls: "pill-idle" };
    return { label: `${hm.files.length} file${hm.files.length === 1 ? "" : "s"}`, cls: "pill-muted" };
  }
</script>

<script>
  // HEIC & MOV tool page — preview, convert, and file list UI.
  // Faithful Svelte 5 port: the single hm object is $state (mutating it
  // re-renders, replacing every renderAll() call, including in-loop progress).
  // hm is created here AND handed back to app-tools via `bindState` so the
  // synchronous statusPill (read by the shell chrome) sees the same live state.
  let { invoke, convertFileSrc, logTo, pickHeicMovFiles, pickFolder, bindState } = $props();

  let hm = $state({
    files: [],
    selectedPath: null,
    outputDir: null,
    imageFormat: "jpeg",
    overwrite: false,
    busy: false,
    busyLabel: "",
    progress: null,
    previewSrc: null,
    previewMime: null,
  });

  // Publish the live $state proxy so renderStatusPill() can read it synchronously.
  bindState?.(hm);

  function hmSelectedFile() {
    return hm.files.find((f) => f.path === hm.selectedPath) || null;
  }

  function hmFormatFileMeta(file) {
    const parts = [];
    if (file.width && file.height) parts.push(`${file.width}×${file.height}`);
    if (file.duration_sec != null) {
      const s = Math.round(file.duration_sec);
      const m = Math.floor(s / 60);
      const r = s % 60;
      parts.push(m > 0 ? `${m}:${String(r).padStart(2, "0")}` : `${s}s`);
    }
    parts.push(file.kind === "video" ? "video" : "image");
    return parts.join(" · ");
  }

  async function hmRefreshPreview() {
    const file = hmSelectedFile();
    hm.previewSrc = null;
    hm.previewMime = null;
    if (!file) {
      return;
    }
    hm.busy = true;
    hm.busyLabel = "Previewing";
    try {
      const preview = await invoke("heicmov_make_preview", { path: file.path });
      hm.previewSrc = convertFileSrc(preview.preview_path);
      hm.previewMime = preview.mime;
      logTo("heicmov", `Preview ready: ${file.path.split(/[/\\]/).pop()}`, "ok");
    } catch (err) {
      logTo("heicmov", `Preview failed: ${err}`, "error");
    } finally {
      hm.busy = false;
      hm.busyLabel = "";
    }
  }

  async function hmPickFiles() {
    try {
      const paths = await pickHeicMovFiles();
      if (paths.length === 0) return;
      hm.busy = true;
      hm.busyLabel = "Loading";
      hm.progress = { done: 0, total: paths.length };

      const files = [];
      for (const path of paths) {
        try {
          const probe = await invoke("heicmov_probe", { path });
          files.push(probe);
          logTo("heicmov", `Added ${path.split(/[/\\]/).pop()}`, "info");
        } catch (err) {
          logTo("heicmov", `Skipped ${path}: ${err}`, "error");
        }
        hm.progress.done += 1;
      }

      hm.files = files;
      if (files.length > 0) {
        const stillSelected = files.some((f) => f.path === hm.selectedPath);
        hm.selectedPath = stillSelected ? hm.selectedPath : files[0].path;
        await hmRefreshPreview();
      } else {
        hm.selectedPath = null;
      }
    } catch (err) {
      logTo("heicmov", `Could not pick files: ${err}`, "error");
    } finally {
      hm.busy = false;
      hm.busyLabel = "";
      hm.progress = null;
    }
  }

  async function hmPickOutputDir() {
    try {
      const dir = await pickFolder();
      if (dir) {
        hm.outputDir = dir;
        logTo("heicmov", `Output folder: ${dir}`, "info");
      }
    } catch (err) {
      logTo("heicmov", `Could not pick folder: ${err}`, "error");
    }
  }

  async function hmConvert() {
    if (hm.files.length === 0) return;
    hm.busy = true;
    hm.busyLabel = "Converting";
    hm.progress = { done: 0, total: hm.files.length };
    try {
      const batch = await invoke("heicmov_convert", {
        paths: hm.files.map((f) => f.path),
        outputDir: hm.outputDir,
        imageFormat: hm.imageFormat,
        overwrite: hm.overwrite,
      });
      let okCount = 0;
      for (const r of batch.results) {
        const name = r.input.split(/[/\\]/).pop();
        if (r.ok) {
          okCount += 1;
          logTo("heicmov", `Converted ${name} → ${r.output.split(/[/\\]/).pop()}`, "ok");
        } else {
          logTo("heicmov", `${name}: ${r.error || "failed"}`, "error");
        }
        hm.progress.done += 1;
      }
      logTo("heicmov", `Done — ${okCount}/${batch.results.length} succeeded.`, okCount ? "ok" : "warn");
    } catch (err) {
      logTo("heicmov", `Convert failed: ${err}`, "error");
    } finally {
      hm.busy = false;
      hm.busyLabel = "";
      hm.progress = null;
    }
  }

  async function hmOpenOutputFolder() {
    const dir = hm.outputDir
      || (hm.files[0] ? hm.files[0].path.replace(/[/\\][^/\\]+$/, "") : null);
    if (!dir) return;
    try {
      await invoke("heicmov_open_path", { path: dir });
    } catch (err) {
      logTo("heicmov", `Could not open folder: ${err}`, "error");
    }
  }

  function hmSelectFile(path) {
    if (hm.selectedPath === path) return;
    hm.selectedPath = path;
    hmRefreshPreview();
  }

  function hmRemoveFile(path) {
    hm.files = hm.files.filter((f) => f.path !== path);
    if (hm.selectedPath === path) {
      hm.selectedPath = hm.files[0]?.path || null;
      hm.previewSrc = null;
      hm.previewMime = null;
      if (hm.selectedPath) hmRefreshPreview();
      return;
    }
  }

  function hmClearFiles() {
    hm.files = [];
    hm.selectedPath = null;
    hm.previewSrc = null;
    hm.previewMime = null;
  }

  const outputLabel = $derived(hm.outputDir || "Same folder as each source file");
  const isVideoPreview = $derived(hm.previewSrc && hm.previewMime?.startsWith("video/"));
</script>

<div class="plugin-controls">
  <section class="plugin-section">
    <h3>Files</h3>
    <div class="action-row">
      <button class="btn btn-primary" disabled={hm.busy} onclick={hmPickFiles}>Choose files…</button>
      <button class="btn-ghost" disabled={hm.busy || hm.files.length === 0} onclick={hmClearFiles}>Clear list</button>
    </div>
    <ul class="hm-file-list">
      {#if hm.files.length === 0}
        <li class="hm-file-empty muted small">No files yet. Choose HEIC, HEIF, or MOV files to preview and convert.</li>
      {:else}
        {#each hm.files as file (file.path)}
          <li
            class="hm-file-row {file.path === hm.selectedPath ? 'hm-file-active' : ''}"
            onclick={() => hmSelectFile(file.path)}
          >
            <span class="hm-file-name">{file.path.split(/[/\\]/).pop()}</span>
            <span class="hm-file-meta muted small">{hmFormatFileMeta(file)}</span>
            <button
              class="btn-ghost hm-file-remove"
              title="Remove"
              onclick={(e) => { e.stopPropagation(); hmRemoveFile(file.path); }}
            >×</button>
          </li>
        {/each}
      {/if}
    </ul>
  </section>

  <section class="plugin-section">
    <h3>Preview</h3>
    <div class="hm-preview-frame">
      {#if isVideoPreview}
        <video class="hm-preview-media" src={hm.previewSrc} controls></video>
      {:else if hm.previewSrc}
        <img class="hm-preview-media" src={hm.previewSrc} alt="Preview" />
      {:else}
        <p class="hm-preview-empty muted small">{hm.busy ? "Generating preview…" : "Select a file to preview."}</p>
      {/if}
    </div>
  </section>

  <section class="plugin-section">
    <h3>Convert</h3>
    <p class="muted small">Images → JPEG or PNG. Videos → MP4 (H.264 + AAC).</p>
    <div class="hm-convert-options">
      <label class="hm-option">
        Image format
        <select disabled={hm.busy} bind:value={hm.imageFormat}>
          <option value="jpeg">JPEG</option>
          <option value="png">PNG</option>
        </select>
      </label>
      <label class="checkbox-row hm-option">
        <input type="checkbox" disabled={hm.busy} bind:checked={hm.overwrite} />
        <span>Overwrite existing outputs</span>
      </label>
    </div>
    <p class="muted small hm-output-line">
      Output:
      <span class="hm-output-path">{outputLabel}</span>
      <button class="btn-ghost hm-pick-dir" disabled={hm.busy} onclick={hmPickOutputDir}>
        {hm.outputDir ? "Change folder…" : "Choose folder…"}
      </button>
      {#if hm.outputDir}
        <button class="btn-ghost" disabled={hm.busy} onclick={() => { hm.outputDir = null; }}>Use source folders</button>
      {/if}
    </p>
    <div class="action-row">
      <button class="btn btn-primary" disabled={hm.busy || hm.files.length === 0} onclick={hmConvert}>
        {hm.busy && hm.busyLabel === "Converting" ? "Converting…" : "Convert all"}
      </button>
      <button class="btn-ghost" disabled={hm.files.length === 0 && !hm.outputDir} onclick={hmOpenOutputFolder}>Open output folder</button>
    </div>
  </section>
</div>
