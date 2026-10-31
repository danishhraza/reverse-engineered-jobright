import type { Answer, Profile } from '../types';
import type { Field } from './fields';
import { norm, patternMatches, type Desired } from './match';

// Classification (question text -> profile key) and resolution (key -> answer).

interface Rule {
  key: string;
  label?: RegExp;
  attr?: RegExp;
  not?: RegExp;
  /** Only match short labels (a field name, not a sentence-long question). */
  short?: boolean;
}

// Order matters: specific rules before general ones.
const RULES: Rule[] = [
  { key: 'consent', label: /\bi (have read|agree|acknowledge|consent|certify|accept|understand)\b|privacy (policy|notice)|terms (of|and)|\bconsent\b/ },
  { key: 'coverLetter', label: /cover letter/, attr: /cover letter/ },
  { key: 'resume', label: /\b(resume|cv|curriculum vitae)\b/, attr: /\bresume\b|\bcv\b/, short: true },
  { key: 'preferredFirstName', label: /\b(preferred|nick) ?(first )?name\b|\bname you (go by|prefer)\b/, attr: /preferred (first )?name/ },
  { key: 'middleName', label: /\bmiddle (name|initial)\b/, attr: /middle name/ },
  { key: 'firstName', label: /\b(first|given|fore) ?name\b/, attr: /\bfirst ?name\b|\bfname\b|given name/, short: true },
  { key: 'lastName', label: /\b(last|family|sur) ?name\b/, attr: /\blast ?name\b|\blname\b|family name|surname/, short: true },
  { key: 'signature', label: /\bsignature\b|sign your (full )?name/, short: true },
  { key: 'fullName', label: /^(your |candidate |applicant )?(full |legal |complete )?name$|^(full|legal) name\b/, attr: /^name$|\bfull name\b|systemfield name/, short: true },
  { key: 'email', label: /\be ?mail\b/, attr: /\be ?mail\b/, short: true },
  { key: 'phoneType', label: /phone (device )?type|type of phone/, attr: /phone device type|phone type/ },
  { key: 'phoneCountryCode', label: /country (phone )?code|phone country|dial(ing)? code/, attr: /country phone code|phone country|country code/ },
  { key: 'skip', label: /\bextension\b|\bext\b/, short: true },
  { key: 'phone', label: /\b(phone|mobile|cell|telephone)\b/, attr: /\bphone\b|\btel\b/, short: true },
  { key: 'linkedin', label: /linked ?in/, attr: /linkedin/ },
  { key: 'github', label: /git ?hub/, attr: /github/ },
  { key: 'twitter', label: /twitter|\bx com\b/, attr: /twitter/ },
  { key: 'portfolio', label: /portfolio|personal (web)?site|^website|^web site|^blog|other (website|url|link)/, attr: /portfolio|website/, short: true },
  { key: 'address2', label: /address (line )?2|\bapt\b|apartment|suite/, attr: /address (line )?2|address2/, short: true },
  { key: 'address1', label: /^(street |mailing |home |current )?address( line)?( 1)?$|^street/, attr: /address (line )?1|address1|street/, short: true },
  { key: 'postalCode', label: /postal|\bzip\b|post code/, attr: /postal|\bzip\b/, short: true },
  { key: 'county', label: /\bcounty\b/, attr: /\bcounty\b/, short: true },
  { key: 'location', label: /\blocation\b|where are you (currently )?(located|based)|city (and|,) state|current city/, attr: /\blocation\b/, short: true, not: /willing|open to|relocat/ },
  { key: 'city', label: /\bcity\b|\btown\b/, attr: /\bcity\b/, short: true },
  { key: 'state', label: /\b(state|province|region)\b/, attr: /\bstate\b|\bregion\b|province/, short: true, not: /united states|statement/ },
  { key: 'country', label: /\bcountry\b/, attr: /\bcountry\b/, short: true, not: /code/ },
  { key: 'pronouns', label: /pronoun/ },
  { key: 'sponsorship', label: /sponsor/ },
  { key: 'workAuthorized', label: /(legally )?(authori[sz]ed|eligible|permitted) to work|work (authori[sz]ation|permit)|right to work|legal right to/ },
  { key: 'citizen', label: /\bcitizen(ship)?\b/ },
  { key: 'over18', label: /18 years|over 18|at least 18|age of 18|legal (working )?age/ },
  { key: 'previouslyEmployed', label: /(previously|ever|formerly|currently) (been )?(employed|worked) (by|for|at|with)|former employee|worked (for|at) .* before/ },
  { key: 'referred', label: /were you referred|referred by|employee referral|know anyone (who works|at)/ },
  { key: 'howDidYouHear', label: /how did you (hear|find|learn|come across)|where did you (hear|find|learn|see)|^source$|referral source|how .* find (out )?about/, attr: /\bsource\b/ },
  { key: 'relocate', label: /relocat/ },
  { key: 'hispanic', label: /hispanic|latin[oax]/ },
  { key: 'ethnicity', label: /\b(race|ethnicity|ethnic|racial)\b/ },
  { key: 'gender', label: /\bgender\b|\bsex\b/, not: /transgender|orientation/ },
  { key: 'lgbtq', label: /lgbt|sexual orientation|transgender/ },
  { key: 'veteran', label: /veteran|military|armed forces/ },
  { key: 'disability', label: /disabilit/ },
  { key: 'salary', label: /salary|compensation|pay (expectation|range|requirement)|desired pay|expected pay|rate expectation/ },
  { key: 'startAvailability', label: /start date|when can you start|available to start|earliest (start|available)|availability to start|notice period|when (would|could) you (be able to )?start/ },
  { key: 'yearsExperience', label: /years of (relevant |professional |work )?experience|how many years/ },
  { key: 'currentCompany', label: /(current|most recent|present|latest) (company|employer|organi[sz]ation)|^company( name)?$|^employer( name)?$|^organi[sz]ation$/, short: true },
  { key: 'currentTitle', label: /(current|most recent|present|latest) (job )?(title|position|role)|^(job )?title$|^position$/, short: true },
  { key: 'school', label: /\b(school|university|college|institution)\b/, attr: /\bschool\b/, short: true },
  { key: 'degree', label: /\bdegree\b|level of education|highest education/, attr: /\bdegree\b/, short: true },
  { key: 'major', label: /\bmajor\b|discipline|field of study|area of study|concentration/, attr: /discipline|major|field of study/, short: true },
  { key: 'gpa', label: /\bgpa\b|grade point|overall result/, short: true },
  { key: 'gradYear', label: /graduat(ion|e|ed)( year| date)?|year of graduation|completion (date|year)/, short: true },
  { key: 'skills', label: /^(technical )?skills$/, short: true },
  { key: 'additionalInfo', label: /additional information|anything else|additional comments|is there anything|other information/ },
  { key: 'summary', label: /^(professional )?summary$|^about (you|yourself|me)$|^bio$/, short: true },
  { key: 'headline', label: /^headline$/, short: true },
  { key: 'todayDate', label: /^(today s |todays )?date$|^date signed$/, short: true },
];

