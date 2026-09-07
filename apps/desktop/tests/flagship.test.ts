/**
 * The signature workflow, end to end.
 *
 * "Check my GitHub issue from yesterday, see if the maintainer replied,
 *  summarize what they said, draft a response, and ask me before sending."
 *
 * WHAT IS REAL IN THESE TESTS, AND WHAT IS NOT.
 *
 * Real: the orchestrator, the state machine, the dispatcher, the risk policy,
 * the approval broker, the approval binding, the turn budget, the duplicate
 * ledger, the browser tools, the observation view, the verification, and the
 * event stream the UI and the JSONL log both read.
 *
 * Not real: the model (a `ScriptedBrain` with a fixed plan) and the page (a
 * `FakeSite` serving GitHub-shaped markup offline). Both are substituted at
 * interfaces the product already depends on.
 *
 * So what these tests establish is: GIVEN a brain that proposes this sequence,
 * Axon gates it correctly, verifies it honestly, and cannot be talked out of
 * either. They establish nothing about whether Claude proposes this sequence,
 * and nothing about github.com. Those are separate claims with separate
 * evidence, and the Step 7 report keeps them apart.
 */

import { describe, expect, it } from 'vitest';
import { createHarness } from './support/agent-harness.js';
import { githubIssueSite } from './support/fake-site.js';
import { ScriptedBrain, pageTextOf, refFor, verificationOf, type Step } from './support/scripted-brain.js';

const ISSUES = 'https://github.com/axon/demo/issues';
const DRAFT =
  "Thanks for the clarification — I'm on 0.4.2 as well. " +
  'Passing the timeout explicitly fixes it on my side too.';

/**
 * The flagship plan.
 *
 * Written as an agent, not a macro: every reference it acts on is one it read
 * out of the previous result. A plan that hardcoded "e3" would keep passing
 * after references stopped meaning anything, which is precisely the bug the
 * stale-reference work exists to catch.
 */
function flagshipPlan(options: { draft?: string } = {}): Step[] {
  const draft = options.draft ?? DRAFT;

  return [
    { kind: 'plan', summary: 'Looking at your open issues', steps: ['browser.open'] },
    { kind: 'call', tool: 'browser.open', input: { url: ISSUES } },

    // Find the issue by its text, then follow the link.
    {
      kind: 'decide',
      next: (results) => {
        const ref = refFor(results.at(-1), 'Timeout is ignored');
        return ref ? { kind: 'call', tool: 'browser.click', input: { ref } } : { kind: 'say', text: 'I could not find that issue.' };
      },
    },

    // Read the issue page: the maintainer's reply is in this reading.
    { kind: 'call', tool: 'browser.read', input: {} },

    // Put the draft in the comment box. Filling a visible field sends nothing.
    {
      kind: 'decide',
      next: (results) => {
        const ref = refFor(results.at(-1), 'Add a comment', 'textbox');
        return ref
          ? { kind: 'call', tool: 'browser.type', input: { ref, text: draft, submit: false } }
          : { kind: 'say', text: 'I could not find the comment box.' };
      },
    },

    // Submit it. THIS is the act that needs the user, and it is a separate
    // call from the one that wrote the text.
    {
      kind: 'decide',
      next: (results) => {
        // The BUTTON labelled "Comment", not the box labelled "Add a
        // comment" — naming the role is how the plan says which it means.
        const ref = refFor(results.at(-1), 'Comment', 'button');
        return ref
          ? { kind: 'call', tool: 'browser.click', input: { ref } }
          : { kind: 'say', text: 'I could not find the comment button.' };
      },
    },

    // What Axon says is decided from the verification, not from optimism.
    {
      kind: 'decide',
      next: (results) => {
        const verified = verificationOf(results.at(-1));
        const last = results.at(-1);
        if (last && !last.ok) {
          return { kind: 'say', text: `I did not send it. ${last.failure.message}` };
        }
        return verified?.changed === true
          ? { kind: 'say', text: 'Done. The response was submitted successfully.' }
          : { kind: 'say', text: 'I clicked Comment, but the page did not change, so I cannot confirm it posted.' };
      },
    },
  ];
}

