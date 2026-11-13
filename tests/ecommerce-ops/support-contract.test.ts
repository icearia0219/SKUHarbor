import { describe, expect, it } from 'vitest';
import {
  prepareSupportContext,
  validateSupportDraft,
  type SupportDraftPayload,
  type SupportInput,
} from '../../src/ecommerce-ops/tasks/support.js';

const input = (): SupportInput => ({
  workspace_id: 'web:support-contract',
  market: 'US',
  locale: 'en-US',
  as_of: '2026-11-12T10:00:00Z',
  ticket: {
    ticket_id: 'contract-ticket',
    workspace_id: 'web:support-contract',
    text: 'Please review my refund request.',
  },
  order: {
    workspace_id: 'web:support-contract',
    ownership_verified: true,
    observed_at: '2026-11-12T08:00:00Z',
    valid_until: '2026-11-13T08:00:00Z',
    evidence_refs: ['contract-order-e1'],
    refund: { state: 'requested' },
  },
  policy: {
    workspace_id: 'web:support-contract',
    market: 'US',
    approved: true,
    effective_from: '2026-01-01T00:00:00Z',
    effective_to: null,
    known_at: '2026-01-01T00:00:00Z',
    evidence_refs: ['contract-policy-e1'],
  },
});

const draft = (
  patch: Partial<SupportDraftPayload> = {},
): SupportDraftPayload => ({
  ticket_id: 'contract-ticket',
  intent: 'refund_request',
  action: 'reply_draft',
  reply_body: 'We will ask a human to review your request.',
  order_evidence_refs: ['contract-order-e1'],
  internal_notes_zh: ['仅为待人工审核的草稿。'],
  ...patch,
});

