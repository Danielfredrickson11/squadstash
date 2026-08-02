# SquadStash Master Product, Financial and Technical Specification

**Document version:** 2.0  
**Product stage:** Existing prototype transitioning into an embedded-finance platform  
**Initial market:** United States  
**Initial eligible users:** Adults age 18 and older  
**Platforms:** iOS and Android  
**Primary client technology:** React Native, Expo and TypeScript  
**Primary infrastructure:** Firebase, secure backend services, relational financial ledger and an authorized banking or embedded-finance partner  
**Document purpose:** Define the complete product vision, financial-account model, user experience, technical architecture, security controls, operating requirements and release plan for SquadStash.

---

# 1. Executive Product Summary

## 1.1 Product Name

**SquadStash**

## 1.2 Product Description

SquadStash is a mobile savings, trip-funding and group-money-management platform that helps individuals and groups securely save, contribute, spend and settle real money for personal goals, trips and shared experiences.

Eligible users will be able to:

- Create a SquadStash account.
- Complete identity verification.
- Connect an eligible external bank account.
- Transfer money into and out of SquadStash.
- Allocate personal funds among savings buckets.
- Create or join group trips.
- Contribute money to a controlled trip wallet.
- Track each member’s contribution and ownership position.
- Pay approved trip expenses.
- Reimburse members.
- Split expenses.
- Resolve disputes.
- Return unused funds.
- Complete final settlement.

SquadStash will not independently hold customer funds in Firebase or an ordinary company bank account. Actual customer funds must be held and moved through accounts and payment infrastructure provided by an authorized bank, payment provider or embedded-finance partner.

SquadStash’s internal systems will maintain:

- User permissions.
- Personal bucket allocations.
- Trip ownership records.
- Financial ledger entries.
- Transfer instructions.
- Expense allocations.
- Manager authorizations.
- Transaction status.
- Reconciliation records.
- Audit history.

The financial partner will remain authoritative for:

- Actual account status.
- Available cash.
- Settled cash.
- ACH transfers.
- Card transactions.
- Holds.
- Returns.
- Reversals.
- Disputes.
- Account restrictions.
- Regulatory freezes.

SquadStash must reconcile its internal financial ledger against the partner’s records and must never create or modify a user-facing balance without an underlying balanced ledger transaction.

## 1.3 Core Value Proposition

SquadStash gives individuals and groups one transparent place to answer:

- How much money have I saved?
- Where is my money allocated?
- How much is available to withdraw?
- How much is committed to a trip?
- Who contributed each portion of the group fund?
- Who is permitted to spend the group fund?
- What has the manager spent?
- How was each expense divided?
- Who owes money?
- Who should receive money?
- How much unused money will be returned?
- Is the group on pace to reach its goal?

## 1.4 Product Vision

SquadStash should become the trusted financial operating system for shared experiences.

The long-term platform may serve:

- Group trips.
- Couples.
- Roommates.
- Families.
- Wedding parties.
- Clubs.
- Recreational teams.
- Group events.
- Shared household goals.
- Other approved collaborative savings use cases.

The initial public product must remain focused on personal savings buckets and group trips.

## 1.5 Product Positioning

SquadStash is a financial technology platform and not a bank.

All deposit, account, card or money-transmission services must identify the regulated institution or partner providing those services.

SquadStash must not claim:

- That SquadStash itself is an FDIC-insured bank.
- That all displayed money is immediately available.
- That pending transfers are settled money.
- That every balance automatically qualifies for deposit insurance.
- That a trip manager owns members’ contributions.
- That SquadStash provides investment or professional financial advice.

---

# 2. Product Goals

## 2.1 User Goals

SquadStash must allow a user to:

- Securely establish a verified financial profile.
- Link an external bank account.
- Deposit and withdraw money.
- Create personal savings goals.
- Separate money into understandable bucket balances.
- Create or join a shared trip.
- Contribute real money to the trip.
- Retain visibility into contributed funds.
- Understand when funds become committed.
- See every expense affecting their contribution.
- Dispute unauthorized or incorrect activity.
- Receive unused money when a trip closes.

## 2.2 Group Goals

SquadStash must allow a group to:

- Establish a trip goal and budget.
- Agree on contribution expectations.
- Collect contributions.
- Track pending and available money.
- Assign controlled spending authority.
- Pay trip-related expenses.
- Split expenses fairly.
- Approve or dispute material transactions.
- Reimburse members.
- Return unused funds.
- Complete a documented settlement.

## 2.3 Business Goals

SquadStash should:

- Build trust through transparent money controls.
- Generate recurring subscription revenue.
- Potentially generate permitted card-related or transfer-related revenue through financial partners.
- Maintain a useful free tier.
- Scale without rebuilding its financial core.
- Minimize regulatory and operational risk.
- Avoid becoming dependent on one infrastructure provider.
- Support expansion into additional shared-money use cases.
- Maintain a complete and defensible audit history.

## 2.4 Success Metrics

Product success should be measured using:

- Verified user count.
- Bank-link completion rate.
- First-deposit completion rate.
- Personal bucket creation rate.
- Trip creation rate.
- Trip-join rate.
- Percentage of trips with multiple funded members.
- Total successfully settled transfer volume.
- ACH return rate.
- Unauthorized-transaction report rate.
- Reconciliation exception count.
- Support contact rate.
- Trip settlement completion rate.
- Weekly and monthly active users.
- Subscription conversion.
- Retention.
- Crash-free session rate.
- Security-event rate.
- Customer satisfaction.
- Complaint-resolution time.

Exact financial amounts should not be included in general analytics unless required and properly protected.

---

# 3. Product Principles

## 3.1 User Ownership

A user must always be able to understand:

- Which funds belong to them.
- Which funds are merely pending.
- Which funds are committed.
- Which funds were spent.
- Which funds remain refundable.
- Which person authorized each transaction.

## 3.2 Manager Authority Is Not Ownership

A trip manager may receive spending and administrative authority, but does not automatically own other members’ money.

## 3.3 No Balance Without a Ledger Entry

Every financial balance must be derived from balanced ledger entries.

No developer, administrator, screen or Firebase document may directly overwrite a financial balance.

## 3.4 Partner-Confirmed Money Movement

A transfer must not be considered settled solely because a user tapped a button.

Transfer status must be updated from server-side partner confirmations.

## 3.5 Financial Clarity

Pending, available, committed, spent, disputed, frozen and settled balances must be visually and conceptually distinct.

## 3.6 Least-Privilege Access

Users, managers, support personnel and administrators should receive only the access necessary for their role.

## 3.7 Security Before Convenience

High-risk financial actions may require:

- Reauthentication.
- Multi-factor authentication.
- Transaction confirmation.
- Waiting periods.
- Additional approval.
- Manual review.

## 3.8 Reversible Accounting

Confirmed financial records must not be silently deleted or overwritten.

Corrections must use:

- Reversals.
- Adjustments.
- Replacement entries.
- Complete audit history.

## 3.9 Transparent Restrictions

SquadStash must explain why money is:

- Pending.
- Unavailable.
- Frozen.
- Under review.
- Ineligible for withdrawal.
- Returned.
- Reversed.

## 3.10 Gradual Risk Expansion

SquadStash should begin with:

- United States users.
- USD.
- Adults.
- ACH funding.
- Conservative limits.
- Controlled trip spending.
- A limited pilot.

Additional countries, currencies and payment methods should be added only after the core platform is stable.

---

# 4. Regulatory and Legal Foundation

This specification is a product and technical plan, not legal advice.

Before enabling live money movement, SquadStash must retain qualified financial-services counsel and complete a written analysis covering:

- Federal money-services-business implications.
- State money-transmitter licensing.
- Sponsor-bank responsibilities.
- Bank Secrecy Act and anti-money-laundering responsibilities.
- Sanctions screening.
- Customer identification and identity verification.
- Electronic Fund Transfer Act and Regulation E.
- ACH authorization requirements.
- Privacy requirements.
- Gramm-Leach-Bliley Act implications.
- State privacy laws.
- Unclaimed-property requirements.
- Funds ownership.
- Deposit-insurance disclosures.
- Card-program requirements.
- Complaint handling.
- Record retention.
- Tax reporting.
- Subscription and fee disclosures.

