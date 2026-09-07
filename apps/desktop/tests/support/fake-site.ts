/**
 * A deterministic, GitHub-shaped site behind the real `BrowserController`
 * interface.
 *
 * WHAT THIS IS FOR, AND WHAT IT IS NOT EVIDENCE OF.
 *
 * The flagship workflow has to be exercised end to end in CI, on a machine
 * with no network, no GitHub account and no Chromium window. So this stands in
 * for the browser — and for nothing else. Everything above it in the flagship
 * tests is the shipping code: the real dispatcher, the real risk policy, the
 * real approval broker with its real binding and expiry, the real turn budget,
 * the real duplicate ledger, the real orchestrator and the real state machine.
 *
 * It is NOT evidence that Axon works against github.com. It cannot be: it
 * serves markup this file wrote, in a page model this file implements. Real
 * Chromium against real HTTP is `scripts/verify-agent.cjs`; real github.com is
 * a manual check. Those distinctions are kept sharp in the Step 7 report
 * because collapsing them is how a demo becomes a claim nobody verified.
 *
 * WHAT IT DOES MODEL FAITHFULLY, because the tests above it depend on it:
 *
 * - Element references are minted per reading, exactly as `AxonBrowser` mints
 *   them, and an old reading's references are not valid against a new page.
 * - Observations carry a monotonic epoch and go stale when the page changes
 *   for a reason Axon did not cause — the case the whole stale-reference
 *   mechanism exists for.
 * - A submission changes the page: the comment appears in the visible text,
 *   which is what `verifyChange` has to find.
 * - Page text is written by "the site", including the hostile fixtures. A page
 *   here can say anything; it still cannot do anything.
 */

import { BROWSING_LIMITS, type BrowserStatus, type ElementRole, type ObservedElement, type PageObservation } from '@axon/core';
import type { BrowserController } from '../../src/main/browser/axon-browser.js';

/** One element as the site declares it, before Axon mints a reference. */
export interface SiteElement {
  readonly role: ElementRole;
  readonly label: string;
  readonly href?: string | null;
  readonly sensitive?: boolean;
  readonly submits?: boolean;
  /** Text fields carry a value the site remembers between actions. */
  value?: string | null;
  /** What clicking does. Absent means "nothing observable". */
  readonly onClick?: (site: FakeSite) => void;
}

export interface SitePage {
  readonly title: string;
  /** Visible text. A function so it can reflect state the page has gained. */
  text(site: FakeSite): string;
  elements(site: FakeSite): readonly SiteElement[];
}

export interface FakeSiteOptions {
  readonly origin?: string;
  readonly pages: Readonly<Record<string, SitePage>>;
  readonly start?: string;
}

/**
 * A page model with a browser's shape.
 *
 * Deliberately not a mock in the vitest sense: it has real state, and the
 * assertions in the flagship tests are about what that state became.
 */
export class FakeSite implements BrowserController {
  readonly origin: string;
  /** Every controller method that was called, in order, for assertions. */
  readonly calls: string[] = [];
  /** Comments the site has accepted. The record a duplicate submit would grow. */
  readonly comments: string[] = [];

  private readonly pages: Readonly<Record<string, SitePage>>;
  private path: string;
  /** Whether the window is open. Named `windowOpen` so it cannot collide
   *  with the `open()` method the controller interface requires. */
  private windowOpen = false;

  private observation: PageObservation | null = null;
  private epoch = 0;
  private stale = true;
  /** Reference -> the element that reading described. Rebuilt every read. */
  private refs = new Map<string, SiteElement>();

  private actions = 0;
  private cancelled = false;

  /** Set by a test to make the next action fail, as a real browser can. */
  private nextFailure: Error | null = null;

  constructor(options: FakeSiteOptions) {
    this.origin = options.origin ?? 'https://github.com';
    this.pages = options.pages;
    this.path = options.start ?? '/';
  }

  // --- test controls ------------------------------------------------------

  /** The page URL the site is currently on. */
  get url(): string {
    return `${this.origin}${this.path}`;
  }

  /**
   * Move the page without Axon asking.
   *
   * A redirect, a timer, a live update — the class of change that makes an
   * element reference dangerous, because Axon's record still describes the
   * document that was there before.
   */
  driftTo(path: string): void {
    this.path = path;
    this.stale = true;
  }

  /** Change the page's content in place, without navigating. */
  mutate(mutate: (site: FakeSite) => void): void {
    mutate(this);
    this.stale = true;
  }

