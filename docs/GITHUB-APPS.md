# Legion GitHub Apps: production rules

Owner: @dnh33 (personal account; owner decision 2026-10-15: keep there for now). Install target: any account. Every Legion user signs in through these two Apps, so treat their GitHub pages like a production server.

| App | Slug | App ID | Client ID (public) | Permissions |
|---|---|---|---|---|
| Legion (read) | legion-read | 5314210 | Iv23liIt2yvFfWgPrZfK | Metadata R, Contents R, Issues R, Pull requests R, Actions R, Commit statuses R |
| Legion (write) | legion-write | 5314282 | Iv23li7s6igxaj3TZMa3 | Metadata R, Contents R, Commit statuses R, Issues RW, Pull requests RW, Actions RW, Repository creation RW |

Both: device flow on, expiring user tokens, no webhook, no callback, no client secret. Private keys exist only because GitHub requires one before install. The private keys are kept offline by the maintainer; Legion never uses them.

Never:
- press "Revoke all user tokens" (signs every user out);
- rename, delete or transfer the Apps without a plan (a transfer may change IDs; GitHub's docs do not say);
- change permissions casually (every installer must approve again); a change needs a design note and a release note;
- generate a client secret.

If an App is misused (phishing with the public client ID, abuse): GitHub can suspend an installation; users revoke at github.com/settings/applications. Legion's help text tells users to start GitHub sign-in only from inside Legion and to install on selected repos only.

Account risk: if @dnh33 loses access or is suspended, GitHub in Legion breaks for everyone. Moving to an organization later is possible but unverified for ID continuity: test with a throwaway App first.

Experiments with permissions: register a separate "Legion Dev" App; never edit these two for a test.