describe('support date and completed handoff contracts', () => {
  it.each(['2026-11-12', '2026-11-13', '2024-02-29', '2000-02-29'])(
    'preserves the valid ISO date %s in minimized model data',
    (date) => {
      const value = input();
      value.ticket.text = `Please review my request dated ${date}.`;
      const context = prepareSupportContext(value);
      expect(context.model_context.ticket_text).toContain(date);
    },
  );

  it.each(['2026-11-12', '2026-11-13', '2024-02-29', '2000-02-29'])(
    'allows the valid ISO date %s in draft notes without a PII false positive',
    (date) => {
      expect(
        validateSupportDraft(
          draft({ internal_notes_zh: [`订单摘要日期为${date}，需人工审核。`] }),
          prepareSupportContext(input()),
        ),
      ).toEqual([]);
    },
  );

  it.each([
    '2026-02-29',
    '2026-11-31',
    '1900-02-29',
    '2026-13-12',
    '2026-11-00',
    '20261112',
    '2026-11-12-1234',
    '+1 2026-11-12',
    'AB2026-11-12CD',
    '+1 202 555 0199',
    '+49 30 12345678',
    'buyer@example.com',
  ])('continues minimizing and rejecting the identifier %s', (identifier) => {
    const value = input();
    value.ticket.text = `Please review my request. Contact: ${identifier}.`;
    const context = prepareSupportContext(value);
    expect(context.model_context.ticket_text).not.toContain(identifier);
    expect(
      validateSupportDraft(
        draft({ internal_notes_zh: [`联系信息：${identifier}`] }),
        context,
      ).map((issue) => issue.code),
    ).toContain('SUPPORT_PII');
  });

  it('keeps explicit date-shaped PII redacted and protected by the local hash guard', () => {
    const value = input();
    value.ticket.pii = { order_id: '2026-11-12', name: 'Lena Buyer' };
    value.ticket.text = 'Order 2026-11-12 belongs to Lena Buyer.';
    const context = prepareSupportContext(value);
    expect(context.model_context.ticket_text).not.toContain('2026-11-12');
    expect(context.model_context.ticket_text).not.toContain('Lena Buyer');
    for (const reply_body of ['Order 2026-11-12.', 'Hello LENA BUYER.'])
      expect(
        validateSupportDraft(draft({ reply_body }), context).map(
          (issue) => issue.code,
        ),
      ).toContain('SUPPORT_PII');
  });

  it.each([
    'We have forwarded your case.',
    'We have escalated your case.',
    'We escalated your request to a human.',
    "We've already logged your complaint.",
    'I have registered your ticket.',
    'We have sent your message to the platform.',
    'We have contacted the platform.',
    'Wir haben Ihren Fall erfasst und weitergeleitet.',
    'Wir haben Ihre Anfrage an das Team eskaliert.',
    'Ich habe die Plattform kontaktiert.',
    'Wir haben Ihre Nachricht an die Plattform verschickt.',
    '我们已登记您的工单。',
    '我们已将您的工单转交给人工。',
    '我们已经联系平台。',
  ])('rejects a claimed completed handoff: %s', (reply_body) => {
    expect(
      validateSupportDraft(
        draft({ reply_body }),
        prepareSupportContext(input()),
      ).map((issue) => issue.code),
    ).toContain('UNSUPPORTED_HANDOFF_EFFECT');
  });

  it('keeps the existing message-send guard blocking German sent-message claims', () => {
    expect(
      validateSupportDraft(
        draft({ reply_body: 'Wir haben Ihre Nachricht gesendet.' }),
        prepareSupportContext(input()),
      ).map((issue) => issue.code),
    ).toContain('UNSUPPORTED_MESSAGE_EFFECT');
  });

  it.each([
    'We will ask a human to review your case.',
    'We have received your request. A human will review it.',
    'We have not forwarded your case.',
    'We have not yet contacted the platform.',
    'We will contact the platform after a human approves this draft.',
    'Wir werden einen Menschen bitten, Ihren Fall zu prüfen.',
    'Wir haben Ihren Fall noch nicht weitergeleitet.',
    'Wir haben die Plattform nicht kontaktiert.',
    'Wir haben Ihre Nachricht noch nicht an die Plattform verschickt.',
    '我们将请人工审核该请求。',
    '我们尚未转交您的工单。',
  ])('allows a pending, future or negated handoff: %s', (reply_body) => {
    expect(
      validateSupportDraft(
        draft({ reply_body }),
        prepareSupportContext(input()),
      ),
    ).toEqual([]);
  });

  it('does not treat a verified refund receipt as evidence of a completed handoff', () => {
    const value = input();
    value.order!.refund = {
      state: 'completed',
      receipt: {
        id: 'contract-refund-receipt',
        verified: true,
        evidence_ref: 'contract-order-e1',
        completed_at: '2026-11-12T09:00:00Z',
      },
    };
    const context = prepareSupportContext(value);
    expect(
      validateSupportDraft(
        draft({ reply_body: 'Your refund has been processed.' }),
        context,
      ),
    ).toEqual([]);
    expect(
      validateSupportDraft(
        draft({
          reply_body:
            'Your refund has been processed. We have forwarded your case.',
        }),
        context,
      ).map((issue) => issue.code),
    ).toContain('UNSUPPORTED_HANDOFF_EFFECT');
  });

  it.each([
    'We have sent your replacement.',
    'Wir haben den Ersatz verschickt.',
    'Wir haben den Ersatz versandt.',
  ])('preserves verified replacement completion: %s', (reply_body) => {
    const value = input();
    value.order!.replacement = {
      state: 'completed',
      receipt: {
        id: 'contract-replacement-receipt',
        verified: true,
        evidence_ref: 'contract-order-e1',
        completed_at: '2026-11-12T09:00:00Z',
      },
    };
    expect(
      validateSupportDraft(draft({ reply_body }), prepareSupportContext(value)),
    ).toEqual([]);
  });

  it('still enforces needs_info and escalate branches with date-bearing notes', () => {
    const stale = input();
    stale.order!.valid_until = '2026-11-11T10:00:00Z';
    const notes = { internal_notes_zh: ['订单日期2026-11-12，等待人工补料。'] };
    const staleContext = prepareSupportContext(stale);
    expect(staleContext.action).toBe('needs_info');
    expect(
      validateSupportDraft(draft(notes), staleContext).map(
        (issue) => issue.code,
      ),
    ).toContain('REQUIRED_SUPPORT_BRANCH');
    expect(
      validateSupportDraft(
        draft({ ...notes, action: 'needs_info', order_evidence_refs: [] }),
        staleContext,
      ),
    ).toEqual([]);
    const danger = input();
    danger.ticket.text = 'The unit emitted smoke.';
    const dangerContext = prepareSupportContext(danger);
    expect(dangerContext.action).toBe('escalate');
    expect(
      validateSupportDraft(draft(notes), dangerContext).map(
        (issue) => issue.code,
      ),
    ).toContain('REQUIRED_SUPPORT_BRANCH');
    expect(
      validateSupportDraft(
        draft({ ...notes, action: 'escalate' }),
        dangerContext,
      ),
    ).toEqual([]);
  });
});
