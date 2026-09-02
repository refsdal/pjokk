# Security policy

Pjokk stores health data about children (GDPR Article 9). Security reports
are taken seriously and handled with priority.

## Reporting a vulnerability

Please report vulnerabilities **privately** through GitHub:

**[Security → Report a vulnerability](https://github.com/refsdal/pjokk/security/advisories/new)**

Do not open a public issue for security problems, and please do not test
against the hosted instance at app.pjokk.no — use your own self-hosted
deployment or the compose stack in this repository.

What to include: affected version or commit, reproduction steps, and impact
as you understand it. You can expect an acknowledgement within a few days —
this is a small project, not a security team — and credit in the release
notes for a confirmed report, if you want it.

## Scope

- The application (Go server, SPA, container image) and its release
  artifacts.
- The CI/release pipeline (workflow injection, artifact tampering).

Out of scope: vulnerabilities in third-party dependencies without a
demonstrated impact here (report those upstream — but a heads-up is
welcome), and the availability of the hosted instance.

## Verifying releases

Release artifacts are signed with keyless [cosign](https://github.com/sigstore/cosign)
and ship SPDX SBOMs — see the "Verifying a release" section of the README.
