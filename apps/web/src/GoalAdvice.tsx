import { useEffect, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import type { GoalAdvice as Advice } from '@statement/shared';

export default function GoalAdvice({ uploadId, busy, analysisVersion }: { uploadId: string; busy: boolean; analysisVersion: string }) {
  const [goal, setGoal] = useState('');
  const advice = useMutation({
    mutationFn: async (submittedGoal: string): Promise<Advice> => {
      const response = await fetch(`/api/uploads/${uploadId}/goal-advice`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ goal: submittedGoal })
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Could not get goal advice. Try again.');
      return body;
    }
  });
  const resetAdvice = advice.reset;
  useEffect(() => { resetAdvice(); }, [analysisVersion, resetAdvice]);
  const current = advice.variables === goal.trim();
  return <section className="goal-advice" aria-label="Financial goal advice">
    <h2>Plan toward your goal</h2>
    <p>Tell us what you want to achieve. AI will use your spending analysis and category corrections to suggest a plan.</p>
    <form onSubmit={e => { e.preventDefault(); if (!busy && !advice.isPending && goal.trim().length >= 3) advice.mutate(goal.trim()); }}>
      <label htmlFor="financial-goal">Your goal</label>
      <textarea id="financial-goal" value={goal} onChange={e => setGoal(e.target.value)} maxLength={2000} rows={3} placeholder="For example: Save 30,000 EGP over the next six months for an emergency fund. I already have 5,000 EGP saved." required minLength={3} />
      <div className="upload-footer"><small>Include an amount, currency, deadline and existing savings if you can.</small><button className="primary" disabled={busy || advice.isPending || goal.trim().length < 3}>{advice.isPending ? 'Preparing advice…' : 'Get goal advice →'}</button></div>
    </form>
    <div aria-live="polite">
      {advice.isPending && <p className="notice">Reviewing your goal against the saved spending analysis…</p>}
      {current && advice.error && <p className="error" role="alert">{advice.error.message}</p>}
      {current && advice.data && <div className="goal-plan"><h3>Your suggested plan</h3><p>{advice.data.summary}</p><p>{advice.data.feasibility}</p>
        <ol>{advice.data.actions.map((action, index) => <li key={index}><strong>{action.title}</strong><p>{action.recommendation}</p><small>{action.evidence}</small></li>)}</ol>
        {advice.data.assumptions.length > 0 && <><h3>Assumptions and limits</h3><ul>{advice.data.assumptions.map((item, i) => <li key={i}>{item}</li>)}</ul></>}
        {advice.data.questions.length > 0 && <><h3>Details to refine your plan</h3><ul>{advice.data.questions.map((item, i) => <li key={i}>{item}</li>)}</ul></>}
      </div>}
    </div>
  </section>;
}
