/**
 * Composite plugin registry (GoF Composite) — Task 049/SK-ADR-005
 * (ARCH-002). `cli/index.ts` is the only thing that instantiates this; every
 * CLI command (`list`/`info`/`init`) keeps consuming the plain
 * `PluginRegistry` port (`core/ports.ts`) and never knows whether a given
 * plugin came from a `StaticPluginRegistry` (built-ins) or a
 * `DynamicPluginRegistry` (externally registered) — exactly the point of
 * composing them behind one port.
 *
 * Composed `[staticRegistry, dynamicRegistry]`, in that order (SK-ADR-005
 * Decision 4): a built-in always wins an id collision against an external
 * plugin.
 *   - `resolve()` tries each composed registry in order and returns the
 *     first match — silently; an id collision never throws, so a typo'd
 *     external registration that happens to shadow a built-in id can never
 *     block `stackfold` for everyone (same reasoning as a single broken
 *     external entry never breaking `list()`/`init` for the others, in
 *     `infra/dynamicPluginRegistry.ts`).
 *   - `list()` concatenates every composed registry's own `list()`,
 *     deduping by id. The earlier registry's plugin wins; the later,
 *     colliding one is dropped with a warning to stderr — same "warn,
 *     don't throw" treatment a broken entry already gets inside
 *     `DynamicPluginRegistry.list()`.
 */
import type { PluginRegistry } from '../core/ports.js';
import type { StackfoldPlugin } from '../core/types.js';

export interface CompositePluginRegistryDependencies {
  /** Defaults to `(line) => console.error(line)`. */
  stderr?: (line: string) => void;
}

export class CompositePluginRegistry implements PluginRegistry {
  readonly #registries: readonly PluginRegistry[];
  readonly #stderr: (line: string) => void;

  constructor(registries: readonly PluginRegistry[], deps: CompositePluginRegistryDependencies = {}) {
    this.#registries = registries;
    this.#stderr = deps.stderr ?? ((line) => console.error(line));
  }

  async resolve(id: string): Promise<StackfoldPlugin | undefined> {
    for (const registry of this.#registries) {
      const plugin = await registry.resolve(id);
      if (plugin) return plugin;
    }
    return undefined;
  }

  async list(): Promise<StackfoldPlugin[]> {
    const byId = new Map<string, StackfoldPlugin>();

    for (const registry of this.#registries) {
      for (const plugin of await registry.list()) {
        if (byId.has(plugin.id)) {
          this.#stderr(
            `stackfold: plugin id "${plugin.id}" is registered more than once — keeping the first one found ` +
              'and ignoring this one.'
          );
          continue;
        }
        byId.set(plugin.id, plugin);
      }
    }

    return [...byId.values()];
  }
}