## 4.1 Required Legal Entity

SquadStash must operate through a registered legal entity before live financial services are offered.

The application should not be submitted as an individual developer account once it operates as a regulated financial-services application.

## 4.2 Initial Market Restrictions

The first live-money release should be:

- United States only.
- USD only.
- Adults age 18 and older.
- Available only in approved states.
- Limited to eligible consumer accounts.
- Subject to identity verification and financial-partner approval.

## 4.3 Financial Partner Requirement

SquadStash must select an authorized partner capable of supporting the approved use case.

Required capabilities may include:

- Consumer identity verification.
- Financial-account creation.
- FBO or custodial account structures.
- Beneficial-owner recordkeeping.
- ACH debit and credit.
- Bank-account verification.
- Balance and transaction APIs.
- Transfer returns.
- Disputes.
- Account restrictions.
- Card issuing.
- Spending controls.
- Webhooks.
- Statements.
- Reconciliation data.
- Compliance reporting.
- Sandbox testing.
- Production support.

The product must remain provider-neutral until a partner contract and approved account structure are established.

---

# 5. User and Account Model

## 5.1 SquadStash User

A SquadStash user has:

- An application identity.
- Authentication credentials.
- A personal profile.
- A financial eligibility status.
- An identity-verification status.
- Zero or more linked external bank accounts.
- One or more partner financial-account references.
- Personal savings buckets.
- Trip memberships.
- Security and notification preferences.

## 5.2 Verified Financial User

A user becomes financially enabled only after all required steps are completed.

Possible statuses:

- `not_started`
- `information_required`
- `submitted`
- `pending_review`
- `verified`
- `restricted`
- `rejected`
- `suspended`
- `closed`

A user may use planning-only features before verification, but may not move real money.

## 5.3 Underlying User Financial Account

The preferred model is one partner-supported financial account or beneficial ownership position for each verified user.

The account may contain:

- Unallocated available funds.
- Funds allocated to personal buckets.
- Funds pending transfer.
- Funds reserved for withdrawal.
- Funds committed to trip wallets.

The exact legal structure must be approved by the financial partner.

## 5.4 Personal Buckets

Personal buckets should generally be internal ledger partitions rather than separate bank accounts.

Example:

- Available unallocated balance: $300.00
- Emergency bucket: $2,000.00
- Puerto Rico bucket: $750.00
- Rent bucket: $1,200.00

The total of all bucket allocations and unallocated funds must reconcile to the user’s applicable underlying available balance.

Moving money between the user’s own buckets is an internal ledger reallocation and does not require an external ACH transfer.

## 5.5 External Bank Accounts

A verified user may connect eligible external accounts.

Each linked account should store only provider references and safe display information, such as:

- Provider account token.
- Institution name.
- Account type.
- Account nickname.
- Last four digits.
- Verification status.
- Ownership-match status.
- Enabled transfer directions.
- Date linked.
- Date last used.

SquadStash should not store raw online-banking credentials.

## 5.6 User Statements

Users should receive or access:

- Transfer history.
- Bucket activity.
- Trip-wallet activity.
- Card activity.
- Fees.
- Adjustments.
- Returns.
- Monthly account statements when required.
- Annual tax documentation when applicable.

---

# 6. Trip Wallet Model

## 6.1 Trip Wallet Definition

A trip wallet is a controlled financial workspace associated with one trip.

It must track:

- Total member contributions.
- Pending contributions.
- Available contributed funds.
- Committed funds.
- Funds spent.
- Refundable funds.
- Reserved funds.
- Disputed funds.
- Returned funds.
- Each member’s remaining financial interest.

## 6.2 Legal and Operational Structure

The final trip-wallet structure may be:

- A partner-supported subaccount.
- A financial account associated with the trip manager under controlled terms.
- A pooled custodial account with a member-level subledger.
- Another sponsor-bank-approved structure.

SquadStash must not select the final structure based only on technical convenience.

## 6.3 Member Ownership Ledger

Every trip wallet must maintain a member-level ledger showing:

- Contributions.
- Contribution returns.
- Expense responsibility.
- Expenses personally paid.
- Reimbursements.
- Adjustments.
- Settlements.
- Remaining refundable interest.

Operational pooling must never remove the member-level accounting record.

## 6.4 Trip Wallet States

Supported states:

- `draft`
- `funding_open`
- `funding_locked`
- `active_spending`
- `spending_paused`
- `settling`
- `settled`
- `frozen`
- `canceled`
- `closed`

## 6.5 Trip Fund Stages

### Open Funding

Members may:

- Join.
- Review terms.
- Contribute.
- Cancel an eligible pending transfer.
- Withdraw eligible uncommitted funds.
- View the trip ledger.

### Committed Funding

After a defined lock date or member confirmation:

- Contributions become subject to the trip agreement.
- Withdrawals may require manager or group approval.
- Funds may be used only for approved trip purposes.
- Each change is recorded.

### Active Spending

Authorized managers may:

- Use a controlled trip card.
- Pay approved vendors.
- Reimburse approved members.
- Record and allocate expenses.

### Settlement

The group must:

- Stop new discretionary spending.
- Resolve pending transactions.
- Resolve disputes.
- Allocate final expenses.
- Distribute unused money.
- Complete reimbursements.
- Close the wallet.

---

# 7. Roles, Permissions and Governance

## 7.1 Trip Owner

The creator is initially the trip owner.

The owner may:

- Edit trip settings.
- Define the contribution plan.
- Invite members.
- Appoint managers.
- Configure spending rules.
- Propose expense splits.
- Initiate authorized payments.
- Pause spending.
- Begin settlement.
- Transfer ownership.
- Cancel the trip under applicable rules.

The owner may not:

- Treat all trip funds as personal property.
- Change another member’s ownership ledger without a valid transaction.
- Withdraw pooled funds to a personal account without a documented reimbursement, refund or settlement.
- Delete confirmed transactions.
- Conceal trip activity from members.

## 7.2 Trip Manager

A manager is an authorized operator.

Manager permissions may include:

- Viewing the wallet.
- Holding a trip card.
- Paying trip expenses.
- Uploading receipts.
- Proposing splits.
- Initiating reimbursements.
- Managing trip logistics.
- Pausing a card.

Manager permissions must be configurable and revocable.

## 7.3 Financial Approver

A trip may require a separate approver for certain actions.

Possible approval rules:

- One manager may approve ordinary expenses.
- Two authorized members must approve high-value transactions.
- A majority vote is required for non-budgeted spending.
- The affected member must approve a disputed allocation.
- Refunds to a manager require secondary approval.

## 7.4 Member

A member may:

- View trip terms.
- View relevant financial activity.
- Contribute money.
- Withdraw eligible uncommitted money.
- Record expenses they personally paid.
- Review proposed splits.
- Approve or dispute allocations.
- Receive reimbursements.
- Confirm settlement payments.
- Leave when no unresolved obligation remains.

## 7.5 Removed Member

A member may not be removed while unresolved financial obligations exist.

The application must first address:

- Remaining contributions.
- Expense responsibility.
- Reimbursements.
- Disputes.
- Refunds.
- Settlement.

Historical financial records must remain intact.

## 7.6 Ownership Transfer

Trip ownership transfer must:

- Require an eligible verified user.
- Require the incoming owner’s acceptance.
- Reevaluate cardholder and spending permissions.
- Be logged.
- Notify all members.
- Preserve the existing ledger.

---

# 8. Trip Cards and Spending Controls

## 8.1 Trip Card Purpose

A trip card allows an authorized person to spend available trip funds for approved trip expenses.

The trip card does not grant ownership of the trip wallet.

## 8.2 Initial Card Model

