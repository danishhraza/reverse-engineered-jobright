import { hiddenOn, parseSites, siteOf, USUAL_HIDDEN_SITES } from '../src/profile/sites';
import { DEFAULT_SETTINGS } from '../src/types';

// Sites where the floating Autofill button stays hidden.

describe('sites without the floating button', () => {
  it('starts hidden on the big everyday sites, but not on job sites', () => {
    const list = DEFAULT_SETTINGS.fabHiddenSites;
    for (const host of ['www.youtube.com', 'm.youtube.com', 'web.whatsapp.com', 'www.facebook.com', 'mail.google.com', 'www.google.com', 'x.com'])
      expect(hiddenOn(host, list)).toBe(true);
    for (const host of ['careers.google.com', 'docs.google.com', 'job-boards.greenhouse.io', 'acme.wd1.myworkdayjobs.com', 'jobs.lever.co', 'www.linkedin.com'])
      expect(hiddenOn(host, list)).toBe(false);
    expect(list).toBe(USUAL_HIDDEN_SITES);
  });

  it('matches a site and its subdomains, not look-alikes', () => {
    expect(hiddenOn('news.example.com', ['example.com'])).toBe(true);
    expect(hiddenOn('example.com.', ['example.com'])).toBe(true);
    expect(hiddenOn('notexample.com', ['example.com'])).toBe(false);
    expect(hiddenOn('example.com.evil.io', ['example.com'])).toBe(false);
  });

  it('takes sites typed or pasted any which way', () => {
    expect(siteOf('https://www.YouTube.com/watch?v=1')).toBe('www.youtube.com');
    expect(siteOf('*.example.com')).toBe('example.com');
    expect(siteOf('localhost:8080/x')).toBe('localhost');
    expect(siteOf('not a site')).toBeNull();
    expect(parseSites('youtube.com\n\nhttps://youtube.com/feed, reddit.com\n# a note\nnonsense')).toEqual(['youtube.com', 'reddit.com']);
  });
});
