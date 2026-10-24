import { readFileSync } from 'node:fs';

/** The installed package version, read once from package.json so it never drifts. */
export const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