The preferred initial model is:

- One virtual trip card.
- Assigned to one verified manager.
- Limited to available settled trip funds.
- Controlled by category, amount, date and status.
- Capable of being immediately paused.

Physical cards may be added later.

## 8.3 Card Controls

Controls should include:

- Per-transaction limit.
- Daily limit.
- Total trip limit.
- Merchant-category restrictions.
- Geographic restrictions when supported.
- Start and expiration dates.
- Online or in-person controls.
- ATM disabled by default.
- Cash-equivalent purchases disabled.
- International use disabled by default.
- Manager-specific card permissions.
- Immediate card lock.

## 8.4 Card Transaction Workflow

A card transaction should create:

1. An authorization event.
2. A pending card transaction.
3. A reservation of trip funds.
4. A notification to members.
5. A request for receipt or categorization.
6. A settled transaction or reversed authorization.
7. A linked expense record.
8. A final allocation.

## 8.5 Unsupported Card Activity

SquadStash should block or flag:

- Cash withdrawals.
- Gambling.
- Person-to-person cash equivalents.
- Cryptocurrency purchases.
- Money orders.
- High-risk merchants.
- Purchases outside the trip’s configured period.
- Transactions exceeding available money.
- Transactions exceeding limits.

Final restrictions must align with partner requirements.

---

# 9. Bank Linking and Money Movement

## 9.1 Bank Linking

The app should use a secure partner-hosted or embedded account-linking experience.

A bank-link flow should:

- Identify the authenticated user.
- Display consent.
- Connect an eligible account.
- Verify account ownership.
- Return a token rather than credentials.
- Support relinking.
- Support removal where permitted.

## 9.2 Transfer Types

Supported transfer types may include:

- External bank to user account.
- User account to external bank.
- User balance to personal bucket.
- Personal bucket to unallocated balance.
- User balance to trip wallet.
- Personal bucket to trip wallet.
- Trip wallet to user account as refund.
- Trip wallet to member account as reimbursement.
- Trip wallet to vendor through card or approved payment rail.

## 9.3 ACH Transfer States

Supported states:

- `created`
- `authorization_required`
- `submitted`
- `processing`
- `pending`
- `available_with_hold`
- `settled`
- `failed`
- `returned`
- `canceled`
- `reversed`
- `under_review`

## 9.4 Availability

A transfer amount must not be labeled fully available until the partner indicates that it is available under the approved risk policy.

The interface must distinguish:

- Initiated.
- Pending.
- Available.
- Settled.
- Returned.

## 9.5 Transfer Authorization

Every external debit must have a valid authorization record containing:

- User.
- Funding account.
- Amount or permitted recurrence.
- Date.
- Authorization language version.
- Method of consent.
- IP and device context where appropriate.
- Revocation status.
- Provider reference.

## 9.6 Scheduled Contributions

Users may optionally schedule recurring contributions.

The user must be able to:

- Review the schedule.
- Modify future contributions.
- Pause the schedule.
- Cancel the schedule.
- Receive advance notice when required.
- See failed or returned transfers.

## 9.7 Transfer Limits

The risk system should support:

- Per-transfer limits.
- Daily limits.
- Weekly limits.
- Monthly limits.
- New-user limits.
- New-bank-account limits.
- Trip-wallet limits.
- Withdrawal limits.
- Manager-spending limits.

Limits should be configurable without an app update.

---

# 10. Personal Savings Buckets

## 10.1 Bucket Purpose

A bucket represents money allocated to a personal goal.

Examples:

- Emergency Fund.
- Rent.
- Canada Trip.
- Puerto Rico Trip.
- New Laptop.
- Car Repair.
- Entertainment.
- Custom Goal.

## 10.2 Create Bucket

Required:

- Name.
- Target amount.

Optional:

- Starting allocation.
- Category.
- Description.
- Target date.
- Image.
- Icon.
- Contribution schedule.
- Reminder.
- Priority.

## 10.3 Bucket Balances

Each bucket should display:

- Allocated balance.
- Pending incoming amount.
- Available amount.
- Reserved amount.
- Target amount.
- Remaining amount.
- Progress.
- Required contribution pace.

## 10.4 Bucket Funding

A bucket can be funded from:

- User’s unallocated SquadStash balance.
- A linked external bank account.
- A scheduled transfer.
- An eligible trip refund.
- Another personal bucket.

## 10.5 Bucket Withdrawal

A user may:

- Move available money to another bucket.
- Move available money to the unallocated balance.
- Withdraw eligible money to a verified bank account.
- Contribute eligible money to a trip wallet.

## 10.6 Bucket Calculations

All monetary values use integer cents.

`allocatedBalance = credits - debits`

`remainingAmount = max(targetAmount - allocatedBalance, 0)`

`progressPercentage = min(allocatedBalance / targetAmount, 1) × 100`

`requiredWeeklyContribution = remainingAmount / remainingEligibleWeeks`

The application must handle:

- Completed goals.
- Past target dates.
- Missing target dates.
- Negative adjustments.
- Frozen balances.
- Pending deposits.
- Returned deposits.

## 10.7 Bucket Statuses

- Active.
- Completed.
- Paused.
- Archived.
- Restricted.

## 10.8 Bucket Deletion

Buckets with financial history must be archived rather than deleted.

A never-funded bucket may be permanently deleted after confirmation.

---

# 11. Trips

## 11.1 Create Trip

Required:

- Trip name.
- Destination.
- Start date.
- End date.
- Target amount.
- Currency.
- Contribution terms.
- Spending-governance selection.

Optional:

- Description.
- Cover image.
- Contribution deadline.
- Suggested contribution.
- Budget categories.
- Member capacity.
- Default split method.
- Manager permissions.
- Approval threshold.

## 11.2 Trip List

Trip cards should display:

- Image.
- Name.
- Location.
- Dates.
- Status.
- Confirmed balance.
- Pending balance.
- Goal progress.
- User contribution.
- User role.
- Member count.
- Outstanding action.

## 11.3 Trip Detail Sections

### Overview

- Goal.
- Available trip money.
- Pending money.
- Spent amount.
- Remaining amount.
- Personal contribution position.
- Upcoming dates.
- Quick actions.

### Wallet

- Contributions.
- Withdrawals.
- Refunds.
- Available money.
- Holds.
- Member ownership positions.

### Budget

- Planned categories.
- Actual spending.
- Remaining budget.
- Over-budget alerts.

### Expenses

- Card expenses.
- Member-paid expenses.
- Group-fund expenses.
- Personal expenses.
- Receipts.
- Allocations.
- Disputes.

### Members

- Roles.
- Contributions.
- Outstanding actions.
- Approval status.
- Financial position.

### Settlements

- Reimbursements.
- Refunds.
- Outstanding obligations.
- Final distributions.

### Settings

- Wallet rules.
- Spending permissions.
- Card controls.
- Notifications.
- Ownership transfer.
- Pause, cancel or close trip.

---

# 12. Invitations and Joining

## 12.1 Invitation Methods

The initial product should support:

- Secure invitation links.
- Invitation codes.
- Direct invitations to existing users.

## 12.2 Pre-Join Disclosure

Before joining, a user must see:

- Trip name.
- Manager.
- Dates.
- Target.
- Expected contribution.
- Contribution deadline.
- Withdrawal and commitment rules.
- Spending authority.
- Approval model.
- Refund policy.
- Relevant fees.
- Partner disclosures.
- Trip agreement.

## 12.3 Acceptance

Joining requires affirmative acceptance of:

- Trip terms.
- Contribution rules.
- Expense-allocation rules.
- Manager authority.
- Refund and settlement terms.

The accepted terms version must be recorded.

## 12.4 Invitation Security

Invitations must:

- Be difficult to guess.
- Expire.
- Be revocable.
- Avoid exposing financial details before acceptance.
- Be validated by the backend.
- Prevent unauthorized reuse.

---

# 13. Contributions

## 13.1 Contribution Sources

A contribution may originate from:

- Available SquadStash balance.
- Personal bucket.
- Linked external bank account.
- Approved future funding method.

## 13.2 Contribution Statuses

- Scheduled.
- Initiated.
- Pending.
- Available.
- Committed.
- Spent.
- Partially returned.
- Returned.
- Failed.
- Reversed.
- Frozen.

## 13.3 Contribution Ownership

A contribution record must identify:

- Contributing user.
- Funding source.
- Amount.
- Transfer reference.
- Availability.
- Commitment status.
- Remaining member interest.
- Amount spent or allocated.
- Refund eligibility.

## 13.4 Commitment

Funds become committed according to the accepted trip terms.

Commitment may occur:

- Immediately.
- On a specified date.
- After member confirmation.
- After a trip threshold is reached.
- When spending begins.

The rule must be visible before contribution.

## 13.5 Contribution Correction

Confirmed contributions cannot be edited in place.

Corrections require:

- Reversal.
- Replacement.
- Adjustment.
- Audit event.

---

# 14. Expenses and Expense Splitting

## 14.1 Expense Types

- Shared group expense.
- Personal trip expense.
- Manager card expense.
- Member-paid reimbursable expense.
- Group-fund transfer.
- Refund or credit.
- Fee.

## 14.2 Payment Sources

An expense may be paid by:

- Trip card.
- Trip wallet.
- A member.
- A manager.
- An approved vendor-payment method.

## 14.3 Split Methods

The initial product should support:

- Equal split.
- Custom amount.
- Percentage.
- Shares or units.
- Single-member allocation.

## 14.4 Rounding

Currency must be stored in cents.

For equal splits:

1. Divide total cents by included members.
2. Assign the base amount.
3. Distribute remainder cents deterministically.
4. Verify that allocations exactly equal the expense total.

## 14.5 Proposed and Final Allocations

A manager may propose an allocation.

The system should distinguish:

- Proposed.
- Awaiting review.
- Approved.
- Disputed.
- Finalized.
- Reversed.

## 14.6 Expense Disputes

A member may dispute:

- Inclusion in an expense.
- Allocation amount.
- Duplicate expense.
- Incorrect amount.
- Unauthorized purchase.
- Missing refund.
- Personal purchase charged to the trip.

A dispute should:

- Preserve the original record.
- Freeze the disputed allocation when appropriate.
- Notify responsible parties.
- Track evidence.
- Record the resolution.
- Create adjustment entries rather than deleting history.

---

# 15. Reimbursements, Refunds and Settlement

## 15.1 Reimbursement

A member who personally paid an approved trip expense may receive money from the trip wallet.

The reimbursement must reference:

- Expense.
- Recipient.
- Amount.
- Approval.
- Payment status.
- Partner transfer.

## 15.2 Contribution Refund

A contribution refund returns eligible trip money to the contributing member.

The refund may be limited by:

- Money already spent.
- Commitment terms.
- Pending card authorizations.
- Disputes.
- Transfer holds.
- Trip cancellation terms.

## 15.3 Unused Funds

Before settlement, the trip must define how unused funds are handled.

Supported methods:

- Return proportionally according to remaining ownership.
- Return based on net contributions.
- Apply approved custom distribution.
- Preserve a documented reserve temporarily.

A manager cannot unilaterally claim unused funds.

## 15.4 Member Net Position

A member’s position should consider:

- Contributions.
- Contribution returns.
- Personally paid approved expenses.
- Allocated expense responsibility.
- Reimbursements received.
- Settlement payments.
- Remaining wallet interest.

The calculation must be centralized and tested.

## 15.5 Settlement Readiness

A trip may enter settlement when:

- Spending is stopped.
- Pending transfers are resolved.
- Pending card transactions are resolved.
- Expenses are categorized.
- Allocations are finalized.
- Disputes are resolved or formally reserved.
- Refund rules are selected.

## 15.6 Trip Closure

A trip can close only when:

- The financial partner reports no unresolved wallet transactions.
- The internal ledger is balanced.
- Reconciliation has no unresolved material discrepancy.
- Member positions are zero or documented.
- Unused money is distributed or legally retained.
- Cards are canceled.
- Required records are preserved.

---

# 16. Double-Entry Financial Ledger

## 16.1 Ledger Requirement

SquadStash must maintain a server-controlled double-entry ledger.

Every financial event must create equal debits and credits.

## 16.2 Ledger Accounts

Possible internal ledger account categories:

- Partner cash.
- User available balance.
- User pending balance.
- Personal bucket allocation.
- Trip available balance.
- Trip pending balance.
- Trip committed balance.
- Card authorization reserve.
- Reimbursement payable.
- Refund payable.
- Fee revenue.
- ACH return receivable.
- Loss reserve.
- Suspense.
- Reconciliation difference.

## 16.3 Ledger Entry Properties

Every entry should include:

- Entry ID.
- Transaction ID.
- Debit account.
- Credit account.
- Amount in cents.
- Currency.
- Effective timestamp.
- Created timestamp.
- Event type.
- User reference.
- Trip reference.
- Partner reference.
- Idempotency key.
- Reversal reference.
- Audit metadata.

## 16.4 Ledger Invariants

The system must enforce:

- Debits equal credits.
- Amount is positive.
- Currency matches.
- Entries are append-only.
- Reversals reference original entries.
- Idempotency prevents duplicates.
- No direct balance edits.
- Every displayed balance is reproducible.
- Every partner cash movement has an internal transaction.
- Every internal cash-affecting transaction has a partner or approved adjustment reference.

## 16.5 Source-of-Truth Hierarchy

1. **Financial partner:** Actual external money movement and settlement state.
2. **Internal ledger:** SquadStash accounting, ownership and allocations.
3. **Read models:** Fast user-interface projections.
4. **Analytics:** Non-authoritative reporting.

---

# 17. Technical Architecture

## 17.1 Mobile Client

Recommended stack:

- React Native.
- Expo.
- Expo Router.
- TypeScript.
- Secure local storage.
- Push notifications.
- Platform biometric APIs.
- EAS Build and Submit.

## 17.2 Firebase Responsibilities

Firebase may handle:

- Authentication.
- User session identity.
- Trip metadata.
- Images.
- Notifications.
- Realtime collaboration views.
- Non-authoritative projections.
- Feature flags.
- App analytics.
- Crash reporting.

Firebase must not be the sole authoritative system for real-money accounting.

## 17.3 Secure Backend

All sensitive actions must pass through a server-side backend.

Recommended responsibilities:

- Authorization.
- Financial-partner API calls.
- Ledger transactions.
- Transfer creation.
- Card controls.
- Webhook verification.
- Idempotency.
- Reconciliation.
- Risk checks.
- Audit logging.
- Support tools.
- Compliance restrictions.

Recommended deployment:

- TypeScript backend.
- Containerized services.
- Cloud Run or an equivalent managed environment.
- Private database connectivity.
- Secret manager.
- Managed queues.
- Scheduled jobs.

## 17.4 Financial Database

Use a relational database such as PostgreSQL for:

- Double-entry ledger.
- Financial transactions.
- Idempotency keys.
- Reconciliation.
- Transfer states.
- Card states.
- Disputes.
- Financial audit records.

Strong transactional consistency is required.

## 17.5 Event Processing

Use event-driven processing for:

- Partner webhooks.
- Transfer updates.
- Card authorizations.
- Card settlement.
- ACH returns.
- Account restrictions.
- Identity-verification updates.
- Notifications.
- Reconciliation jobs.

Events must support:

- Signature verification.
- Deduplication.
- Retry.
- Dead-letter handling.
- Ordering where required.
- Audit retention.

## 17.6 Provider Abstraction

Create internal interfaces such as:

- `IdentityProvider`
- `BankLinkProvider`
- `AccountProvider`
- `TransferProvider`
- `CardProvider`
- `StatementProvider`
- `ComplianceProvider`

Business logic should not be tightly coupled to one provider’s API objects.

## 17.7 Read Models