export interface Classification {
  key: string;
  score: number;
  source: 'learned' | 'answer-bank' | 'rule';
  answer?: string;
}

function wordCount(s: string): number {
  return s.split(' ').filter(Boolean).length;
}

export function classify(field: Field, bank: Answer[], learned: Answer[]): Classification | null {
  const label = norm(field.label);

  if (label) {
    const exact = learned.find((a) => norm(a.pattern) === label);
    if (exact) return { key: 'answer', score: 0.9, source: 'learned', answer: exact.answer };
    // Answer bank entries are meant for questions, not single-word fields like "Name".
    if (wordCount(label) >= 3) {
      const hit = bank.find((a) => patternMatches(a.pattern, field.label));
      if (hit) return { key: 'answer', score: 0.88, source: 'answer-bank', answer: hit.answer };
    }
  }

  const short = wordCount(label) <= 7;
  for (const r of RULES) {
    if (r.not && r.not.test(label)) continue;
    if (r.label && label && (!r.short || short) && r.label.test(label)) {
      return { key: r.key, score: short ? 0.92 : 0.85, source: 'rule' };
    }
  }
  // Weaker signal: name/id/automation-id attributes.
  for (const r of RULES) {
    if (r.attr && field.hints && r.attr.test(field.hints) && !(r.not && r.not.test(label))) {
      return { key: r.key, score: label ? 0.7 : 0.75, source: 'rule' };
    }
  }
  return null;
}

