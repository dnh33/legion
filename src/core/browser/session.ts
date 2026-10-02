/**
 * One run's browser: starts the process (through the launcher), opens ONE page, and implements the tool operations over CDP.
 * Every page-derived value returned here is raw outside text; tools.ts wraps it. Every address that is navigated to, redirected to (as far as
 * Legion can see it) or landed on is run through the URL guard and the DNS check; a bad one resets the page and returns a refusal, never content.
 */
import { BROWSER_LIMITS } from '../../shared/browser.js';
import type { CdpEvent, CdpPort } from './cdp.js';
import type { RunningBrowser } from './launcher.js';
import { checkUrl } from './url-guard.js';
import type { GuardOptions } from './url-guard.js';
import { checkUrlResolved } from './resolve.js';
import type { Resolver } from './resolve.js';

export class SessionRefusal extends Error {
  constructor(message: string) { super(message); this.name = 'SessionRefusal'; }
}

export interface SessionDeps {
  /** The engine of this run, fixed when the run's browser object is made: it never changes during a run. */
  engine?: 'chromium' | 'lightpanda';
  launch(): Promise<RunningBrowser>;
  guard(): GuardOptions;
  resolve: Resolver;
  /** Asked after an action (click, submit) landed on an origin not seen in this run. Resolving false resets the page. */
  approveOrigin(origin: string, url: string): Promise<boolean>;
  limits?: Partial<typeof BROWSER_LIMITS>;
  onEnded?(): void;
}

export interface PageView { url: string; title: string }
const ABOUT_BLANK = 'about:blank';
const strLit = (s: string): string => JSON.stringify(s);

export class BrowserSession {
  readonly origins = new Set<string>();
  private run: RunningBrowser | null = null;
  private cdp: CdpPort | null = null;
  private targetId: string | null = null;
  private sessionId: string | null = null;
  private violation: string | null = null;
  private hops = 0;
  private checks: Array<Promise<void>> = [];
  private loadWaiters: Array<() => void> = [];
  private interception = false;
  private starting: Promise<void> | null = null;
  private ended = false;
  private extraTargets = 0;
  private hostVerdicts = new Map<string, Promise<string | null>>();
  private readonly lim: typeof BROWSER_LIMITS;

  constructor(private readonly d: SessionDeps) { this.lim = { ...BROWSER_LIMITS, ...(d.limits ?? {}) }; }

  get started(): boolean { return !!this.run; }
  get hasInterception(): boolean { return this.interception; }
  get processId(): number | undefined { return this.run?.pid; }
  /** What ran, for results and Settings ("Lightpanda", "Microsoft Edge 120.0.2210.91 (headless)"). Empty until the browser has started. */
  get engineLabel(): string { return this.run?.label ?? ''; }
  get engine(): 'chromium' | 'lightpanda' { return this.d.engine ?? 'lightpanda'; }
  get closedTabsBlocked(): number { return this.extraTargets; }

  // ------------------------------------------------------------------ start / stop

  private async start(): Promise<void> {
    if (this.ended) throw new SessionRefusal('This browser was closed. Open a page again to start a new one.');
    if (this.run && this.cdp && !this.cdp.closed) return;
    if (this.starting) return this.starting;
    this.starting = (async () => {
      await this.teardown(false);
      const run = await this.d.launch();
      if (this.ended) { await run.stop().catch(() => undefined); throw new SessionRefusal('This browser was closed while it was starting.'); }
      this.run = run; this.cdp = run.cdp;
      run.cdp.onClose(() => { this.cdp = null; this.targetId = null; this.sessionId = null; });
      void run.exited.then(() => { if (this.run === run) { this.cdp = null; this.targetId = null; this.sessionId = null; } });
      run.cdp.onEvent((e) => this.onEvent(e));
    })();
    try { await this.starting; } finally { this.starting = null; }
  }

  private async teardown(final: boolean): Promise<void> {
    const run = this.run;
    this.run = null; this.cdp = null; this.targetId = null; this.sessionId = null;
    if (final) this.ended = true;
    if (run) { try { await run.stop(); } catch { /* the process is being removed */ } }
  }

  /** Stops the process and everything it started. Idempotent. */
  async close(): Promise<void> {
    const was = !this.ended;
    await this.teardown(true);
    for (const w of this.loadWaiters.splice(0)) w();
    if (was) this.d.onEnded?.();
  }