  failNext(error: Error): void {
    this.nextFailure = error;
  }

  /** Accept a comment, as the site's own submit handler would. */
  acceptComment(text: string): void {
    this.comments.push(text);
  }

  // --- BrowserController --------------------------------------------------

  status(): BrowserStatus {
    return { available: true, reason: null, open: this.windowOpen, url: this.observation?.url ?? null };
  }

  lastObservation(): PageObservation | null {
    return this.observation;
  }

  describeElement(ref: string): ObservedElement | null {
    return this.observation?.elements.find((element) => element.ref === ref) ?? null;
  }

  observationFresh(): boolean {
    return this.observation !== null && !this.stale && this.windowOpen;
  }

  beginTurn(): void {
    this.actions = 0;
    this.cancelled = false;
  }

  cancel(): void {
    this.cancelled = true;
    this.stale = true;
  }

  close(): void {
    this.calls.push('close');
    this.windowOpen = false;
    this.observation = null;
    this.stale = true;
  }

  open(url: string): Promise<PageObservation> {
    this.calls.push(`open:${url}`);
    this.windowOpen = true;
    return this.goto(url);
  }

  navigate(url: string): Promise<PageObservation> {
    this.calls.push(`navigate:${url}`);
    if (!this.windowOpen) throw new Error('The browser is not open. Open a page first.');
    return this.goto(url);
  }

  read(): Promise<PageObservation> {
    this.calls.push('read');
    this.spend();
    return Promise.resolve(this.observe());
  }

  async click(ref: string): Promise<PageObservation> {
    this.calls.push(`click:${ref}`);
    this.spend();
    this.requireFresh();
    const element = this.refs.get(ref);
    if (!element) throw new Error('That element is no longer on the page.');
    element.onClick?.(this);
    // A click can change the page, so the reading it produces is a new one.
    this.stale = true;
    return Promise.resolve(this.observe());
  }

  async type(ref: string, text: string, submit: boolean): Promise<PageObservation> {
    this.calls.push(`type:${ref}:${submit}`);
    this.spend();
    this.requireFresh();
    const element = this.refs.get(ref);
    if (!element) throw new Error('That element is no longer on the page.');
    if (element.sensitive) throw new Error('Refusing to type into a credential or payment field.');
    if (element.role !== 'textbox') throw new Error('That element is not a text field.');

    element.value = text;
    if (submit) {
      this.acceptComment(text);
      element.value = '';
    }
    this.stale = true;
    return Promise.resolve(this.observe());
  }

  scroll(pages: number): Promise<PageObservation> {
    this.calls.push(`scroll:${pages}`);
    this.spend();
    return Promise.resolve(this.observe());
  }

  history(direction: 'back' | 'forward'): Promise<PageObservation> {
    this.calls.push(`history:${direction}`);
    this.spend();
    throw new Error(`There is no page to go ${direction} to.`);
  }

  // --- internals ----------------------------------------------------------

  private goto(url: string): Promise<PageObservation> {
    this.spend();
    if (!url.startsWith(this.origin)) {
      throw new Error(`This fake site only serves ${this.origin}`);
    }
    this.path = url.slice(this.origin.length) || '/';
    this.stale = true;
    return Promise.resolve(this.observe());
  }

  private spend(): void {
    if (this.cancelled) throw new Error('Browsing was cancelled.');
    if (this.nextFailure) {
      const error = this.nextFailure;
      this.nextFailure = null;
      throw error;
    }
    this.actions += 1;
    if (this.actions > BROWSING_LIMITS.maxActionsPerTurn) {
      throw new Error('Axon has taken too many browser actions for this request.');
    }
  }

  private requireFresh(): void {
    if (this.observationFresh()) return;
    throw new Error('The page has changed since Axon last read it. Read the page again.');
  }

  /**
   * Take a reading.
   *
   * References are minted here and nowhere else, freshly each time, exactly as
   * the real browser's page program does — so a reference from an earlier
   * reading may or may not mean the same thing, and the tests can rely on
   * neither.
   */
  private observe(): PageObservation {
    const page = this.pages[this.path];
    if (!page) throw new Error(`No such page: ${this.path}`);

    this.epoch += 1;
    this.refs = new Map();

    const elements: ObservedElement[] = page.elements(this).map((element, index) => {
      const ref = `e${index + 1}`;
      this.refs.set(ref, element);
      return {
        ref,
        role: element.role,
        label: element.label,
        href: element.href ?? null,
        sensitive: element.sensitive === true,
        submits: element.submits === true,
        value: element.value ?? null,
      };
    });

    const observation: PageObservation = {
      epoch: this.epoch,
      url: this.url,
      title: page.title,
      text: page.text(this).slice(0, BROWSING_LIMITS.maxTextCharacters),
      textTruncated: page.text(this).length > BROWSING_LIMITS.maxTextCharacters,
      elements,
      elementsTruncated: false,
      loading: false,
    };

    this.observation = observation;
    this.stale = false;
    return observation;
  }
}