describe('the flagship workflow, approved', () => {
  it('walks the whole path and only asks about the submission', async () => {
    const site = githubIssueSite();
    const brain = new ScriptedBrain({ steps: flagshipPlan() });
    const h = createHarness({ site, brain });

    await h.send(
      'Axon, check my GitHub issue from yesterday, see if the maintainer replied, ' +
        'summarize what they said, draft a response, and ask me before sending.',
      'voice',
    );

    // 1-2: the utterance became a normal user message, marked as voice.
    const said = h.eventsOfType('USER_MESSAGE');
    expect(said).toHaveLength(1);
    expect(said[0]?.source).toBe('voice');

    // 5-6: a real page was opened and observed through the real dispatcher.
    expect(site.calls).toContain(`open:${ISSUES}`);

    // 7-8: the issue was located and the maintainer's reply was actually read.
    const reads = brain.results.filter((result) => result.ok);
    const issueRead = reads.find((result) => pageTextOf(result).includes('maintainer commented'));
    expect(issueRead, 'the maintainer comment should have been observed').toBeTruthy();
    expect(pageTextOf(issueRead)).toContain('pass the timeout explicitly');

    // 10-11: exactly one approval, and it is the submission — not the
    // navigation, not the reading, not the drafting.
    expect(h.approvals).toHaveLength(1);
    const approval = h.approvals[0]!;
    expect(approval.tool).toBe('browser.click');
    expect(approval.binding.effect).toBe('EXTERNAL');

    // 11: the user was shown where it lands.
    expect(approval.binding.target).toContain('/axon/demo/issues/41');

    // 14-16: nothing was submitted before the approval, and exactly one
    // comment exists afterwards.
    expect(site.comments).toEqual([DRAFT]);

    // 17-18: the submission was verified against the page, not assumed.
    const submit = brain.results.at(-1);
    expect(submit?.ok).toBe(true);
    expect(verificationOf(submit)?.changed).toBe(true);

    // 20: and what Axon said follows from that verification.
    const spoken = h.eventsOfType('ASSISTANT_MESSAGE').at(-1);
    expect(spoken?.text).toBe('Done. The response was submitted successfully.');

    // The turn completed and the machine came to rest.
    expect(h.eventsOfType('COMPLETED')).toHaveLength(1);
    expect(h.orchestrator.state).toBe('IDLE');
  });

  it('shows the user the exact text before it is sent', async () => {
    // The dialog is the whole product at this moment. A user cannot consent to
    // text they were not shown, so the draft must be in the request verbatim.
    const site = githubIssueSite();
    const h = createHarness({ site, brain: new ScriptedBrain({ steps: flagshipPlan() }) });

    await h.send('reply to the maintainer');

    const approval = h.approvals[0]!;
    const shown = approval.parameters.map((parameter) => `${parameter.label}: ${parameter.value}`).join('\n');

    // What will happen, where, and what it says.
    expect(approval.title).toMatch(/click "Comment"/i);
    expect(shown).toContain('github.com/axon/demo/issues/41');
    expect(approval.binding.action).toBe('click something on a web page');
    expect(approval.risk).toBe('REQUIRES_APPROVAL');

    // The draft itself reached the field before the approval was raised, which
    // is what makes it visible in the browser window the user is watching.
    expect(site.comments).toEqual([DRAFT]);
  });

  it('passes through the states a user can follow', async () => {
    const site = githubIssueSite();
    const h = createHarness({ site, brain: new ScriptedBrain({ steps: flagshipPlan() }) });

    await h.send('reply to the maintainer');

    const states = h.eventsOfType('STATE_CHANGED').map((event) => event.to);
    expect(states[0]).toBe('THINKING');
    expect(states).toContain('EXECUTING');
    expect(states).toContain('WAITING_FOR_APPROVAL');
    expect(states.at(-1)).toBe('IDLE');

    // Every timeline row corresponds to something that really happened: one
    // TOOL_CALL and one TOOL_RESULT per dispatch, never an orphan.
    const calls = h.eventsOfType('TOOL_CALL');
    const results = h.eventsOfType('TOOL_RESULT');
    expect(results.map((result) => result.callId).sort()).toEqual(calls.map((call) => call.callId).sort());
  });
});

