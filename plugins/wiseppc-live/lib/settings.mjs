// Duplicate-install check. wiseppc-live is installed INSTEAD of the standard wiseppc plugin; with
// both enabled, every WisePPC tool would appear twice and the standard plugin would hold a second
// connection. This reads Claude Code's settings files (local files only, no network) and reports it.
//
// enabledPlugins is an object such as { "wiseppc@wiseppc": true }. Later files override earlier
// ones key by key (user, then project, then project-local), as Claude Code does.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const STANDARD_PLUGIN = /^wiseppc@/; // "wiseppc-live@..." does not match: the character after "wiseppc" must be "@"

export function settingsFiles(env = process.env) {
  const userDir = (env.CLAUDE_CONFIG_DIR ?? '').trim() || join(homedir(), '.claude');
  const files = [join(userDir, 'settings.json')];
  const project = (env.CLAUDE_PROJECT_DIR ?? '').trim();
  if (project) files.push(join(project, '.claude', 'settings.json'), join(project, '.claude', 'settings.local.json'));
  return files;
}

function readEnabledPlugins(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    const plugins = parsed?.enabledPlugins;
    return plugins !== null && typeof plugins === 'object' && !Array.isArray(plugins) ? plugins : {};
  } catch {
    return {}; // missing or unreadable settings are not an error here
  }
}

/** The enabled "wiseppc@<marketplace>" plugin ids (the standard plugin), or []. */
export function findStandardPlugin(env = process.env) {
  const merged = {};
  for (const file of settingsFiles(env)) Object.assign(merged, readEnabledPlugins(file));
  return Object.keys(merged).filter(id => STANDARD_PLUGIN.test(id) && merged[id] === true);
}

export function duplicateWarning(env = process.env) {
  const found = findStandardPlugin(env);
  if (found.length === 0) return null;
  return (
    `The standard WisePPC plugin (${found.join(', ')}) is also enabled next to wiseppc-live. ` +
    'Both provide the same WisePPC tools, so they appear twice. Disable one: run `/plugin`, then ' +
    'disable either wiseppc or wiseppc-live (use only one of them).'
  );
}
