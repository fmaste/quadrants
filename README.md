# Quadrants

An Eisenhower matrix for teams that are building something, not only keeping it
running. Two labels put every open issue in one of four quadrants:

| Quadrant | Labels                 | The team rule                                              |
| :---     | :---                   | :---                                                       |
| Do now   | `urgent` + `strategic` | important work that also has a reason to happen now        |
| Ongoing  | `strategic`            | keep it progressing unless something genuinely urgent wins |
| Respond  | `urgent`               | needed by the operation, does not advance it               |
| Unsorted | neither                | nothing has flagged it, by decision or by default          |

The board exists for **Ongoing**: new features, new products, improvements,
growth, new clients. It is the only quadrant that moves the project forward
rather than holding it in place. Urgency is loud and fills a day by itself, so
**Do now** and **Respond** never need help being seen; showing all four at once
is what keeps the proactive work beside them instead of behind them. A team
whose **Ongoing** is quiet is not progressing, however busy the other three
look. **Respond** is necessary and not an achievement: if the same kind of card
keeps arriving, automate it or share it out.

## How it works

One static page: HTML, jQuery and Bootstrap, no build step, no backend, nothing
to run. Drop it on GitHub Pages and it reads a repository's open issues straight
from the API.

Because it holds a GitHub token, what it does not do is part of what it is. There
is no server, so nothing of yours is ever sent anywhere but `api.github.com`, and
the token never leaves your browser: not to a URL, a form, a log or a `Referer`.
The page runs no `eval`, no `new Function`, no `innerHTML` of anything it did not
escape itself, and a Content Security Policy in the head allows scripts only from
its own origin and network calls only to the GitHub API. jQuery and Bootstrap are
vendored rather than loaded from a CDN, and `verify.py` installs nothing that npm
and a channel independent of npm have not both confirmed, byte for byte, along
with every other channel that publishes a digest. Compromising one distribution
channel is therefore not enough to reach this page.

One thing it cannot defend, and you should decide about before deploying: browser
storage is shared by every page on one origin. On `user.github.io` that is every
site the account publishes, all of which can read the stored tokens. A dedicated
domain, or an account that hosts nothing else, is the only thing that isolates
them. Keeping the token fine grained, issues only and short lived bounds what a
theft is worth.

## Why it is like this

| Choice                            | Why                                                                                      |
| :---                              | :---                                                                                     |
| two labels, no database           | the state lives in the repository, visible on GitHub, shared by the whole team           |
| `strategic`, not `important`      | on a shared board "not important" lands on the person who filed the issue                |
| `Unsorted`, not `Backlog`         | new issues arrive unflagged and land here, so it is a pile to sort, not a verdict        |
| a token you paste, not OAuth      | GitHub's token endpoint needs a client secret and sends no CORS, so OAuth needs a server |
| the search API, not `/issues`     | only search can express "has neither label", which is what Unsorted is                   |
| one query per quadrant            | each quadrant gets its true total and its own pager, at four requests per query group   |
| jQuery and Bootstrap in `vendor/` | a CDN could serve code to a page holding your token, and an update installs only if independent channels agree |

## Use it

### Run it

Open `index.html` from disk. `file://` is enough: every asset is relative and
`api.github.com` answers a null origin. The page's CSP is written around an
origin, and a `file://` origin is opaque, so if a browser ever refuses to load
`js/app.js` from disk, serve it over http instead. For GitHub Pages, push to a repository
named `quadrants` and the board is at `https://<you>.github.io/quadrants/`.

`node test/run.js` runs the tests: they stub jQuery, storage and the GitHub API,
load `js/app.js` unmodified, and exercise the real code. No dependencies.

### Sign in

The key icon opens **Access**, which holds two kinds of entry.

| Section | Gives                                 | Writes |
| :---    | :---                                  | :---   |
| Tokens  | whatever the token was granted        | yes    |
| Public  | any public repository or organization | no     |

**Create a token** opens GitHub's form with Issues read and write, Metadata
read, and a 30 day lifetime already filled in. Under **Resource owner** pick
your account *or an organization*: one token covers one owner, so add one per
owner. Organizations often cap token lifetime, and a token over the cap is
refused there entirely. A short lifetime is therefore the setting that passes the
most organizations, and it also limits how long a stolen token is worth anything.
If an organization rejects your token, the fix is a shorter lifetime, never a
longer one. GitHub's own maximum is 366 days, which is a ceiling, not a default.

An organization that refuses your token is invisible to it, and GitHub cannot
list which ones those are. Add such an organization by name under **Public**:
typing `IntersectMBO` on its own adds all of its public repositories, read only,
with no token involved.