// ---------- Resolution ----------

export type Resolution = { desired: Desired } | { flag: string } | { skip: string };

const COUNTRY_ALTS: Record<string, string[]> = {
  'United States': ['United States of America', 'USA', 'US', 'U.S.', 'U.S.A.', 'America'],
  'United Kingdom': ['UK', 'Great Britain', 'England'],
  Canada: ['CA'],
};

const COUNTRY_CODES: [RegExp, string][] = [
  [/\bcanad/, 'CA'],
  [/\b(united kingdom|uk|britain|england)\b/, 'GB'],
  [/\baustralia/, 'AU'],
  [/\bireland\b/, 'IE'],
  [/\bnew zealand\b/, 'NZ'],
  [/\b(united states|u s|us|usa|america)\b/, 'US'],
];

function degreeAlts(degree: string, short?: string): string[] {
  const d = norm(degree);
  const alts = short ? [short, short.replace(/\./g, '')] : [];
  if (/master/.test(d)) alts.push("Master's Degree", 'Masters', 'Master', "Master's");
  if (/bachelor/.test(d)) alts.push("Bachelor's Degree", 'Bachelors', 'Bachelor', "Bachelor's");
  if (/doctor|phd/.test(d)) alts.push('PhD', 'Doctorate', 'Ph.D.');
  return alts;
}

const pad = (n: number) => String(n).padStart(2, '0');

const yes = (b: boolean): Desired => ({ text: b ? 'Yes' : 'No', bool: b });

function isYesNoQuestion(label: string): boolean {
  return /^(are|is|do|does|have|has|will|would|can|did|were)\b/.test(norm(label)) || /\?$/.test(label.trim());
}

