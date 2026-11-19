import type { Answer, Education, Profile, Work } from '../types';
import { currentValue, type Field } from './fields';
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
  // Optional extras (texts about the application, newsletters, talent communities): never ticked for you.
  { key: 'optIn', label: /\btext messages?\b|\bsms\b|\bmarketing\b|newsletter|promotional|job alerts?|talent (community|network|pool)|keep me (informed|updated|posted)|receive (e ?mails?|updates|communications|notifications|texts|alerts)|\bopt[ -]?in\b/ },
  { key: 'consent', label: /\bi (have read|agree|acknowledge|consent|certify|accept|understand)\b|privacy (policy|notice)|terms (of|and)|\bconsent\b|process (my|your) (personal )?(data|information)|data processing/ },
  { key: 'coverLetter', label: /cover letter/, attr: /cover letter/ },
  { key: 'resume', label: /\b(resume|cv|curriculum vitae)\b/, attr: /\bresume\b|\bcv\b/, short: true },
  { key: 'preferredFirstName', label: /\b(preferred|nick) ?(first )?name\b|\bname you (go by|prefer)\b/, attr: /preferred (first )?name/ },
  { key: 'middleName', label: /\bmiddle (name|initial)\b/, attr: /middle name/ },
  { key: 'username', label: /^(user ?name|user ?id|login( id| name)?|(user ?name|login) or e ?mail( address)?|e ?mail( address)? or (user ?name|login))$/, short: true },
  { key: 'firstName', label: /\b(first|given|fore) ?name\b/, attr: /\bfirst ?name\b|\bfname\b|given name/, short: true },
  { key: 'lastName', label: /\b(last|family|sur) ?name\b/, attr: /\blast ?name\b|\blname\b|family name|surname/, short: true },
  { key: 'signature', label: /\bsignature\b|sign your (full )?name/, short: true },
  { key: 'fullName', label: /^(your |candidate |applicant )?(full |legal |complete )?name$|^(full|legal) name\b/, attr: /^name$|\bfull name\b|systemfield name/, short: true },
  { key: 'email', label: /\be ?mail\b/, attr: /\be ?mail\b/, short: true },
  { key: 'phoneType', label: /phone (device )?type|type of phone/, attr: /phone device type|phone type/ },
  { key: 'addressType', label: /^address type$|type of address/, attr: /address type/, short: true },
  { key: 'phoneCountryCode', label: /country (phone )?code|phone country|dial(ing)? code/, attr: /country phone code|phone country|country code/ },
  { key: 'skip', label: /\bextension\b|\bext\b/, short: true },
  { key: 'phone', label: /\b(phone|mobile|cell|telephone)\b/, attr: /\bphone\b|\btel\b/, short: true },
  { key: 'linkedin', label: /linked ?in/, attr: /linkedin/ },
  { key: 'github', label: /git ?hub/, attr: /github/ },
  { key: 'twitter', label: /twitter|\bx com\b/, attr: /twitter/ },
  { key: 'portfolio', label: /portfolio|personal (web)?site|^website|^web site|^blog|other (website|url|link)/, attr: /portfolio|website/, short: true },
  { key: 'address2', label: /address (line )?2|\bapt\b|apartment|suite/, attr: /address (line )?2|address2/, short: true },
  { key: 'address1', label: /^(street |mailing |home |current )?address( line)?( 1)?$|^street/, attr: /address (line )?1|address1|street/, short: true },
  { key: 'postalCode', label: /postal|\bzip|\bpost ?code/, attr: /postal|\bzip|post ?code/, short: true },
  { key: 'county', label: /\bcounty\b/, attr: /\bcounty\b/, short: true },
  { key: 'schoolCity', label: /\b(institution|school|university|college)\b.*\b(city|location)\b/, short: true },
  { key: 'schoolState', label: /\b(institution|school|university|college)\b.*\b(state|province)\b/, short: true },
  { key: 'schoolCountry', label: /\b(institution|school|university|college)\b.*\bcountry\b/, short: true },
  { key: 'location', label: /\blocation\b|where are you (currently )?(located|based)|city (and|,) state|current city/, attr: /\blocation\b/, short: true, not: /willing|open to|relocat/ },
  { key: 'city', label: /\bcity\b|\btown\b/, attr: /\bcity\b/, short: true },
  { key: 'state', label: /\b(state|province|region)\b/, attr: /\bstate\b|\bregion\b|province/, short: true, not: /united states|statement/ },
  { key: 'country', label: /\bcountry\b/, attr: /\bcountry\b/, short: true, not: /code/ },
  { key: 'pronouns', label: /\bpronouns?\b/ },
  { key: 'sponsorship', label: /sponsor/ },
  { key: 'workAuthorized', label: /(legally )?(authori[sz]ed|eligible|permitted) to work|work (authori[sz]ation|permit)|right to work|legal right to/ },
  { key: 'citizen', label: /\bcitizen(ship)?\b|\bu\.? ?s\.? worker\b|permanent resident|green card/ },
  { key: 'over18', label: /18 years|over 18|at least 18|age of 18|legal (working )?age/ },
  // About you, not your family ("Do you have relatives currently employed by…" is a different question).
  { key: 'previouslyEmployed', label: /(previously|ever|formerly|currently) (been )?(employed|worked) (by|for|at|with)|former employee|worked (for|at) .* before/, not: /relative|family|friend|spouse|partner|household|know anyone|related to/ },
  { key: 'referred', label: /were you referred|referred by|employee referral|know anyone (who works|at)/ },
  { key: 'howDidYouHear', label: /how (did )?you (hear|heard|find|found|learn|learned|come across)|where did you (hear|find|learn|see)|^source$|referral source|how .* find (out )?about/, attr: /\bsource\b/ },
  { key: 'school', label: /which (university|school|college)|(university|school|college) (are you|did you)/ },
  // "Will you require relocation assistance?" is not "Are you willing to relocate?".
  { key: 'relocationAssistance', label: /relocation (assistance|package|support|help|benefits?|expenses?|reimbursement)|(need|require|requiring|expect)\b.*\brelocation\b/ },
  { key: 'relocate', label: /relocat/ },
  { key: 'hispanic', label: /hispanic|latin[oax]/ },
  { key: 'ethnicity', label: /\b(race|ethnicity|ethnic|racial)\b/ },
  { key: 'gender', label: /\bgender\b|\bsex\b/, not: /transgender|orientation/ },
  { key: 'lgbtq', label: /lgbt|sexual orientation|transgender/ },
  { key: 'veteran', label: /veteran|military|armed forces/ },
  { key: 'disability', label: /disabilit/ },
  { key: 'salary', label: /salary|compensation|pay (expectation|range|requirement)|desired pay|expected pay|rate expectation/ },
  { key: 'startAvailability', label: /start date|when can you start|available to start|earliest (start|available)|availability to start|notice period|when (would|could) you (be able to )?start|how soon (can|could|would) you (be able to )?(start|join|begin)/ },
  { key: 'yearsExperience', label: /years of (relevant |professional |work )?experience|how many years/ },
  { key: 'workDescription', label: /^(job |role |position )?(description|responsibilities|duties)( of (your )?(role|position|job))?$|^(job|role|work) (description|responsibilities|duties)|^roles? and responsibilities$|describe your (role|responsibilities|duties)/, short: true },
  { key: 'currentCompany', label: /(current|most recent|present|latest) (company|employer|organi[sz]ation)|^company( name)?$|^employer( name)?$|^organi[sz]ation$/, short: true },
  { key: 'currentTitle', label: /(current|most recent|present|latest) (job )?(title|position|role)|^(job |position )?title$|^(job )?position$/, short: true },
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

  // A password box is a password box, whatever its label says ("Re-enter", "Confirm"…).
  if (field.inputType === 'password') return { key: 'password', score: 0.95, source: 'rule' };

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
      // A one- or two-word label ("Number", "Type") says little, so the field's id ("PhoneNumber") decides; trust it.
      return { key: r.key, score: !label ? 0.75 : wordCount(label) <= 2 ? 0.8 : 0.7, source: 'rule' };
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

