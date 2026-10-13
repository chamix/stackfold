/**
 * `createWebAppPlugin()`: turns a declarative `WebAppFlavorDefinition`
 * into a `StackfoldPlugin` (SK-ADR-001 §Decision 2; initial_scaffold.md
 * "Interfaces"). The only place in the `web-app` family that calls
 * `composeBlueprint()` — a flavor module never composes fragments itself.
 *
 * Strategy (GoF): `selectFragments(answers)` is the strategy each flavor
 * supplies; this factory is strategy-agnostic and otherwise identical for
 * every flavor.
 */
import { composeBlueprint, type BlueprintFragment } from '../../core/composition.js';
import type { Answers, QuestionDefinition, StackfoldPlugin } from '../../core/types.js';
import { sharedQuestions } from './shared-questions.js';

export interface WebAppFlavorDefinition {
  flavorId: string;
  description: string;
  /** Questions beyond the shared base (appName/description/author). */
  flavorQuestions: QuestionDefinition[];
  selectFragments(answers: Answers): BlueprintFragment[];
}

export function createWebAppPlugin(def: WebAppFlavorDefinition): StackfoldPlugin {
  return {
    id: def.flavorId,
    description: def.description,

    questions(): QuestionDefinition[] {
      return [...sharedQuestions, ...def.flavorQuestions];
    },

    buildBlueprint(answers: Answers) {
      return composeBlueprint(def.selectFragments(answers));
    },
  };
}
