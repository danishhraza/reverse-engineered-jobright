import type { FillMode, FillReport, PendingLearn } from './types';
import { getPending, getSettings, setPending } from './profile/storage';
import { importSeed } from './profile/seed';
import type { AiQuestion } from './engine/fill';
import { norm } from './engine/match';
import { askGuide, askModel } from './llm/openrouter';
import { getAiAnswers, getLlm, saveAiAnswer } from './queue/store';
import { aiDecided, noteOnJob, onAlarm, recordFill, onPageLoaded, onReadyResult, onStepResult, recordAi, onTabCreated, onTabRemoved, pauseRunner, queueAction, recover, startRunner, type QueueAction } from './queue/runner';

// Routes "fill this tab" to every frame and keeps the latest report per frame
// (chrome.storage.session) so the side panel can show it when opened later.

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  void importSeed();
});
chrome.runtime.onStartup.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  void importSeed();
  void recover();
});

// ---------- Autopilot ----------

chrome.alarms.onAlarm.addListener((a) => {
  if (a.name.startsWith('autopilot-')) void onAlarm(a.name);
});
chrome.webNavigation.onCompleted.addListener(({ tabId, frameId }) => void onPageLoaded(tabId, frameId));
chrome.tabs.onCreated.addListener((tab) => void onTabCreated(tab));
chrome.notifications?.onClicked.addListener(() => {
  chrome.tabs.create({ url: chrome.runtime.getURL('queue.html') });
});

/** Answers are reused across applications: same question + options = same answer. */
async function answerQuestion(q: AiQuestion, facts: string, job: string, tabId?: number): Promise<{ answer?: string; confidence?: number; error?: string }> {
  const asked = { what: q.question, options: q.options, note: q.note };
  const llm = await getLlm();
  if (!llm.enabled || !llm.apiKey) {
    if (tabId !== undefined) await recordAi(tabId, { ...asked, result: 'skipped — AI is off (no OpenRouter key in Options)', decision: 'AI off — left for you' });
    return {};
  }
  // Questions naming the company ("…working at Deloitte?") differ per company, so the job isn't part of the key;
  // the note is ("for Education 2, the answer is…").
  const key = `${norm(q.question)}|${q.options.map(norm).join('|')}|${norm(q.note ?? '')}`;
  const cached = (await getAiAnswers())[key];
  if (cached && cached.confidence >= 0.7) {
    if (tabId !== undefined) await recordAi(tabId, { ...asked, result: `"${cached.answer}" (${cached.confidence}, reused)`, answer: cached.answer, confidence: cached.confidence });
    return cached;
  }
  try {
    const { answer: a, usage } = await askModel(llm, q, { facts, job });
    if (tabId !== undefined) await recordAi(tabId, { ...asked, result: a ? `"${a.answer}" (${a.confidence})` : 'no usable answer', usage, answer: a?.answer, confidence: a?.confidence });
    if (!a) return { error: 'The model gave no usable answer' };
    if (a.confidence >= 0.7) await saveAiAnswer(key, a);
    return a;
  } catch (e) {
    if (tabId !== undefined) await recordAi(tabId, { ...asked, result: `error: ${(e as Error).message}` });
    return { error: (e as Error).message };
  }
}

type FillResult = { frames: number; started: number; reasons: string[] };

async function fillTab(tabId: number, profileId?: string, mode?: FillMode, page?: number): Promise<FillResult> {
  const id = profileId ?? (await getSettings()).activeProfileId;
  const frames = (await chrome.webNavigation.getAllFrames({ tabId })) ?? [{ frameId: 0 }];
  if (mode === 'focused') return fillFocused(tabId, id, frames);
  await chrome.storage.session.remove((await reportKeys(tabId)) as string[]);
  const results = await Promise.all(
    frames.map((f) =>
      chrome.tabs
        .sendMessage(tabId, { type: 'fill', profileId: id, mode, page }, { frameId: f.frameId })
        .then((r: { started: boolean; reason?: string }) => r)
        .catch(() => ({ started: false, reason: 'No content script' })),
    ),
  );
  return {
    frames: frames.length,
    started: results.filter((r) => r?.started).length,
    reasons: results.filter((r) => r && !r.started && r.reason).map((r) => r.reason!),
  };
}