// Countries a work-authorization question may name. If one is named that the
// profile has no entry for, the question is flagged instead of guessed.
const COUNTRY_CODES: [RegExp, string][] = [
  [/\bcanad/, 'CA'],
  [/\b(united kingdom|uk|britain|british|england)\b/, 'GB'],
  [/\baustralia/, 'AU'],
  [/\bireland\b|\birish\b/, 'IE'],
  [/\bnew zealand\b/, 'NZ'],
  [/\bsingapore/, 'SG'],
  [/\bindia\b|\bindian\b/, 'IN'],
  [/\bpakistan/, 'PK'],
  [/\bgerman/, 'DE'],
  [/\bfrance\b|\bfrench\b/, 'FR'],
  [/\bnetherlands\b|\bdutch\b/, 'NL'],
  [/\bspain\b|\bspanish\b/, 'ES'],
  [/\bital(y|ian)\b/, 'IT'],
  [/\bswitzerland\b|\bswiss\b/, 'CH'],
  [/\bswed(en|ish)\b/, 'SE'],
  [/\bpoland\b|\bpolish\b/, 'PL'],
  [/\bisrael/, 'IL'],
  [/\bjapan/, 'JP'],
  [/\b(south )?korea/, 'KR'],
  [/\bchina\b|\bchinese\b/, 'CN'],
  [/\bmexic/, 'MX'],
  [/\bbrazil/, 'BR'],
  [/\bphilippine|\bfilipino/, 'PH'],
  [/\b(uae|united arab emirates|dubai)\b/, 'AE'],
  [/\beuropean union\b|\beu\b|\beea\b/, 'EU'],
  [/\b(united states|u s|us|usa|america|american)\b/, 'US'],
];

