// Account page — local profile, org switching, folder sync.

/**
 * @param {object} deps
 * @param {import("./dom.js").el} deps.el
 * @param {() => object|null} deps.getAuthState
 * @param {() => object|null} deps.activeAuthUser
 * @param {() => object|null} deps.activeAuthOrg
 * @param {object} deps.authDraft
 * @param {() => boolean} deps.getAuthSyncBusy
 * @param {() => string} deps.getAuthSyncMessage
 * @param {() => void|Promise<void>} deps.authCreateLocalAccount
 * @param {(orgId: string) => void|Promise<void>} deps.authSwitchOrg
 * @param {() => void|Promise<void>} deps.authCreateOrg
 * @param {() => void|Promise<void>} deps.authSignOut
 * @param {() => void|Promise<void>} deps.authExportSnapshot
 * @param {() => void|Promise<void>} deps.authPickSyncFolder
 * @param {() => void|Promise<void>} deps.authClearSyncFolder
 * @param {(opts?: { quiet?: boolean }) => void|Promise<void>} deps.authSyncNow
 * @param {() => void} deps.renderAll
 */
export function createAccountPageUi({
  el, getAuthState, activeAuthUser, activeAuthOrg, authDraft,
  getAuthSyncBusy, getAuthSyncMessage,
  authCreateLocalAccount, authSwitchOrg, authCreateOrg, authSignOut,
  authExportSnapshot, authPickSyncFolder, authClearSyncFolder, authSyncNow,
  renderAll,
}) {
  function renderPage() {
    const root = document.getElementById("view-root");
    root.replaceChildren();

    root.appendChild(el("div", { class: "view-header" },
      el("h2", {}, "Account"),
    ));

    const authState = getAuthState();
    const user = activeAuthUser();
    const org = activeAuthOrg();
    const session = authState && authState.session;
    const userOrgs = session
      ? (authState.orgs || []).filter((o) => o.ownerUserId === session.userId)
      : [];
    const lastSynced = authState && authState.lastSyncedAt
      ? new Date(authState.lastSyncedAt * 1000).toLocaleString()
      : "";
    const authSyncBusy = getAuthSyncBusy();
    const authSyncMessage = getAuthSyncMessage();

    root.appendChild(el("section", { class: "settings-card" },
      el("h3", {}, "Profile & sync"),
      session
        ? el("div", { class: "settings-stack" },
            el("p", { class: "muted small" },
              "Preferences, last page, installed tools, and workspace state are saved under this local user and organization."),
            el("div", { class: "settings-kv" },
              el("span", { class: "muted small" }, "User"),
              el("strong", {}, user ? user.name : session.userId),
              el("span", { class: "muted small" }, "Email"),
              el("span", {}, user ? user.email : "local"),
              el("span", { class: "muted small" }, "Organization"),
              el("select", {
                class: "nm-input",
                onchange: (e) => authSwitchOrg(e.target.value),
              }, ...userOrgs.map((o) => el("option", {
                value: o.id,
                selected: o.id === session.orgId ? "selected" : undefined,
              }, o.name))),
              el("span", { class: "muted small" }, "Device"),
              el("code", {}, authState.deviceId || session.deviceId),
            ),
            el("div", { class: "settings-inline" },
              el("input", {
                class: "nm-input",
                value: authDraft.newOrgName,
                placeholder: "New organization",
                oninput: (e) => { authDraft.newOrgName = e.target.value; renderAll(); },
                onkeydown: (e) => { if (e.key === "Enter") authCreateOrg(); },
              }),
              el("button", {
                class: "btn-ghost",
                disabled: !authDraft.newOrgName.trim() ? "disabled" : undefined,
                onclick: authCreateOrg,
              }, "Add org"),
            ),
            el("p", { class: "muted small" },
              authState.syncStatus ? authState.syncStatus.message : "Local-first profile."),
            authState.syncFolder && el("div", { class: "settings-kv" },
              el("span", { class: "muted small" }, "Sync folder"),
              el("code", {}, authState.syncFolder),
              lastSynced && el("span", { class: "muted small" }, "Last sync"),
              lastSynced && el("span", {}, lastSynced),
            ),
            authSyncMessage && el("p", { class: "muted small" }, authSyncMessage),
            el("div", { class: "tool-actions" },
              el("button", {
                class: "btn-ghost",
                disabled: authSyncBusy ? "disabled" : undefined,
                onclick: authPickSyncFolder,
              }, authState.syncFolder ? "Change sync folder" : "Choose sync folder"),
              authState.syncFolder && el("button", {
                class: "btn btn-primary",
                disabled: authSyncBusy ? "disabled" : undefined,
                onclick: () => authSyncNow(),
              }, authSyncBusy ? "Syncing..." : "Sync now"),
              authState.syncFolder && el("button", {
                class: "btn-ghost",
                disabled: authSyncBusy ? "disabled" : undefined,
                onclick: authClearSyncFolder,
              }, "Disconnect sync"),
              el("button", { class: "btn-ghost", onclick: authExportSnapshot }, "Copy snapshot"),
              el("button", { class: "btn-ghost", onclick: authSignOut }, "Sign out"),
            ),
          )
        : el("div", { class: "settings-stack" },
            el("p", { class: "muted small" },
              "Create a local profile so app state is scoped by user and organization instead of only browser storage."),
            el("div", { class: "settings-form-grid" },
              el("label", { class: "field-label" },
                "Name",
                el("input", {
                  class: "nm-input",
                  value: authDraft.name,
                  placeholder: "Local User",
                  oninput: (e) => { authDraft.name = e.target.value; },
                }),
              ),
              el("label", { class: "field-label" },
                "Email",
                el("input", {
                  class: "nm-input",
                  value: authDraft.email,
                  placeholder: "name@example.com",
                  oninput: (e) => { authDraft.email = e.target.value; },
                }),
              ),
              el("label", { class: "field-label" },
                "Organization",
                el("input", {
                  class: "nm-input",
                  value: authDraft.orgName,
                  placeholder: "Personal",
                  oninput: (e) => { authDraft.orgName = e.target.value; },
                }),
              ),
            ),
            el("div", { class: "tool-actions" },
              el("button", { class: "btn btn-primary", onclick: authCreateLocalAccount }, "Create local profile"),
              el("button", {
                class: "btn-ghost",
                disabled: authSyncBusy ? "disabled" : undefined,
                onclick: authPickSyncFolder,
              }, authSyncBusy ? "Connecting..." : "Connect sync folder"),
            ),
            authSyncMessage && el("p", { class: "muted small" }, authSyncMessage),
          ),
    ));
  }

  return { renderPage };
}
