import { config } from '../config';
import { getSettings } from '../db/repo';

/**
 * Optional phone push via ntfy (https://ntfy.sh or self-hosted). Set the topic
 * URL in Settings, e.g. https://ntfy.sh/money-factory-<random>. Only a short
 * summary is sent; approving still happens in the app.
 */
export async function notify(title: string, body: string, opts: { priority?: 'default' | 'high'; tags?: string[]; path?: string } = {}) {
  const url = getSettings().ntfy_url;
  if (!url) return;
  try {
    await fetch(url, {
      method: 'POST',
      body,
      headers: {
        Title: title.replace(/[^\x20-\x7E]/g, ''),
        Priority: opts.priority === 'high' ? '4' : '3',
        Tags: (opts.tags ?? ['factory']).join(','),
        Click: config.PUBLIC_URL + (opts.path ?? ''),
      },
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    // Notifications are best-effort; never block the factory on them.
  }
}
