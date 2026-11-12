# Security Policy

`@bymax-one/nest-telemetry` wires OpenTelemetry tracing into NestJS and plain Node applications. Its redaction of span data is what keeps URLs, query strings and Redis payloads from reaching a tracing backend, and applications rely on it. We take vulnerability reports seriously and triage them ahead of feature work.

## Supported versions

Only the most recent minor receives security fixes; upgrade to it.

| Version | Status                              |
| ------- | ----------------------------------- |
| `1.x`   | ✅ Active — receives security fixes |

## Reporting a vulnerability

**Do not report security issues through public GitHub Issues, Discussions, or pull requests.** Public reports give attackers a window between disclosure and patch deployment.

Use GitHub **Private Vulnerability Reporting**, which is enabled on this repository:

➡️ [Open a private security advisory](https://github.com/bymaxone/nest-telemetry/security/advisories/new)

If you cannot use the GitHub form (e.g., you do not have an account), email **support@bymax.one** with `[security] @bymax-one/nest-telemetry` in the subject line.

### What to include

A useful report contains:

- A clear description of the vulnerability and its impact (CIA triad — confidentiality, integrity, availability)
- Step-by-step reproduction against the latest `1.x` release
- The affected subpath (`.`, `./register` or `./nest`)
- A suggested fix or mitigation, if you have one
- Whether you would like to be credited in the published advisory (and how — name, handle, affiliation)

### Response timeline

| Phase                                   | Target                                |
| --------------------------------------- | ------------------------------------- |
| Acknowledgement of receipt              | within **72 hours**                   |
| Initial assessment and severity rating  | within **7 days**                     |
| Coordinated fix for **Critical / High** | within **90 days** of acknowledgement |
| Coordinated fix for **Medium / Low**    | best effort, tracked in advisory      |

We follow [coordinated vulnerability disclosure](https://en.wikipedia.org/wiki/Coordinated_vulnerability_disclosure) and publish the advisory only after a fixed version is on npm, unless active exploitation forces an earlier publication.

Reporters are credited in the GitHub Security Advisory and CHANGELOG entry unless they request anonymity.

## In-scope vulnerabilities

The following classes are explicitly in scope:

- **Secret leakage through spans** — any path where `url.query`, `url.full` or a Redis command payload reaches an exporter unredacted under the default configuration
- **Silent redaction bypass** — any way to turn redaction off, or to make it skip a span, without the explicit, reported option
- **Span attribute injection** — an external actor forging attributes (service name, resource, trace identity) through request data the library reads
- **Environment-driven escalation** — a crafted `OTEL_*` value that makes the library load or execute something it should not
- **Bundle supply-chain integrity** — compromised dependency, malicious typosquat, tampered release artifact
- **CodeQL `security-extended` alerts** — anything the automated scan surfaces in the Security tab

## Out of scope

These are not vulnerabilities in `@bymax-one/nest-telemetry` itself:

- Misconfigurations in the **consuming application** (e.g., turning redaction off through its explicit option, putting secrets in custom span attributes) unless they reproduce with the documented default configuration
- Issues in optional peer dependencies (`@opentelemetry/*`) when the upstream maintainer has already accepted them or when the dependency is not exercised by the library
- Self-XSS, social engineering, denial of service via legitimate authenticated load
- Theoretical attacks without a practical demonstration

## Security best practices for consumers

The README's threat-model section lists what span data can carry and what the library redacts.

Pin the package to an exact version in production, verify the publish provenance (`npm audit signatures`), and subscribe to the repository's security advisories so you receive notifications when a CVE is published.

## Acknowledgements

We are grateful to the security community and to every reporter who takes the time to investigate and disclose responsibly.