The app may use denormalized read models for fast display, but those models must be rebuildable from authoritative systems.

Examples:

- User balance summary.
- Bucket summary.
- Trip wallet summary.
- Member position summary.
- Recent activity.
- Expense totals.

---

# 18. Core Financial Data Model

## 18.1 Application Users

`users`

Fields:

- Internal user ID.
- Firebase UID.
- Display name.
- Email.
- Phone.
- Date of birth status.
- Financial eligibility status.
- Preferred currency.
- Time zone.
- Account state.
- Created and updated timestamps.

## 18.2 Partner Customers

`partner_customers`

- User ID.
- Provider.
- Provider customer ID.
- Verification status.
- Requirements due.
- Restrictions.
- Created and updated timestamps.

## 18.3 External Accounts

`external_accounts`

- User ID.
- Provider reference.
- Institution.
- Type.
- Last four digits.
- Verification.
- Ownership status.
- Transfer capabilities.
- Status.

## 18.4 Financial Accounts

`financial_accounts`

- Owner type.
- Owner ID.
- Provider.
- Provider account reference.
- Legal structure type.
- Status.
- Currency.
- Restrictions.

## 18.5 Ledger Accounts

`ledger_accounts`

- Account ID.
- Owner type.
- Owner ID.
- Account category.
- Currency.
- Status.

## 18.6 Ledger Transactions

`ledger_transactions`

- Transaction ID.
- Type.
- Status.
- User.
- Trip.
- Partner reference.
- Idempotency key.
- Description.
- Created and effective timestamps.

## 18.7 Ledger Entries

`ledger_entries`

- Entry ID.
- Transaction ID.
- Ledger account.
- Debit or credit direction.
- Amount cents.
- Currency.
- Created timestamp.

## 18.8 Buckets

`buckets`

- Owner.
- Name.
- Goal.
- Category.
- Target date.
- Status.
- Display settings.
- Ledger account reference.

## 18.9 Trips

`trips`

- Owner.
- Name.
- Location.
- Dates.
- Goal.
- Status.
- Governance model.
- Terms version.
- Wallet reference.
- Created and updated timestamps.

## 18.10 Trip Members

`trip_members`

- Trip.
- User.
- Role.
- Membership status.
- Accepted terms version.
- Contribution expectation.
- Joined date.
- Removed date.

## 18.11 Transfers

`transfers`

- User.
- Trip.
- Transfer type.
- Direction.
- Amount.
- Currency.
- Funding source.
- Destination.
- Partner reference.
- Status.
- Availability date.
- Return reason.
- Idempotency key.

## 18.12 Cards

`cards`

- Trip.
- Cardholder.
- Partner card reference.
- Type.
- Status.
- Spending-control policy.
- Last four digits.
- Expiration reference.

## 18.13 Card Transactions

`card_transactions`

- Card.
- Trip.
- Authorization reference.
- Merchant.
- Amount.
- Status.
- Category.
- Expense reference.
- Settled amount.

## 18.14 Expenses

`expenses`

- Trip.
- Title.
- Amount.
- Expense type.
- Paid-by source.
- Status.
- Receipt.
- Created by.
- Finalized date.

## 18.15 Expense Allocations

`expense_allocations`

- Expense.
- Member.
- Amount.
- Status.
- Approval.
- Dispute reference.

## 18.16 Disputes

`disputes`

- User.
- Trip.
- Transaction type.
- Transaction reference.
- Reason.
- Evidence.
- Status.
- Resolution.
- Regulatory deadline fields where applicable.

## 18.17 Reconciliation Runs

`reconciliation_runs`

- Period.
- Provider.
- Opening balance.
- Closing balance.
- Internal total.
- Difference.
- Status.
- Exceptions.
- Completed by.

## 18.18 Audit Events

`audit_events`

- Actor.
- Action.
- Entity.
- Before-safe-summary.
- After-safe-summary.
- Device and request context.
- Timestamp.
- Reason.
- Approval reference.

Sensitive values must be excluded or redacted.

---

# 19. Identity Verification and Compliance Operations

## 19.1 Verification Experience

The preferred experience uses partner-hosted or partner-embedded onboarding to minimize SquadStash’s direct handling of highly sensitive identity information.

## 19.2 Required Product States

The app must support:

- Additional information required.
- Document upload required.
- Manual review.
- Verification failure.
- Temporary restriction.
- Permanent ineligibility.
- Successful verification.

## 19.3 Restricted Actions

An unverified or restricted user may be prevented from:

- Funding an account.
- Joining a funded trip.
- Receiving a trip card.
- Withdrawing.
- Managing a wallet.
- Receiving certain reimbursements.

## 19.4 Compliance Case Management

An internal case system should support:

- User review.
- Transaction review.
- Document requests.
- Notes.
- Escalation.
- Account restriction.
- Release of restriction.
- Partner communication.
- Complete audit history.

## 19.5 Sensitive Identity Data

SquadStash should avoid storing:

- Full Social Security numbers.
- Raw identity documents.
- Bank credentials.
- Full card numbers.

Where unavoidable, data must be encrypted, tightly restricted and retained only as legally and operationally necessary.

---

# 20. Fraud and Risk Management

## 20.1 Risk Controls

The risk system should evaluate:

- New account age.
- Device history.
- Identity confidence.
- Bank-account ownership.
- Transfer velocity.
- Transfer amount.
- Repeated failed transfers.
- ACH returns.
- Rapid deposit and withdrawal.
- Multiple accounts.
- Unusual trip behavior.
- Manager spending patterns.
- Geographic anomalies.
- Account takeover indicators.

## 20.2 Available-Funds Risk

SquadStash must not allow users or managers to spend money merely because an ACH debit has been initiated.

Risk policy may require:

- Settlement.
- Holding periods.
- Reduced availability.
- Reserve.
- Manual review.

## 20.3 Negative Balances

The system must have a defined process for:

- ACH returns after funds were spent.
- Card reversals.
- Chargebacks.
- Duplicate credits.
- Operational mistakes.
- Partner corrections.

Possible actions:

- Freeze withdrawals.
- Freeze trip spending.
- Apply available funds.
- Create a receivable.
- Request repayment.
- Suspend the account.
- Escalate for review.

## 20.4 Account Takeover Protection

High-risk changes require step-up authentication:

- New external bank.
- Password or email change.
- Large withdrawal.
- New trip manager.
- New cardholder.
- Ownership transfer.
- Security-setting change.

---

# 21. Authentication and Security

## 21.1 Authentication

Support:

- Email and password.
- Email verification.
- Password reset.
- Multi-factor authentication.
- Biometric reauthentication.
- Secure session revocation.
- Device management.

Social sign-in may be added after financial identity matching is designed.

## 21.2 Step-Up Authentication

Require additional verification for:

- Withdrawals.
- Bank-account changes.
- Large contributions.
- Manager changes.
- Card controls.
- Settlement approval.
- Personal-data export.
- Account deletion.

## 21.3 Security Framework

The security program should align with:

- NIST Cybersecurity Framework 2.0.
- OWASP Mobile Application Security Verification Standard.
- OWASP Application Security Verification Standard.
- Financial-partner security requirements.

## 21.4 Required Security Controls

- Encryption in transit.
- Encryption at rest.
- Managed secrets.
- Key rotation.
- Least privilege.
- Role-based access.
- Environment separation.
- Multifactor administrative access.
- Dependency scanning.
- Static analysis.
- Vulnerability scanning.
- Penetration testing.
- Secure code review.
- Audit logging.
- Rate limiting.
- Bot protection.
- Secure webhook verification.
- Database backups.
- Disaster recovery.
- Incident-response plan.

## 21.5 Mobile Security

The mobile app must:

- Store tokens in platform-secure storage.
- Avoid logging sensitive data.
- Detect invalid sessions.
- Avoid embedding server secrets.
- Validate deep links.
- Protect screenshots on highly sensitive views when appropriate.
- Require reauthentication for sensitive operations.
- Use certificate and transport protections appropriate to the threat model.
- Support secure application updates.

