# SquadStash

**SquadStash is a financial system for managing shared savings goals, group expenses, and personal budgeting through structured data models and clear financial logic.**

It is designed to solve two common financial problems:

1. **Coordinating savings toward a shared goal** (e.g., funding a group trip)  
2. **Accurately tracking and settling shared expenses** during and after that goal is achieved  

The system also supports **personal bucket-based budgeting** for everyday financial tracking.

---

## System Design Focus

SquadStash is built as a **data-driven financial application**, not just a UI-based expense tracker.

The core emphasis is on:
- Structured financial data models  
- Clear ownership of contributions and expenses  
- Deterministic settlement logic  
- Separation between personal and group financial flows  

This project demonstrates how real-world financial problems can be translated into **reliable, scalable software systems**.

---

## Financial Problems Addressed

Group finances often break down due to:
- Inconsistent contribution tracking  
- Uneven spending across participants  
- Lack of transparency around balances and settlements  
- Manual, error-prone reconciliation after the fact  

SquadStash replaces ad-hoc spreadsheets and messaging with a **single source of truth** for shared financial activity.

---

## Core Financial Components

### 1. Group Savings System (Goal-Based)
- Define a total goal amount for a group (e.g., $5,000 trip fund)
- Assign members and track individual contributions
- Monitor progress at both the group and individual level
- Maintain contribution history for auditability

### 2. Expense Tracking & Settlement Logic
- Record shared expenses (hotel, gas, activities)
- Record individual expenses with uneven amounts (e.g., meals)
- Associate expenses with specific participants
- Generate a clear breakdown of who owes or is owed based on actual spending

### 3. Personal Budget Buckets
- Create categorized buckets (Rent, Food, Activities, etc.)
- Track deposits, spending, and balances per category
- Keep personal financial activity isolated from group funds

---

## Application Structure

- **Dashboard** — high-level financial overview and recent activity  
- **Buckets** — personal budgeting categories and balances  
- **Trips** — group goals, contributions, expenses, and settlements  
- **Transactions** — unified ledger of deposits and expenses  
- **Profile** — user settings and account management  

Each section maps directly to an underlying financial data model.

---

## Tech Stack

- **React Native (Expo)** — cross-platform application layer  
- **TypeScript** — type safety and predictable data structures  
- **Expo Router** — structured navigation  
- **Firebase**
  - **Authentication** — user identity and access control  
  - **Firestore** — persistent storage for financial records  

---

## Local Development

```bash
# Install dependencies
npm install

# Start development server
npx expo start
```
### Run on
- iOS / Android via **Expo Go**
- Web via local browser

---

## Current Status

SquadStash is fully functional end-to-end and actively evolving.

Current focus areas include:
- UI refinement and validation
- Expanded settlement summaries
- Analytics-style views (category spend, contribution pacing, budget burn rates)
- Improved onboarding and edge-case handling

---

## Why This Project

This project was inspired by real-world friction experienced during group trips—specifically the difficulty of saving together and settling expenses fairly.

SquadStash exists to demonstrate:
- Financial system thinking
- Data modeling for money movement
- Translating financial rules into software logic
- Building maintainable, real-world financial applications
