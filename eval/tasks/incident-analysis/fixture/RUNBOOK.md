# Checkout incident runbook

- `auth cache refresh delayed` is a known warning during key rotation. If requests
  continue to authenticate, it is not an incident trigger.
- Declare checkout degradation when the gateway's rolling failure counter is
  non-zero for two consecutive samples.
- Recovery time is the first sample after mitigation where failures are zero and
  the database pool waiters are also zero.
- The payments API normally runs with a database pool size of 40. Pool waiters
  above 20 usually cause checkout timeouts.
