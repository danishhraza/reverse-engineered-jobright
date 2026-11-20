import { scanFields, type Field } from '../engine/fields';
import { norm } from '../engine/match';
import { textToPdf } from '../engine/textpdf';
import { fillField } from '../engine/widgets';
import { sleep } from '../engine/dom';
import { loadSetup } from './context';

// Answers you got from Claude (Autopilot's "Copy prompt for Claude"), filled
// into this frame: each found by its question's label. A cover letter becomes
// a PDF and goes into its upload box.

export interface PastedAnswer {
  /** The question's label as the fill log recorded it. */
  label: string;
  text: string;
  coverLetter?: boolean;
}

export interface PasteResult {
  filled: string[];
  /** Found here, but it wouldn't take (no such option, upload refused…), with why. */
  failed: { label: string; reason: string }[];
  /** Not in this frame (another frame, or the page moved on). */
  notHere: string[];
}

/** The field this label belongs to: same text, or one is the start of the other (logged labels are cut short). */
function findField(fields: Field[], label: string): Field | undefined {
  const want = norm(label);
  if (!want) return undefined;
  return (
    fields.find((f) => norm(f.label) === want) ??
    fields.find((f) => {
      const have = norm(f.label);
      return have.length >= 12 && (have.startsWith(want) || want.startsWith(have));
    })
  );
}

function coverFile(text: string, input: HTMLInputElement, name: string): File {
  const accept = (input.accept || '').toLowerCase();
  const pdfOk = !accept || /pdf|\*/.test(accept);
  const fileName = name ? `Cover Letter - ${name}` : 'Cover Letter';
  if (!pdfOk && /\.txt|text\/plain/.test(accept)) return new File([text], `${fileName}.txt`, { type: 'text/plain' });
  return new File([textToPdf(text)], `${fileName}.pdf`, { type: 'application/pdf' });
}

export async function fillPastedAnswers(answers: PastedAnswer[], profileId?: string): Promise<PasteResult> {
  const out: PasteResult = { filled: [], failed: [], notHere: [] };
  const fields = scanFields();
  let name = '';
  for (const a of answers) {
    const f = findField(fields, a.label);
    if (!f) {
      out.notHere.push(a.label);
      continue;
    }
    if (!a.text.trim()) {
      out.failed.push({ label: a.label, reason: 'No answer in the reply' });
      continue;
    }
    try {
      if (f.kind === 'file') {
        if (!name) {
          // Your name on the file ("Cover Letter - Alex Doe.pdf"); without it, just "Cover Letter.pdf".
          const s = await loadSetup(profileId).catch(() => ({ error: 'no storage' }));
          name = 'error' in s ? '' : `${s.profile.personal.firstName} ${s.profile.personal.lastName}`.trim();
        }
        const input = f.el as HTMLInputElement;
        const dt = new DataTransfer();
        dt.items.add(coverFile(a.text, input, name));
        input.files = dt.files;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        await sleep(300);
        if (!input.isConnected || input.files?.length) out.filled.push(a.label);
        else out.failed.push({ label: a.label, reason: "The upload box didn't take the file" });
        continue;
      }
      const r = await fillField(f, { text: a.text.trim() }, true);
      if (r.ok && !r.skipped) out.filled.push(a.label);
      else out.failed.push({ label: a.label, reason: r.reason ?? "Couldn't fill it" });
    } catch (e) {
      out.failed.push({ label: a.label, reason: String((e as Error)?.message ?? e) });
    }
  }
  return out;
}
