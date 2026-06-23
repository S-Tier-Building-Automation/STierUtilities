// Shared DOM helpers for tool pages and shell chrome.

import { opener } from "../platform/tauri.js";

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") node.className = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  for (const c of children) {
    if (c == null || c === false) continue;
    node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return node;
}

const SVG_NS = "http://www.w3.org/2000/svg";

/**
 * Like `el()` but for SVG: builds nodes in the SVG namespace so shapes actually
 * render (createElement would make inert HTML elements). Used by the Graphics
 * Builder canvas. Event handlers (on*) and string children work the same way.
 */
export function svgEl(tag, attrs = {}, ...children) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  for (const c of children) {
    if (c == null || c === false) continue;
    node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return node;
}

export async function openExternal(url) {
  try {
    await opener.openUrl(url);
  } catch (err) {
    console.warn("openExternal failed:", err);
  }
}
