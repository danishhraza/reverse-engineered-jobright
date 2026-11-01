import type { FillMode, FillReport, PendingLearn } from './types';
import { getPending, getSettings, setPending } from './profile/storage';

// Routes "fill this tab" to every frame and keeps the latest report per frame
// (chrome.storage.session) so the side panel can show it when opened later.

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
});
chrome.runtime.onStartup.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
});

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
    if (!r.done) await pushReport(tabId, Number(m[2]), { ...r, done: true, current: undefined, cancelled, message });
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
});
