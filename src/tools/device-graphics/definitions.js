import { VAV_REHEAT_SERIES } from "./definitions/vav-reheat-series.js";
import { VAV_REHEAT_SERIES_SVG } from "./assets/vav-reheat-series.js";

/** @type {Record<string, string>} */
export const DEVICE_GRAPHIC_SVG = {
  "vav-reheat-series": VAV_REHEAT_SERIES_SVG,
};

/** @type {import("./resolve.js").DeviceGraphicDefinition[]} */
export const DEVICE_GRAPHICS = [VAV_REHEAT_SERIES];

/** Fallback when template entities predate graphicId metadata. */
/** @type {Record<string, string>} */
export const TEMPLATE_GRAPHIC_FALLBACK = {
  "template:vav": "vav-reheat-series",
  vav: "vav-reheat-series",
};