export function degreeAlts(degree: string, short?: string): string[] {
  const d = norm(degree);
  const alts = short ? [short, short.replace(/\./g, '')] : [];
  if (/master/.test(d)) alts.push("Master's Degree", 'Masters', 'Master', "Master's");
  if (/bachelor/.test(d)) alts.push("Bachelor's Degree", 'Bachelors', 'Bachelor', "Bachelor's");
  if (/doctor|phd/.test(d)) alts.push('PhD', 'Doctorate', 'Ph.D.');
  return alts;
}

function degreeLevel(e: Education): number {
  const d = norm(`${e.degree} ${e.degreeShort ?? ''}`);
  if (/doctor|phd/.test(d)) return 4;
  if (/master|\bm ?s\b|\bmba\b/.test(d)) return 3;
  if (/bachelor|\bb ?s\b|\bb ?a\b/.test(d)) return 2;
  if (/associate/.test(d)) return 1;
  return 0;
}

/** The highest degree already finished (an in-progress degree isn't "obtained"). */
function highestCompleted(list: Education[]): Education | undefined {
  const now = new Date();
  const finished = list.filter((e) => !e.current && (!e.end || e.end.year * 12 + (e.end.month ?? 12) <= now.getFullYear() * 12 + now.getMonth() + 1));
  return finished.sort((a, b) => degreeLevel(b) - degreeLevel(a))[0];
}

/** A job's description for a "Role Description" box: summary line, then one "• " bullet per line. */
export function describeJob(w: Work): string {
  const bullets = (w.bullets ?? []).map((b) => `• ${b.replace(/^\s*[•\-*]\s*/, '')}`);
  return [w.summary, ...bullets].filter(Boolean).join('\n');
}

const pad = (n: number) => String(n).padStart(2, '0');

const yes = (b: boolean): Desired => ({ text: b ? 'Yes' : 'No', bool: b });

function isYesNoQuestion(label: string): boolean {
  return /^(are|is|do|does|have|has|will|would|can|did|were)\b/.test(norm(label)) || /\?$/.test(label.trim());
}

/**
 * Does this dropdown want Yes/No? A native select says so with its options; otherwise go by the
 * question itself — the last sentence, since long legal preambles end with the actual question
 * ("…Are you in one of the above five groups?").
 */
