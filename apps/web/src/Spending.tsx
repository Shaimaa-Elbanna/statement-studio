import { categoryLabels, kindLabels, type SpendingAnalysis } from '@statement/shared';

const money = (amount: string, currency: string) => `${Number(amount).toLocaleString(undefined, { maximumFractionDigits: 8 })} ${currency}`;
export default function Spending({ data }: { data: SpendingAnalysis }) {
  return <section className="spending-section" aria-label="Spending analysis">
    <div className="section-title"><div><span className="eyebrow">WHERE YOUR MONEY GOES</span><h2>Spending analysis</h2></div><span className="pill">{data.reviewCount} entries to review</span></div>
    <p className="footnote">Categories suggested through OpenRouter, with any saved user corrections. Gross purchases, bills and fees. Transfers, cash withdrawals and debt repayments are shown separately. Refunds are not subtracted without matching them to a purchase.</p>
    {data.summaries.map(group => <div className="spending-card" key={group.currency}>
      <div className="section-title"><div><small className="eyebrow">{group.currency} · {group.partial ? 'PROVISIONAL TOTALS' : 'CLASSIFIED SPENDING'}</small><h3 className="spending-total">{money(group.totalSpending, group.currency)}</h3><p>{group.expenseCount} spending transactions</p></div><span className="pill">{group.categories[0] ? `Top category: ${group.categories[0].category === 'uncategorized' ? 'Uncategorized' : categoryLabels[group.categories[0].category]}` : 'No confirmed spending yet'}</span></div>
      <div className="spending-grid">
        <div><h3>By category</h3>{group.categories.length ? group.categories.map(row => <div className="category-row" key={row.category}>
          <div><span>{row.category === 'uncategorized' ? 'Uncategorized' : categoryLabels[row.category]}</span><strong>{money(row.total, group.currency)}</strong></div>
          <div className="category-track"><div style={{ width: `${Math.min(100, Number(row.percentage))}%` }} /></div>
          <small>{row.percentage}% · {row.count} transactions</small>
        </div>) : <p className="footnote">Assign spending categories to eligible transactions to see a breakdown.</p>}</div>
        <div><h3>By month</h3>{group.months.length ? <ul className="monthly-list">{group.months.map(row => <li key={row.month}><span>{row.month === 'undated' ? 'Date unavailable' : row.month}</span><strong>{money(row.total, group.currency)}</strong></li>)}</ul> : <p className="footnote">No categorized spending to show.</p>}
          <div className="excluded-spending"><h3>Outside spending totals</h3>{group.excluded.filter(row => row.totalOut !== '0').map(row => <p key={row.kind}><span>{kindLabels[row.kind]}{row.kind === 'unknown' ? ' / needs review' : ''}</span><strong>{money(row.totalOut, group.currency)}</strong></p>)}<p><span>Refunds received</span><strong>{money(group.refunds, group.currency)}</strong></p></div>
        </div>
      </div>
    </div>)}
    {!data.summaries.length && <p className="notice">No spending totals are available. Review the extracted amounts, currencies and categories.</p>}
    <p className="footnote">{data.excludedTransactionCount} non-spending or unresolved transactions excluded. Currencies are kept separate. Totals cover this statement only.</p>
    {data.issues.length > 0 && <details className="spending-issues"><summary>Spending review notes ({data.issues.length})</summary><ul>{data.issues.map((issue, i) => <li key={i}>{issue}</li>)}</ul></details>}
  </section>;
}
