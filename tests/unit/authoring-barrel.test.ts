/**
 * ARCH-006 slice A (`.agents/specs/arch-006-plugin-composition.md`,
 * SK-ADR-011) — pins the exact runtime export surface of the published
 * `stackfold/authoring` barrel (`src/authoring/index.ts`), so a future
 * accidental removal (breaking an external author's import) or addition
 * (silently growing the SemVer-contract surface — SK-ADR-011 Decision 3) is
 * caught immediately, rather than discovered later against a real external
 * consumer.
 *
 * Deliberately checks `Object.keys()` of the real imported module (every
 * named export actually reachable at runtime), not a hand-maintained
 * duplicate list reasoned about from the source — a barrel file that
 * re-exports a type-only symbol contributes nothing here (types are erased),
 * which is why the type-only re-exports in the barrel's own export list
 * (`Fragment`, `FragmentFactory`, `MountFragmentOptions`,
 * `DefineScaffoldInput`, etc.) do not appear below.
 */
import { describe, expect, it } from 'vitest';
import * as authoringBarrel from '../../src/authoring/index.js';

describe('stackfold/authoring barrel — runtime export surface (SK-ADR-011 Decision 3: every export is SemVer contract)', () => {
  it('exports exactly the expected set of runtime symbols', () => {
    const actual = Object.keys(authoringBarrel).sort();

    const expected = [
      // builder.ts (pre-existing)
      'defineScaffold',
      'file',
      'gitInit',
      'mkdir',
      'npmInstall',
      'runCommand',
      'step',
      // templateLoader.ts (pre-existing)
      'loadTemplate',
      // core/validation.ts (pre-existing)
      'MAX_PACKAGE_NAME_LENGTH',
      'appNameConstraints',
      'appNameSchema',
      'authorConstraints',
      'authorSchema',
      'descriptionConstraints',
      'descriptionSchema',
      'pluginIdConstraints',
      'pluginIdSchema',
      'toValidate',
      // core/validation.ts (new — ARCH-006 slice B)
      'npmPackageNameConstraints',
      'npmPackageNameSchema',
      'singleLineConstraints',
      'singleLineSchema',
      // fragment.ts (new — ARCH-006 slice A)
      'composeFragments',
      'mergeHooks',
      'mountFragment',
      'resetFragmentNamespaceRegistry',
    ].sort();

    expect(actual).toEqual(expected);
  });
});
