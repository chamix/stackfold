/**
 * Plugin registry (GoF Registry) — maps a stable stack id to a
 * `StackfoldPlugin` instance, so the orchestrator only ever sees "a
 * StackfoldPlugin", never an `if (id === "electron-ts")` chain
 * (initial_scaffold.md, "Pattern Application"; functional_domain §3.5).
 *
 * Deliberately a simple static registry for now: there is exactly one
 * plugin today, so dynamic (cosmiconfig-based) discovery is not justified
 * yet. The concrete plugin list is supplied by the CLI composition root,
 * which keeps this module depending only on core/ (Inward Dependency Rule).
 */
import type { PluginRegistry } from '../core/ports.js';
import type { StackfoldPlugin } from '../core/types.js';

export class StaticPluginRegistry implements PluginRegistry {
  // Map, not a plain object: ids like "constructor" / "__proto__" must
  // never resolve to prototype members.
  readonly #byId = new Map<string, StackfoldPlugin>();

  constructor(plugins: readonly StackfoldPlugin[]) {
    for (const plugin of plugins) {
      if (typeof plugin.id !== 'string' || plugin.id.trim() === '') {
        throw new Error('Cannot register a stackfold plugin with an empty id');
      }
      if (this.#byId.has(plugin.id)) {
        throw new Error(`Duplicate stackfold plugin id "${plugin.id}"`);
      }
      this.#byId.set(plugin.id, plugin);
    }
  }

  resolve(id: string): StackfoldPlugin | undefined {
    return this.#byId.get(id);
  }

  list(): StackfoldPlugin[] {
    return [...this.#byId.values()];
  }
}
