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
  if (p.facts?.length) {
    lines.push('Facts the candidate stated about themself (always true; they settle questions on these topics):');
    for (const f of p.facts.slice(0, 60)) lines.push(`- ${f.trim().slice(0, 300)}`);
  }
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
  if (pref.salaryMin || pref.salaryMax) {
    lines.push(
      `Salary expectation: ${[pref.salaryMin, pref.salaryMax].filter(Boolean).join(' – ')} ${pref.salaryCurrency ?? 'USD'}${
        pref.salaryPreferred ? ` (as one number: ${pref.salaryPreferred})` : ''
      }; if the job posts a pay range, answer within that range instead`,
    );
  }
  if (pref.startAvailability) lines.push(`Can start: ${pref.startAvailability}`);
  if (pref.noticePeriod) lines.push(`Notice period: ${pref.noticePeriod}`);
  if (pref.willingToRelocate !== undefined) lines.push(`Willing to relocate: ${pref.willingToRelocate ? 'yes' : 'no'}`);
  if (pref.remotePreference) lines.push(`Remote preference: ${pref.remotePreference}`);
  if (pref.additionalInfo) lines.push(`Other notes from the candidate: ${pref.additionalInfo.slice(0, 1200)}`);
  // Your own answers to recurring questions, so similar wordings get the same answer.
  if (p.answers.length) {
    lines.push('Answers the candidate gave to recurring questions (question pattern -> answer):');
    for (const a of p.answers.slice(0, 40)) lines.push(`- ${a.pattern.replace(/^\/(.+)\/[a-z]*$/, '$1')} -> ${a.answer}`);
  }
  return lines.join('\n');
}
