# Security requirements

- Reset tokens expire after at most 15 minutes.
- Each token is single-use. A successful reset consumes it immediately.
- A successful reset invalidates every existing session for that account.
- Responses must not reveal whether an email address has an account.
