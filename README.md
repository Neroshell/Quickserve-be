# Quickserve-be

## Required security configuration

`QR_CAPABILITY_SIGNING_SECRET` is the server-only HMAC key for revocable
ServicePoint QR capabilities. Configure at least 32 random characters in every
API instance. Never expose this value to frontend or `NEXT_PUBLIC_*` variables.
