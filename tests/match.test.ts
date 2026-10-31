import { matchOption, patternMatches } from '../src/engine/match';

const pick = (opts: string[], d: Parameters<typeof matchOption>[1]) => {
  const m = matchOption(opts, d);
  return m ? { label: opts[m.index], score: m.score } : null;
};

describe('matchOption', () => {
  it('matches countries through alternates', () => {
    const r = pick(['Select...', 'Canada', 'United States of America', 'United Kingdom'], { text: 'United States', alts: ['USA'] });
    expect(r?.label).toBe('United States of America');
    expect(r!.score).toBeGreaterThanOrEqual(0.8);
  });

  it('answers sponsorship No against wordy options', () => {
    const r = pick(['Yes, I will require sponsorship', 'No, I will not require sponsorship'], { text: 'No', bool: false });
    expect(r?.label).toMatch(/^No/);
  });

  it('picks the not-a-veteran option and ignores decline', () => {
    const opts = [
      'I identify as one or more of the classifications of protected veteran',
      'I am not a protected veteran',
      "I don't wish to answer",
    ];
    expect(pick(opts, { text: 'No', bool: false })?.label).toBe('I am not a protected veteran');
    expect(pick(opts, { text: 'Decline', decline: true })?.label).toBe("I don't wish to answer");
  });

  it('picks the right disability option', () => {
    const opts = [
      'Yes, I have a disability (or previously had a disability)',
      'No, I do not have a disability and have not had one in the past',
      'I do not want to answer',
    ];
    expect(pick(opts, { text: 'No', bool: false })?.label).toMatch(/^No, I do not/);
  });

  it('maps Male to Man', () => {
    expect(pick(['Woman', 'Man', 'Non-binary', 'Decline to self-identify'], { text: 'Male', alts: ['Man', 'Male'] })?.label).toBe('Man');
  });

  it('gives low confidence when nothing fits', () => {
    const r = pick(['Red', 'Green', 'Blue'], { text: 'Austin, TX' });
    expect(r === null || r.score < 0.6).toBe(true);
  });
});

describe('patternMatches', () => {
  it('handles plain words and regex', () => {
    expect(patternMatches('require sponsorship', 'Will you now or in the future require sponsorship for employment visa status?')).toBe(true);
    expect(patternMatches('/18 years|over 18/i', 'Are you at least 18 years of age?')).toBe(true);
    expect(patternMatches('require sponsorship', 'Are you authorized to work?')).toBe(false);
  });
});
