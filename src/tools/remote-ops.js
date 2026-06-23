// Remote operations + role-based access control. The cloud supervisor shares a
// site with different audiences: integrators engineer it, operators command it,
// owners watch it, tenants see only their own space. This module is the policy
// gate for remote reads and manual point commands.

/** Capabilities each role is granted. Integrators get everything. */
export const ROLE_GRANTS = {
  integrator: { read: true, command: true, configure: true, share: true },
  operator: { read: true, command: true, configure: false, share: false },
  owner: { read: true, command: false, configure: false, share: false },
  tenant: { read: true, command: false, configure: false, share: false, ownScopeOnly: true },
};

export function grantsFor(role) {
  return ROLE_GRANTS[role] || { read: false, command: false, configure: false, share: false };
}

export function canRead(role) {
  return Boolean(grantsFor(role).read);
}

export function canCommand(role) {
  return Boolean(grantsFor(role).command);
}

/** Tenants are restricted to entities under their assigned scope id. */
export function scopeAllowed(role, { allowedScopeId, entityScopeId } = {}) {
  const g = grantsFor(role);
  if (!g.ownScopeOnly) return true;
  return Boolean(allowedScopeId) && allowedScopeId === entityScopeId;
}

/**
 * The remote-ops service: gates point commands by role before delegating to the
 * bacnet.read write path, and records an audit entry via the injected logger.
 * @param {{ bacnet: object, role: string, audit?: (entry:object)=>void, allowedScopeId?: string }} deps
 */
export function createRemoteOps({ bacnet, role, audit = () => {}, allowedScopeId = null } = {}) {
  if (!bacnet) throw new Error("remote ops requires a bacnet.read capability");

  return {
    role,
    can: (action) => Boolean(grantsFor(role)[action]),

    /** Read a point remotely (any role with read). */
    async readPoint({ device, objectType, instance, entityScopeId = null }) {
      if (!canRead(role)) throw new Error(`role "${role}" cannot read`);
      if (!scopeAllowed(role, { allowedScopeId, entityScopeId })) throw new Error("out of allowed scope");
      return bacnet.readPoint(device, objectType, instance);
    },

    /** Manually command a point remotely — integrator/operator only, audited. */
    async commandPoint({ device, objectType, instance, property, value, priority = null, entityScopeId = null, actor = null }) {
      if (!canCommand(role)) throw new Error(`role "${role}" is not permitted to command points`);
      if (!scopeAllowed(role, { allowedScopeId, entityScopeId })) throw new Error("out of allowed scope");
      const result = await bacnet.writeProperty({ device, objectType, instance, property, value, priority });
      audit({ action: "command", actor, role, device, objectType, instance, property, value, priority, at: new Date().toISOString() });
      return result;
    },
  };
}
