/* Quadrants: an Eisenhower matrix over GitHub issues.
   jQuery + Bootstrap, no build step.
   Copyright 2026 Federico Mastellone. PolyForm Noncommercial 1.0.0, see
   LICENSE. */
(function () {
'use strict';

var CONFIG = window.QUADRANTS_CONFIG || {};
var API = 'https://api.github.com';

/* localStorage keys. The strings are a storage format: renaming one loses
   whatever a browser already saved under it. */
var KEY =
  { tokens: 'q.tokens'
  , selected: 'q.sel'
  , publicRepos: 'q.public'
  , urgentNames: 'q.urgent'
  , strategicNames: 'q.strategic'
  , flagColors: 'q.colors'
  , fullyListed: 'q.complete'
  , quadrantColors: 'q.qcolors'
  , ownerTypes: 'q.ptypes'
  , refusedWrites: 'q.ro'
  , oldToken: 'q.token'
  , oldRepo: 'q.repo'
  };

/* The board is these two booleans. The keys are the words the interface
   shows; the labels matched against them are whatever config names. */
var QUADRANT_FLAGS =
  { now:      { urgent: true,  strategic: true  }
  , ongoing:  { urgent: false, strategic: true  }
  , respond:  { urgent: true,  strategic: false }
  , unsorted: { urgent: false, strategic: false }
  };
var QUADRANT_KEYS = ['now', 'ongoing', 'respond', 'unsorted'];
var FLAGS = ['urgent', 'strategic'];

/* The token form, prefilled. Issues read and write is what moving a card
   needs; 30 days is the lifetime most organizations still accept. */
var TOKEN_LIFETIME_DAYS = 30;
var NEW_TOKEN_URL =
  'https://github.com/settings/personal-access-tokens/new' +
  '?name=Quadrants' +
  '&description=An+Eisenhower+matrix+for+teams+over+open+GitHub+issues' +
  '&issues=write' +
  '&metadata=read' +
  '&expires_in=' + TOKEN_LIFETIME_DAYS;

var SEARCH_RESULT_CAP = 1000;  // GitHub's ceiling on search results, not ours
var QUERY_CHAR_CAP = 250;      // GitHub documents a 256 character query
var PUBLIC_ROWS_SHOWN = 12;    // rows per owner in the access dialog
var MAX_PAGES_FOLLOWED = 20;   // stop following rel=next, whatever it claims

var state =
  { tokens: []             // every pasted token, in paste order
  , tokenLogin: {}         // token -> the login it authenticates as
  , ownerToken: {}         // owner -> the token that reaches it
  , ownerType: {}          // owner -> 'User' or 'Organization'
  , ownerFullyListed: Object.create(null)  // owner -> whole listing was seen
  , user: null             // the first token's own account, or null
  , repos: []              // every reachable repository, as GitHub sent it
  , repoMeta: {}           // full_name -> the same row, for lookups
  , selected: []           // full_names the board is currently showing
  , groups: []             // the selection, split into search queries
  , refusedWrites: {}      // full_name -> a write was refused, so read only
  , searchAnonymously: {}  // owner -> search it without a token
  , loadingRepos: false
  , issuesByKey: {}        // 'owner/repo#number' -> the issue
  , quadrants: {}          // quadrant key -> items, totals and paging
  , writingKeys: Object.create(null)       // issue key -> a write is in flight
  , filter: ''             // the toolbar's text filter over loaded cards
  , sort: 'updated'
  , issueState: 'open'
  , urgentNames: []        // label names that count as urgent, lowercased
  , strategicNames: []
  , flagColors: {}         // flag -> hex, written to GitHub with the label
  , quadrantColors: {}     // quadrant key -> hex, never leaves this browser
  , edit: { key: null, value: '' }         // the card whose title is open
  };

/* ---------- storage ---------- */

function readStored(key) {
  try { return localStorage.getItem(key); } catch (e) { return null; }
}

function writeStored(key, value) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch (e) {}
}

/* Stored JSON is hand editable and can be anything, so a bad value reads as
   empty rather than throwing. */
function readStoredList(key) {
  try { return JSON.parse(readStored(key) || '[]'); } catch (e) { return []; }
}

function readStoredObject(key) {
  try { return JSON.parse(readStored(key) || '{}'); } catch (e) { return {}; }
}

function writeStoredJson(key, value) {
  writeStored(key, JSON.stringify(value));
}

/* ---------- small helpers ---------- */

function parseLabels(text) {
  return String(text || '').split(',')
    .map(function (name) { return name.trim().toLowerCase(); })
    .filter(function (name) { return name.length; });
}

function escapeHtml(value) {
  var text = value === null || value === undefined ? '' : String(value);
  return text.replace(/&/g, '&amp;')
             .replace(/</g, '&lt;')
             .replace(/>/g, '&gt;')
             .replace(/"/g, '&quot;')
             .replace(/'/g, '&#39;');
}

/* A six digit hex, whatever the colour input hands back. */
function hexColor(value, fallback) {
  var hex = String(value || '').replace('#', '').toLowerCase();
  return /^[0-9a-f]{6}$/.test(hex) ? hex : fallback;
}

/* Readable ink on a label's background colour. */
function readableTextOn(background) {
  var hex = String(background || '6c757d');
  if (hex.length === 3) hex = hex.replace(/./g, '$&$&');
  var packed = parseInt(hex, 16);
  if (isNaN(packed)) return '#fff';
  var red = (packed >> 16) & 255;
  var green = (packed >> 8) & 255;
  var blue = packed & 255;
  return (0.299 * red + 0.587 * green + 0.114 * blue) > 150 ? '#000' : '#fff';
}

var TIME_UNITS =
  [ [31536000, 'y']
  , [2592000, 'mo']
  , [604800, 'w']
  , [86400, 'd']
  , [3600, 'h']
  , [60, 'm']
  ];

function timeAgo(iso) {
  var seconds = (Date.now() - new Date(iso).getTime()) / 1000;
  for (var i = 0; i < TIME_UNITS.length; i++) {
    var size = TIME_UNITS[i][0];
    if (seconds >= size) {
      return Math.floor(seconds / size) + TIME_UNITS[i][1] + ' ago';
    }
  }
  return 'just now';
}

function compareCaseless(a, b) {
  return String(a).toLowerCase().localeCompare(String(b).toLowerCase());
}

function ownerOf(fullName) {
  return String(fullName || '').split('/')[0];
}

function repoNameOf(fullName) {
  return String(fullName || '').split('/')[1] || '';
}

var busyRequests = 0;
function setBusy(on) {
  busyRequests = Math.max(0, busyRequests + (on ? 1 : -1));
  $('#spinner').toggleClass('d-none', busyRequests === 0);
}

function toast(message, kind) {
  var $toast = $(
    '<div class="toast align-items-center text-bg-' + (kind || 'secondary') +
      ' border-0" role="alert">' +
      '<div class="d-flex"><div class="toast-body"></div>' +
      '<button type="button" class="btn-close btn-close-white me-2 m-auto"' +
        ' data-bs-dismiss="toast"></button>' +
      '</div>' +
    '</div>');
  $toast.find('.toast-body').text(message);
  $('#alerts').append($toast);
  $toast.on('hidden.bs.toast', function () { $toast.remove(); });
  new bootstrap.Toast($toast[0], { delay: 7000 }).show();
}

/* ---------- github api ---------- */

/* One token per owner: a fine grained token is granted one owner, so a write
   has to say which owner it is for. Reads are looser, since every token also
   reads every public repository, so any token will do and is worth using for
   the far higher rate limit. */
function tokenFor(owner) {
  return state.ownerToken[owner] || state.tokens[0] || null;
}

function tokenForRequest(options) {
  if (options.anon) return null;
  if (options.token) return options.token;
  if (options.owner) return tokenFor(options.owner);
  return state.tokens[0] || null;
}

function apiRequest(path, options) {
  options = options || {};
  var token = tokenForRequest(options);
  var request =
    { url: path.charAt(0) === '/' ? API + path : path
    , method: options.method || 'GET'
    , dataType: options.dataType || 'json'
    , headers:
        { 'Accept': 'application/vnd.github+json'
        , 'X-GitHub-Api-Version': '2022-11-28'
        }
    };
  if (token) request.headers.Authorization = 'Bearer ' + token;
  if (options.body) {
    request.contentType = 'application/json';
    request.data = JSON.stringify(options.body);
  }
  return $.ajax(request);
}

/* RFC 5988 header GitHub sends on every collection: rel=next/prev/first. */
function parseLinkHeader(header) {
  var byRel = {};
  String(header || '').split(',').forEach(function (part) {
    var found = /<([^>]+)>;\s*rel="([^"]+)"/.exec(part);
    if (found) byRel[found[2]] = found[1];
  });
  return byRel;
}

/* The next page is a URL the server chose and it is followed with the token
   attached, so it has to stay on the API host. */
function isApiUrl(url) {
  return String(url || '').indexOf(API + '/') === 0;
}

function fetchAllPages(path, options, soFar, depth) {
  soFar = soFar || [];
  depth = depth || 0;
  return apiRequest(path, options).then(function (rows, status, jq) {
    var all = soFar.concat(rows);
    var next = parseLinkHeader(jq.getResponseHeader('Link')).next;
    if (!next) return all;
    if (!isApiUrl(next) || depth >= MAX_PAGES_FOLLOWED) {
      all.truncated = true;
      return all;
    }
    return fetchAllPages(next, options, all, depth + 1);
  });
}

function issuesPerPage() {
  return Math.min(100, Math.max(1, CONFIG.perPage || 50));
}

function pageCountFor(total) {
  var reachable = Math.min(total, SEARCH_RESULT_CAP);
  return Math.max(1, Math.ceil(reachable / issuesPerPage()));
}

/* GitHub answers 403 for the core rate limit, for the secondary abuse limit
   on bursts of writes, for a locked issue and for an archived repository, as
   well as for a missing permission. Only the last is a fact about access. */
function isTemporaryRefusal(jq) {
  if (!jq || jq.status !== 403) return false;
  if (jq.getResponseHeader('X-RateLimit-Remaining') === '0') return true;
  if (jq.getResponseHeader('Retry-After')) return true;
  var message = (jq.responseJSON && jq.responseJSON.message) || '';
  message = message.toLowerCase();
  return message.indexOf('rate limit') >= 0 ||
         message.indexOf('abuse') >= 0 ||
         message.indexOf('is locked') >= 0 ||
         message.indexOf('archived') >= 0;
}

/* GitHub says which budget ran out and how big it was, so the message names
   real numbers instead of guessing whether a token was involved. */
function rateLimitAdvice(jq) {
  var limit = Number(jq.getResponseHeader('X-RateLimit-Limit'));
  var isSearch = jq.getResponseHeader('X-RateLimit-Resource') === 'search';
  var anonymous = isSearch ? limit <= 10 : limit <= 60;
  if (anonymous && isSearch) {
    return 'Without a token search allows 10 queries a minute, per IP ' +
           'address and shared with everyone on your network. A token ' +
           'raises that to 30 a minute. Add one under Access.';
  }
  if (anonymous) {
    return 'Without a token GitHub allows 60 requests an hour, per IP ' +
           'address and shared with everyone on your network. A token ' +
           'raises that to 5000. Add one under Access.';
  }
  if (isSearch) {
    return 'A token gets 30 searches a minute. Each board costs four per ' +
           'query group, so selecting fewer repositories, or all of one ' +
           'owner, costs fewer.';
  }
  return 'A token gets 5000 requests an hour. Selecting fewer repositories ' +
         'costs fewer.';
}

function reportApiError(jq) {
  if (jq.status === 401) {
    return toast('A token was rejected. Remove it under Access.', 'danger');
  }
  var exhausted = jq.getResponseHeader('X-RateLimit-Remaining') === '0';
  if (jq.status === 403 && exhausted) {
    var epoch = Number(jq.getResponseHeader('X-RateLimit-Reset')) * 1000;
    return toast('Rate limit reached, resets at ' +
                 new Date(epoch).toLocaleTimeString() + '. ' +
                 rateLimitAdvice(jq), 'warning');
  }
  var message = (jq.responseJSON && jq.responseJSON.message) ||
                jq.statusText || 'request failed';
  if (jq.status === 422) {
    message += '. A search says this when it cannot see the repositories';
  }
  toast('GitHub: ' + message + ' (' + jq.status + ')', 'danger');
}

/* ---------- tokens and access ---------- */

function addToken(token) {
  if (!token) return;
  if (state.tokens.indexOf(token) >= 0) {
    return toast('That token is already here.', 'secondary');
  }
  if (/^gh[pousr]_/.test(token)) {
    toast('That is a classic token: it reaches every organization you ' +
          'belong to and is not limited to issues. A fine grained one ' +
          'grants far less.', 'warning');
  }
  setBusy(true);
  apiRequest('/user', { token: token })
    .done(function () {
      state.tokens.push(token);
      writeStoredJson(KEY.tokens, state.tokens);
      reloadAccess();
    })
    .fail(reportApiError)
    .always(function () { setBusy(false); });
}

/* GitHub revokes credentials through an endpoint that needs no authentication
   and allows any origin, so a page with no server can end a token for good.
   Dropping a token only makes this browser forget it; this ends it. */
function revokeToken(index) {
  var token = state.tokens[index];
  if (!token) return;
  var confirmed = window.confirm(
    'Revoke this token at GitHub?\n\nIt stops working everywhere, ' +
    'immediately and permanently, not just in this browser. This cannot ' +
    'be undone.');
  if (!confirmed) return;
  setBusy(true);
  apiRequest('/credentials/revoke',
             { method: 'POST'
             , anon: true
             , dataType: 'text'
             , body: { credentials: [token] }
             })
    .done(function () {
      toast('Sent to GitHub. Check your token settings to see it gone.',
            'success');
      dropToken(index);
    })
    .fail(reportApiError)
    .always(function () { setBusy(false); });
}

function dropToken(index) {
  state.tokens.splice(index, 1);
  writeStoredJson(KEY.tokens, state.tokens);
  reloadAccess();
}

function dropPublic(shouldDrop) {
  var kept = publicRepoNames().filter(function (full) {
    return !shouldDrop(full);
  });
  var keptOwners = {};
  kept.forEach(function (full) { keptOwners[ownerOf(full)] = true; });
  writeStoredJson(KEY.publicRepos, kept);
  writeStoredJson(KEY.fullyListed,
                  fullyListedOwners().filter(function (owner) {
                    return keptOwners[owner];
                  }));
  reloadAccess();
}

function signOut() {
  state.tokens = [];
  writeStored(KEY.tokens, null);
  reloadAccess();
}

/* Back to what js/config.js says: flag names, their colours and the quadrant
   colours. What was added rather than configured is left alone. */
function resetSettings() {
  [KEY.urgentNames, KEY.strategicNames, KEY.flagColors, KEY.quadrantColors]
    .forEach(function (key) { writeStored(key, null); });
  loadSettings();
  applyQuadrantColors();
}

/* Anything that changes access rebuilds from scratch, so one path covers
   adding a token, dropping one, and dropping a public owner. */
function reloadAccess() {
  writeStoredJson(KEY.selected, state.selected);
  state.ownerToken = {};
  state.ownerType = {};
  state.searchAnonymously = {};
  state.tokenLogin = {};
  state.refusedWrites = {};
  writeStored(KEY.refusedWrites, null);   // access changed, so re-learn it
  state.user = null;
  state.repos = [];
  state.repoMeta = {};
  state.ownerFullyListed = Object.create(null);
  resetBoard();                           // no stale cards during the reload
  render();
  state.loadingRepos = !!(state.tokens.length || publicRepoNames().length);
  renderAccess();
  if (state.loadingRepos) return loadReachableRepos();
  state.selected = [];
  showSignedOut();
}

/* The board is always on screen; signed out just means it holds nothing. */
function showSignedOut() {
  $('#signin').removeClass('d-none');
  $('#account, #toolbar').addClass('d-none').removeClass('d-flex');
  resetBoard();
  render();
}

function showSignedIn() {
  $('#signin').addClass('d-none');
  $('#account, #toolbar').removeClass('d-none').addClass('d-flex');
  if (!state.user) {
    $('#avatar').addClass('d-none');
    $('#login').text('public, read only');
    $('#profile').removeAttr('href').removeAttr('title');
    return;
  }
  $('#avatar').attr('src', state.user.avatar_url + '&s=56')
              .removeClass('d-none');
  $('#login').text(state.user.login);
  $('#profile')
    .attr('href', state.user.html_url ||
                  'https://github.com/' + state.user.login)
    .attr('title', 'Open ' + state.user.login + ' on GitHub');
}

/* ---------- repositories ---------- */

function publicRepoNames() { return readStoredList(KEY.publicRepos); }

/* org:/user: stands for every repository an owner has, so it may only replace
   a selection that provably covers the owner. A token listing cannot prove
   that: it returns what the token was granted. Enumerating the owner can. */
function fullyListedOwners() { return readStoredList(KEY.fullyListed); }

function markOwnerFullyListed(owner) {
  var listed = fullyListedOwners();
  if (listed.indexOf(owner) < 0) {
    listed.push(owner);
    writeStoredJson(KEY.fullyListed, listed);
  }
  state.ownerFullyListed[owner] = true;
}

function storedOwnerTypes() { return readStoredObject(KEY.ownerTypes); }

/* A public repository remembered by name only: enough for the picker until
   its own listing arrives. */
function stubRepoFor(fullName) {
  var owner = ownerOf(fullName);
  return { full_name: fullName
         , name: repoNameOf(fullName)
         , owner: { login: owner, type: storedOwnerTypes()[owner] || 'User' }
         , 'private': false
         };
}

function rememberRepo(row) {
  var known = state.repos.some(function (other) {
    return other.full_name === row.full_name;
  });
  if (!known) state.repos.push(row);
  if (!state.repoMeta[row.full_name]) state.repoMeta[row.full_name] = row;
}

function rememberOwnerOf(row, types) {
  var owner = row.owner.login;
  types[owner] = row.owner.type || 'User';
  state.ownerType[owner] = types[owner];
  if (!state.ownerToken[owner]) state.searchAnonymously[owner] = true;
}

function fetchOwnerRepos(path) {
  return fetchAllPages(path, { anon: true });
}

/* An owner's own listing, which is what /user/repos will not give you for an
   organization the token was not granted, even when its repositories are
   public. Organizations and users have separate endpoints, so try both. */
function addPublicOwner(owner) {
  var query = '/repos?per_page=100&sort=updated';
  setBusy(true);
  fetchOwnerRepos('/orgs/' + owner + query)
    .then(null, function () {
      return fetchOwnerRepos('/users/' + owner + query);
    })
    .done(function (rows) { adoptPublicOwner(owner, rows); })
    .fail(function (jq) {
      if (jq && jq.status === 404) {
        return toast('No user or organization called ' + owner + '.',
                     'warning');
      }
      if (jq) reportApiError(jq);
    })
    .always(function () { setBusy(false); });
}

function adoptPublicOwner(owner, rows) {
  if (!rows.length) {
    return toast('No public repositories found for ' + owner + '.', 'warning');
  }
  if (!rows.truncated) markOwnerFullyListed(owner);
  var names = publicRepoNames();
  var types = storedOwnerTypes();
  var added = 0;
  rows.forEach(function (row) {
    rememberOwnerOf(row, types);
    if (names.indexOf(row.full_name) < 0) {
      names.push(row.full_name);
      added += 1;
    }
    rememberRepo(row);
  });
  writeStoredJson(KEY.publicRepos, names);
  writeStoredJson(KEY.ownerTypes, types);
  toast(added + ' public repositories added from ' + owner +
        '. Pick the ones you want.', 'success');
  renderAccess();
  showSignedIn();
  renderPicker();
  openPicker();
}

function addPublicRepo(raw) {
  var name = String(raw || '').trim()
    .replace(/^https?:\/\/github\.com\//, '')   // a pasted URL is reasonable
    .replace(/\/+$/, '');
  if (/^[^/\s]+$/.test(name)) return addPublicOwner(name);
  if (!/^[^/\s]+\/[^/\s]+$/.test(name)) {
    return toast('Use owner/repo, or just owner.', 'warning');
  }
  setBusy(true);
  apiRequest('/repos/' + name, { anon: true })
    .done(adoptPublicRepo)
    .fail(function (jq) {
      if (jq.status === 404) {
        return toast('Not found. Without a token only public repositories ' +
                     'are visible.', 'warning');
      }
      reportApiError(jq);
    })
    .always(function () { setBusy(false); });
}

function adoptPublicRepo(row) {
  var names = publicRepoNames();
  if (names.indexOf(row.full_name) < 0) names.push(row.full_name);
  writeStoredJson(KEY.publicRepos, names);
  var types = storedOwnerTypes();
  rememberOwnerOf(row, types);
  writeStoredJson(KEY.ownerTypes, types);
  rememberRepo(row);
  if (!state.selected.length) state.selected = [row.full_name];
  writeStoredJson(KEY.selected, state.selected);
  renderAccess();
  showSignedIn();
  renderPicker();
  loadIssues();
}

/* Every token's own list, merged. A fine grained token lists only what it was
   granted, so this is also the answer to "what is this token for". */
function loadReachableRepos() {
  state.loadingRepos = true;
  setBusy(true);
  var found = [];
  var failure = { jq: null };
  var steps = state.tokens.map(function (token) {
    return function () { return fetchReposFor(token, found, failure); };
  });
  runInOrder(steps).always(function () {
    adoptPublicStubs(found);
    state.repos = dedupeRepos(found);
    setBusy(false);
    state.loadingRepos = false;
    renderAccess();           // after the listing: RO and RW come from it
    finishRepoLoad(failure.jq);
  });
}

function fetchReposFor(token, found, failure) {
  var path = '/user/repos?per_page=100&sort=updated' +
             '&affiliation=owner,collaborator,organization_member';
  return apiRequest('/user', { token: token })
    .then(function (user) {
      state.tokenLogin[token] = user.login;
      state.user = state.user || user;
    }, function (jq) { failure.jq = jq; })
    .then(function () { return fetchAllPages(path, { token: token }); })
    .then(function (rows) {
      rows.forEach(function (row) {
        found.push(row);
        claimOwnerForToken(row, token);
      });
    }, function (jq) { failure.jq = jq; });
}

/* A private repository proves the token reaches that owner; a public one may
   only be visible to everyone, so a later private row wins. */
function claimOwnerForToken(row, token) {
  var owner = row.owner.login;
  if (state.ownerToken[owner] && !row['private']) return;
  state.ownerToken[owner] = token;
  delete state.searchAnonymously[owner];
}

function adoptPublicStubs(found) {
  fullyListedOwners().forEach(function (owner) {
    state.ownerFullyListed[owner] = true;
  });
  publicRepoNames().forEach(function (fullName) {
    found.push(stubRepoFor(fullName));
    var owner = ownerOf(fullName);
    if (!state.ownerToken[owner]) state.searchAnonymously[owner] = true;
  });
}

function dedupeRepos(found) {
  var seen = {};
  return found.filter(function (row) {
    if (seen[row.full_name]) return false;
    seen[row.full_name] = true;
    state.repoMeta[row.full_name] = row;
    state.ownerType[row.owner.login] = row.owner.type || 'User';
    return true;
  });
}

function finishRepoLoad(failed) {
  if (failed && failed.status === 401) {
    toast('A token was rejected. Remove it under Access.', 'danger');
  } else if (failed) {
    reportApiError(failed);
  }
  if (!state.repos.length) {
    toast('No repositories reachable. Check what the token was granted.',
          'warning');
    return showSignedOut();
  }
  showSignedIn();
  restoreSelection();
  renderPicker();
  if (state.selected.length) loadIssues();
  else openPicker();
}

/* Tokens are tried one after another so that ownerToken lands in paste order
   rather than in whichever order the requests happen to finish. */
function runInOrder(steps) {
  return steps.reduce(function (chain, step) {
    return chain.then(step);
  }, $.Deferred().resolve().promise());
}

function restoreSelection() {
  var reachable = {};
  state.repos.forEach(function (row) { reachable[row.full_name] = true; });
  state.selected = readStoredList(KEY.selected).filter(function (full) {
    return reachable[full];
  });
}

/* ---------- the access dialog ---------- */

/* Enough of the head to tell two tokens apart, never enough to use. */
function maskToken(token) {
  var text = String(token);
  var found = /^(gh[pousr]_|github_pat_)/.exec(text);
  var prefix = found ? found[1] : '';
  return prefix + text.slice(prefix.length, prefix.length + 4) +
         '...' + text.slice(-4);
}

function ownersReachedBy(token) {
  return Object.keys(state.ownerToken).filter(function (owner) {
    return state.ownerToken[owner] === token;
  });
}

function hasWritableRepo(owner) {
  return state.repos.some(function (row) {
    return row.owner.login === owner && isWritable(row.full_name);
  });
}

function tokenReachSummary(token) {
  if (state.loadingRepos) return 'loading...';
  var owners = ownersReachedBy(token).sort(compareCaseless);
  if (!owners.length) return 'no repositories yet';
  return 'sees ' + owners.map(function (owner) {
    return owner + (hasWritableRepo(owner) ? '' : ' (read only)');
  }).join(', ');
}

function tokenRowHtml(token, index) {
  return '<div class="d-flex align-items-center gap-2 border rounded p-2' +
           ' mb-1">' +
           '<code class="small">' + escapeHtml(maskToken(token)) + '</code>' +
           '<span class="small">' +
             escapeHtml(state.tokenLogin[token] || '') + '</span>' +
           '<span class="small text-body-secondary flex-grow-1">' +
             escapeHtml(tokenReachSummary(token)) + '</span>' +
           '<button type="button" class="btn btn-sm btn-outline-danger"' +
             ' data-revoke-token="' + index + '"' +
             ' title="Revoke at GitHub, everywhere and for good">' +
             'revoke</button>' +
           '<button type="button" class="btn btn-sm btn-outline-secondary"' +
             ' data-drop-token="' + index + '"' +
             ' title="Forget it in this browser only">' +
             '<i class="bi bi-trash"></i></button>' +
         '</div>';
}

function publicRepoRowHtml(fullName) {
  return '<div class="d-flex align-items-center gap-2 ps-3 pt-1">' +
           '<span class="small flex-grow-1">' +
             escapeHtml(repoNameOf(fullName)) + '</span>' +
           '<button type="button"' +
             ' class="btn btn-sm btn-outline-danger py-0 px-1"' +
             ' data-drop-repo="' + escapeHtml(fullName) + '"' +
             ' title="Remove ' + escapeHtml(fullName) + '">' +
             '<i class="bi bi-x-lg"></i></button>' +
         '</div>';
}

function publicOwnerHtml(owner, names) {
  var sorted = names.slice().sort(compareCaseless);
  var shown = sorted.slice(0, PUBLIC_ROWS_SHOWN);
  var hidden = sorted.length - shown.length;
  return '<div class="border rounded p-2 mb-1">' +
           '<div class="d-flex align-items-center gap-2">' +
             '<strong class="small flex-grow-1">' + escapeHtml(owner) +
               '</strong>' +
             '<span class="small text-body-secondary">' + sorted.length +
               (sorted.length === 1 ? ' repository' : ' repositories') +
               '</span>' +
             '<button type="button" class="btn btn-sm btn-outline-danger"' +
               ' data-drop-owner="' + escapeHtml(owner) + '"' +
               ' title="Remove all of ' + escapeHtml(owner) + '">' +
               '<i class="bi bi-trash"></i></button>' +
           '</div>' +
           shown.map(publicRepoRowHtml).join('') +
           (hidden > 0
             ? '<div class="small text-body-secondary ps-3 pt-1">and ' +
               hidden + ' more, too many to list</div>'
             : '') +
         '</div>';
}

function groupByOwner(fullNames) {
  var byOwner = {};
  fullNames.forEach(function (full) {
    var owner = ownerOf(full);
    byOwner[owner] = byOwner[owner] || [];
    byOwner[owner].push(full);
  });
  return byOwner;
}

function renderAccess() {
  var tokens = state.tokens.map(tokenRowHtml).join('');
  $('#token-list').html(tokens ||
    '<div class="small text-body-secondary">No tokens yet.</div>');

  var byOwner = groupByOwner(publicRepoNames());
  var owners = Object.keys(byOwner).sort(compareCaseless).map(function (o) {
    return publicOwnerHtml(o, byOwner[o]);
  }).join('');
  $('#public-list').html(owners ||
    '<div class="small text-body-secondary">Nothing added yet.</div>');
}

/* ---------- the repository picker ---------- */

function selectionLabel() {
  if (!state.selected.length) return 'Select repositories';
  if (state.selected.length === 1) return state.selected[0];
  var owners = Object.keys(groupByOwner(state.selected));
  if (owners.length > 1) {
    return state.selected.length + ' repositories, ' + owners.length +
           ' owners';
  }
  var owned = state.repos.filter(function (row) {
    return row.owner.login === owners[0];
  }).length;
  if (state.selected.length === owned) {
    return owners[0] + '/*  (' + owned + ')';
  }
  return owners[0] + '  (' + state.selected.length + ')';
}

function updateQueryCost() {
  if (!state.selected.length) {
    return $('#query-cost')
      .text('Nothing selected. Tick the repositories this board is for.');
  }
  var queries = queryGroupsFor(state.selected).length * QUADRANT_KEYS.length;
  $('#query-cost').text(state.selected.length + ' selected, ' + queries +
                        ' queries per load');
}

/* Nothing picked is the one state that needs the eye. */
function updatePickerButton() {
  var empty = !state.selected.length;
  $('#repo-button').text(selectionLabel())
                   .toggleClass('btn-outline-secondary', !empty)
                   .toggleClass('btn-warning', empty);
}

function pickerRowHtml(row, id, isSelected) {
  var badge = isWritable(row.full_name)
    ? ' <span class="badge badge-rw">RW</span>'
    : ' <span class="badge badge-ro">RO</span>';
  return '<div class="form-check">' +
           '<input class="form-check-input" type="checkbox" id="' + id + '"' +
             ' data-repo="' + escapeHtml(row.full_name) + '"' +
             (isSelected ? ' checked' : '') + '>' +
           '<label class="form-check-label" for="' + id + '">' +
             escapeHtml(row.name) +
             (row['private']
               ? ' <span class="badge text-bg-secondary">private</span>'
               : '') +
             badge +
           '</label>' +
         '</div>';
}

function pickerOwnerHtml(owner, rows) {
  return '<div class="mb-2">' +
           '<div class="d-flex justify-content-between align-items-center">' +
             '<strong class="small">' + escapeHtml(owner) + '</strong>' +
             '<span class="small">' +
               '<a href="#" data-all="' + escapeHtml(owner) + '">all</a> ' +
               '<a href="#" data-none="' + escapeHtml(owner) + '">none</a>' +
             '</span>' +
           '</div>' + rows +
         '</div>';
}

/* Your own account first, then alphabetical. */
function pickerOwnerOrder(owners) {
  var me = state.user && state.user.login;
  return owners.sort(function (a, b) {
    if (a === me) return -1;
    if (b === me) return 1;
    return compareCaseless(a, b);
  });
}

function matchingRepos() {
  var needle = String($('#repo-filter').val() || '').toLowerCase();
  if (!needle) return state.repos;
  return state.repos.filter(function (row) {
    return row.full_name.toLowerCase().indexOf(needle) >= 0;
  });
}

function renderPicker() {
  var byOwner = {};
  matchingRepos().forEach(function (row) {
    var owner = row.owner.login;
    byOwner[owner] = byOwner[owner] || [];
    byOwner[owner].push(row);
  });
  var isSelected = {};
  state.selected.forEach(function (full) { isSelected[full] = true; });

  /* One counter across the whole render: per owner it would repeat ids. */
  var nextId = 0;
  var html = pickerOwnerOrder(Object.keys(byOwner)).map(function (owner) {
    var rows = byOwner[owner].sort(function (a, b) {
      return compareCaseless(a.name, b.name);
    }).map(function (row) {
      nextId += 1;
      return pickerRowHtml(row, 'pick-' + nextId, isSelected[row.full_name]);
    }).join('');
    return pickerOwnerHtml(owner, rows);
  }).join('');

  $('#repo-list').html(html ||
    '<div class="small text-body-secondary">nothing matches</div>');
  updatePickerButton();
  updateQueryCost();
}

/* Opened when nothing is selected yet, so the list is the first thing seen. */
function openPicker() {
  try {
    bootstrap.Dropdown.getOrCreateInstance($('#repo-button')[0]).show();
  } catch (e) {}
}

function toggleSelection(fullName, wanted) {
  var at = state.selected.indexOf(fullName);
  if (wanted && at < 0) state.selected.push(fullName);
  if (!wanted && at >= 0) state.selected.splice(at, 1);
}

/* ---------- search queries ---------- */

function flagNamesFor(flag) {
  return flag === 'urgent' ? state.urgentNames : state.strategicNames;
}

function quoteLabel(name) {
  return '"' + String(name).replace(/"/g, '') + '"';
}

/* A quadrant asks for one flag set and the other cleared. With no configured
   name for a flag it must carry, the quadrant cannot be expressed at all. */
function flagTermsFor(wanted) {
  var terms = [];
  var impossible = false;
  FLAGS.forEach(function (flag) {
    var names = flagNamesFor(flag);
    if (!wanted[flag]) {
      names.forEach(function (name) {
        terms.push('-label:' + quoteLabel(name));
      });
      return;
    }
    if (!names.length) impossible = true;
    else terms.push('label:' + names.map(quoteLabel).join(','));  // comma ORs
  });
  return impossible ? null : terms.join(' ');
}

function longestFlagTerms() {
  return Math.max.apply(null, QUADRANT_KEYS.map(function (key) {
    return (flagTermsFor(QUADRANT_FLAGS[key]) || '').length;
  }));
}

/* Repeated repo: qualifiers are ORed by this endpoint. The boolean OR keyword
   is not accepted here at all: "(repo:a OR repo:b)" fails with 422. */
function repoTermsFor(fullNames) {
  return fullNames.map(function (full) { return 'repo:' + full; }).join(' ');
}

/* Open, closed, or no term at all, which is how search says "both". */
function issueStateTerm() {
  return state.issueState === 'all' ? '' : 'is:' + state.issueState;
}

/* org:/user: means every repository of that owner, which equals the selection
   only when the listing the picker was built from was complete. */
function coversWholeOwner(owner, picked) {
  var owned = state.repos.filter(function (row) {
    return row.owner.login === owner;
  }).length;
  return owned > 1 && picked.length === owned &&
         !!state.ownerFullyListed[owner];
}

function wholeOwnerGroup(owner, picked) {
  var prefix = state.ownerType[owner] === 'Organization' ? 'org:' : 'user:';
  return { owner: owner, repos: picked, q: prefix + owner };
}

/* Splits a sorted owner's repositories into as few queries as fit the cap. */
function chunkByBudget(owner, picked, budget) {
  var groups = [];
  var chunk = [];
  picked.forEach(function (full) {
    var grown = chunk.concat([full]);
    if (chunk.length && repoTermsFor(grown).length > budget) {
      groups.push({ owner: owner, repos: chunk, q: repoTermsFor(chunk) });
      chunk = [full];
      return;
    }
    chunk = grown;
  });
  if (chunk.length) {
    groups.push({ owner: owner, repos: chunk, q: repoTermsFor(chunk) });
  }
  return groups;
}

/* A selection becomes one query per owner, split again whenever it would
   outgrow GitHub's documented 256 character query. */
function queryGroupsFor(selection) {
  var byOwner = groupByOwner(selection);
  var fixedTerms = (' is:issue ' + issueStateTerm()).length + 1;
  var budget = QUERY_CHAR_CAP - longestFlagTerms() - fixedTerms;
  var groups = [];
  Object.keys(byOwner).sort(compareCaseless).forEach(function (owner) {
    var picked = byOwner[owner].slice().sort(compareCaseless);
    if (coversWholeOwner(owner, picked)) {
      groups.push(wholeOwnerGroup(owner, picked));
      return;
    }
    groups = groups.concat(chunkByBudget(owner, picked, budget));
  });
  return groups;
}

function searchSortField() {
  if (state.sort === 'comments') return 'comments';
  return state.sort.indexOf('created') === 0 ? 'created' : 'updated';
}

function searchUrl(group, quadrantKey, page) {
  var flags = flagTermsFor(QUADRANT_FLAGS[quadrantKey]);
  if (flags === null) return null;
  var stateTerm = issueStateTerm();
  var query = group.q + ' is:issue' +
              (stateTerm ? ' ' + stateTerm : '') +
              (flags ? ' ' + flags : '');
  return '/search/issues?per_page=' + issuesPerPage() +
         '&page=' + (page || 1) +
         '&sort=' + searchSortField() +
         '&order=' + (state.sort === 'created-asc' ? 'asc' : 'desc') +
         '&q=' + encodeURIComponent(query);
}

/* ---------- issues ---------- */

function resetBoard() {
  state.edit = { key: null, value: '' };
  state.issuesByKey = {};
  state.groups = [];
  QUADRANT_KEYS.forEach(function (key) {
    state.quadrants[key] =
      { items: []
      , total: 0
      , page: 1
      , pages: 1
      , loading: false
      , groupTotals: []
      , groupPages: []
      };
  });
}

/* Issue numbers repeat across repositories, so nothing is keyed by number. */
function repoOf(issue) {
  var found = /\/repos\/([^/]+\/[^/]+)/.exec(issue.repository_url || '');
  return found ? found[1] : (state.selected[0] || '');
}

function issueKeyOf(issue) {
  return repoOf(issue) + '#' + issue.number;
}

function findIssue(key) {
  var known = Object.prototype.hasOwnProperty.call(state.issuesByKey, key);
  return known ? state.issuesByKey[key] : null;
}

/* The same issue can arrive in two quadrants across a reload, so the tracked
   object is updated in place and every list keeps pointing at it. */
function trackIssue(issue) {
  var key = issueKeyOf(issue);
  var known = findIssue(key);
  if (known) return $.extend(known, issue);
  state.issuesByKey[key] = issue;
  return issue;
}

function loadIssues() {
  writeStoredJson(KEY.selected, state.selected);
  resetBoard();
  state.groups = queryGroupsFor(state.selected);
  render();
  if (!state.groups.length) return;
  QUADRANT_KEYS.forEach(function (key) { fetchQuadrant(key, 1); });
}

/* A 422 is GitHub saying the token cannot search those repositories, which is
   what a fine grained token does for an owner it was not granted. Public
   repositories need no token, so drop it and remember that. */
function searchGroup(group, url, collect, failure) {
  var authorised = !state.searchAnonymously[group.owner];
  var options = authorised ? { owner: group.owner } : { anon: true };
  return apiRequest(url, options).then(collect, function (jq) {
    if (jq.status !== 422 || !authorised) {
      failure.jq = jq;
      return;
    }
    state.searchAnonymously[group.owner] = true;
    return apiRequest(url, { anon: true }).then(collect, function (retried) {
      failure.jq = retried;
    });
  });
}

function quadrantRequests(quadrant, quadrantKey, page, results, failure) {
  return state.groups.map(function (group, index) {
    var beyondThisGroup = page > 1 && quadrant.groupPages[index] &&
                          page > quadrant.groupPages[index];
    if (beyondThisGroup) return null;
    var url = searchUrl(group, quadrantKey, page);
    if (!url) return null;
    var collect = function (body) {
      results.push({ index: index
                   , total: body.total_count || 0
                   , items: body.items || []
                   });
    };
    return searchGroup(group, url, collect, failure);
  });
}

function applyQuadrantTotals(quadrant, results) {
  results.forEach(function (result) {
    quadrant.groupTotals[result.index] = result.total;
    quadrant.groupPages[result.index] = pageCountFor(result.total);
  });
  quadrant.total = quadrant.groupTotals.reduce(function (sum, count) {
    return sum + (count || 0);
  }, 0);
  quadrant.pages = Math.max.apply(
    null, [1].concat(quadrant.groupPages.filter(Boolean)));
}

/* Each group sorts its own results, so concatenating them would order the
   quadrant by group first and by the chosen sort only within a group. */
function applyQuadrantItems(quadrant, results, page) {
  quadrant.page = page;
  quadrant.items = results
    .reduce(function (all, result) {
      return all.concat(result.items.map(trackIssue));
    }, [])
    .sort(sorterFor(state.sort));
}

function fetchQuadrant(quadrantKey, page) {
  var quadrant = state.quadrants[quadrantKey];
  if (!state.groups.length || quadrant.loading) return;
  quadrant.loading = true;
  setBusy(true);
  render();

  var results = [];
  var failure = { jq: null };
  var calls = quadrantRequests(quadrant, quadrantKey, page, results, failure);

  $.when.apply($, calls).always(function () {
    applyQuadrantTotals(quadrant, results);
    quadrant.loading = false;
    setBusy(false);
    /* Nothing came back, so keep the cards and the page number that are on
       screen rather than reporting an empty quadrant. */
    if (results.length) applyQuadrantItems(quadrant, results, page);
    if (failure.jq) reportApiError(failure.jq);
    render();
  });
}

/* ---------- classifying a card ---------- */

function flagsOf(issue) {
  var present = {};
  (issue.labels || []).forEach(function (label) {
    present[String(label.name || label).toLowerCase()] = true;
  });
  var carries = function (names) {
    return names.some(function (name) { return present[name]; });
  };
  return { urgent: carries(state.urgentNames)
         , strategic: carries(state.strategicNames)
         };
}

function quadrantForFlags(flags) {
  if (flags.urgent && flags.strategic) return 'now';
  if (flags.strategic) return 'ongoing';
  if (flags.urgent) return 'respond';
  return 'unsorted';
}

function quadrantOf(issue) {
  return quadrantForFlags(flagsOf(issue));
}

/* Every listed repository carries the requester's own permissions, so
   writability is read off the listing rather than guessed from which token
   saw it. Triage is the role GitHub gives for managing issues and labels and
   it reports push:false, so pushing is the wrong question to ask. */
function isWritable(fullName) {
  var granted = (state.repoMeta[fullName] || {}).permissions || {};
  var mayWrite = granted.push || granted.triage ||
                 granted.maintain || granted.admin;
  return !!mayWrite && !state.refusedWrites[fullName];
}

/* Writable says the account may; this says a token for it is actually here. */
function canWrite(fullName) {
  return isWritable(fullName) && !!state.ownerToken[ownerOf(fullName)];
}

function issueMatches(issue, needle) {
  if (('#' + issue.number).indexOf(needle) === 0) return true;
  if (String(issue.title).toLowerCase().indexOf(needle) >= 0) return true;
  if (repoOf(issue).toLowerCase().indexOf(needle) >= 0) return true;
  return (issue.labels || []).some(function (label) {
    return String(label.name || label).toLowerCase().indexOf(needle) >= 0;
  });
}

function sorterFor(mode) {
  return function (a, b) {
    if (mode === 'comments') return b.comments - a.comments;
    if (mode === 'created') {
      return new Date(b.created_at) - new Date(a.created_at);
    }
    if (mode === 'created-asc') {
      return new Date(a.created_at) - new Date(b.created_at);
    }
    return new Date(b.updated_at) - new Date(a.updated_at);
  };
}

/* ---------- drawing a card ---------- */

/* Letter and hover text come from the configured label, so the pill says what
   the repository says rather than what this file was written with. */
function flagPill(flag, isOn, variant, mayWrite) {
  var name = flagNamesFor(flag)[0] || flag;
  return '<button type="button" class="btn btn-flag btn-' +
           (isOn ? '' : 'outline-') + variant + '"' +
           (mayWrite ? '' : ' disabled') +
           ' data-flag="' + flag + '"' +
           ' title="' + escapeHtml(name) + '">' +
           escapeHtml(name.charAt(0).toUpperCase()) +
         '</button>';
}

function labelBadgesHtml(issue) {
  return (issue.labels || []).map(function (label) {
    var name = label.name || label;
    var color = hexColor(label.color, '6c757d');
    return '<span class="badge" style="background:#' + escapeHtml(color) +
             ';color:' + readableTextOn(color) + '">' +
             escapeHtml(name) +
           '</span>';
  }).join(' ');
}

function assigneesHtml(issue) {
  return (issue.assignees || []).map(function (person) {
    return '<img src="' + escapeHtml(person.avatar_url) + '&s=36"' +
             ' width="18" height="18" alt=""' +
             ' title="' + escapeHtml(person.login) + '">';
  }).join('');
}

function editingHeadHtml(issue) {
  return '<div class="d-flex gap-2 justify-content-between' +
           ' align-items-start">' +
           '<input class="form-control edit-title flex-grow-1" value="' +
             escapeHtml(state.edit.value) + '">' +
           '<span class="text-nowrap d-flex align-items-center gap-1">' +
             '<button type="button" class="btn btn-flag btn-success"' +
               ' data-edit="save" title="Save">' +
               '<i class="bi bi-check-lg"></i></button>' +
             '<button type="button"' +
               ' class="btn btn-flag btn-outline-secondary"' +
               ' data-edit="cancel" title="Cancel">' +
               '<i class="bi bi-x-lg"></i></button>' +
             '<span class="small text-body-secondary">#' + issue.number +
               '</span>' +
           '</span>' +
         '</div>';
}

function cardHeadHtml(issue, flags, mayWrite) {
  return '<div class="d-flex gap-2 justify-content-between' +
           ' align-items-start">' +
           '<a class="issue-title text-decoration-none" draggable="false"' +
             ' target="_blank" rel="noopener"' +
             ' href="' + escapeHtml(issue.html_url) + '">' +
             escapeHtml(issue.title) + '</a>' +
           '<span class="text-nowrap d-flex align-items-center gap-1">' +
             (mayWrite
               ? '<button type="button"' +
                 ' class="btn btn-flag btn-outline-secondary"' +
                 ' data-edit="start" title="Edit title">' +
                 '<i class="bi bi-pencil"></i></button>'
               : '') +
             flagPill('urgent', flags.urgent, 'danger', mayWrite) +
             flagPill('strategic', flags.strategic, 'primary', mayWrite) +
             '<span class="small text-body-secondary">#' + issue.number +
               '</span>' +
           '</span>' +
         '</div>';
}

function cardMetaHtml(issue, repo) {
  var labels = labelBadgesHtml(issue);
  var people = assigneesHtml(issue);
  return '<div class="issue-meta small text-body-secondary mt-1">' +
           (issue.state === 'closed'
             ? '<span class="badge text-bg-secondary">closed</span>' : '') +
           (state.selected.length > 1
             ? '<span class="fw-semibold">' +
               escapeHtml(repoNameOf(repo)) + '</span>' : '') +
           (people ? '<span>' + people + '</span>' : '') +
           (labels ? '<span class="issue-labels">' + labels + '</span>' : '') +
           (issue.comments
             ? '<span><i class="bi bi-chat"></i> ' + issue.comments +
               '</span>' : '') +
           '<span>updated ' + escapeHtml(timeAgo(issue.updated_at)) +
             '</span>' +
         '</div>';
}

function issueCard(issue) {
  var repo = repoOf(issue);
  var mayWrite = canWrite(repo);
  var isEditing = state.edit.key === issueKeyOf(issue);
  var head = isEditing
    ? editingHeadHtml(issue)
    : cardHeadHtml(issue, flagsOf(issue), mayWrite);
  return '<div class="list-group-item issue py-2' +
           (issue.state === 'closed' ? ' issue-closed' : '') + '"' +
           ' data-issue="' + escapeHtml(issueKeyOf(issue)) + '"' +
           (mayWrite && !isEditing ? ' draggable="true"' : '') + '>' +
           head + cardMetaHtml(issue, repo) +
         '</div>';
}

/* ---------- drawing the board ---------- */

/* The shadow is a claim about the content, so it is re-checked on scroll as
   well as after a render, or it lies once you reach the bottom. */
function markScrollable(element) {
  if (!element || typeof element.scrollHeight !== 'number') return;
  var hidden = element.scrollHeight - element.clientHeight -
               element.scrollTop;
  $(element).toggleClass('has-more', hidden > 2);
}

function visibleItems(quadrant) {
  if (!state.filter) return quadrant.items.slice();
  var needle = state.filter.toLowerCase();
  return quadrant.items.filter(function (issue) {
    return issueMatches(issue, needle);
  });
}

function renderQuadrantList($list, quadrant, quadrantKey, isLive) {
  var rows = visibleItems(quadrant);
  $list.empty();
  if (rows.length) {
    $list.append(rows.map(issueCard).join(''));
  } else if (!isLive) {
    $list.append('<div class="quadrant-blurb text-body-secondary">' +
                 escapeHtml(quadrantBlurb(quadrantKey)) + '</div>');
  } else if (!quadrant.loading) {
    $list.append('<div class="empty-quadrant text-body-secondary small">' +
                 'Empty</div>');
  }
  $list.each(function () { markScrollable(this); });
}

function quadrantStatusText(quadrant) {
  if (quadrant.loading) return 'loading';
  if (!quadrant.total) return 'no issues';
  var text = quadrant.total + ' issue' + (quadrant.total === 1 ? '' : 's');
  var capped = quadrant.groupTotals.some(function (total) {
    return total > SEARCH_RESULT_CAP;
  });
  if (capped) {
    text += ', search reaches the first ' + SEARCH_RESULT_CAP + ' per query';
  }
  return text;
}

function renderQuadrantFooter(quadrant, quadrantKey) {
  $('[data-status="' + quadrantKey + '"]')
    .text(quadrantStatusText(quadrant));
  $('[data-pager="' + quadrantKey + '"]')
    .toggleClass('d-none', quadrant.pages <= 1);
  $('[data-pageno="' + quadrantKey + '"]')
    .text(quadrant.page + ' / ' + quadrant.pages);
  var $foot = $('[data-foot="' + quadrantKey + '"]');
  $foot.find('[data-page="prev"]').prop('disabled', quadrant.page <= 1);
  $foot.find('[data-page="next"]')
       .prop('disabled', quadrant.page >= quadrant.pages);
}

function render() {
  var isLive = state.selected.length > 0;
  QUADRANT_KEYS.forEach(function (quadrantKey) {
    var quadrant = state.quadrants[quadrantKey];
    $('[data-count="' + quadrantKey + '"]').text(isLive ? quadrant.total : 0);
    renderQuadrantList($('[data-list="' + quadrantKey + '"]'), quadrant,
                       quadrantKey, isLive);
    $('[data-foot="' + quadrantKey + '"]').toggleClass('d-none', !isLive);
    if (isLive) renderQuadrantFooter(quadrant, quadrantKey);
  });
  if (state.edit.key) focusTitleEditor();
}

function focusTitleEditor() {
  var element = $('.edit-title')[0];
  if (!element || typeof element.focus !== 'function') return;
  element.focus();
  if (typeof element.setSelectionRange !== 'function') return;
  element.setSelectionRange(element.value.length, element.value.length);
}

/* ---------- writing flags back ---------- */

/* One list per quadrant, so a moved card is carried over by hand. */
function moveCardBetweenQuadrants(issue, from, to) {
  if (from === to) return;
  var items = state.quadrants[from].items;
  var at = items.indexOf(issue);
  if (at >= 0) items.splice(at, 1);
  state.quadrants[from].total = Math.max(0, state.quadrants[from].total - 1);
  state.quadrants[to].items.unshift(issue);
  state.quadrants[to].total += 1;
}

/* Why a write was refused. Only 'forbidden' is a fact about access; 'stale'
   means this board's copy is out of date, not that access is gone. */
function writeFailureKind(jq) {
  if (isTemporaryRefusal(jq)) return 'temporary';
  if (!jq) return 'other';
  if (jq.status === 404) return 'stale';
  if (jq.status === 403) return 'forbidden';
  return 'other';
}

function reportWriteFailure(jq, repo, what) {
  var kind = writeFailureKind(jq);
  if (kind === 'temporary') {
    var why = (jq.responseJSON && jq.responseJSON.message) || 'rate limited';
    toast('GitHub refused that ' + what + ' for now: ' + why +
          '. Try again shortly.', 'warning');
  } else if (kind === 'stale') {
    toast('That issue or label is no longer what this board thought. ' +
          'Reloading it.', 'warning');
  } else if (kind === 'forbidden') {
    state.refusedWrites[repo] = true;
    writeStoredJson(KEY.refusedWrites, Object.keys(state.refusedWrites));
    toast('No token can write ' + repo + ', so it is marked read only.',
          'warning');
    renderPicker();
  } else if (jq) {
    reportApiError(jq);
  }
  return kind;
}

function startEdit(key) {
  var issue = findIssue(key);
  if (!issue || !canWrite(repoOf(issue))) return;
  state.edit = { key: key, value: issue.title };
  render();
}

function cancelEdit() {
  state.edit = { key: null, value: '' };
  render();
}

/* PATCH on the issue, which is the only endpoint for a title. Everything else
   this board writes goes through the labels sub-resource instead. */
function saveTitle() {
  var key = state.edit.key;
  var title = String(state.edit.value || '').trim();
  var issue = findIssue(key);
  state.edit = { key: null, value: '' };
  if (!issue || !title || title === issue.title) return render();

  var repo = repoOf(issue);
  if (!canWrite(repo)) {
    render();
    return toast('No token can write ' + repo + '.', 'warning');
  }

  var before = issue.title;
  issue.title = title;
  render();

  setBusy(true);
  apiRequest('/repos/' + repo + '/issues/' + issue.number,
             { method: 'PATCH', body: { title: title }, owner: ownerOf(repo) })
    .done(function (fresh) {
      if (fresh && fresh.title) issue.title = fresh.title;
      render();
    })
    .fail(function (jq) {
      issue.title = before;
      reportWriteFailure(jq, repo, 'rename');
      render();
    })
    .always(function () { setBusy(false); });
}

/* Which labels to add and which to remove for a move, by name. missing names
   a flag the move needs but settings has no label for. */
function labelChangeFor(issue, have, wanted) {
  var change = { add: [], remove: [], missing: null };
  FLAGS.forEach(function (flag) {
    if (have[flag] === wanted[flag]) return;
    var names = flagNamesFor(flag);
    if (wanted[flag]) {
      if (!names[0]) change.missing = flag;
      else change.add.push(names[0]);
      return;
    }
    (issue.labels || []).forEach(function (label) {
      var name = String(label.name || label);
      if (names.indexOf(name.toLowerCase()) >= 0) change.remove.push(name);
    });
  });
  return change;
}

/* The card moves before the write lands, so the board answers immediately. */
function applyLabelsLocally(issue, change) {
  return (issue.labels || [])
    .filter(function (label) {
      return change.remove.indexOf(String(label.name || label)) < 0;
    })
    .concat(change.add.map(function (name) {
      var isUrgent = state.urgentNames.indexOf(name.toLowerCase()) >= 0;
      var flag = isUrgent ? 'urgent' : 'strategic';
      return { name: name, color: hexColor(state.flagColors[flag], '6c757d') };
    }));
}

/* The labels sub-resource rather than PATCH on the issue, so labels this
   board knows nothing about are never clobbered. */
function labelWriteSteps(repo, issue, change) {
  var owner = ownerOf(repo);
  var base = '/repos/' + repo + '/issues/' + issue.number + '/labels';
  var steps = [];
  if (change.add.length) {
    steps.push(function () {
      return apiRequest(base,
                        { method: 'POST'
                        , body: { labels: change.add }
                        , owner: owner
                        });
    });
  }
  change.remove.forEach(function (name) {
    steps.push(function () {
      return apiRequest(base + '/' + encodeURIComponent(name),
                        { method: 'DELETE', owner: owner });
    });
  });
  return steps;
}

/* Some of the label calls may already have landed, so ask the server what the
   issue looks like rather than assuming the whole move was refused. */
function reconcileIssue(key, issue, repo) {
  state.writingKeys[key] = true;          // still ours until this lands
  apiRequest('/repos/' + repo + '/issues/' + issue.number,
             { owner: ownerOf(repo) })
    .done(function (fresh) {
      if (!fresh || !fresh.labels || findIssue(key) !== issue) return;
      var wasIn = quadrantOf(issue);
      issue.labels = fresh.labels;
      moveCardBetweenQuadrants(issue, wasIn, quadrantOf(issue));
      render();
    })
    .always(function () { delete state.writingKeys[key]; });
}

function moveIssue(key, to) {
  var issue = findIssue(key);
  if (!issue || !QUADRANT_FLAGS[to]) return;
  var repo = repoOf(issue);
  if (!canWrite(repo)) {
    return toast('No token can write to ' + repo + '.', 'warning');
  }
  var have = flagsOf(issue);
  var from = quadrantForFlags(have);
  if (from === to) return;

  var change = labelChangeFor(issue, have, QUADRANT_FLAGS[to]);
  if (change.missing) {
    return toast('No ' + change.missing + ' label configured in settings.',
                 'warning');
  }
  if (!change.add.length && !change.remove.length) return;
  if (state.writingKeys[key]) {
    return toast('That card is still being written.', 'secondary');
  }
  state.writingKeys[key] = true;

  var before = (issue.labels || []).slice();
  issue.labels = applyLabelsLocally(issue, change);
  moveCardBetweenQuadrants(issue, from, to);
  render();

  setBusy(true);
  runInOrder(labelWriteSteps(repo, issue, change))
    .done(function (labels) {
      if (Array.isArray(labels)) issue.labels = labels;
      /* The server may disagree if someone else relabelled it meanwhile. */
      moveCardBetweenQuadrants(issue, to, quadrantOf(issue));
      render();
    })
    .fail(function (jq) {
      issue.labels = before;
      moveCardBetweenQuadrants(issue, to, from);
      var kind = reportWriteFailure(jq, repo, 'move');
      /* Only these two mean the server may hold something this board does
         not; a rate limit or an outage is the wrong moment to ask again. */
      if (kind === 'stale' || kind === 'forbidden') {
        reconcileIssue(key, issue, repo);
      }
      render();
    })
    .always(function () {
      delete state.writingKeys[key];
      setBusy(false);
    });
}

/* ---------- settings and the flag labels ---------- */

function configLabel(flag) {
  return (CONFIG.labels || {})[flag] || {};
}

function configQuadrantColor(quadrantKey) {
  return hexColor((CONFIG.quadrantColors || {})[quadrantKey], '6c757d');
}

function loadSettings() {
  var urgent = readStored(KEY.urgentNames) ||
               (configLabel('urgent').names || ['urgent']).join(',');
  var strategic = readStored(KEY.strategicNames) ||
                  (configLabel('strategic').names || ['strategic']).join(',');
  state.urgentNames = parseLabels(urgent);
  state.strategicNames = parseLabels(strategic);

  var savedFlags = readStoredObject(KEY.flagColors);
  state.flagColors =
    { urgent: hexColor(savedFlags.urgent,
                       hexColor(configLabel('urgent').color, '999999'))
    , strategic: hexColor(savedFlags.strategic,
                          hexColor(configLabel('strategic').color, '999999'))
    };

  var savedQuadrants = readStoredObject(KEY.quadrantColors);
  state.quadrantColors = {};
  QUADRANT_KEYS.forEach(function (key) {
    state.quadrantColors[key] = hexColor(savedQuadrants[key],
                                         configQuadrantColor(key));
  });
}

/* What the settings dialog currently shows, before it is saved. */
function readSettingsDraft() {
  return {
    urgent: parseLabels($('#urgent-labels').val()),
    strategic: parseLabels($('#strategic-labels').val()),
    colors:
      { urgent: hexColor($('#urgent-color').val(),
                         configLabel('urgent').color || '999999')
      , strategic: hexColor($('#strategic-color').val(),
                            configLabel('strategic').color || '999999')
      },
    quadColors: QUADRANT_KEYS.reduce(function (colors, key) {
      colors[key] = hexColor($('#quad-color-' + key).val(),
                             configQuadrantColor(key));
      return colors;
    }, {})
  };
}

function paintQuadrant(quadrantKey, color) {
  $('.q-' + quadrantKey).css('--q', '#' + color);
  $('[data-count="' + quadrantKey + '"]')
    .css({ background: '#' + color, color: readableTextOn(color) });
}

/* The accent drives the card's top rule through --q, and the count badge. */
function applyQuadrantColors() {
  QUADRANT_KEYS.forEach(function (key) {
    paintQuadrant(key, hexColor(state.quadrantColors[key],
                                configQuadrantColor(key)));
  });
}

/* The long description lives in the header's tooltip. Stripped of the "Name
   (Axis, Axis): " opening the header already says, it is the empty board's
   copy. */
function quadrantBlurb(quadrantKey) {
  var tip = $('.q-' + quadrantKey + ' [data-bs-toggle="tooltip"]')
    .attr('data-bs-title') || '';
  /* The attribute is wrapped across lines in the markup, so its newlines and
     indentation collapse here rather than at every place it is shown. */
  return tip.replace(/^[^:]*:\s*/, '').replace(/\s+/g, ' ').trim();
}

/* The names live in the markup, so the dialog reads them rather than
   repeating them. */
function quadrantName(quadrantKey) {
  var shown = $('.q-' + quadrantKey).find('.fw-semibold').first().text();
  return shown || quadrantKey;
}

/* One GitHub label: the first configured name, the chosen colour, and the
   description from config, which is where a team's definition belongs. */
function labelSpecFor(flag, draft) {
  var configured = configLabel(flag);
  var names = flag === 'urgent' ? draft.urgent : draft.strategic;
  return { name: names[0] || flag
         , color: hexColor((draft.colors || {})[flag],
                           hexColor(configured.color, '999999'))
         , description: String(configured.description || '')
         };
}

/* The two flags mean the same thing everywhere, so they are written to every
   selected repository that will take them. */
function writableSelection() {
  return state.selected.filter(canWrite);
}

var LABEL_DESCRIPTION_CAP = 100;   // GitHub's limit, not ours

function labelPreviewRowHtml(spec) {
  var length = spec.description.length;
  var overLong = length > LABEL_DESCRIPTION_CAP;
  return '<div class="d-flex align-items-start gap-2 mb-1">' +
           '<span class="badge" style="background:#' +
             escapeHtml(spec.color) + ';color:' +
             readableTextOn(spec.color) + '">' +
             escapeHtml(spec.name) + '</span>' +
           '<span class="small text-body-secondary flex-grow-1">' +
             escapeHtml(spec.description) + '</span>' +
           '<span class="small text-nowrap ' +
             (overLong ? 'text-danger fw-bold' : 'text-body-secondary') +
             '">' + length + '/' + LABEL_DESCRIPTION_CAP + '</span>' +
         '</div>';
}

function labelTargetText(targets) {
  if (targets.length === 1) return targets[0];
  if (targets.length) return targets.length + ' selected repositories';
  return 'nothing writable';
}

function labelHelpText(targets) {
  if (!targets.length) {
    return 'None of the selected repositories can be written to, so there ' +
           'is nowhere to put these.';
  }
  var skipped = state.selected.length - targets.length;
  return 'Writes exactly what is shown, to every selected repository. An ' +
         'existing label keeps its name and gets this colour and ' +
         'description.' +
         (skipped
           ? ' ' + skipped + ' read only one' + (skipped === 1 ? '' : 's') +
             ' will be skipped.'
           : '');
}

function renderLabelPreview() {
  var draft = readSettingsDraft();
  $('#label-preview').html(FLAGS.map(function (flag) {
    return labelPreviewRowHtml(labelSpecFor(flag, draft));
  }).join(''));
  var targets = writableSelection();
  $('#label-repo').text(labelTargetText(targets));
  $('#label-help').text(labelHelpText(targets));
  $('#make-labels').prop('disabled', !targets.length);
}

/* GitHub has no upsert for a label, so look first: PATCH if it is there, POST
   if it is not. Any other failure is the repository refusing. */
function upsertLabelStep(repo, spec, tally) {
  var owner = ownerOf(repo);
  var url = '/repos/' + repo + '/labels/' + encodeURIComponent(spec.name);
  var body = { color: spec.color, description: spec.description };
  return function () {
    return apiRequest(url, { owner: owner })
      .then(function () {
        return apiRequest(url, { method: 'PATCH', body: body, owner: owner });
      }, function (jq) {
        if (jq.status !== 404) return $.Deferred().reject(jq).promise();
        return apiRequest('/repos/' + repo + '/labels',
                          { method: 'POST', body: spec, owner: owner });
      })
      .then(function () { tally.written += 1; },
            function () {
              /* one repository refusing must not abandon the rest */
              if (tally.failed.indexOf(repo) < 0) tally.failed.push(repo);
            });
  };
}

function labelsWrittenText(tally, targets) {
  var reached = targets.length - tally.failed.length;
  return tally.written + ' label' + (tally.written === 1 ? '' : 's') +
         ' written across ' + reached + ' of ' + targets.length +
         ' repositories' +
         (tally.failed.length ? ', refused by ' + tally.failed.join(', ') : '')
         + '.';
}

function writeFlagLabels() {
  var targets = writableSelection();
  if (!targets.length) return;
  var draft = readSettingsDraft();
  var specs = FLAGS.map(function (flag) {
    return labelSpecFor(flag, draft);
  });
  var overLong = specs.filter(function (spec) {
    return spec.description.length > LABEL_DESCRIPTION_CAP;
  })[0];
  if (overLong) {
    return toast('GitHub caps a label description at ' +
                 LABEL_DESCRIPTION_CAP + ' characters. Shorten ' +
                 overLong.name + '.', 'warning');
  }

  var tally = { written: 0, failed: [] };
  var steps = [];
  targets.forEach(function (repo) {
    specs.forEach(function (spec) {
      steps.push(upsertLabelStep(repo, spec, tally));
    });
  });

  setBusy(true);
  runInOrder(steps)
    .done(function () {
      toast(labelsWrittenText(tally, targets),
            tally.failed.length ? 'warning' : 'success');
    })
    .fail(function (jq) {
      if (jq && (jq.status === 403 || jq.status === 404)) {
        return toast('This token cannot manage labels. It needs Issues: ' +
                     'read and write.', 'warning');
      }
      if (jq) reportApiError(jq);
    })
    .always(function () { setBusy(false); });
}

/* ---------- wiring ---------- */

function bindAccessDialog() {
  $('#new-token-link').attr('href', NEW_TOKEN_URL);

  $('#add-token, #open-access').on('click', function () {
    renderAccess();
    bootstrap.Modal.getOrCreateInstance('#access').show();
  });

  $('#pat-form').on('submit', function (e) {
    e.preventDefault();
    var token = String($('#pat').val() || '').trim();
    if (!token) return;
    $('#pat').val('');
    addToken(token);
  });

  $('#anon-form').on('submit', function (e) {
    e.preventDefault();
    addPublicRepo($('#anon-repo').val());
  });

  $('#token-list').on('click', '[data-drop-token]', function () {
    dropToken(Number($(this).attr('data-drop-token')));
  });

  $('#token-list').on('click', '[data-revoke-token]', function () {
    revokeToken(Number($(this).attr('data-revoke-token')));
  });

  $('#public-list').on('click', '[data-drop-owner]', function () {
    var owner = $(this).attr('data-drop-owner');
    dropPublic(function (full) { return ownerOf(full) === owner; });
  });

  $('#public-list').on('click', '[data-drop-repo]', function (e) {
    e.preventDefault();
    var fullName = $(this).attr('data-drop-repo');
    dropPublic(function (full) { return full === fullName; });
  });
}

function bindSignOut() {
  $('#logout').on('click', function () {
    if (!state.tokens.length) return signOut();
    var count = state.tokens.length;
    $('#signout-count').text(count + ' token' + (count === 1 ? '' : 's'));
    $('#signout-reset').prop('checked', false);
    bootstrap.Modal.getOrCreateInstance('#signout').show();
  });

  $('#signout-go').on('click', function () {
    bootstrap.Modal.getOrCreateInstance('#signout').hide();
    if ($('#signout-reset').prop('checked')) resetSettings();
    signOut();
  });
}

function bindPicker() {
  /* The picker stays open while boxes are ticked; the board reloads once, on
     close, rather than once per click. */
  var selectionOnOpen = '';
  $('#repo-picker')
    .on('show.bs.dropdown', function () {
      selectionOnOpen = state.selected.slice().sort().join();
    })
    .on('hidden.bs.dropdown', function () {
      $('#repo-filter').val('');
      renderPicker();
      if (state.selected.slice().sort().join() !== selectionOnOpen) {
        loadIssues();
      }
    });

  $('#repo-list').on('change', 'input[type=checkbox]', function () {
    toggleSelection($(this).attr('data-repo'), this.checked);
    updatePickerButton();
    updateQueryCost();
  });

  $('#repo-list').on('click', '[data-all], [data-none]', function (e) {
    e.preventDefault();
    var owner = $(this).attr('data-all') || $(this).attr('data-none');
    var wanted = !!$(this).attr('data-all');
    state.repos.forEach(function (row) {
      if (row.owner.login !== owner) return;
      toggleSelection(row.full_name, wanted);
    });
    renderPicker();
  });

  $('#repo-filter').on('input', renderPicker);
}

var FILTER_DEBOUNCE_MS = 150;

function bindToolbar() {
  $('#refresh').on('click', loadIssues);

  /* Sorting and the open/closed filter are both part of the query, so both
     reload rather than re-render. */
  $('#sort').on('change', function () {
    state.sort = $(this).val();
    loadIssues();
  });
  $('#state').on('change', function () {
    state.issueState = $(this).val();
    loadIssues();
  });

  var pending = null;
  $('#filter').on('input', function () {
    var text = $(this).val();
    clearTimeout(pending);
    pending = setTimeout(function () {
      state.filter = text;
      render();
    }, FILTER_DEBOUNCE_MS);
  });

  $(document).on('click', '[data-page]', function () {
    var quadrantKey = $(this).closest('[data-foot]').attr('data-foot');
    var quadrant = state.quadrants[quadrantKey];
    var wanted = $(this).attr('data-page') === 'next'
      ? quadrant.page + 1
      : quadrant.page - 1;
    if (wanted >= 1 && wanted <= quadrant.pages) {
      fetchQuadrant(quadrantKey, wanted);
    }
  });
}

function bindSettingsDialog() {
  $('#settings-btn').on('click', function () {
    $('#urgent-labels').val(state.urgentNames.join(', '));
    $('#strategic-labels').val(state.strategicNames.join(', '));
    $('#urgent-color').val('#' + state.flagColors.urgent);
    $('#strategic-color').val('#' + state.flagColors.strategic);
    QUADRANT_KEYS.forEach(function (key) {
      $('#quad-color-' + key).val('#' + state.quadrantColors[key]);
      $('#quad-name-' + key).text(quadrantName(key));
    });
    renderLabelPreview();
    bootstrap.Modal.getOrCreateInstance('#settings').show();
  });

  /* Colours preview on the board behind the dialog while you pick them. */
  $('#settings').on('input', 'input', function () {
    renderLabelPreview();
    var draft = readSettingsDraft();
    QUADRANT_KEYS.forEach(function (key) {
      paintQuadrant(key, draft.quadColors[key]);
    });
  });

  $('#make-labels').on('click', writeFlagLabels);

  $('#settings-form').on('submit', function (e) {
    e.preventDefault();
    var draft = readSettingsDraft();
    state.urgentNames = draft.urgent;
    state.strategicNames = draft.strategic;
    state.flagColors = draft.colors;
    state.quadrantColors = draft.quadColors;
    writeStored(KEY.urgentNames, state.urgentNames.join(','));
    writeStored(KEY.strategicNames, state.strategicNames.join(','));
    writeStoredJson(KEY.flagColors, state.flagColors);
    writeStoredJson(KEY.quadrantColors, state.quadrantColors);
    applyQuadrantColors();
    bootstrap.Modal.getOrCreateInstance('#settings').hide();
    loadIssues();      // the labels are the query
  });
}

function bindCards() {
  $(document).on('click', '[data-edit]', function (e) {
    e.preventDefault();
    var what = $(this).attr('data-edit');
    if (what === 'start') {
      return startEdit($(this).closest('.issue').attr('data-issue'));
    }
    if (what === 'cancel') return cancelEdit();
    saveTitle();
  });

  /* The draft lives in state, so a fetch landing mid edit cannot swallow it. */
  $(document).on('input', '.edit-title', function () {
    state.edit.value = $(this).val();
  });

  $(document).on('keydown', '.edit-title', function (e) {
    if (e.which === 13) {
      e.preventDefault();
      state.edit.value = $(this).val();
      saveTitle();
    }
    if (e.which === 27) {
      e.preventDefault();
      cancelEdit();
    }
  });

  /* Flag toggles: the touch friendly half of "move between quadrants". */
  $(document).on('click', '.btn-flag', function (e) {
    e.preventDefault();
    var key = $(this).closest('.issue').attr('data-issue');
    var issue = findIssue(key);
    if (!issue) return;
    var flags = flagsOf(issue);
    var flag = $(this).attr('data-flag');
    flags[flag] = !flags[flag];
    moveIssue(key, quadrantForFlags(flags));
  });
}

/* Native HTML5 drag and drop, no extra library. */
function bindDragAndDrop() {
  $(document)
    .on('dragstart', '.issue', function (e) {
      var key = $(this).attr('data-issue');
      e.originalEvent.dataTransfer.setData('text/plain', key);
      e.originalEvent.dataTransfer.effectAllowed = 'move';
      $(this).addClass('dragging');
    })
    .on('dragend', '.issue', function () {
      $(this).removeClass('dragging');
      $('.drop-target').removeClass('drop-target');
    })
    .on('dragover', '[data-list]', function (e) {
      e.preventDefault();
      e.originalEvent.dataTransfer.dropEffect = 'move';
      $(this).addClass('drop-target');
    })
    .on('dragleave', '[data-list]', function () {
      $(this).removeClass('drop-target');
    })
    .on('drop', '[data-list]', function (e) {
      e.preventDefault();
      $(this).removeClass('drop-target');
      var key = e.originalEvent.dataTransfer.getData('text/plain');
      if (key) moveIssue(key, $(this).attr('data-list'));
    });
}

function bind() {
  $('[data-bs-toggle="tooltip"]').each(function () {
    new bootstrap.Tooltip(this);
  });
  applyQuadrantColors();

  /* scroll does not bubble, so these four are bound directly. The elements
     are never replaced, only their contents. */
  $('[data-list]').on('scroll', function () { markScrollable(this); });

  bindAccessDialog();
  bindSignOut();
  bindPicker();
  bindToolbar();
  bindSettingsDialog();
  bindCards();
  bindDragAndDrop();
}

/* ---------- start ---------- */

/* Settings saved by an older version of this page, moved to where it looks
   now. Each runs once: it clears the old key as it goes. */
function migrateOldKeys() {
  var oldFlag = readStored('q.important');   // the axis was called that
  if (oldFlag !== null && readStored(KEY.strategicNames) === null) {
    writeStored(KEY.strategicNames, oldFlag);
    writeStored('q.important', null);
  }
  var oldToken = readStored(KEY.oldToken);   // one token, one repo
  if (oldToken) {
    writeStoredJson(KEY.tokens, [oldToken]);
    writeStored(KEY.oldToken, null);
  }
  var oldRepo = readStored(KEY.oldRepo);
  if (oldRepo && !readStoredList(KEY.selected).length) {
    writeStoredJson(KEY.selected, [oldRepo]);
    writeStored(KEY.oldRepo, null);
  }
}

$(function () {
  resetBoard();
  loadSettings();
  bind();
  migrateOldKeys();
  readStoredList(KEY.refusedWrites).forEach(function (full) {
    state.refusedWrites[full] = true;
  });
  state.tokens = readStoredList(KEY.tokens);
  if (state.tokens.length || publicRepoNames().length) loadReachableRepos();
  else showSignedOut();
});

})();
