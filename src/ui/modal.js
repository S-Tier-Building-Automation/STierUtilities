// Generic modal overlay — About dialogs and confirmAction prompts.

import { el } from "./dom.js";

let activeModal = null;

export function closeModal() {
  if (!activeModal) return;
  document.removeEventListener("keydown", activeModal.onKey);
  activeModal.overlay.remove();
  activeModal = null;
}

/** One modal at a time: backdrop + centered card. Closes on ×, backdrop click, or Escape. */
export function openModal({ title, body = [] } = {}) {
  closeModal();
  const closeBtn = el("button", {
    class: "modal-close", title: "Close", "aria-label": "Close", onclick: closeModal,
  }, "×");
  const card = el("div",
    { class: "modal-card", role: "dialog", "aria-modal": "true", "aria-label": title || "Dialog" },
    el("div", { class: "modal-head" },
      el("h3", { class: "modal-title" }, title || ""),
      closeBtn,
    ),
    el("div", { class: "modal-body" }, ...(Array.isArray(body) ? body : [body])),
  );
  const overlay = el("div", {
    class: "modal-overlay",
    onclick: (e) => { if (e.target === e.currentTarget) closeModal(); },
  }, card);
  const onKey = (e) => { if (e.key === "Escape") { e.preventDefault(); closeModal(); } };
  document.addEventListener("keydown", onKey);
  document.body.appendChild(overlay);
  activeModal = { overlay, onKey };
  closeBtn.focus();
}

/** Modal yes/no. Resolves true on confirm, false on cancel or dismiss. */
export function confirmAction({ title = "Confirm", message = "", confirmLabel = "Confirm", danger = false } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; closeModal(); resolve(v); } };
    const confirmBtn = el("button", {
      class: danger ? "btn btn-danger" : "btn btn-primary",
      onclick: () => done(true),
    }, confirmLabel);
    const cancelBtn = el("button", { class: "btn btn-ghost", onclick: () => done(false) }, "Cancel");
    const body = el("div", { class: "confirm-body" },
      el("p", {}, message),
      el("div", { class: "confirm-actions" }, cancelBtn, confirmBtn),
    );
    openModal({ title, body: [body] });
    cancelBtn.focus();
  });
}
