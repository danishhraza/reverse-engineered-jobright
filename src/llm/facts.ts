import type { Profile, YearMonth } from '../types';

// What the model is told about you. Only what screening questions need: no
// email, phone, street address or EEO answers.

const ym = (d?: YearMonth) => (d ? `${d.month ? `${String(d.month).padStart(2, '0')}/` : ''}${d.year}` : '');

export function profileFacts(p: Profile): string {
  const per = p.personal;
  const lines: string[] = [];
  lines.push(`Today: ${new Date().toISOString().slice(0, 10)}`);
  const place = [per.city, per.state, per.country].filter(Boolean).join(', ');
  if (place) lines.push(`Lives in: ${place}`);
  for (const [country, a] of Object.entries(p.eeo.workAuth ?? {})) {
    lines.push(
      `Work authorization in ${country}: ${a.authorized ? 'authorized to work' : 'NOT authorized to work'}; ${a.requiresSponsorship ? 'needs visa sponsorship now or in future' : 'does not need sponsorship'}${a.citizen ? '; citizen' : ''}`,
    );
  }
  if (p.eeo.over18 !== undefined) lines.push(`Over 18: ${p.eeo.over18 ? 'yes' : 'no'}`);
  if (p.headline) lines.push(`Headline: ${p.headline}`);
  if (p.education.length) {
    lines.push('Education:');
    for (const e of p.education) {
      lines.push(`- ${e.degree} in ${e.major}, ${e.school}${e.end ? `, ${e.current ? 'expected' : 'graduated'} ${ym(e.end)}` : ''}${e.gpa ? `, GPA ${e.gpa}` : ''}`);
    }
  }
  if (p.work.length) {
    lines.push('Work history:');
    for (const w of p.work) lines.push(`- ${w.title}, ${w.company}${w.location ? ` (${w.location})` : ''}, ${ym(w.start)} – ${w.current ? 'present' : ym(w.end)}`);
  }
  if (p.skills.length) lines.push(`Skills: ${p.skills.slice(0, 30).join(', ')}`);
  const pref = p.preferences;
  if (pref.salaryMin || pref.salaryMax) lines.push(`Salary expectation: ${[pref.salaryMin, pref.salaryMax].filter(Boolean).join(' – ')} ${pref.salaryCurrency ?? 'USD'}`);
  if (pref.startAvailability) lines.push(`Can start: ${pref.startAvailability}`);
  if (pref.noticePeriod) lines.push(`Notice period: ${pref.noticePeriod}`);
  if (pref.willingToRelocate !== undefined) lines.push(`Willing to relocate: ${pref.willingToRelocate ? 'yes' : 'no'}`);
  if (pref.remotePreference) lines.push(`Remote preference: ${pref.remotePreference}`);
  return lines.join('\n');
}
