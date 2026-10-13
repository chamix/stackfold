/**
 * Barrel for the `web-app` plugin family — exports both Cycle 1 flavor
 * instances (initial_scaffold.md, "File set — Cycle 1"). `cli/index.ts`
 * registers these the same way it registers `electronTsPlugin`; nothing
 * outside this family needs to know the flavors share fragments.
 */
export { webAppSpaPlugin } from './spa.js';
export { webAppStandaloneHtmlPlugin } from './standalone-html.js';