### Set up the labels

The gear icon holds the flag names, a colour for each, and **Create or update**,
which writes both labels to the selected repository. GitHub caps a label
description at 100 characters; the preview counts them and refuses to send more.

Put the definition in the label description, not in someone's head. A flag is
one bit and carries no reasoning, so a shared board only works if everyone
applies it the same way:

| Label       | Description                                                                             |
| :---        | :---                                                                                    |
| `urgent`    | Waiting makes it worse: someone is blocked, something is broken, or a date is at stake. |
| `strategic` | Moves us toward a goal we have written down. Name the goal or it is not strategic.      |

Listing an old name second, as `['strategic', 'important']`, keeps an existing
board classified while new moves write the new word.

### Pick repositories

The picker is a checkbox list of everything your tokens and public entries
reach, grouped by owner, badged `RW` or `RO` beside `private`. Nothing is
selected until you select it, and the button stays amber while nothing is.
Ticking boxes changes nothing until the dropdown closes, so a board reloads
once, not once per click, and the footer shows what the current selection costs
in queries.

Selecting every repository of one owner collapses to a single `org:` query, so a
whole organization costs the same four requests as one repository. That shortcut
is used only when the listing behind the picker was complete, since `org:` means
every repository of that owner and would otherwise pull in ones you never
selected.

### Move a card, or rename it

Drag a card to another quadrant, or click its `U` and `S` pills. The pencil edits
the issue title in place: Enter saves, Escape cancels. Both write to the
repository that card came from, apply immediately, and put the card back if the
write fails. A repository that refuses a write is marked read only and
remembered, so it is only tried once, and a 403 that is really a rate limit, a
locked issue or an archived repository is not mistaken for one. Read only cards
render their pills disabled and show no pencil or drag handle.

## js/config.js

One entry per axis and one per quadrant, keyed by the same words the board shows,
so nothing here needs translating. `names[0]` is the label written when a card
moves; the rest are aliases that still classify, which is how a flag gets renamed
without reclassifying anything.

```js
labels:
  { urgent:    { names: ['urgent'],                 color: 'd73a4a', description: '...' }
  , strategic: { names: ['strategic', 'important'], color: '1d76db', description: '...' }
  }
, quadrantColors:
  { 'now': 'dc3545', ongoing: '0d6efd', respond: 'fd7e14', unsorted: '6c757d' }
, perPage: 50
```

Label colours are written to GitHub with the label. Quadrant colours are this
board's own and never leave it. Both are defaults: the settings dialog overrides
them per browser.

## Artwork

`img/` is nine static files, committed. Nothing checks them specially and
nothing needs to: `verify.py site` compares every served byte with the
repository's own blob, and `.png`, `.ico` and `.jpg` are in the list it walks,
so the icons are covered by the same git object id as everything else.

`art/` keeps the two sources they were cut from. The crops are written down
here rather than in a script, because the numbers are the only part that was
expensive to find:

| In `art/icon.jpg` | |
| :--- | :--- |
| the rounded tile | x 320, y 84, 379 x 388, rim to rim |
| the coloured artwork | x 324, y 128, 338 x 304 |
| the tile's bevelled edge | 11px, dropped so one clean edge is drawn |
| corner radius | 0.22 of the side, matching the tile's own corners |
| the icon's left edge | x 324, the vertical the red arrow's tail is cut on, not the rim: the artwork runs into the rim there and any white left of it reads as a sliver |

| In `art/logo.jpg` | |
| :--- | :--- |
| the lettering | x 451, y 230, 513 x 116 |
| its own tile | unused: a second drawing, with the artwork almost filling it, that would not match the favicon |
| lettering against the tile | 0.66 of the tile's height, which is what balances the lockup; the source sets it near 0.36 and it reads as an afterthought |
| light ink for the dark header | `#f0f6fc`, the same as the header's text |

The header is dark whichever theme the page is in, so the page uses
`img/logo-dark.png`; `img/logo.png` is the same lockup for light backgrounds.
Its displayed height is `--brand-height` in `css/app.css`.

## Vendored libraries

`verify.py` is the whole tool: `python3 verify.py libs` checks what is installed
and `python3 verify.py libs --update` downloads, checks and installs. Versions and
URLs live
only in it, so the fetch list cannot drift from the check list. It asks five
channels what the bytes should be:

| Channel | What it is | Independent of npm |
| :--- | :--- | :--- |
| npm | the registry's sha512 for the tarball, then the file inside it | no |
| github-release | the maintainers' own release artifact | yes |
| direct | the project's own CDN, where it publishes one | yes |
| cdnjs | a separate CDN publishing its own SRI | no |
| jsdelivr | per file sha256 from its API | no |

cdnjs and jsDelivr both serve the npm tarball, so agreement among those three is
one channel's word. A file passes only when npm agrees **and** at least one
npm-independent channel agrees, with every other channel that publishes a digest
agreeing too. A file sitting in `vendor/` that no channel vouches for fails as
well, since the page's CSP would happily load it.

`update` stages the downloads, runs that check, and copies into `vendor/` only if
it all passed, cleaning the staging directory up on any exit. To upgrade a
library, edit the table in `verify.py`, run update, and change the matching path
in `index.html`.

## Where to host it

Browser storage is keyed by origin, which is scheme, host and port, never the
path. That one fact decides most of this tool's security.

| | `user.github.io/quadrants/` | a dedicated `quadrants.example.com` |
| :--- | :--- | :--- |
| Who can read the tokens | every page that account publishes, on any path | only what you serve on that host |
| `script-src 'self'` covers | the whole shared origin | just this site, so the policy finally means what it reads like |
| Cookie isolation | `github.io` is a public suffix, so no `*.github.io` site can set cookies on it | a sibling subdomain can set cookies for the parent domain; this board sets none, so it costs nothing here |
| HTTPS | Pages serves it; no `Strict-Transport-Security` header is sent | same, plus you own whether the name is preloaded |
| Extra risk | none beyond your own account | a dangling CNAME: if the DNS record outlives the repository, someone else can claim the name and serve their page on your origin. Verify the domain in GitHub's settings and remove the record when you stop |

A custom domain is the fix for the first row, which is the row that matters, but
only if that host serves this and nothing else. Pointing `example.com` at Pages
and also serving other apps from `example.com/other/` rebuilds exactly the problem
you moved to escape.

## Can a stranger trust this page?

Not on its word, and no measure below changes that. Whoever serves the page
chooses the code your browser runs, can change it tomorrow, and can serve one
visitor something different. There is no cryptographic link between a reviewable
commit and the bytes GitHub Pages hands a browser: Pages publishes no signed
digest of what it served. Everything here either removes the need to trust, bounds
the loss, or makes a violation detectable afterwards.

| What a visitor can do | What it settles | What it does not |
| :--- | :--- | :--- |
| **Do not sign in.** Public repositories and organizations need no token | nothing to lose, the only path where trust is unnecessary | 60 requests an hour per IP, and no writing |
| **Run their own copy.** `git clone`, open `index.html` from disk | removes the operator permanently; no build step, so the clone is the whole program | nothing about the hosted copy |
| **Check the deployment.** `python3 verify.py site URL owner/repo` | the bytes served now are a specific public commit, every file, compared against GitHub's own copy | a snapshot; says nothing about the next request or another visitor |
| **Bound the grant.** Fine grained, Issues only, chosen repositories, a week | caps the worst case at issue writes on named repositories | the page cannot read back what was actually granted |
| **Revoke when done.** The revoke button, or GitHub's settings | ends the credential everywhere, not just in this browser | a malicious operator already copied it at paste time |

`.github/workflows/verify-deployment.yml` runs that check on a schedule. It is
worth more copied into a repository under a different account, because run from
here one compromised account silences both the site and its watchdog.

Considered and rejected as unusable here: WEBCAT, the closest thing to real
enforcement, needs a CSP delivered as an HTTP header and Pages sends none;
Sigstore build attestations do not cover a Pages deploy and are near circular for
a site with no build; signed release archives and IPFS mirrors move the problem to
a channel ordinary visitors do not check; and the page verifying itself proves
nothing, because it is the code under suspicion.

## Limits

* Open issues only, pull requests filtered out.
* A quadrant past 1000 issues shows its real total but pages only to 1000, which
  is GitHub's search ceiling.
* Search is 30 requests a minute signed in, 10 anonymous, and its index lags a
  write by a few seconds.
* Writing needs Issues read and write; everything under Public is read only.
* Drag and drop is the desktop path, the flag pills are the touch path.

## License

Copyright 2026 Federico Mastellone, under the
[PolyForm Noncommercial 1.0.0](https://polyformproject.org/licenses/noncommercial/1.0.0)
license: read it, run it, change it, host it yourself, for any purpose that is
not commercial. Commercial use needs a separate license, which you can ask me
for. Third party code in `vendor/` is MIT and stays MIT, see
`vendor/LICENSES.md`.
