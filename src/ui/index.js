// Shared UI modules — barrel re-exports for the app shell and tool pages.

export { el, openExternal } from "./dom.js";
export { pickHeicMovFiles, pickFolder } from "./dialogs.js";
export { initWindowControls } from "./shell.js";
export { openModal, closeModal, confirmAction } from "./modal.js";
export { toast } from "./toast.js";
export { filterMediaPaths } from "./media-paths.js";
export { createAccountMenu } from "./account-menu.js";
export { createActivityLog } from "./activity.js";
export { createLibraryUi } from "./library.js";
export { createServicesPageUi } from "./services-page.js";
export { createAccountPageUi } from "./account-page.js";
export { createSettingsPageUi } from "./settings-page.js";
export { createPluginPageUi } from "./plugin-page.js";
export { createAppShell, initSidebarSplitter } from "./app-shell.js";