function asksYesNo(field: Field, label: string): boolean {
  if (field.kind === 'select') {
    const opts = Array.from((field.el as HTMLSelectElement).options).map((o) => norm(o.textContent ?? ''));
    if (opts.some((o) => /^yes\b/.test(o)) && opts.some((o) => /^no\b/.test(o))) return true;
  }
  const sentences = label.split(/(?<=[.?!])\s+/).filter((s) => s.trim());
  const last = sentences[sentences.length - 1] ?? label;
  return /^(are|is|do|does|have|has|will|would|can|did|were)\b/.test(norm(last)) || (sentences.length === 1 && isYesNoQuestion(label));
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
  const phoneCountry = (): Resolution => {
    const code = per.phoneCountryCode ?? '+1';
    return t(per.country ?? 'United States', [
      `${per.country ?? 'United States'} (${code})`,
      `${per.country ?? 'United States'} ${code}`,
      `United States of America (${code})`,
      code,
      ...(COUNTRY_ALTS[per.country ?? 'United States'] ?? []),
    ]);
  };

  switch (c.key) {
    case 'answer': {
      const a = c.answer ?? '';
      if (/^yes$/i.test(a)) return { desired: yes(true) };
      if (/^no$/i.test(a)) return { desired: yes(false) };
      return { desired: { text: a } };
    }
    case 'skip':
      return { skip: 'Not needed' };
    case 'optIn':
      return field.required ? { flag: 'Opt-in marked required — decide yourself' } : { skip: 'Optional opt-in — left as it was' };
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
      // On a sign-up / sign-in page, use the job-site login email.
      return t(onAccountPage() && p.account?.email ? p.account.email : per.email);
    case 'username':
      return t(p.account?.username || p.account?.email || per.email);
    case 'password':
      return p.account?.password ? { desired: { text: p.account.password } } : { flag: 'Save your job-site password in Options → Job site login' };
    case 'addressType':
      return t('Home', ['Home Address', 'Residential', 'Primary', 'Mailing', 'Permanent', 'Current']);
    case 'phoneType':
      return t(per.phoneType ?? 'Mobile', ['Cell', 'Mobile Phone', 'Cell Phone', 'Personal Mobile', 'Personal']);
    case 'phoneCountryCode':
      return phoneCountry();
    case 'phone':
      // The flag / country-code picker next to a phone box carries the same label ("Mobile Number *").
      // Leave it: it defaults to the right country, and re-picking one resets the number on many sites.
      if (field.kind === 'select' || field.kind === 'combobox' || field.kind === 'buttonGroup') {
        return field.kind === 'select' && field.required && !currentValue(field) ? phoneCountry() : { skip: "Left the site's country code" };
      }
      // A second, optional number (home, work…): leave it blank.
      if (!field.required && /\b(home|work|office|business|alternate|alt|other|secondary|additional|landline|fax|evening|day ?time)\b/.test(lnorm)) {
        return { skip: 'Optional extra phone number — left blank' };
      }
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
      // Address boxes with suggestions (Google Places) find the right one faster with the city.
      if (!per.address1) return t(per.address1);
      return {
        desired: {
          text: per.address1,
          query: [per.address1, per.city, per.stateCode || per.state].filter(Boolean).join(', '),
          // Lookups list full addresses: these pick the right "100 Example Road" among several.
          alts: [
            [per.address1, per.city, per.stateCode, per.country === 'United States' ? 'USA' : per.country].filter(Boolean).join(', '),
            [per.address1, per.city, per.state, per.postalCode].filter(Boolean).join(', '),
          ],
        },
      };
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
      // Unnamed country ("the country you're applying in") defaults to the US.
      const code = COUNTRY_CODES.find(([re]) => re.test(lnorm))?.[1] ?? 'US';
      const auth = p.eeo.workAuth[code];
      if (!auth) return { flag: `Asks about ${code} — no work authorization saved for that country` };
      if (c.key === 'sponsorship') return { desired: yes(auth.requiresSponsorship) };
      if (c.key === 'workAuthorized') return { desired: yes(auth.authorized) };
      // "Country of citizenship" wants a country; "Are you a U.S. citizen?" / "…one of the above five groups?" wants Yes/No.
      if (field.kind === 'text' || ((field.kind === 'combobox' || field.kind === 'select') && !asksYesNo(field, label))) {
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
    case 'relocationAssistance':
      return { flag: 'Relocation assistance — answer it yourself, or add a standing answer for the AI' };
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
    // The usual EEO wording, so "I am not a veteran" wins over "…just not a protected veteran".
    case 'veteran':
      if (p.eeo.veteran === undefined || p.eeo.veteran === null) return { desired: { text: 'Decline', decline: true } };
      return {
        desired: p.eeo.veteran
          ? { text: 'I identify as a veteran', alts: ['Veteran', 'Yes'], bool: true }
          : { text: 'I am not a veteran', alts: ['Not a veteran', 'I am not a protected veteran', 'No'], bool: false },
      };
    case 'disability':
      if (p.eeo.disability === undefined || p.eeo.disability === null) return { desired: { text: 'Decline', decline: true } };
      return {
        desired: p.eeo.disability
          ? { text: 'Yes, I have a disability', alts: ['Yes, I have a disability (or previously had a disability)'], bool: true }
          : { text: "No, I don't have a disability", alts: ['No, I do not have a disability', 'I do not have a disability'], bool: false },
      };
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
    case 'workDescription':
      return currentJob ? t(describeJob(currentJob)) : { flag: 'No work experience in profile' };
    case 'currentCompany':
      return t(currentJob?.company);
    case 'currentTitle':
      return t(currentJob?.title);
    case 'school':
      return t(edu?.school);
    case 'degree': {
      const d = /obtain|complet|earn|attain|achiev|receiv|awarded/.test(lnorm) ? highestCompleted(p.education) : edu;
      return d ? t(d.degree, degreeAlts(d.degree, d.degreeShort)) : { flag: 'No completed degree in profile' };
    }
    case 'schoolCity':
    case 'schoolState':
    case 'schoolCountry': {
      const v = c.key === 'schoolCity' ? edu?.city : c.key === 'schoolState' ? edu?.state : edu?.country;
      return v ? t(v) : { flag: `Add the school's ${c.key.slice(6).toLowerCase()} to education in your profile` };
    }
    case 'major':
      return t(edu?.major);
    case 'gpa':
      return edu?.gpa ? t(edu.gpa) : { skip: 'No GPA for this school' };
    case 'gradYear':
      return edu?.end ? t(String(edu.end.year), edu.end.month ? [`${pad(edu.end.month)}/${edu.end.year}`] : []) : { flag: 'No graduation date' };
    case 'skills':
      // Tag-style pickers add these one at a time; plain text boxes get the joined list.
      return p.skills.length ? { desired: { text: p.skills.slice(0, 25).join(', '), multi: p.skills.slice(0, 25) } } : { flag: 'No skills in your profile' };
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

/** A page with a password box is a sign-up / sign-in page. */
function onAccountPage(): boolean {
  return typeof document !== 'undefined' && !!document.querySelector('input[type="password"]');
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