## 21.6 Administrative Security

Administrative users must use:

- Separate admin authentication.
- Mandatory multifactor authentication.
- Role approval.
- Restricted network or identity-aware access.
- Session recording or detailed logs for sensitive operations.
- No direct ledger balance-edit capability.

---

# 22. Reconciliation and Financial Operations

## 22.1 Reconciliation Requirement

SquadStash must reconcile internal records with the financial partner.

## 22.2 Reconciliation Frequency

Recommended:

- Event-level reconciliation continuously.
- Daily account reconciliation.
- Monthly statement reconciliation.
- Additional reconciliation after incidents.

## 22.3 Reconciliation Checks

Compare:

- Opening balance.
- Inflows.
- Outflows.
- Pending money.
- Settled money.
- Returns.
- Card authorizations.
- Card settlements.
- Fees.
- Adjustments.
- Closing balance.

## 22.4 Reconciliation Exceptions

Exceptions must:

- Be assigned.
- Be investigated.
- Be aged.
- Be escalated.
- Be resolved with documented adjustments.
- Never be hidden by overwriting balances.

## 22.5 Webhook Failure Recovery

The system must support:

- Webhook retries.
- Scheduled status polling.
- Missed-event detection.
- Event replay.
- Idempotent processing.
- Dead-letter review.

---

# 23. Disputes, Errors and Customer Protection

## 23.1 In-App Reporting

Users must be able to report:

- Unauthorized transfer.
- Incorrect amount.
- Duplicate transaction.
- Missing transfer.
- Incorrect expense allocation.
- Unauthorized card purchase.
- Missing refund.
- Account takeover.
- Manager misuse.

## 23.2 Case Timeline

The case should track:

- Date reported.
- Transaction.
- User explanation.
- Evidence.
- Required follow-up.
- Partner case reference.
- Investigation status.
- Temporary credit where applicable.
- Final determination.
- User notification.

## 23.3 Emergency Controls

Users should be able to:

- Lock their account.
- Pause withdrawals.
- Pause a trip card when authorized.
- Report a compromised device.
- Revoke sessions.
- Contact support.

## 23.4 Manager Misuse

When manager misuse is alleged:

- Pause disputed spending when appropriate.
- Preserve evidence.
- Notify authorized parties.
- Prevent retaliation through record deletion.
- Allow ownership transfer or manager removal.
- Escalate to the partner when actual money movement is involved.

---

# 24. Notifications and Communications

## 24.1 Financial Notifications

Notify users of:

- Bank account linked.
- Deposit initiated.
- Deposit available.
- Deposit returned.
- Withdrawal initiated.
- Withdrawal completed.
- Contribution made.
- Contribution committed.
- Card authorization.
- Card purchase.
- Expense allocation.
- Reimbursement.
- Refund.
- Settlement.
- Account restriction.
- Security change.

## 24.2 Trip Notifications

- Invitation.
- Member joined.
- Funding deadline.
- Goal reached.
- Proposed expense split.
- Dispute.
- Spending paused.
- Trip canceled.
- Settlement started.
- Wallet closed.

## 24.3 Communication Channels

- In-app.
- Push.
- Email for important financial and security events.
- SMS only when justified and consented to.

Critical account and security messages cannot be disabled when delivery is legally or operationally necessary.

---

# 25. Home Dashboard

The Home dashboard should show:

- Available SquadStash balance.
- Money allocated to personal buckets.
- Pending deposits.
- Active trip commitments.
- Upcoming contribution schedules.
- Recent transactions.
- Security or verification tasks.
- Trip actions requiring approval.
- Savings progress.
- Upcoming trip.

Financial totals must be separated so users do not mistakenly believe trip-committed money is personally withdrawable.

---

# 26. Activity and Transaction History

## 26.1 Activity Types

- External deposit.
- External withdrawal.
- Bucket allocation.
- Bucket transfer.
- Trip contribution.
- Trip refund.
- Card authorization.
- Card settlement.
- Expense.
- Reimbursement.
- Fee.
- Adjustment.
- Return.
- Reversal.
- Dispute.
- Settlement.

## 26.2 Transaction Detail

Each financial transaction should display:

- Description.
- Amount.
- Status.
- Date.
- Source.
- Destination.
- Trip or bucket.
- Provider tracking information where appropriate.
- Availability or settlement timing.
- Related expense.
- Receipt.
- Support and dispute action.

---

# 27. Design and User Experience

## 27.1 Brand

SquadStash should feel:

- Trustworthy.
- Modern.
- Social.
- Clear.
- Safe.
- Motivating.
- Professional without feeling like a traditional bank.

## 27.2 Visual System

Use:

- Blue-toned professional design.
- Strong contrast.
- Clear money typography.
- Consistent cards.
- Status badges.
- Progress indicators.
- Simple navigation.
- Limited decorative clutter.

## 27.3 Money Status Language

Use precise labels:

- Pending.
- Available.
- Committed.
- Reserved.
- Spent.
- Refundable.
- Frozen.
- Returned.
- Settled.

Avoid vague labels such as “saved” when money is not yet available.

## 27.4 Confirmations

Money movement confirmations must display:

- Amount.
- Source.
- Destination.
- Fee.
- Expected timing.
- Withdrawal or commitment effect.
- Authorization language.
- Final confirmation action.

## 27.5 Accessibility

Support:

- Screen readers.
- Dynamic text.
- Adequate contrast.
- Large touch targets.
- Non-color status indicators.
- Accessible errors.
- Logical focus.
- Reduced motion.

---

# 28. Customer Support and Operations

## 28.1 Support Channels

Initial support should include:

- In-app help center.
- Secure support form.
- Email support.
- Emergency account-security flow.

Phone support may be required by the financial program or introduced for high-severity cases.

## 28.2 Support Categories

- Login.
- Verification.
- Bank linking.
- Deposit.
- Withdrawal.
- Contribution.
- Trip card.
- Expense split.
- Refund.
- Dispute.
- Account restriction.
- Account closure.

## 28.3 Support Permissions

Support agents may:

- View safe account summaries.
- Review transaction states.
- Open cases.
- Request documents through approved workflows.
- Escalate issues.

Support agents may not:

- Edit ledger balances.
- Change transaction status manually without controlled operations.
- View full sensitive identity data without authorization.
- Withdraw money.
- Create undocumented adjustments.

---

# 29. Privacy and Data Governance

## 29.1 Data Minimization

Collect only information necessary for:

- Authentication.
- Financial services.
- Security.
- Compliance.
- Support.
- Product functionality.

## 29.2 Privacy Controls

Users should be able to:

- Review privacy disclosures.
- Manage optional analytics consent.
- Manage marketing consent.
- Download eligible data.
- Request correction.
- Request account deletion.
- Revoke linked-bank access where supported.

## 29.3 Data Retention

Retention schedules must be defined by data category.

Financial, compliance and dispute records may need to be retained after account closure.

Unnecessary personal data should be removed or anonymized when retention is no longer required.

## 29.4 Account Deletion

Account deletion must:

- Reauthenticate the user.
- Resolve open trips.
- Resolve remaining money.
- Close or disconnect financial accounts.
- Cancel cards.
- Preserve legally required records.
- Remove optional profile and marketing data.
- Notify the user when completed.

---

# 30. Monetization

## 30.1 Free Tier

Possible free features:

- Three active personal buckets.
- One active funded trip.
- Basic equal splitting.
- Standard bank transfers.
- Basic trip card.
- Core transaction history.
- Required financial and security controls.

## 30.2 SquadStash Pro

Potential Pro features:

- Unlimited buckets.
- Unlimited trips.
- Advanced contribution schedules.
- Additional trip managers.
- Advanced budget categories.
- Multiple trip cards.
- Advanced approvals.
- Reporting.
- Data export.
- Custom trip themes.
- Extended receipt storage.
- Priority support.

## 30.3 Additional Revenue

