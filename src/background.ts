import type { FillReport } from './types';
import { getSettings } from './profile/storage';

// Routes "fill this tab" to every frame and keeps the latest report per frame
// (chrome.storage.session) so the side panel can show it when opened later.

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
});
chrome.runtime.onStartup.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
});

async function fillTab(tabId: number, profileId?: string): Promise<{ frames: number; started: number; reasons: string[] }> {
  const id = profileId ?? (await getSettings()).activeProfileId;
  await chrome.storage.session.remove((await reportKeys(tabId)) as string[]);
  const frames = (await chrome.webNavigation.getAllFrames({ tabId })) ?? [{ frameId: 0 }];
  const results = await Promise.all(
    frames.map((f) =>
      chrome.tabs
        .sendMessage(tabId, { type: 'fill', profileId: id }, { frameId: f.frameId })
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

async function reportKeys(tabId: number): Promise<string[]> {
  const all = await chrome.storage.session.get(null);
  return Object.keys(all).filter((k) => k.startsWith(`report:${tabId}:`));
}

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg.type === 'fillTab') {
    const tabId: number | undefined = msg.tabId ?? sender.tab?.id;
    if (tabId === undefined) return;
    fillTab(tabId, msg.profileId).then(reply);
    return true;
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
  if (command !== 'fill') return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id !== undefined) fillTab(tab.id);
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  await chrome.storage.session.remove(await reportKeys(tabId));
});
