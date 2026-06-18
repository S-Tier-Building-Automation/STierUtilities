export const HEICMOV_EXTENSIONS = ["heic", "heif", "mov"];

export function isSupportedMediaPath(path) {
  const base = path.split(/[/\\]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return false;
  const ext = base.slice(dot + 1).toLowerCase();
  return HEICMOV_EXTENSIONS.includes(ext);
}

/** @param {string[]} paths */
export function filterMediaPaths(paths) {
  return paths.filter(isSupportedMediaPath);
}