Subject to partner agreements and applicable requirements:

- Card interchange revenue share.
- Optional expedited-transfer fees.
- Premium group-planning features.
- Business or organization plans.

## 30.4 Revenue Restrictions

SquadStash must not:

- Hide a user’s own money behind a subscription.
- Charge undisclosed fees.
- Charge for account deletion.
- Charge for dispute submission.
- Prevent withdrawal solely because a subscription ended.
- Misrepresent interest or insurance.

## 30.5 App Store Billing

Digital premium features must comply with current Apple and Google billing policies.

Money deposited into financial accounts or contributed to trips is not a purchase of digital content, but subscription design must be reviewed independently under current store rules.

---

# 31. Analytics

Permitted analytics events may include:

- Registration completed.
- Verification started.
- Verification completed.
- Bank linked.
- First deposit completed.
- Bucket created.
- Trip created.
- Trip joined.
- Contribution completed.
- Expense allocated.
- Trip settled.
- Subscription started.

Do not send:

- Full account numbers.
- Identity documents.
- Social Security numbers.
- Raw transaction descriptions.
- Receipts.
- Exact private notes.
- Authentication tokens.

Analytics must not be authoritative for financial reporting.

---

# 32. Admin and Operations Console

The platform requires a secure internal console for:

- User support.
- Identity-status review.
- Account restrictions.
- Transfer monitoring.
- Card monitoring.
- Disputes.
- Risk cases.
- Reconciliation.
- Trip governance complaints.
- Webhook health.
- System incidents.
- Partner communication.

Every sensitive administrative action must require:

- Appropriate role.
- Reason.
- Audit event.
- Reauthentication when warranted.
- Secondary approval for high-impact actions.

---

# 33. Testing Requirements

## 33.1 Unit Tests

Required:

- Currency arithmetic.
- Double-entry balancing.
- Bucket allocation.
- Contribution accounting.
- Expense splitting.
- Rounding.
- Member ownership.
- Refund distribution.
- Reimbursement.
- Settlement.
- Reversal.
- Return.
- Idempotency.
- Limit calculation.

## 33.2 Integration Tests

Required:

- Verification status updates.
- Bank linking.
- Deposit initiation.
- Deposit settlement.
- Deposit return.
- Withdrawal.
- Contribution.
- Card authorization.
- Card settlement.
- Card reversal.
- Expense allocation.
- Refund.
- Dispute.
- Wallet closure.
- Webhook duplication.
- Webhook delay.
- Reconciliation.

## 33.3 Security Tests

- Authentication bypass.
- Authorization escalation.
- Insecure direct object references.
- Session theft.
- Token leakage.
- API replay.
- Webhook forgery.
- Rate-limit bypass.
- Mobile storage review.
- Dependency vulnerabilities.
- Database access.
- Admin-console access.
- Social engineering procedures.

## 33.4 Financial Scenario Tests

At minimum:

1. One user funds one bucket.
2. A deposit is returned.
3. A user moves funds between buckets.
4. Three members fund a trip.
5. One member withdraws before commitment.
6. One member attempts withdrawal after commitment.
7. A manager uses the trip card.
8. A card authorization is reversed.
9. A card settlement amount changes.
10. A member personally pays an expense.
11. An equal split produces remainder cents.
12. A member disputes an allocation.
13. A manager is removed.
14. A trip is canceled before spending.
15. A trip closes with unused money.
16. An ACH return creates a negative position.
17. A webhook is delivered twice.
18. A webhook is missed.
19. Internal and partner balances disagree.
20. A compromised account is frozen.

## 33.5 External Assessment

Before live public launch:

- Independent penetration test.
- Mobile application security assessment.
- Backend security assessment.
- Financial-ledger review.
- Firestore rules review.
- Partner certification testing.
- Incident-response exercise.
- Disaster-recovery test.

---

# 34. Reliability and Observability

## 34.1 Required Monitoring

Monitor:

- API errors.
- Transfer failures.
- ACH returns.
- Webhook latency.
- Webhook failures.
- Ledger imbalance attempts.
- Reconciliation mismatches.
- Negative balances.
- Card declines.
- Authentication anomalies.
- Database health.
- Queue backlog.
- Notification failures.

## 34.2 Critical Alerts

Immediate alerts for:

- Unbalanced ledger transaction.
- Unauthorized administrative action.
- Missing partner events.
- Reconciliation discrepancy.
- Exposed secret.
- Suspicious withdrawal pattern.
- Unavailable financial backend.
- Widespread transfer failure.

## 34.3 Disaster Recovery

The platform must have:

- Automated backups.
- Documented recovery procedures.
- Recovery-time objectives.
- Recovery-point objectives.
- Provider outage procedures.
- Read-only degraded mode.
- Transaction replay.
- Emergency communication templates.

---

# 35. Development Standards for Claude and Developers

Claude or any developer must:

- Inspect the existing repository before editing.
- Preserve working functionality where appropriate.
- Use strict TypeScript.
- Keep financial logic server-side.
- Use complete files rather than disconnected snippets.
- Add migrations for database changes.
- Add tests for financial logic.
- Use provider sandboxes.
- Use idempotency.
- Verify webhooks.
- Update documentation.
- Run type checks, linting and tests.
- State what was and was not tested.
- Stop when required credentials, legal decisions or partner approvals are unavailable.

Claude or a developer must not:

- Simulate real custody using Firebase balances.
- Store partner secrets in the mobile app.
- Call money-movement APIs directly from the mobile client.
- Modify financial balances from a screen.
- Disable security rules for convenience.
- Hardcode user or account IDs.
- Mark transfers settled before confirmation.
- Delete financial history.
- Invent partner capabilities.
- Claim regulatory compliance.
- Launch live money without approval.
- Build an unrestricted manager withdrawal function.
- Use floating-point arithmetic for currency.

---

# 36. Recommended Repository Structure

```text
apps/
  mobile/
  admin/

services/
  api/
  webhooks/
  ledger/
  reconciliation/
  notifications/
  risk/

packages/
  financial-domain/
  validation/
  provider-interfaces/
  shared-types/
  design-system/

infrastructure/
  environments/
  database/
  queues/
  monitoring/

firebase/
  rules/
  indexes/
  functions/

docs/
  product/
  architecture/
  security/
  compliance/
  incidents/
  operations/

tests/
  unit/
  integration/
  financial-scenarios/
  security/
```

The existing repository may transition toward this structure incrementally.

---

# 37. Development and Launch Milestones

## Milestone 0: Company and Program Foundation

- Establish legal entity.
- Secure product name and domains.
- Retain financial-services counsel.
- Create initial regulatory analysis.
- Define initial states and users.
- Prepare partner requirements.
- Begin financial-partner evaluation.
- Create security and privacy governance.

**No live money movement.**

## Milestone 1: Repository Audit and Stabilization

- Audit existing Expo application.
- Inventory features.
- Fix navigation.
- Establish strict TypeScript.
- Establish testing.
- Secure environment variables.
- Finalize design system.
- Separate UI from Firebase services.
- Document existing Firestore data.

## Milestone 2: Production Architecture

- Create backend API.
- Create PostgreSQL financial database.
- Create double-entry ledger.
- Create provider abstraction.
- Create queues and webhook processing.
- Create audit logging.
- Create financial read models.
- Add monitoring.

## Milestone 3: Authentication and Financial Profile

- Registration.
- Login.
- Email verification.
- Multifactor authentication.
- Device security.
- User profile.
- Financial eligibility state.
- Partner sandbox identity onboarding.

## Milestone 4: Personal Buckets in Sandbox

- User financial-account model.
- Linked-bank sandbox flow.
- Test deposits.
- Test withdrawals.
- Personal bucket ledger.
- Scheduled allocations.
- Transaction history.
- Reconciliation tests.

## Milestone 5: Trip Wallets in Sandbox

- Trip creation.
- Trip terms.
- Member invitations.
- Trip wallet.
- Member ownership ledger.
- Contributions.
- Commitment rules.
- Refunds.
- Wallet restrictions.