describe('the flagship workflow, denied', () => {
  it('does not submit, and says so', async () => {
    const site = githubIssueSite();
    const brain = new ScriptedBrain({ steps: flagshipPlan() });
    const h = createHarness({ site, brain, decide: () => 'DENY' });

    await h.send('reply to the maintainer, but ask me first');

    // The one thing that matters.
    expect(site.comments).toEqual([]);

    const submit = brain.results.at(-1);
    expect(submit?.ok).toBe(false);
    if (submit?.ok !== false) throw new Error('unreachable');
    expect(submit.failure.kind).toBe('DENIED');

    // And Axon reports the denial rather than narrating a success.
    const spoken = h.eventsOfType('ASSISTANT_MESSAGE').at(-1);
    expect(spoken?.text).toMatch(/did not send/i);
    expect(spoken?.text).not.toMatch(/submitted successfully/i);

    const resolved = h.eventsOfType('APPROVAL_RESOLVED');
    expect(resolved).toHaveLength(1);
    expect(resolved[0]?.decision).toBe('DENY');
    expect(resolved[0]?.resolvedBy).toBe('user');
  });

  it('denies by default when nobody answers', async () => {
    // An approval nobody answers must not become an approval. It is the
    // failure mode where a user walks away and comes back to a posted comment.
    const site = githubIssueSite();
    const brain = new ScriptedBrain({ steps: flagshipPlan() });
    const h = createHarness({ site, brain, approvalTimeoutMs: 80, decide: () => null });

    await h.send('reply to the maintainer');

    expect(site.comments).toEqual([]);
    const submit = brain.results.at(-1);
    expect(submit?.ok).toBe(false);
    if (submit?.ok !== false) throw new Error('unreachable');
    expect(submit.failure.kind).toBe('APPROVAL_TIMEOUT');
    expect(h.eventsOfType('APPROVAL_RESOLVED')[0]?.resolvedBy).toBe('timeout');
  });
});

describe('the flagship workflow, interrupted', () => {
  it('submits nothing when the user cancels before approving', async () => {
    const site = githubIssueSite();
    const brain = new ScriptedBrain({ steps: flagshipPlan() });

    // Cancel the moment the approval appears — the realistic case, because the
    // dialog is when the user learns what Axon is about to do.
    const h = createHarness({
      site,
      brain,
      approvalTimeoutMs: 5_000,
      decide: () => null,
    });

    h.bus.subscribe((event) => {
      if (event.type === 'APPROVAL_REQUIRED') {
        setTimeout(() => h.orchestrator.cancelTurn('User stopped it'), 1);
      }
    });

    const accepted = h.orchestrator.sendUserMessage('reply to the maintainer');
    expect(accepted.accepted).toBe(true);
    await h.settled();

    expect(site.comments).toEqual([]);
  });
});

describe('the workflow does not invent success', () => {
  it('reports honestly when the click changes nothing', async () => {
    // The failure this whole verification mechanism exists for: the executor
    // returns normally, and nothing happened. A site whose Comment button is
    // broken looks, to a naive agent, exactly like one that worked.
    const site = githubIssueSite();

    // Make the submit a no-op, as a disabled button or a rejected POST would.
    const brain = new ScriptedBrain({
      steps: [
        { kind: 'call', tool: 'browser.open', input: { url: `${ISSUES}/41` } },
        {
          kind: 'decide',
          next: (results) => {
            const ref = refFor(results.at(-1), 'Close issue', 'button');
            return ref ? { kind: 'call', tool: 'browser.click', input: { ref } } : null;
          },
        },
        {
          kind: 'decide',
          next: (results) => {
            const verified = verificationOf(results.at(-1));
            return {
              kind: 'say',
              text:
                verified?.changed === true
                  ? 'Done.'
                  : 'I clicked it, but nothing on the page changed, so I cannot confirm it worked.',
            };
          },
        },
      ],
    });

    const h = createHarness({ site, brain });
    await h.send('close the issue');

    // "Close issue" submits and does nothing observable in this fixture.
    const verified = verificationOf(brain.results.at(-1));
    expect(verified?.changed).toBe(false);
    expect(String(verified?.summary)).toMatch(/nothing observable changed/i);

    const spoken = h.eventsOfType('ASSISTANT_MESSAGE').at(-1);
    expect(spoken?.text).toMatch(/cannot confirm/i);
  });
});