  private async page(): Promise<{ cdp: CdpPort; sid: string }> {
    await this.start();
    const cdp = this.cdp;
    if (!cdp) throw new SessionRefusal('The browser stopped. Open the page again.');
    if (!this.targetId || !this.sessionId) {
      const t = await cdp.send('Target.createTarget', { url: ABOUT_BLANK });
      if (typeof t.targetId !== 'string') throw new SessionRefusal('The browser did not open a page.');
      this.targetId = t.targetId;
      const a = await cdp.send('Target.attachToTarget', { targetId: t.targetId, flatten: true });
      if (typeof a.sessionId !== 'string') throw new SessionRefusal('The browser did not attach to the page.');
      this.sessionId = a.sessionId;
      await cdp.send('Page.enable', {}, { sessionId: a.sessionId });
      await cdp.send('Network.enable', {}, { sessionId: a.sessionId }).catch(() => undefined);
      this.interception = await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*' }] }, { sessionId: a.sessionId }).then(() => true, () => false);
      await cdp.send('Target.setDiscoverTargets', { discover: true }).catch(() => undefined);
      // the Chromium family has no private-network option of its own: every request must pass Legion's check through the Fetch domain, so a run
      // whose interception did not start opens nothing. Downloads are denied at the browser.
      if (this.engine === 'chromium') {
        if (!this.interception) { await this.resetPage(); throw new SessionRefusal('This browser did not accept request interception, so no page was opened (Legion checks every request itself on this engine).'); }
        const dl = await cdp.send('Browser.setDownloadBehavior', { behavior: 'deny' }).then(() => true, () => false);
        if (!dl) { await this.resetPage(); throw new SessionRefusal('This browser did not accept the "deny downloads" setting, so no page was opened.'); }
      }
      // local addresses are on and the browser's own private-network block is off: without request interception nothing stops a request before it is sent
      if (this.d.guard().allowLocal && !this.interception) { await this.resetPage(); throw new SessionRefusal('Local addresses are enabled but this browser build cannot filter requests, so no page was opened. Turn local addresses off or use a build that supports request interception.'); }
    }
    return { cdp, sid: this.sessionId as string };
  }

  // ------------------------------------------------------------------ events: redirects, subresources, extra tabs

  private hostVerdict(url: string, document: boolean): Promise<string | null> {
    // address rules for every request; the domain list only for documents (a page may load images from any CDN)
    const g: GuardOptions = document ? this.d.guard() : { ...this.d.guard(), allowDomains: [] };
    const key = `${document ? 'd' : 's'}|${JSON.stringify(g)}|${url.split(/[?#]/)[0]}`;
    const cached = this.hostVerdicts.get(key);
    if (cached) return cached;
    // a page's own image or script whose name does not resolve is not a reason to refuse the page; a document that does not resolve is
    const p = checkUrlResolved(url, g, this.d.resolve).then((v) => (v.ok || (!document && !g.allowLocal && /could not be resolved/.test(v.reason)) ? null : v.reason), () => 'the address could not be checked');
    if (this.hostVerdicts.size > 500) this.hostVerdicts.clear();
    this.hostVerdicts.set(key, p);
    return p;
  }

