# Operations Monitoring Specification

## Purpose

Defines operational visibility for scraping health, ingestion failures, and admin alerts.

## Requirements

### Requirement: Scrape Run Tracking

The system MUST record each ingestion attempt and its outcome.

#### Scenario: Ingestion run succeeds

- GIVEN the ingestion job completes
- WHEN transactions are processed
- THEN the system MUST record run start time, end time, status, and transaction counts

#### Scenario: Ingestion run fails

- GIVEN the ingestion job cannot complete
- WHEN the failure occurs
- THEN the system MUST record the failure reason and run status
- AND the failure MUST NOT stop dashboard access to previously stored transactions

### Requirement: Operational Alerts

The system SHALL alert an admin when ingestion needs attention.

#### Scenario: Bank UI or authentication failure occurs

- GIVEN the scraper cannot locate expected transaction data or authentication is required
- WHEN the failure is detected
- THEN the system MUST notify an admin with a safe, non-secret error summary

### Requirement: Safe Diagnostics

The system MUST avoid exposing sensitive banking data in diagnostics by default.

#### Scenario: Diagnostic evidence is captured

- GIVEN a scrape failure requires debugging
- WHEN diagnostic data is stored
- THEN the system MUST redact credentials, session tokens, and unrelated account details
