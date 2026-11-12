// Open a URL in the user's default browser without involving a shell.
import { spawn } from 'node:child_process';

/**
 * The command that opens a URL on a platform. The URL is always one argument and never reaches a
 * shell: on Windows `cmd /c start` would let cmd.exe parse `&` in the query string, so the
 * documented shell-free equivalent (rundll32 url.dll,FileProtocolHandler) is used instead.
 */
export function browserCommand(url, platform = process.platform) {
  if (platform === 'darwin') return ['open', [url]];
  if (platform === 'win32') return ['rundll32', ['url.dll,FileProtocolHandler', url]];
  return ['xdg-open', [url]];
}

/** Best effort: resolves true if the opener was started. The caller always shows the URL as well. */
export function openBrowser(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return Promise.resolve(false);
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return Promise.resolve(false);
  const [command, args] = browserCommand(parsed.href);
  return new Promise(resolve => {
    try {
      const child = spawn(command, args, { stdio: 'ignore', detached: true, shell: false, windowsHide: true });
      child.once('error', () => resolve(false)); // e.g. xdg-open is not installed
      child.once('spawn', () => {
        child.unref();
        resolve(true);
      });
    } catch {
      resolve(false);
    }
  });
}