  private onEvent(e: CdpEvent): void {
    const cdp = this.cdp;
    if (e.method === 'Target.targetCreated') {
      const id = e.params?.targetInfo?.targetId;
      if (typeof id === 'string' && id !== this.targetId && this.targetId) {
        this.extraTargets++;
        void cdp?.send('Target.closeTarget', { targetId: id }).catch(() => undefined);
      }
      return;
    }
    if (e.sessionId && e.sessionId !== this.sessionId) return;
    switch (e.method) {
      case 'Network.requestWillBeSent': {
        const url = e.params?.request?.url;
        if (typeof url !== 'string') return;
        const isDoc = e.params?.type === 'Document';
        if (isDoc && !/^https?:/i.test(url) && url !== ABOUT_BLANK) { this.violation ??= `a navigation to a non-web address (${shortUrl(url.split(':')[0] + ':')}) was refused`; return; }
        if (url.startsWith('data:') || url.startsWith('about:')) return;
        if (e.params?.redirectResponse && isDoc) {
          this.hops++;
          if (this.hops > this.lim.maxRedirectHops) this.violation ??= `too many redirects (more than ${this.lim.maxRedirectHops})`;
        }
        const p = this.hostVerdict(url, isDoc).then((bad) => { if (bad) this.violation ??= `${isDoc ? 'a redirect or navigation' : 'a request made by the page'} to ${shortUrl(url)} was refused: ${bad}`; });
        this.checks.push(p);
        return;
      }
      case 'Fetch.requestPaused': {
        const id = e.params?.requestId; const url = e.params?.request?.url;
        if (typeof id !== 'string' || !cdp) return;
        const isDoc = e.params?.resourceType === 'Document';
        const nonWebDoc = isDoc && typeof url === 'string' && !/^https?:/i.test(url) && url !== ABOUT_BLANK;
        const decide = nonWebDoc ? Promise.resolve<string | null>('a navigation to a non-web address') : typeof url === 'string' && !url.startsWith('data:') && !url.startsWith('about:') ? this.hostVerdict(url, isDoc) : Promise.resolve<string | null>(null);
        const p = decide.then(async (bad) => {
          if (bad) { this.violation ??= `a request to ${shortUrl(String(url))} was refused: ${bad}`; await cdp.send('Fetch.failRequest', { requestId: id, errorReason: 'BlockedByClient' }, { sessionId: this.sessionId ?? undefined }).catch(() => undefined); }
          else await cdp.send('Fetch.continueRequest', { requestId: id }, { sessionId: this.sessionId ?? undefined }).catch(() => undefined);
        });
        this.checks.push(p);
        return;
      }
      case 'Page.frameNavigated': {
        const f = e.params?.frame;
        if (f && !f.parentId && typeof f.url === 'string' && f.url !== ABOUT_BLANK) this.checks.push(this.hostVerdict(f.url, true).then((bad) => { if (bad) this.violation ??= `the page ended up at ${shortUrl(f.url)}: ${bad}`; }));
        return;
      }
      case 'Page.loadEventFired': case 'Page.frameStoppedLoading': case 'Page.domContentEventFired':
        for (const w of this.loadWaiters.splice(0)) w();
        return;
      default:
    }
  }

  private async settle(ms: number): Promise<void> {
    await new Promise<void>((resolve) => {
      const t = setTimeout(done, ms);
      function done() { clearTimeout(t); resolve(); }
      this.loadWaiters.push(done);
    });
    // checks can add checks (a redirect inside a paused request); drain until quiet
    for (let i = 0; i < 5 && this.checks.length; i++) await Promise.all(this.checks.splice(0));
  }

  private async resetPage(): Promise<void> {
    const cdp = this.cdp; const t = this.targetId; const s = this.sessionId;
    this.targetId = null; this.sessionId = null;
    if (cdp && s) await cdp.send('Page.navigate', { url: ABOUT_BLANK }, { sessionId: s, timeoutMs: 3000 }).catch(() => undefined);
    if (cdp && t) await cdp.send('Target.closeTarget', { targetId: t }, { timeoutMs: 3000 }).catch(() => undefined);
  }

