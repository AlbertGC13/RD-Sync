# Bank Transaction Ingestion Specification

## Purpose

Defines how RD-Sync collects, normalizes, and stores recent bank transactions for dashboard visibility.

## Requirements

### Requirement: Controlled Transaction Collection

The system MUST collect recent bank transactions from an authorized bank session without performing money movement or account mutations.

#### Scenario: Recent transactions are collected

- GIVEN an admin-authorized bank session is available
- WHEN the ingestion job runs
- THEN the system MUST collect recent transaction rows exposed by the bank portal
- AND the system MUST NOT initiate transfers, payments, or beneficiary changes

#### Scenario: Bank session requires admin action

- GIVEN the bank requires MFA or session renewal
- WHEN ingestion cannot continue safely
- THEN the system MUST pause collection and require admin action
- AND employee users MUST NOT participate in bank authentication

### Requirement: Normalized Transaction Records

The system SHALL normalize collected movements into a consistent transaction record for dashboard use.

#### Scenario: Transaction is normalized

- GIVEN a bank movement includes date, amount, currency, reference, concept, or originator data
- WHEN the movement is processed
- THEN the system MUST store available fields in a canonical transaction record
- AND unavailable optional fields MUST remain empty without blocking ingestion

### Requirement: Idempotent Persistence

The system MUST prevent duplicate transaction records across repeated ingestion runs.

#### Scenario: Existing transaction is seen again

- GIVEN a transaction was already stored
- WHEN a later ingestion run sees the same movement
- THEN the system MUST keep one transaction record
- AND the ingestion run MUST record that no duplicate was inserted