// ---------------------------------------------------------------------------
// The flagship fixture: an issue with a maintainer reply on it.
// ---------------------------------------------------------------------------

/**
 * A GitHub-shaped issue thread.
 *
 * The maintainer's comment is ordinary, helpful and entirely benign, because
 * the flagship test is about the happy path working. The hostile variants live
 * in `agent-security.test.ts` and reuse this same shape, so the only
 * difference between "it worked" and "it was attacked" is the words on the
 * page — which is exactly the property the architecture claims.
 */
export function githubIssueSite(options: { maintainerComment?: string } = {}): FakeSite {
  const maintainerComment =
    options.maintainerComment ??
    'Thanks for the report. I can reproduce it on 0.4.2. The fix is to pass the ' +
      'timeout explicitly rather than relying on the default. Could you confirm ' +
      'which version you are on?';

  /**
   * The comment box, created ONCE.
   *
   * Element objects have to outlive a reading, because a real text field does:
   * text typed into it is still there when the page is read again, and the
   * submit that follows reads it back. Rebuilding the elements on every
   * observation would silently discard what was typed — and the flagship test
   * would then pass with an empty comment, which is exactly the invented
   * success this milestone is about not producing.
   */
  const commentBox: SiteElement = { role: 'textbox', label: 'Add a comment', value: '' };

  const commentButton: SiteElement = {
    role: 'button',
    label: 'Comment',
    submits: true,
    onClick: (s) => {
      // The site posts whatever is in the box, as a real one would — so
      // click-to-submit and type-with-submit reach the same place, and the
      // duplicate guard is exercised against both.
      const pending = commentBox.value;
      if (pending !== null && pending !== undefined && pending !== '') {
        s.acceptComment(pending);
        commentBox.value = '';
      }
    },
  };

  return new FakeSite({
    origin: 'https://github.com',
    start: '/axon/demo/issues',
    pages: {
      '/axon/demo/issues': {
        title: 'Issues · axon/demo',
        text: () =>
          [
            'Issues',
            '#41 Timeout is ignored when a custom client is supplied — opened 3 days ago, 2 comments',
            '#40 Typo in the README — opened last week, 0 comments',
          ].join('\n'),
        elements: () => [
          { role: 'link', label: 'New issue', href: 'https://github.com/axon/demo/issues/new' },
          {
            role: 'link',
            label: 'Timeout is ignored when a custom client is supplied',
            href: 'https://github.com/axon/demo/issues/41',
            onClick: (s) => {
              s.driftTo('/axon/demo/issues/41');
            },
          },
          {
            role: 'link',
            label: 'Typo in the README',
            href: 'https://github.com/axon/demo/issues/40',
            onClick: (s) => {
              s.driftTo('/axon/demo/issues/40');
            },
          },
        ],
      },

      '/axon/demo/issues/41': {
        title: 'Timeout is ignored when a custom client is supplied · Issue #41 · axon/demo',
        text: (s) =>
          [
            'Timeout is ignored when a custom client is supplied #41',
            '',
            'you opened this issue 3 days ago',
            'The timeout option has no effect when I pass my own client instance.',
            '',
            'maintainer commented yesterday',
            maintainerComment,
            '',
            ...s.comments.map((comment) => `you commented just now: ${comment}`),
          ].join('\n'),
        elements: () => [
          { role: 'link', label: 'Back to issues', href: 'https://github.com/axon/demo/issues' },
          commentBox,
          commentButton,
          // Submits, and deliberately does nothing observable. The fixture for
          // "the executor returned and the page did not change" — which is the
          // case verification exists to catch.
          { role: 'button', label: 'Close issue', submits: true },
        ],
      },

      '/axon/demo/issues/40': {
        title: 'Typo in the README · Issue #40 · axon/demo',
        text: () =>
          ['Typo in the README #40', '', 'you opened this issue last week', 'Nobody has replied.'].join('\n'),
        elements: () => [{ role: 'link', label: 'Back to issues', href: 'https://github.com/axon/demo/issues' }],
      },
    },
  });
}