  private async evalValue(cdp: CdpPort, sid: string, expression: string): Promise<unknown> {
    const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, { sessionId: sid });
    if (r.exceptionDetails) {
      const t = r.exceptionDetails.exception?.description ?? r.exceptionDetails.text ?? 'script error';
      throw new PageScriptError(String(t));
    }
    return r.result?.value;
  }

  private async view(cdp: CdpPort, sid: string): Promise<PageView> {
    const v = await this.evalValue(cdp, sid, '({url: location.href, title: document.title || ""})') as { url?: unknown; title?: unknown } | undefined;
    return { url: typeof v?.url === 'string' ? v.url : '', title: typeof v?.title === 'string' ? v.title : '' };
  }

  /** After the page moved: the final address must pass the guard (and DNS and the domain list); queued checks are drained first. */
  private async verifyLanding(cdp: CdpPort, sid: string, before: string | null): Promise<PageView> {
    await this.settle(0);
    const v = await this.view(cdp, sid);
    if (!this.violation && v.url && v.url !== ABOUT_BLANK) {
      const fin = await checkUrlResolved(v.url, this.d.guard(), this.d.resolve);
      if (!fin.ok) this.violation = `the page ended up at ${shortUrl(v.url)}: ${fin.reason}`;
    }
    if (this.violation) {
      const why = this.violation; this.violation = null;
      await this.resetPage();
      throw new SessionRefusal(`Refused: ${why}. The page was closed and none of its content was returned.`);
    }
    if (v.url && v.url !== before) {
      const origin = safeOrigin(v.url);
      if (origin && !this.origins.has(origin)) {
        const ok = await this.d.approveOrigin(origin, v.url);
        if (!ok) { await this.resetPage(); throw new SessionRefusal(`Not approved: the page moved to ${origin}. The page was closed and none of its content was returned.`); }
        this.origins.add(origin);
      }
    }
    return v;
  }

  // ------------------------------------------------------------------ operations

  /** `url` was already approved and passed checkUrlResolved by the caller; the final address is checked again here. */
  async open(url: string): Promise<PageView> {
    const { cdp, sid } = await this.page();
    this.violation = null; this.hops = 0; this.checks = [];
    const origin = safeOrigin(url);
    const nav = await cdp.send('Page.navigate', { url }, { sessionId: sid, timeoutMs: this.lim.navigationMs });
    if (typeof nav.errorText === 'string' && nav.errorText) {
      this.checks = [];
      throw new SessionRefusal(`The page did not load: ${nav.errorText.slice(0, 120)}`);
    }
    await this.settle(this.lim.navigationMs);
    // the caller already asked about this origin; a redirect to ANOTHER origin is asked about in verifyLanding
    if (origin) this.origins.add(origin);
    return this.verifyLanding(cdp, sid, null);
  }

  /** Reads must not trust the last check: the page may have moved on its own (meta refresh, a timer) since open(). */
  private async recheck(): Promise<{ cdp: CdpPort; sid: string }> {
    const { cdp, sid } = await this.livePage();
    await this.verifyLanding(cdp, sid, (await this.view(cdp, sid)).url);
    return { cdp, sid };
  }

  async text(selector?: string): Promise<{ text: string; url: string; found: boolean }> {
    const { cdp, sid } = await this.recheck();
    const sel = selector && selector.trim() ? selector.trim().slice(0, this.lim.selectorChars) : null;
    const expr = sel
      ? `(()=>{const e=document.querySelector(${strLit(sel)});if(!e)return null;return String(e.innerText||e.textContent||"").slice(0,${this.lim.textChars * 2})})()`
      : `(()=>{const b=document.body;return b?String(b.innerText||b.textContent||"").slice(0,${this.lim.textChars * 2}):""})()`;
    const v = await this.evalValue(cdp, sid, expr);
    return { text: typeof v === 'string' ? v : '', url: (await this.view(cdp, sid)).url, found: v !== null };
  }

  async links(): Promise<Array<{ text: string; href: string }>> {
    const { cdp, sid } = await this.recheck();
    const v = await this.evalValue(cdp, sid, `Array.from(document.querySelectorAll("a[href]")).slice(0,${this.lim.links}).map(a=>({text:String(a.textContent||"").trim().replace(/\\s+/g," ").slice(0,120),href:String(a.href||"").slice(0,${this.lim.linkChars})}))`);
    return Array.isArray(v) ? v.filter((x): x is { text: string; href: string } => !!x && typeof x.href === 'string').slice(0, this.lim.links).map((x) => ({ text: String(x.text ?? ''), href: x.href })) : [];
  }

  async click(selector: string): Promise<{ clicked: boolean; view: PageView }> {
    const { cdp, sid } = await this.livePage();
    const before = (await this.view(cdp, sid)).url;
    // a link's target is checked BEFORE the click; anything else (a button that navigates) is checked where it lands
    const target = await this.evalValue(cdp, sid, `(()=>{const e=document.querySelector(${strLit(selector.slice(0, this.lim.selectorChars))});if(!e)return {found:false};const a=e.closest("a[href]");return {found:true,href:a?String(a.href):""}})()`) as { found?: boolean; href?: string } | undefined;
    if (!target?.found) return { clicked: false, view: await this.view(cdp, sid) };
    if (target.href && /^[a-z][a-z0-9+.-]*:/i.test(target.href) && !/^https?:/i.test(target.href)) throw new SessionRefusal(`Refused: that link goes to ${target.href.split(':')[0]}:, which is not allowed.`);
    if (target.href) {
      const ok = await checkUrlResolved(target.href, this.d.guard(), this.d.resolve);
      if (!ok.ok) throw new SessionRefusal(`Refused: that link goes to ${shortUrl(target.href)}: ${ok.reason}.`);
    }
    this.violation = null; this.hops = 0; this.checks = [];
    await this.evalValue(cdp, sid, `(()=>{const e=document.querySelector(${strLit(selector.slice(0, this.lim.selectorChars))});if(e)e.click()})()`);
    await this.settle(Math.min(this.lim.navigationMs, 3000));
    return { clicked: true, view: await this.verifyLanding(cdp, sid, before) };
  }

  async type(selector: string, text: string, submit: boolean): Promise<{ typed: boolean; view: PageView }> {
    const { cdp, sid } = await this.livePage();
    const before = (await this.view(cdp, sid)).url;
    const info = await this.evalValue(cdp, sid, `(()=>{const e=document.querySelector(${strLit(selector.slice(0, this.lim.selectorChars))});if(!e)return {found:false};return {found:true,type:String(e.type||""),name:String(e.name||"")+" "+String(e.id||"")+" "+String(e.getAttribute("autocomplete")||"")}})()`) as { found?: boolean; type?: string; name?: string } | undefined;
    if (!info?.found) return { typed: false, view: await this.view(cdp, sid) };
    if (info.type?.toLowerCase() === 'password' || /pass(word|wd)|current-password|new-password|one-time-code/i.test(info.name ?? '')) throw new SessionRefusal('Refused: Legion does not type into password fields. Ask the user to do that themselves.');
    if (submit) {
      // the form's target is checked, and a new site is asked about, BEFORE the typed text is sent anywhere
      const act = await this.evalValue(cdp, sid, `(()=>{const e=document.querySelector(${strLit(selector.slice(0, this.lim.selectorChars))});const f=e&&e.form;return f?String(f.action||location.href):""})()`);
      if (typeof act === 'string' && act) {
        const ok = await checkUrlResolved(act, this.d.guard(), this.d.resolve);
        if (!ok.ok) throw new SessionRefusal(`Refused: that form sends to ${shortUrl(act)}: ${ok.reason}. Nothing was typed or sent.`);
        const o = safeOrigin(act);
        if (o && !this.origins.has(o)) { if (!(await this.d.approveOrigin(o, act))) throw new SessionRefusal(`Not approved: the form sends to ${o}. Nothing was typed or sent.`); this.origins.add(o); }
      }
    }
    this.violation = null; this.hops = 0; this.checks = [];
    await this.evalValue(cdp, sid, `(()=>{const e=document.querySelector(${strLit(selector.slice(0, this.lim.selectorChars))});if(!e)return;e.focus();e.value=${strLit(text.slice(0, this.lim.typeChars))};e.dispatchEvent(new Event("input",{bubbles:true}));e.dispatchEvent(new Event("change",{bubbles:true}));${submit ? 'const f=e.form;if(f){if(f.requestSubmit)f.requestSubmit();else f.submit()}' : ''}})()`);
    if (submit) await this.settle(Math.min(this.lim.navigationMs, 3000));
    return { typed: true, view: submit ? await this.verifyLanding(cdp, sid, before) : await this.view(cdp, sid) };
  }

  async evalExpr(expression: string): Promise<{ value: string; view: PageView }> {
    const { cdp, sid } = await this.livePage();
    const before = (await this.view(cdp, sid)).url;
    this.violation = null; this.hops = 0; this.checks = [];
    const v = await this.evalValue(cdp, sid, `JSON.stringify((()=>{try{return (${expression.slice(0, this.lim.evalExprChars)})}catch(e){return {error:String(e)}}})())`).catch((e) => { if (e instanceof PageScriptError) return JSON.stringify({ error: e.message }); throw e; });
    return { value: typeof v === 'string' ? v : 'undefined', view: await this.verifyLanding(cdp, sid, before) };
  }

  private async livePage(): Promise<{ cdp: CdpPort; sid: string }> {
    if (!this.run || !this.cdp || !this.sessionId) throw new SessionRefusal('No page is open. Call browser_open first.');
    return { cdp: this.cdp, sid: this.sessionId };
  }
}

export class PageScriptError extends Error {}
const shortUrl = (u: string): string => { const s = u.replace(/[^\x21-\x7e]/g, ""); return s.length > 120 ? s.slice(0, 117) + "..." : s; };
export function safeOrigin(u: string): string | null { try { const x = new URL(u); return x.protocol === 'http:' || x.protocol === 'https:' ? x.origin : null; } catch { return null; } }
export { checkUrl };
