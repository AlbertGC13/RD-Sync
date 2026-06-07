# Transaction Dashboard Specification

## Purpose

Defines employee-facing visibility into recent bank transactions without direct bank portal access.

## Requirements

### Requirement: Recent Transaction List

The system MUST allow authorized employees to view recent normalized bank transactions.

#### Scenario: Employee opens dashboard

- GIVEN an employee has dashboard access
- WHEN the employee opens the transaction dashboard
- THEN the system MUST show recent transactions sorted by newest first
- AND the system MUST NOT show bank credentials, portal sessions, or scraper controls

#### Scenario: No transactions exist

- GIVEN no transactions are stored
- WHEN the dashboard loads
- THEN the system SHOULD show an empty state explaining that no recent transactions are available

### Requirement: Transaction Filters

The system SHALL support filters that help employees validate customer payments.

#### Scenario: Employee filters by payment details

- GIVEN recent transactions exist
- WHEN the employee filters by bank, account, date, amount, currency, reference, concept, or originator
- THEN the system MUST return only matching transaction records
- AND the filter result MUST preserve the same data-minimization rules

### Requirement: Transaction Review State

The system MAY allow authorized users to mark a transaction as seen or internally validated.

#### Scenario: Reviewer marks transaction as seen

- GIVEN a reviewer is authorized to update review state
- WHEN the reviewer marks a transaction as seen
- THEN the system MUST store the review state, reviewer identity, and timestamp