## Milestone 6: Expenses and Trip Cards in Sandbox

- Virtual card.
- Card controls.
- Authorization webhooks.
- Settlement webhooks.
- Receipts.
- Expense categorization.
- Splits.
- Approvals.
- Disputes.

## Milestone 7: Reimbursement and Settlement

- Member-paid expenses.
- Reimbursements.
- Remaining-fund distribution.
- Settlement workflow.
- Wallet closure.
- Financial statements.

## Milestone 8: Compliance and Risk Operations

- Risk rules.
- Limits.
- Case management.
- Account freezes.
- Dispute operations.
- Complaint workflow.
- Reconciliation console.
- Incident response.
- Support procedures.

## Milestone 9: Closed Test-Money Beta

- Internal testers.
- Full lifecycle testing.
- Simulated returns.
- Simulated disputes.
- Security assessment.
- Partner certification.
- Performance testing.
- App review demonstration mode.

## Milestone 10: Limited Live-Money Pilot

Subject to partner and legal approval:

- Small invited user group.
- Low transaction limits.
- Limited states.
- ACH only.
- Virtual trip cards only.
- Manual operational oversight.
- Daily reconciliation.
- Rapid customer support.
- No international access.

## Milestone 11: Public United States Release

- Production approvals.
- Store approval.
- Privacy and terms.
- Support staffing.
- Incident readiness.
- Scaling review.
- Subscription launch.
- Controlled marketing.

## Milestone 12: Scale

Potential expansion:

- Additional states or partner programs.
- Higher limits.
- Physical cards.
- Additional trip managers.
- Couples and household accounts.
- Group events.
- Additional payment methods.
- International currencies and markets only after separate regulatory analysis.

---

# 38. Production Release Gates

Real-money features cannot launch until all applicable gates are satisfied.

## Legal

- Entity established.
- Partner agreement executed.
- Regulatory analysis completed.
- Required licenses or program coverage confirmed.
- Terms completed.
- Privacy policy completed.
- Account agreement completed.
- Trip agreement completed.
- Fee disclosures completed.
- Funds and insurance disclosures approved.

## Financial Operations

- Ledger reviewed.
- Reconciliation proven.
- Returns tested.
- Disputes tested.
- Negative-balance process tested.
- Daily controls documented.
- Support escalation documented.

## Security

- Risk assessment completed.
- Multifactor authentication enabled.
- Secrets secured.
- Penetration test completed.
- Critical findings remediated.
- Incident-response exercise completed.
- Backup recovery tested.
- Vendor security reviews completed.

## Partner

- Sandbox certification completed.
- Production access approved.
- Identity flow approved.
- Transfer flow approved.
- Card controls approved.
- Webhooks certified.
- Disclosures approved.

## Product

- Clear money statuses.
- No misleading balance labels.
- Withdrawal rules displayed.
- Commitment rules displayed.
- Manager permissions displayed.
- Disputes available.
- Account deletion available.
- Accessibility reviewed.
- Full trip lifecycle completed.

## App Stores

- Submitted through the legal entity.
- Financial disclosures complete.
- Privacy disclosures complete.
- Google Financial Features Declaration complete.
- Review account or demonstration mode available.
- Partner information available for reviewers.

---

# 39. MVP Acceptance Criteria

The live-money MVP is complete when an eligible new user can:

1. Create an account.
2. Verify email.
3. Enable multifactor authentication.
4. Complete financial identity verification.
5. Link an eligible external bank.
6. Initiate a deposit.
7. See pending and available balances correctly.
8. Allocate available money to a personal bucket.
9. Move money between personal buckets.
10. Withdraw eligible money.
11. Create a trip.
12. Define contribution and commitment rules.
13. Invite another verified user.
14. Have the user join and accept trip terms.
15. Receive contributions from both users.
16. View member ownership positions.
17. Assign a controlled trip manager.
18. Issue or activate a virtual trip card.
19. Complete an approved trip purchase.
20. Allocate the expense.
21. Allow members to review or dispute the allocation.
22. Reimburse a member-paid expense.
23. Return unused money.
24. Complete final settlement.
25. Close the trip wallet.
26. Review statements and complete history.
27. Report an unauthorized transaction.
28. Freeze the account.
29. Recover access securely.
30. Delete or close the account through the proper process.

The platform must complete these actions without:

- Ledger imbalance.
- Unauthorized access.
- Hidden transaction history.
- Direct balance edits.
- Unreconciled partner cash.
- Misleading ownership representation.

---

# 40. Growth Strategy

## 40.1 Initial Niche

Begin with friend-group trips where:

- Multiple people contribute over time.
- One or two organizers manage payments.
- Members need transparency.
- Final settlement is difficult using ordinary payment apps.

## 40.2 Growth Loops

Potential organic growth mechanisms:

- Trip invitations.
- Shared progress.
- Contribution reminders.
- Referral rewards where legally and financially approved.
- Reusable member groups.
- Trip templates.
- Post-trip settlement summaries.
- Personal buckets that retain users between trips.

## 40.3 Expansion Path

After the trip product is proven:

1. Couples goals.
2. Roommate expenses.
3. Family events.
4. Wedding groups.
5. Clubs and teams.
6. Small organizations.
7. Approved business group-spending use cases.

Each new use case requires separate product, risk and legal review.

---

# 41. Non-Goals for the Initial Launch

The initial launch will not include:

- Lending.
- Credit.
- Overdraft.
- Investments.
- Cryptocurrency.
- International transfers.
- Foreign exchange.
- Anonymous accounts.
- Minor accounts.
- Cash deposits.
- ATM withdrawals.
- Interest promises.
- Public fundraising.
- Charitable fundraising.
- Merchant acquiring.
- Travel booking.
- Insurance sales.
- Unrestricted manager cash access.

---

# 42. Definition of Done

A feature involving money is complete only when:

- User interface exists.
- Server authorization exists.
- Partner integration exists.
- Ledger entries exist.
- Idempotency exists.
- Webhook processing exists.
- Error and return handling exists.
- Reconciliation exists.
- Audit logging exists.
- Security review exists.
- Permissions are tested.
- Loading, empty and error states exist.
- User disclosures exist.
- Unit and integration tests pass.
- Sandbox lifecycle is verified.
- Operational procedure exists.
- No unresolved critical defect remains.

A screen that displays a number without the supporting financial controls is not a completed financial feature.

---

# 43. Source-of-Truth Rule

This document is the primary product and architectural specification for SquadStash.

When implementation conflicts with this specification:

1. Preserve user funds and data.
2. Stop unsafe money movement.
3. Document the conflict.
4. Consult the applicable owner: product, engineering, security, compliance, legal or financial partner.
5. Update the approved source of truth.
6. Test the correction.
7. Preserve audit history.

Decision priorities are:

1. User fund safety.
2. Legal and partner requirements.
3. Financial correctness.
4. Security.
5. User ownership and transparency.
6. Reliability.
7. Maintainability.
8. User experience.
9. Growth.
10. Development speed.

---

# 44. Final Product Statement

SquadStash will provide each eligible user with a secure way to connect an external bank account, move real money into a partner-supported financial account, allocate money among personal savings buckets and contribute money to controlled group-trip wallets.

Each trip wallet will preserve member-level ownership and transaction records. Trip managers may receive limited administrative and spending authority, including access to controlled trip cards, but will not receive unrestricted ownership of other members’ contributions.

All financial movements will be executed through authorized financial infrastructure, recorded in a double-entry ledger, confirmed through secure backend services and reconciled against the financial partner.

SquadStash will launch gradually, beginning with partner sandboxes and a restricted pilot. Live money will not be enabled until the legal entity, financial partnership, security program, ledger, reconciliation, disclosures, customer support and dispute processes are approved and operational.

The long-term objective is to build a large, trusted platform where individuals and groups can safely save, coordinate, spend and settle money for the experiences they share.
