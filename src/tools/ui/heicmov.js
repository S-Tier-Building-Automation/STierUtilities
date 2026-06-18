// HEIC & MOV tool page — preview, convert, and file list UI.

/**
 * @param {object} deps
 * @param {typeof import("../../platform/tauri.js").invoke} deps.invoke
 * @param {typeof import("../../platform/tauri.js").convertFileSrc} deps.convertFileSrc
 * @param {import("../../ui/dom.js").el} deps.el
 * @param {(toolId: string, msg: string, kind?: string) => void} deps.logTo
 * @param {() => void} deps.renderAll
 * @param {() => Promise<string[]>} deps.pickHeicMovFiles
 * @param {() => Promise<string|null>} deps.pickFolder
 */
export function createHeicMovUi({
  invoke, convertFileSrc, el, logTo, renderAll, pickHeicMovFiles, pickFolder,
}) {
  let hm = {
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
  };

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
      renderAll();
      return;
    }
    hm.busy = true;
    hm.busyLabel = "Previewing";
    renderAll();
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
      renderAll();
    }
  }

  async function hmPickFiles() {
    try {
      const paths = await pickHeicMovFiles();
      if (paths.length === 0) return;
      hm.busy = true;
      hm.busyLabel = "Loading";
      hm.progress = { done: 0, total: paths.length };
      renderAll();

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
        renderAll();
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
      renderAll();
    }
  }

  async function hmPickOutputDir() {
    try {
      const dir = await pickFolder();
      if (dir) {
        hm.outputDir = dir;
        logTo("heicmov", `Output folder: ${dir}`, "info");
        renderAll();
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
    renderAll();
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
        renderAll();
      }
      logTo("heicmov", `Done — ${okCount}/${batch.results.length} succeeded.`, okCount ? "ok" : "warn");
    } catch (err) {
      logTo("heicmov", `Convert failed: ${err}`, "error");
    } finally {
      hm.busy = false;
      hm.busyLabel = "";
      hm.progress = null;
      renderAll();
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
      else renderAll();
      return;
    }
    renderAll();
  }

  function hmClearFiles() {
    hm.files = [];
    hm.selectedPath = null;
    hm.previewSrc = null;
    hm.previewMime = null;
    renderAll();
  }

  function renderStatusPill() {
    if (hm.busy) {
      const label = hm.progress
        ? `${hm.busyLabel} ${hm.progress.done}/${hm.progress.total}`
        : hm.busyLabel || "Working";
      return { label, cls: "pill-running" };
    }
    if (hm.files.length === 0) return { label: "No files", cls: "pill-idle" };
    return { label: `${hm.files.length} file${hm.files.length === 1 ? "" : "s"}`, cls: "pill-muted" };
  }

  function renderPage() {
    const pickBtn = el("button", {
      class: "btn btn-primary",
      disabled: hm.busy ? "disabled" : undefined,
      onclick: hmPickFiles,
    }, "Choose files…");

    const clearBtn = el("button", {
      class: "btn-ghost",
      disabled: hm.busy || hm.files.length === 0 ? "disabled" : undefined,
      onclick: hmClearFiles,
    }, "Clear list");

    const fileList = el("ul", { class: "hm-file-list" });
    if (hm.files.length === 0) {
      fileList.appendChild(el("li", { class: "hm-file-empty muted small" },
        "No files yet. Choose HEIC, HEIF, or MOV files to preview and convert.",
      ));
    } else {
      for (const file of hm.files) {
        const active = file.path === hm.selectedPath;
        fileList.appendChild(el("li", {
          class: `hm-file-row ${active ? "hm-file-active" : ""}`,
          onclick: () => hmSelectFile(file.path),
        },
          el("span", { class: "hm-file-name" }, file.path.split(/[/\\]/).pop()),
          el("span", { class: "hm-file-meta muted small" }, hmFormatFileMeta(file)),
          el("button", {
            class: "btn-ghost hm-file-remove",
            title: "Remove",
            onclick: (e) => { e.stopPropagation(); hmRemoveFile(file.path); },
          }, "×"),
        ));
      }
    }

    let previewNode;
    if (hm.previewSrc && hm.previewMime?.startsWith("video/")) {
      previewNode = el("video", {
        class: "hm-preview-media",
        src: hm.previewSrc,
        controls: "controls",
      });
    } else if (hm.previewSrc) {
      previewNode = el("img", {
        class: "hm-preview-media",
        src: hm.previewSrc,
        alt: "Preview",
      });
    } else {
      previewNode = el("p", { class: "hm-preview-empty muted small" },
        hm.busy ? "Generating preview…" : "Select a file to preview.",
      );
    }

    const outputLabel = hm.outputDir
      ? hm.outputDir
      : "Same folder as each source file";

    const convertBtn = el("button", {
      class: "btn btn-primary",
      disabled: hm.busy || hm.files.length === 0 ? "disabled" : undefined,
      onclick: hmConvert,
    }, hm.busy && hm.busyLabel === "Converting" ? "Converting…" : "Convert all");

    const openFolderBtn = el("button", {
      class: "btn-ghost",
      disabled: hm.files.length === 0 && !hm.outputDir ? "disabled" : undefined,
      onclick: hmOpenOutputFolder,
    }, "Open output folder");

    return el("div", { class: "plugin-controls" },
      el("section", { class: "plugin-section" },
        el("h3", {}, "Files"),
        el("div", { class: "action-row" }, pickBtn, clearBtn),
        fileList,
      ),

      el("section", { class: "plugin-section" },
        el("h3", {}, "Preview"),
        el("div", { class: "hm-preview-frame" }, previewNode),
      ),

      el("section", { class: "plugin-section" },
        el("h3", {}, "Convert"),
        el("p", { class: "muted small" },
          "Images → JPEG or PNG. Videos → MP4 (H.264 + AAC).",
        ),
        el("div", { class: "hm-convert-options" },
          el("label", { class: "hm-option" }, "Image format",
            el("select", {
              disabled: hm.busy ? "disabled" : undefined,
              onchange: (e) => { hm.imageFormat = e.target.value; },
            },
              el("option", { value: "jpeg", selected: hm.imageFormat === "jpeg" ? "selected" : undefined }, "JPEG"),
              el("option", { value: "png", selected: hm.imageFormat === "png" ? "selected" : undefined }, "PNG"),
            ),
          ),
          el("label", { class: "checkbox-row hm-option" },
            el("input", {
              type: "checkbox",
              checked: hm.overwrite ? "checked" : undefined,
              disabled: hm.busy ? "disabled" : undefined,
              onchange: (e) => { hm.overwrite = e.target.checked; },
            }),
            el("span", {}, "Overwrite existing outputs"),
          ),
        ),
        el("p", { class: "muted small hm-output-line" },
          "Output: ",
          el("span", { class: "hm-output-path" }, outputLabel),
          el("button", {
            class: "btn-ghost hm-pick-dir",
            disabled: hm.busy ? "disabled" : undefined,
            onclick: hmPickOutputDir,
          }, hm.outputDir ? "Change folder…" : "Choose folder…"),
          hm.outputDir ? el("button", {
            class: "btn-ghost",
            disabled: hm.busy ? "disabled" : undefined,
            onclick: () => { hm.outputDir = null; renderAll(); },
          }, "Use source folders") : null,
        ),
        el("div", { class: "action-row" }, convertBtn, openFolderBtn),
      ),
    );
  }

  return { renderStatusPill, renderPage };
}
