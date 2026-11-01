// Profile schema. A ProfileStore holds one shared `base` plus per-resume
// profiles that only store what they change (`overrides`). Arrays in overrides
// replace the base array wholesale; objects are deep-merged.

export interface YearMonth {
  year: number;
  month?: number; // 1-12
}

export interface Personal {
  firstName: string;
  middleName?: string;
  lastName: string;
  preferredFirstName?: string;
  preferredLastName?: string;
  pronouns?: string;
  email: string;
  phoneType?: 'Mobile' | 'Home' | 'Work';
  phoneCountry?: string; // ISO code, e.g. "US"
  phoneCountryCode?: string; // e.g. "+1"
  phone: string; // national number, digits or formatted
  address1?: string;
  address2?: string;
  city?: string;
  state?: string; // full name, e.g. "Texas"
  stateCode?: string; // e.g. "TX"
  country?: string; // e.g. "United States"
  county?: string;
  postalCode?: string;
  /** What the resume shows as location, e.g. "Austin, TX". Empty if the resume omits it. */
  location?: string;
  linkedin?: string;
  github?: string;
  portfolio?: string;
  website?: string;
}

export interface Education {
  school: string;
  degree: string; // "Master of Science", "Bachelor of Science"
  degreeShort?: string; // "M.S.", "B.S."
  major: string;
  specialization?: string;
  city?: string; // where the school is, e.g. "Atlanta"
  state?: string;
  country?: string;
  gpa?: string;
  start?: YearMonth;
  end?: YearMonth;
  current?: boolean;
}

export interface Work {
  company: string;
  title: string;
  location?: string;
  country?: string; // for forms that ask each job's country
  start?: YearMonth;
  end?: YearMonth;
  current?: boolean;
  summary?: string;
  bullets?: string[];
}

export interface CountryAuth {
  authorized: boolean;
  citizen?: boolean;
  requiresSponsorship: boolean;
}

export interface Eeo {
  /** Keyed by ISO country code. */
  workAuth: Record<string, CountryAuth>;
  gender?: string; // "Male" | "Female" | "Non-binary" | "Decline to state"
  /** Race/ethnicity as you want it answered. null = always ask the human. */
  ethnicity?: string | null;
  hispanicOrLatino?: boolean | null;
  veteran?: boolean | null; // null = decline
  disability?: boolean | null; // null = decline
  lgbtq?: boolean | null;
  over18?: boolean;
}

export interface Preferences {
  salaryMin?: number;
  salaryMax?: number;
  salaryCurrency?: string;
  startAvailability?: string;
  noticePeriod?: string;
  willingToRelocate?: boolean;
  remotePreference?: string;
  howDidYouHear?: string;
  additionalInfo?: string;
}

export interface Answer {
  /** Plain words (all must appear in the question) or /regex/i. */
  pattern: string;
  answer: string;
  source?: 'manual' | 'learned';
}

export interface Profile {
  personal: Personal;
  headline?: string;
  summary?: string;
  education: Education[];
  work: Work[];
  skills: string[];
  eeo: Eeo;
  preferences: Preferences;
  answers: Answer[];
  signupEmail?: string;
  /** Your job-site login, added at fill time from Options (never part of the profile JSON). */
  account?: Account;
}

/** One login reused for job-site sign-up / sign-in pages (Workday, Taleo, iCIMS…). */
export interface Account {
  email?: string;
  /** Only if a site asks for a user name separate from the email. Defaults to the email. */
  username?: string;
  password?: string;
}

export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends (infer U)[] ? U[] : T[K] extends object ? DeepPartial<T[K]> : T[K];
};

export interface ProfileEntry {
  id: string;
  name: string; // "SWE", "Product", ...
  overrides: DeepPartial<Profile>;
  resumeFileName?: string;
}

export interface ProfileStore {
  version: 1;
  base: DeepPartial<Profile>;
  profiles: ProfileEntry[];
}

/** all = overwrite, empty = only blank fields, focused = only the field you last clicked. */
export type FillMode = 'all' | 'empty' | 'focused';

/** A learned answer waiting for you to approve it in the side panel. */
export interface PendingLearn {
  answer: Answer;
  /** What it would replace, if this question was learned before. */
  previous?: string;
}

export interface Settings {
  activeProfileId?: string;
  /** Workday-style multi-page forms: click Next automatically after a clean page. */
  autoAdvance: boolean;
  /** Overwrite values a site already put in (e.g. from its own resume parsing). */
  overwrite: boolean;
  /** Remember answers you type into flagged fields. */
  learn: boolean;
  /** Show the floating Autofill button on job application pages. */
  showFab: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  autoAdvance: true,
  overwrite: true,
  learn: true,
  showFab: true,
};

// ----- Fill report -----

export type FieldStatus = 'filled' | 'flagged' | 'skipped' | 'failed';

export interface FieldReport {
  id: string; // data attribute stamped on the element, used to scroll to it
  label: string;
  key?: string;
  value?: string;
  status: FieldStatus;
  confidence: number;
  reason?: string;
  required?: boolean;
}

export interface FillReport {
  url: string;
  ats: string;
  page: number;
  fields: FieldReport[];
  done: boolean;
  message?: string;
  /** What it's doing right now ("Picking "Country" — waiting for its options…"). */
  current?: string;
  /** You pressed Cancel. */
  cancelled?: boolean;
}