/** Only the frame where you last clicked a field fills, and only that field. */
async function fillFocused(tabId: number, profileId: string | undefined, frames: { frameId: number }[]): Promise<FillResult> {
  const info = await Promise.all(
    frames.map((f) =>
      chrome.tabs
        .sendMessage(tabId, { type: 'focusInfo' }, { frameId: f.frameId })
        .then((r: { ts: number }) => ({ frameId: f.frameId, ts: r?.ts ?? 0 }))
        .catch(() => ({ frameId: f.frameId, ts: 0 })),
    ),
  );
  const best = info.filter((i) => i.ts > 0).sort((a, b) => b.ts - a.ts)[0];
  if (!best) return { frames: frames.length, started: 0, reasons: ['Click into a field on the page first, then try again.'] };
  const r: { started: boolean; reason?: string } = await chrome.tabs
    .sendMessage(tabId, { type: 'fill', profileId, mode: 'focused' }, { frameId: best.frameId })
    .catch(() => ({ started: false, reason: 'No content script' }));
  return { frames: frames.length, started: r?.started ? 1 : 0, reasons: r?.reason ? [r.reason] : [] };
}

// ---------- Reloads mid-fill ----------
// Some forms (Taleo) reload the whole page on Next or on "upload my resume",
// which kills the running fill. Before such a click the page sends
// "advancing"; if the tab then reloads, the fill starts again on the new page.
// Any other reload just closes out the report so the side panel isn't stuck.

interface Advancing {
  profileId?: string;
  mode?: FillMode;
  page: number;
  frameId: number;
  at: number;
}

/** How long after the click a reload still counts as caused by it. */
const ADVANCE_WINDOW_MS = 30000;
const advKey = (tabId: number) => `advancing:${tabId}`;

async function getAdvancing(tabId: number): Promise<Advancing | undefined> {
  const adv = (await chrome.storage.session.get(advKey(tabId)))[advKey(tabId)] as Advancing | undefined;
  return adv && Date.now() - adv.at < ADVANCE_WINDOW_MS ? adv : undefined;
}

/** Store a report and show it in the side panel and on the floating button. */
async function pushReport(tabId: number, frameId: number, report: FillReport): Promise<void> {
  await chrome.storage.session.set({ [`report:${tabId}:${frameId}`]: report });
  chrome.runtime.sendMessage({ type: 'bgReport', tabId, frameId, report }).catch(() => {});
  chrome.tabs.sendMessage(tabId, { type: 'fabReport', report }, { frameId: 0 }).catch(() => {});
}

/** Close out reports still marked as filling (the frame that was filling is gone). */
async function closeOut(tabId: number, message: string, frameId?: number, cancelled = false): Promise<void> {
  const all = await chrome.storage.session.get(null);
  for (const [k, v] of Object.entries(all)) {
    const m = /^report:(\d+):(\d+)$/.exec(k);
    if (!m || Number(m[1]) !== tabId || (frameId !== undefined && Number(m[2]) !== frameId)) continue;
    const r = v as FillReport;
    if (!r.done) {
      await pushReport(tabId, Number(m[2]), { ...r, done: true, current: undefined, cancelled, message });
      // A fill cut short by a reload still goes in the job's fill log (what got filled before it).
      if (r.fields.length) await recordFill(tabId, { ...r, done: true, message });
    }
  }
}

chrome.webNavigation.onCommitted.addListener(async ({ tabId, frameId }) => {
  if (await getAdvancing(tabId)) return; // expected; the fill carries on once it loads
  await closeOut(tabId, 'The page reloaded while filling. Press Fill again to continue.', frameId);
});

