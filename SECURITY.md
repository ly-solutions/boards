# Security policy

## Supported versions

Security fixes are released for the latest minor version only. Please upgrade to the latest release before
reporting, if you can.

| Version | Supported |
| --- | --- |
| latest minor (currently 0.1.x) | yes |
| older | no |

## Reporting a vulnerability

Please do **not** open a public issue, discussion or pull request for a security problem.

Report it privately through GitHub's private vulnerability reporting: open the **Security** tab of the repository
and choose **Report a vulnerability**, or go directly to
<https://github.com/ly-solutions/boards/security/advisories/new>.

Please include:

- the affected version (image tag, chart version or commit),
- the configuration that matters: storage driver, `BOARDS_AUTH` mode, reverse proxy or ingress in front,
- steps to reproduce or a proof of concept,
- the impact as you understand it: what an attacker can read, change or run, and what access they need first.

## What to expect

- We acknowledge your report within **3 business days**.
- We confirm or rule out the issue and keep you updated as we work on a fix.
- We aim to release a fix and publish an advisory within **90 days** of the report, sooner for severe issues. If a
  fix takes longer, we agree on a disclosure date with you.
- We credit you in the advisory unless you prefer to stay anonymous.

## Scope notes

Some behaviour is intentional. Please read this before reporting.

- **Board links are bearer secrets.** A board link contains the board's slug and key; anyone who has the link can
  open and edit the board. This is the sharing model, not a vulnerability. Ways to obtain a link without being
  given it (enumeration, leaks through logs, headers, referrers or the API) are in scope.
- **`BOARDS_AUTH=none` is for local use.** In this mode every visitor is treated as a signed-in user. Reports that
  amount to "an instance with `BOARDS_AUTH=none` is open" are out of scope; an auth bypass in the `token`, `oidc`
  or `proxy` modes is in scope.
- **Trusted proxy auth** trusts identity headers only from `BOARDS_PROXY_TRUSTED`. Misconfiguring that list is an
  operator error; spoofing the headers from an untrusted address is in scope.
- **Preview SVGs come from the browser.** The editor renders a board thumbnail and uploads it; the server rejects
  previews with scripts, event handlers, `foreignObject`, `javascript:` URLs or embedded frames before storing them
  and serving them from the boards origin (`isSafePreview` in `server/index.mjs`). A way past that check, or any
  other way to run script through a preview, embed or oEmbed response, is in scope.
- **No server-side fetching of arbitrary URLs.** The server only contacts its configured storage, the OIDC issuer
  and the comments webhook URL set by the operator. Any way to make it request a URL chosen by a user (SSRF) is in
  scope.
- Denial of service through very large boards or high request rates against an instance without limits in front
  of it is generally out of scope, unless a small request causes disproportionate work.
