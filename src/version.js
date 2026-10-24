import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
/** The installed package version, read once from package.json so it never drifts. */
export const VERSION = pkg.version;
/** The commit this release was published from, which the release job writes; null in a development copy. */
export const GIT_HEAD = pkg.gitHead ?? null;
