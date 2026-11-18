// Runs in the page's own JavaScript world (manifest "world": "MAIN"), before the
// page's scripts. A browser pop-up (alert / confirm: "You have uploaded your
// resume", OK) freezes the page — and Autopilot with it — until someone clicks.
// In a tab Autopilot is working in, they're answered at once: alert -> OK,
// confirm -> OK unless it's about withdrawing, deleting or leaving (-> Cancel).
// The message goes to the job's log. Everywhere else the browser's own dialogs
// are left alone.

(() => {
  // Set by the content script (same origin, same tab) while Autopilot works here.
  const on = (): boolean => {
    try {
      return sessionStorage.getItem('rej-autopilot') === '1';
    } catch {
      return false;
    }
  };
  const RISKY = /withdraw|delete|remove|discard|leave (this|the) (page|site)|lose (your|all|any)|sign out|log ?out|cancel (your|this|the) application/i;
  const tell = (kind: string, message: unknown, answer: string) =>
    window.postMessage({ source: 'rej-dialog', kind, message: String(message ?? '').slice(0, 300), answer }, '*');

  const realAlert = window.alert;
  const realConfirm = window.confirm;
  window.alert = function (message?: unknown): void {
    if (!on()) return realAlert.call(window, message as string);
    tell('alert', message, 'OK');
  };
  window.confirm = function (message?: string): boolean {
    if (!on()) return realConfirm.call(window, message);
    const ok = !RISKY.test(String(message ?? ''));
    tell('confirm', message, ok ? 'OK' : 'Cancel');
    return ok;
  };
})();

export {};
