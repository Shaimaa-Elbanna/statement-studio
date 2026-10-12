import type { Statement } from '@statement/shared';

// Preview the saved extraction directly, before any inferred categories or spending totals.
const amount = (value: string | null, currency: string | null) => value === null ? 'Not available' : `${value}${currency ? ` ${currency}` : ''}`;
export default function ParsedPreview({ statement }: { statement: Statement }) {
  return <div className="parsed-preview" aria-label="Parsed statement data">
    {!statement.isBankStatement && <p className="notice">This document was not identified as a bank statement. Review the extracted JSON before continuing.</p>}
    <dl className="parsed-metadata">
      <div><dt>Bank</dt><dd>{statement.bankName || 'Not available'}</dd></div>
      <div><dt>Account holder</dt><dd>{statement.accountHolder || 'Not available'}</dd></div>
      <div><dt>Statement period</dt><dd>{statement.periodStart || 'Unknown start'} — {statement.periodEnd || 'Unknown end'}</dd></div>
    </dl>
    <h3>Accounts from the statement</h3>
    {statement.accounts.length ? <div className="table-wrap"><table><thead><tr><th>Account</th><th>Type</th><th>Currency</th><th>Opening balance</th><th>Closing balance</th></tr></thead><tbody>{statement.accounts.map((account, index) => <tr key={`${account.id}-${index}`}><td>{account.lastFour ? `···· ${account.lastFour}` : account.id}</td><td>{account.accountType || 'Not available'}{account.extraFields.length > 0 && <details><summary>Additional details</summary>{account.extraFields.map((field, i) => <p key={i}>{field.label}: {field.value}</p>)}</details>}</td><td>{account.currency || 'Not available'}</td><td>{amount(account.openingBalance, account.currency)}</td><td>{amount(account.closingBalance, account.currency)}</td></tr>)}</tbody></table></div> : <p className="notice">No account details could be extracted.</p>}
    {statement.extraFields.length > 0 && <details><summary>Additional statement fields</summary><dl>{statement.extraFields.map((field, i) => <div key={i}><dt>{field.label}</dt><dd>{field.value}</dd></div>)}</dl></details>}
    <p className="footnote">Verify these account details against your statement before starting spending analysis. Missing values are shown explicitly.</p>
  </div>;
}
