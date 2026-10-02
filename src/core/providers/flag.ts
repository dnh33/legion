/**
 * The experimental switch for everything the second provider pass adds (the CLI adapters, vm_cli, lead choices, the local-MCP opt-in panel,
 * token caps, taint controls in Settings, delegate-only). It is read from config.json only (`"experimental": { "providers": true }`); there
 * is no setting for it in the app. Anything but the boolean `true` means off. Read live, on every use.
 */
export function providersExperimental(config: unknown): boolean {
  const e = config && typeof config === 'object' ? (config as { experimental?: unknown }).experimental : undefined;
  return !!e && typeof e === 'object' && (e as { providers?: unknown }).providers === true;
}
