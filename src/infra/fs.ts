/**
 * File-system adapter. Wraps node:fs so the core/plugin layers never
 * import node:fs directly — keeps them testable with a fake.
 *
 * TODO: fill in as real plugins need it (copy template tree, write
 * rendered files, etc.) — kept empty until there's real usage driving
 * the shape, per "no reinventar la rueda, pero tampoco anticipar".
 */
export {};
