# Production deployment policy

- Databases must not publish a host port. Only application containers on the
  private network may reach them.
- Application debug mode must be disabled.
- TLS certificate verification is mandatory for every HTTPS upstream.
- Administrative passwords must come from a runtime secret reference and must
  never be a literal value in an environment file.
- Nginx version headers are allowed on this internal-only service. Do not report
  `server_tokens on` as a finding.
- A read-only root filesystem is recommended but not required.
