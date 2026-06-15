-- Throwaway database for the gated Prisma contract tests.
-- Pointed at by RD_SYNC_TEST_DATABASE_URL; never holds real data.
-- Runs only on first container init (empty data volume).
CREATE DATABASE rd_sync_test;