export function resolve(c: Classification, p: Profile, field: Field): Resolution {
  const per = p.personal;
  const label = field.label;
  const lnorm = norm(label);
  const currentJob = p.work.find((w) => w.current) ?? p.work[0];
  const edu = p.education[0];
  const fullName = [per.firstName, per.middleName, per.lastName].filter(Boolean).join(' ');
  const t = (text: string | undefined, alts?: string[]): Resolution =>
    text ? { desired: { text, alts } } : { flag: `No "${c.key}" in your profile` };

  switch (c.key) {
    case 'answer': {
      const a = c.answer ?? '';
      if (/^yes$/i.test(a)) return { desired: yes(true) };
      if (/^no$/i.test(a)) return { desired: yes(false) };
      return { desired: { text: a } };
    }
    case 'skip':
      return { skip: 'Not needed' };
    case 'consent':
      return { flag: 'Consent/acknowledgement — please read and check it yourself' };
    case 'coverLetter':
      return field.required ? { flag: 'Cover letter needed' } : { skip: 'Cover letter (optional)' };
    case 'resume':
      return { skip: 'Handled by resume upload' };
    case 'firstName':
      return t(per.firstName);
    case 'middleName':
      return per.middleName ? t(per.middleName) : { skip: 'No middle name' };
    case 'lastName':
      return t(per.lastName);
    case 'preferredFirstName':
      return t(per.preferredFirstName || per.firstName);
    case 'fullName':
    case 'signature':
      return t(fullName);
    case 'email':
      return t(per.email);
    case 'phoneType':
      return t(per.phoneType ?? 'Mobile', ['Cell', 'Mobile Phone', 'Cell Phone', 'Personal Mobile', 'Personal']);
    case 'phoneCountryCode': {
      const code = per.phoneCountryCode ?? '+1';
      return t(per.country ?? 'United States', [
        `${per.country ?? 'United States'} (${code})`,
        `United States of America (${code})`,
        code,
        ...(COUNTRY_ALTS[per.country ?? 'United States'] ?? []),
      ]);
    }
    case 'phone':
      return t(per.phone);
    case 'linkedin':
      return t(per.linkedin);
    case 'github':
      return t(per.github);
    case 'twitter':
      return { skip: 'No Twitter/X in profile' };
    case 'portfolio':
      return t(per.portfolio || per.website || per.github);
    case 'address1':
      return t(per.address1);
    case 'address2':
      return per.address2 ? t(per.address2) : { skip: 'No address line 2' };
    case 'postalCode':
      return t(per.postalCode);
    case 'county':
      return per.county ? t(per.county, [`${per.county} County`]) : { skip: 'No county in profile' };
    case 'city':
      return t(per.city);
    case 'state':
      return t(per.state, per.stateCode ? [per.stateCode] : []);
    case 'country': {
      const country = per.country ?? 'United States';
      return t(country, COUNTRY_ALTS[country]);
    }
    case 'location': {
      const loc = per.location || [per.city, per.stateCode || per.state].filter(Boolean).join(', ');
      if (!loc) return { flag: 'No location in profile' };
      return {
        desired: {
          text: loc,
          alts: [`${per.city}, ${per.state}`, `${per.city}, ${per.state}, ${per.country}`, `${per.city}, ${per.stateCode}, ${per.country}`],
          query: per.city,
        },
      };
    }
    case 'pronouns':
      return per.pronouns ? t(per.pronouns) : { flag: 'Set personal.pronouns in your profile' };
    case 'workAuthorized':
    case 'sponsorship':
    case 'citizen': {
      const code = COUNTRY_CODES.find(([re]) => re.test(lnorm))?.[1] ?? 'US';
      const auth = p.eeo.workAuth[code];
      if (!auth) return { flag: `No work authorization saved for ${code}` };
      if (c.key === 'sponsorship') return { desired: yes(auth.requiresSponsorship) };
      if (c.key === 'workAuthorized') return { desired: yes(auth.authorized) };
      if (field.kind === 'text' || field.kind === 'combobox' || (field.kind === 'select' && !isYesNoQuestion(label))) {
        // "Country of citizenship"
        if (!auth.citizen) return { flag: 'Citizenship country not in profile' };
        return t(per.country ?? 'United States', COUNTRY_ALTS[per.country ?? 'United States']);
      }
      return auth.citizen === undefined ? { flag: 'Citizenship not set in profile' } : { desired: yes(auth.citizen) };
    }
    case 'over18':
      return p.eeo.over18 === undefined ? { flag: 'Set eeo.over18' } : { desired: yes(p.eeo.over18) };
    case 'previouslyEmployed':
      return { desired: yes(false) };
    case 'referred':
      return field.kind === 'text' || field.kind === 'textarea' ? { skip: 'No referrer' } : { desired: yes(false) };
    case 'howDidYouHear':
      return p.preferences.howDidYouHear
        ? t(p.preferences.howDidYouHear, ['LinkedIn', 'Job Board', 'Online Job Board', 'Internet', 'Job Posting', 'Company Website'])
        : { flag: 'Set preferences.howDidYouHear' };
    case 'relocate':
      return p.preferences.willingToRelocate === undefined ? { flag: 'Set preferences.willingToRelocate' } : { desired: yes(p.preferences.willingToRelocate) };
    case 'hispanic':
      if (p.eeo.hispanicOrLatino === null || p.eeo.hispanicOrLatino === undefined) {
        if (p.eeo.ethnicity && /decline/i.test(p.eeo.ethnicity)) return { desired: { text: 'Decline', decline: true } };
        if (p.eeo.ethnicity && /hispanic|latin/i.test(p.eeo.ethnicity)) return { desired: yes(true) };
        if (p.eeo.ethnicity) return { desired: yes(false) };
        return { flag: 'Set eeo.hispanicOrLatino (or eeo.ethnicity) in your profile' };
      }
      return { desired: yes(p.eeo.hispanicOrLatino) };
    case 'ethnicity': {
      const e = p.eeo.ethnicity;
      if (!e) return { flag: 'Set eeo.ethnicity in your profile' };
      if (/decline/i.test(e)) return { desired: { text: e, decline: true } };
      return { desired: { text: e, alts: ethnicityAlts(e) } };
    }
    case 'gender': {
      const g = p.eeo.gender;
      if (!g) return { flag: 'Set eeo.gender' };
      if (/decline/i.test(g)) return { desired: { text: g, decline: true } };
      const alts = /^male$/i.test(g) ? ['Man', 'Cisgender Man', 'Male'] : /^female$/i.test(g) ? ['Woman', 'Cisgender Woman', 'Female'] : [];
      return t(g, alts);
    }
    case 'lgbtq':
      return p.eeo.lgbtq === undefined
        ? { flag: 'Set eeo.lgbtq in your profile (or answer it yourself)' }
        : p.eeo.lgbtq === null
          ? { desired: { text: 'Decline', decline: true } }
          : { desired: yes(p.eeo.lgbtq) };
    case 'veteran':
      return p.eeo.veteran === undefined || p.eeo.veteran === null ? { desired: { text: 'Decline', decline: true } } : { desired: yes(p.eeo.veteran) };
    case 'disability':
      return p.eeo.disability === undefined || p.eeo.disability === null ? { desired: { text: 'Decline', decline: true } } : { desired: yes(p.eeo.disability) };
    case 'salary': {
      const { salaryMin: lo, salaryMax: hi } = p.preferences;
      if (!lo && !hi) return { flag: 'Set preferences.salaryMin/salaryMax' };
      if ((field.el as HTMLInputElement).type === 'number') return t(String(Math.round(((lo ?? hi)! + (hi ?? lo)!) / 2)));
      const fmt = (n: number) => `$${n.toLocaleString('en-US')}`;
      return t(lo && hi ? `${fmt(lo)} - ${fmt(hi)}` : fmt((lo ?? hi)!));
    }
    case 'startAvailability':
      return t(p.preferences.startAvailability);
    case 'yearsExperience':
      return { flag: 'Years of experience — add an answer-bank entry or fill it yourself' };
    case 'currentCompany':
      return t(currentJob?.company);
    case 'currentTitle':
      return t(currentJob?.title);
    case 'school':
      return t(edu?.school);
    case 'degree':
      return edu ? t(edu.degree, degreeAlts(edu.degree, edu.degreeShort)) : { flag: 'No education in profile' };
    case 'major':
      return t(edu?.major);
    case 'gpa':
      return edu?.gpa ? t(edu.gpa) : { skip: 'No GPA for this school' };
    case 'gradYear':
      return edu?.end ? t(String(edu.end.year), edu.end.month ? [`${pad(edu.end.month)}/${edu.end.year}`] : []) : { flag: 'No graduation date' };
    case 'skills':
      return t(p.skills.slice(0, 25).join(', '));
    case 'additionalInfo':
      return p.preferences.additionalInfo ? t(p.preferences.additionalInfo) : { skip: 'Nothing to add' };
    case 'summary':
      return t(p.summary);
    case 'headline':
      return t(p.headline);
    case 'todayDate': {
      const d = new Date();
      return t(`${pad(d.getMonth() + 1)}/${pad(d.getDate())}/${d.getFullYear()}`);
    }
  }
  return { flag: `Unknown field type "${c.key}"` };
}

function ethnicityAlts(e: string): string[] {
  const n = norm(e);
  if (/asian/.test(n)) return ['Asian', 'Asian (Not Hispanic or Latino)', 'South Asian', 'Asian American'];
  if (/white/.test(n)) return ['White', 'White (Not Hispanic or Latino)', 'Caucasian'];
  if (/black|african/.test(n)) return ['Black or African American', 'Black'];
  if (/hispanic|latin/.test(n)) return ['Hispanic or Latino', 'Hispanic/Latino'];
  if (/middle eastern|north african|mena/.test(n)) return ['Middle Eastern or North African', 'Middle Eastern', 'White'];
  if (/two or more|multi/.test(n)) return ['Two or More Races', 'Two or more races (Not Hispanic or Latino)'];
  return [];
}