chrome.webNavigation.onCompleted.addListener(async ({ tabId, frameId }) => {
  const adv = await getAdvancing(tabId);
  if (!adv || (frameId !== 0 && frameId !== adv.frameId)) return;
  await chrome.storage.session.remove(advKey(tabId));
  // Give the content script a moment to start, and retry if it isn't ready yet.
  for (const wait of [1200, 1500, 2500]) {
    await new Promise((r) => setTimeout(r, wait));
    const res = await fillTab(tabId, adv.profileId, adv.mode, adv.page);
    if (res.started) return;
  }
  await closeOut(tabId, 'The page reloaded and the form did not come back. Press Fill to continue.');
});

async function reportKeys(tabId: number): Promise<string[]> {
  const all = await chrome.storage.session.get(null);
  return Object.keys(all).filter((k) => k.startsWith(`report:${tabId}:`));
}

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg.type === 'fillTab') {
    const tabId: number | undefined = msg.tabId ?? sender.tab?.id;
    if (tabId === undefined) return;
    fillTab(tabId, msg.profileId, msg.mode).then(reply);
    return true;
  }
  if (msg.type === 'advancing' && sender.tab?.id !== undefined) {
    const adv: Advancing = { profileId: msg.profileId, mode: msg.mode, page: msg.page ?? 2, frameId: sender.frameId ?? 0, at: Date.now() };
    chrome.storage.session.set({ [advKey(sender.tab.id)]: adv });
    return;
  }
  if (msg.type === 'learnProposal') {
    const p: PendingLearn = { answer: msg.answer, previous: msg.previous };
    // Typing fires several events; keep only the latest answer per question.
    getPending().then((list) => setPending([...list.filter((x) => x.answer.pattern !== p.answer.pattern), p]));
    return;
  }
  if (msg.type === 'report' && sender.tab?.id !== undefined) {
    const report = msg.report as FillReport;
    // Live status lines change many times a second; only store meaningful updates.
    if (!report.current || report.done) chrome.storage.session.set({ [`report:${sender.tab.id}:${sender.frameId ?? 0}`]: report });
    // The fill finished without reloading the page; forget any pending "advancing".
    if (report.done) chrome.storage.session.remove(advKey(sender.tab.id));
    // Autopilot tabs: keep every finished page fill in the job's fill log.
    if (report.done && report.fields.length) void recordFill(sender.tab.id, report);
    // The floating button lives in the top frame, even when an iframe is filling.
    chrome.tabs.sendMessage(sender.tab.id, { type: 'fabReport', report }, { frameId: 0 }).catch(() => {});
    return;
  }
  if (msg.type === 'cancelTab') {
    const tabId: number | undefined = msg.tabId ?? sender.tab?.id;
    if (tabId === undefined) return;
    (async () => {
      await chrome.storage.session.remove(advKey(tabId));
      const frames = (await chrome.webNavigation.getAllFrames({ tabId })) ?? [{ frameId: 0 }];
      const replies = await Promise.all(
        frames.map((f) =>
          chrome.tabs
            .sendMessage(tabId, { type: 'cancel' }, { frameId: f.frameId })
            .then((r: { wasRunning?: boolean }) => !!r?.wasRunning)
            .catch(() => false),
        ),
      );
      // Nothing was actually running (e.g. the page reloaded mid-fill): just close out the report.
      if (!replies.some(Boolean)) await closeOut(tabId, 'Stopped.', undefined, true);
      reply({ ok: true });
    })();
    return true;
  }
  if (msg.type === 'aiDecided' && sender.tab?.id !== undefined) {
    void aiDecided(sender.tab.id, msg.question, msg.decision);
    return;
  }
  if (msg.type === 'dialog' && sender.tab?.id !== undefined) {
    void noteOnJob(sender.tab.id, `Browser ${msg.kind} "${String(msg.message).slice(0, 120)}" — answered ${msg.answer}`);
    return;
  }
  if (msg.type === 'readyResult') {
    void onReadyResult(msg.jobId, msg.outcome);
    return;
  }
  if (msg.type === 'snapshotTab') {
    // Every frame's page structure + what the scanner saw, for a bug report.
    (async () => {
      const frames = (await chrome.webNavigation.getAllFrames({ tabId: msg.tabId })) ?? [{ frameId: 0 }];
      const parts = await Promise.all(
        frames.map((f) => chrome.tabs.sendMessage(msg.tabId, { type: 'snapshot' }, { frameId: f.frameId }).catch(() => null)),
      );
      reply(parts.filter(Boolean));
    })();
    return true;
  }
  if (msg.type === 'autoResult') {
    void onStepResult(msg.step, msg.outcome, sender.tab?.id);
    return;
  }
  if (msg.type === 'aiAsk') {
    answerQuestion(msg.q, msg.facts, msg.job, sender.tab?.id).then(reply);
    return true;
  }
  if (msg.type === 'aiGuide') {
    const tabId = sender.tab?.id;
    (async () => {
      const llm = await getLlm();
      if (!llm.enabled || !llm.apiKey) {
        if (tabId !== undefined) await recordAi(tabId, { what: 'Which button to press', result: 'skipped — AI is off (no OpenRouter key in Options)', decision: 'AI off — left for you' });
        return reply({ error: 'AI answers are off (no OpenRouter key)' });
      }
      const { answer: a, usage } = await askGuide(llm, msg.page);
      const picked = a && a.choice >= 0 ? `"${msg.page.buttons[a.choice]?.text}" (${a.confidence})` : 'none';
      const buttons: string[] = msg.page.buttons.map((b: { text: string }) => b.text);
      if (tabId !== undefined) {
        await recordAi(tabId, {
          what: `Which button to press (${msg.page.title || msg.page.url})`,
          result: `${picked} — ${a?.reason ?? ''}`,
          usage,
          options: buttons,
          answer: a && a.choice >= 0 ? `${buttons[a.choice]} — ${a.reason}` : `none — ${a?.reason ?? ''}`,
          confidence: a?.confidence,
          // Same rule as the page: it presses only at 0.6 or more.
          decision: a && a.choice >= 0 && a.confidence >= 0.6 ? 'Pressed it' : 'Not pressed — left for you',
        });
      }
      reply(a ?? { error: 'The model gave no usable answer' });
    })().catch((e) => reply({ error: (e as Error).message }));
    return true;
  }
  if (msg.type === 'llmTest') {
    // Options page "Test": one real question with the saved key and model.
    answerQuestion({ question: 'Are you at least 18 years old?', kind: 'select', options: ['Yes', 'No'], required: true }, 'Over 18: yes', 'Test')
      .then(async (r) => {
        if (r.error || r.answer) return reply(r);
        const llm = await getLlm();
        reply({ error: llm.apiKey ? 'AI answers are turned off' : 'No OpenRouter key saved' });
      })
      .catch((e) => reply({ error: String(e) }));
    return true;
  }
  if (msg.type === 'queue') {
    queueAction(msg.payload as QueueAction).then(reply, (e) => reply({ ok: false, error: String(e) }));
    return true;
  }
  if (msg.type === 'runner') {
    (msg.cmd === 'start' ? startRunner() : pauseRunner('Paused by you')).then(() => reply({ ok: true }), (e) => reply({ ok: false, error: String(e) }));
    return true;
  }
  if (msg.type === 'getReports') {
    chrome.storage.session.get(null).then((all) => {
      const prefix = `report:${msg.tabId}:`;
      reply(
        Object.entries(all)
          .filter(([k]) => k.startsWith(prefix))
          .map(([k, v]) => ({ frameId: Number(k.slice(prefix.length)), report: v })),
      );
    });
    return true;
  }
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'fill' && command !== 'fill-field') return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id !== undefined) fillTab(tab.id, undefined, command === 'fill-field' ? 'focused' : undefined);
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  await chrome.storage.session.remove([...(await reportKeys(tabId)), advKey(tabId)]);
  await onTabRemoved(tabId);
});
