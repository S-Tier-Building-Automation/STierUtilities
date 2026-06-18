// Transient toast notifications — non-modal feedback stacked in a fixed container.

import { el } from "./dom.js";

let toastContainer = null;

export function toast(message, kind = "ok", timeoutMs = 4000) {
  if (typeof document === "undefined") return null;
  if (!toastContainer || !document.body.contains(toastContainer)) {
    toastContainer = el("div", { class: "toast-stack", "aria-live": "polite" });
    document.body.appendChild(toastContainer);
  }
  const node = el("div", { class: `toast toast-${kind}`, role: "status" }, String(message));
  const remove = () => {
    node.remove();
    if (toastContainer && !toastContainer.childElementCount) {
      toastContainer.remove();
      toastContainer = null;
    }
  };
  node.addEventListener("click", remove);
  toastContainer.appendChild(node);
  setTimeout(remove, Math.max(1000, timeoutMs));
  return node;
}
