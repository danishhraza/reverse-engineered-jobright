// Sites where the floating Autofill button stays hidden. It starts with the big
// everyday sites (they have search boxes and message boxes that look like forms
// but are never job applications); you can edit the list in Options.
//
// Google is listed by subdomain so careers.google.com still gets the button, and
// docs.google.com is left out because some companies take applications in Google Forms.

export const USUAL_HIDDEN_SITES = [
  'youtube.com',
  'whatsapp.com',
  'facebook.com',
  'messenger.com',
  'instagram.com',
  'x.com',
  'twitter.com',
  'reddit.com',
  'tiktok.com',
  'snapchat.com',
  'pinterest.com',
  'discord.com',
  'web.telegram.org',
  'netflix.com',
  'twitch.tv',
  'spotify.com',
  'www.google.com',
  'mail.google.com',
  'drive.google.com',
  'calendar.google.com',
  'meet.google.com',
  'gemini.google.com',
  'outlook.live.com',
  'outlook.office.com',
  'bing.com',
  'yahoo.com',
  'chatgpt.com',
  'claude.ai',
  'amazon.com',
  'ebay.com',
  'wikipedia.org',
  'github.com',
];

/** "https://www.YouTube.com/watch?v=1" or "*.youtube.com" → "www.youtube.com" / "youtube.com". */
export function siteOf(entry: string): string | null {
  let s = entry.trim().toLowerCase();
  if (!s || s.startsWith('#')) return null;
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, '').replace(/^\*\./, '');
  s = s.split(/[/?#\s]/)[0].replace(/:\d+$/, '').replace(/\.$/, '');
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(s) || s === 'localhost' ? s : null;
}

/** One site per line, cleaned up and without repeats. Lines that aren't a site are dropped. */
export function parseSites(text: string): string[] {
  return [...new Set(text.split(/[\n,]+/).map(siteOf).filter((s): s is string => !!s))];
}

/** The page's host is a listed site or one of its subdomains. */
export function hiddenOn(host: string, sites: string[]): boolean {
  const h = host.toLowerCase().replace(/\.$/, '');
  return sites.some((s) => h === s || h.endsWith(`.${s}`));
}
