// Where Claude Code's managed settings live, and which hook commands they already run. Kept apart from managed.mjs
// (which imports the CLI) so the plugin's PreToolUse guard can ask "is Glassbox already installed for every user?"
// without loading anything heavy. Claude Code reads managed-settings.json, then managed-settings.d/*.json by name.
import fs from 'node:fs';
import path from 'node:path';

export function managedDir(platform = process.platform, env = process.env) {
  if (env.GLASSBOX_MANAGED_DIR) return env.GLASSBOX_MANAGED_DIR;
  return platform === 'win32' ? 'C:\\Program Files\\ClaudeCode' : platform === 'darwin' ? '/Library/Application Support/ClaudeCode' : '/etc/claude-code';
}
export const dropInFile = (dir) => path.join(dir || managedDir(), 'managed-settings.d', 'glassbox.json');

export function managedFiles(dir = managedDir()) {
  const out = [path.join(dir, 'managed-settings.json')];
  try { for (const n of fs.readdirSync(path.join(dir, 'managed-settings.d')).filter((x) => /\.json$/i.test(x)).sort()) out.push(path.join(dir, 'managed-settings.d', n)); } catch (e) { }
  return out.filter((f) => { try { return fs.statSync(f).isFile(); } catch (e) { return false; } });
}

// Every hook command in the managed settings (and in any extra settings files given), for the events asked.
export function hookCommands(files, events) {
  const out = [];
  for (const f of files) {
    let j; try { j = JSON.parse(fs.readFileSync(f, 'utf8').replace(/^\ufeff/, '')); } catch (e) { continue; }
    const hooks = (j && j.hooks) || {};
    for (const [ev, list] of Object.entries(hooks)) {
      if (events && !events.includes(ev)) continue;
      if (!Array.isArray(list)) continue;
      for (const entry of list) for (const h of (entry && Array.isArray(entry.hooks) ? entry.hooks : [])) if (h && typeof h.command === 'string') out.push(h.command);
    }
  }
  return out;
}
