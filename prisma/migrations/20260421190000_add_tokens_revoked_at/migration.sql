-- Adds a per-user cutoff timestamp. Access tokens whose `iat` is older than
-- this value are rejected by authMiddleware, giving us a way to invalidate
-- all outstanding access tokens (which live in Redis only) after events like
-- password reset or "log out everywhere".
ALTER TABLE "User" ADD COLUMN "tokensRevokedAt" TIMESTAMP(3);
