export const HEICMOV_EXTENSIONS = ["heic", "heif", "mov"];

export function isSupportedMediaPath(path) {
  const ext = path.split(/[/\\]/).pop()?.split(".").pop()?.toLowerCase();
  return HEICMOV_EXTENSIONS.includes(ext);
}

/** @param {string[]} paths */
export function filterMediaPaths(paths) {
  return paths.filter(isSupportedMediaPath);
}
