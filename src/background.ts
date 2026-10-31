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

async function fillTab(tabId: number, profileId?: string, mode?: FillMode): Promise<FillResult> {
  const id = profileId ?? (await getSettings()).activeProfileId;
  const frames = (await chrome.webNavigation.getAllFrames({ tabId })) ?? [{ frameId: 0 }];
  if (mode === 'focused') return fillFocused(tabId, id, frames);
  await chrome.storage.session.remove((await reportKeys(tabId)) as string[]);
  const results = await Promise.all(
    frames.map((f) =>
      chrome.tabs
        .sendMessage(tabId, { type: 'fill', profileId: id, mode }, { frameId: f.frameId })
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
  if (msg.type === 'learnProposal') {
    const p: PendingLearn = { answer: msg.answer, previous: msg.previous };
    // Typing fires several events; keep only the latest answer per question.
    getPending().then((list) => setPending([...list.filter((x) => x.answer.pattern !== p.answer.pattern), p]));
    return;
  }
  if (msg.type === 'report' && sender.tab?.id !== undefined) {
    const report = msg.report as FillReport;
    chrome.storage.session.set({ [`report:${sender.tab.id}:${sender.frameId ?? 0}`]: report });
    return;
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
  await chrome.storage.session.remove(await reportKeys(tabId));
});
