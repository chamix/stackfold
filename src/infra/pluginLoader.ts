/**
 * Plugin registry (GoF Registry) — maps a stable stack id to a
 * `StackfoldPlugin` instance, so the orchestrator only ever sees "a
 * StackfoldPlugin", never an `if (id === "electron-ts")` chain
 * (initial_scaffold.md, "Pattern Application"; functional_domain §3.5).
 *
 * Was "deliberately a simple static registry for now" — that "for now" ended
 * at Task 049/SK-ADR-005 (ARCH-002): `infra/dynamicPluginRegistry.ts` now
 * covers the cosmiconfig-based, externally-registered case, composed with
 * this one via `infra/compositePluginRegistry.ts`. This class keeps its
 * original, narrow job (built-ins only) and its original synchronous
 * in-memory lookup — `resolve()`/`list()` only wrap already-resolved values
 * in `Promise.resolve(...)` to satisfy `PluginRegistry`'s now-async port
 * shape; zero behavior change for built-ins (no real `await` ever happens).
 * The concrete plugin list is supplied by the CLI composition root, which
 * keeps this module depending only on core/ (Inward Dependency Rule).
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

  async resolve(id: string): Promise<StackfoldPlugin | undefined> {
    return this.#byId.get(id);
  }

  async list(): Promise<StackfoldPlugin[]> {
    return [...this.#byId.values()];
  }
}
