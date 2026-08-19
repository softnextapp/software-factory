// Tests for the host abstraction — the module that owns every host-CLI difference
// (glab vs gh) so main.ts, chain.ts and the role prompts stay host-neutral.
//
// Covers the PURE pieces: argv builders, JSON parsers, prompt-command builders
// and origin-host inference — plus, since issue #25, createHost()'s READ verbs,
// which take their CLI runner and clock as injectable deps so the retry wiring is
// a contract test rather than a claim. The WRITE verb (createDraftChangeRequest)
// stays a thin execFileSync/spawnSync shell and is exercised through its builders
// only. Pure throughout: no network, no live glab/gh, no process.env.
// Run: npx tsx .sandcastle/host.test.ts
import assert from 'node:assert/strict';
import {
  openMrsCommand,
  promptHostArgs,
  parseGlabIssueLabels,
  parseGlabIssue,
  parseOpenMergeRequests,
  ghIssueLabelsArgs,
  parseGhIssueLabels,
  ghIssueViewArgs,
  parseGhIssue,
  glabMrCreateArgs,
  ghPrCreateArgs,
  ghPrListArgs,
  parseGhPrList,
  manualCreateHint,
  createHost,
  inferGitHostFromUrl,
  HOST_TERMS,
  glabQueueListArgs,
  ghQueueListArgs,
  parseGlabQueue,
  parseGhQueue,
  dedupeQueue,
  claimLabels,
  hostTokenKey,
  hostTokenMissingMessage,
  isUncommittedChangesWarning,
  classifyDraftCreateOutput,
  classifyHostFailure,
  hostRetryPlanFor,
  runHostRead,
  HostReadError,
  HOST_READ_ATTEMPTS,
  HOST_RETRY_BASE_DELAY_MS,
  HOST_RETRY_JITTER_MS,
} from './host.ts';
import { test, throws, finish } from './test-harness.ts';

// --- work-queue enumeration ------------------------------------------------
// The queue is enumerated by the ORCHESTRATION (main.ts), not the planner prompt:
// main.ts lists issues for each configured queue label and unions by number, then
// hands the planner a single deduped list (issue #15 — a consumer's "ready" label
// need not be `sandcastle`). These are the pure pieces (argv builders + parsers +
// dedupe + the claim-label set) the host wrappers compose.

test('ghQueueListArgs: issues for ONE label + the queue fields (no --state: defaults open, symmetric with glab)', () => {
  assert.deepEqual(ghQueueListArgs('ready-for-agent'), [
    'issue', 'list', '--label', 'ready-for-agent', '--limit', '100',
    '--json', 'number,title,body,labels',
  ]);
});

test('glabQueueListArgs: open issues for ONE label, JSON output', () => {
  assert.deepEqual(glabQueueListArgs('sandcastle'), [
    'issue', 'list', '--label', 'sandcastle', '--output', 'json', '--per-page', '100',
  ]);
});

test('parseGlabQueue: maps iid/description/labels(string[]) → QueueIssue; malformed dropped', () => {
  const raw = JSON.stringify([
    { iid: 12, title: 'Do thing', description: 'body', labels: ['bug', 'sandcastle'] },
    { iid: 'x', title: 'bad' }, // non-numeric iid → dropped
    null,
  ]);
  const out = parseGlabQueue(raw);
  assert.equal(out.length, 1);
  assert.equal(out[0]?.number, 12);
  assert.equal(out[0]?.title, 'Do thing');
  assert.equal(out[0]?.body, 'body');
  assert.deepEqual(out[0]?.labels, ['bug', 'sandcastle']);
});

test('parseGlabQueue: non-array payload is fatal (would silently empty the queue)', () => {
  throws(() => parseGlabQueue('{"message":"401"}'));
  throws(() => parseGlabQueue('not json'));
});

test('parseGhQueue: maps number/body/labels[{name}] → QueueIssue; malformed dropped', () => {
  const raw = JSON.stringify([
    { number: 12, title: 'Do thing', body: 'body', labels: [{ name: 'bug' }, { name: 'ready-for-agent' }] },
    { title: 'no number' }, // dropped
    {},
  ]);
  const out = parseGhQueue(raw);
  assert.equal(out.length, 1);
  assert.equal(out[0]?.number, 12);
  assert.equal(out[0]?.title, 'Do thing');
  assert.equal(out[0]?.body, 'body');
  assert.deepEqual(out[0]?.labels, ['bug', 'ready-for-agent']);
});

test('parseGhQueue: non-array payload is fatal', () => {
  throws(() => parseGhQueue('{"message":"401"}'));
  throws(() => parseGhQueue('not json'));
});

test('dedupeQueue: union by number, first occurrence wins, order preserved', () => {
  const a = { number: 12, title: 't', body: 'b', labels: ['sandcastle'] };
  const b = { number: 13, title: 't2', body: 'b2', labels: ['ready-for-agent'] };
  const dup = { number: 12, title: 't', body: 'b', labels: ['sandcastle'] };
  assert.deepEqual(dedupeQueue([a, b, dup]), [a, b]);
  assert.deepEqual(dedupeQueue([]), []);
});

test('claimLabels: the configured queue labels actually on the issue, in queue order', () => {
  // captable issue carrying ready-for-agent (not sandcastle) → claims that one.
  assert.deepEqual(claimLabels(['bug', 'ready-for-agent'], ['sandcastle', 'ready-for-agent']), ['ready-for-agent']);
  // an issue with both → removes both.
  assert.deepEqual(claimLabels(['bug', 'sandcastle', 'ready-for-agent'], ['sandcastle', 'ready-for-agent']), ['sandcastle', 'ready-for-agent']);
  // none → empty (defensive; the issue would not have been queued).
  assert.deepEqual(claimLabels(['bug'], ['sandcastle', 'ready-for-agent']), []);
});

test('queue + claim end-to-end (both labels): one issue under two labels is deduped once, claims both', () => {
  // gh/glab return the issue's FULL label set on every per-label hit, so the same
  // #12 comes back from both the `sandcastle` and `ready-for-agent` lists.
  const hit = { number: 12, title: 't', body: 'b', labels: [{ name: 'bug' }, { name: 'sandcastle' }, { name: 'ready-for-agent' }] };
  const queue = dedupeQueue([...parseGhQueue(JSON.stringify([hit])), ...parseGhQueue(JSON.stringify([hit]))]);
  assert.equal(queue.length, 1, 'deduped to a single entry');
  assert.deepEqual(claimLabels(queue[0]!.labels, ['sandcastle', 'ready-for-agent']), ['sandcastle', 'ready-for-agent']);
});

// --- open-MR/PR prompt command (still run verbatim by the planner) ----------
// This string is fed verbatim into promptArgs, so a regression here is a regression
// in what the planner runs. It must keep emitting the SAME normalized JSON shape
// across hosts (the planner's logic does not branch on host).

test('openMrsCommand(glab) lists MRs with source/target branches', () => {
  const cmd = openMrsCommand('glab');
  assert.ok(cmd.startsWith('glab mr list '), cmd);
  assert.ok(cmd.includes('source_branch') && cmd.includes('target_branch'), cmd);
});

test('openMrsCommand(gh) lists PRs mapped to the same source_branch/target_branch shape', () => {
  const cmd = openMrsCommand('gh');
  assert.ok(cmd.startsWith('gh pr list '), cmd);
  // gh calls them headRefName/baseRefName; the command must rename them so the
  // planner sees the same source_branch/target_branch keys regardless of host.
  assert.ok(cmd.includes('headRefName'), cmd);
  assert.ok(cmd.includes('source_branch'), cmd);
  assert.ok(cmd.includes('target_branch'), cmd);
});

test('promptHostArgs(glab) gives the glab close/comment verbs', () => {
  const a = promptHostArgs('glab');
  assert.equal(a.ISSUE_CLI, 'glab');
  assert.equal(a.UNLABEL_PREFIX, 'glab issue update');
  assert.equal(a.UNLABEL_FLAG, '--unlabel');
  assert.equal(a.NOTE_PREFIX, 'glab issue note');
  assert.equal(a.NOTE_FLAG, '-m');
});

test('promptHostArgs(gh) gives the gh edit/comment verbs (different subcommands + flags)', () => {
  const a = promptHostArgs('gh');
  assert.equal(a.ISSUE_CLI, 'gh');
  // gh has no `issue update --unlabel` nor `issue note`: edit --remove-label, comment --body.
  assert.equal(a.UNLABEL_PREFIX, 'gh issue edit');
  assert.equal(a.UNLABEL_FLAG, '--remove-label');
  assert.equal(a.NOTE_PREFIX, 'gh issue comment');
  assert.equal(a.NOTE_FLAG, '--body');
});

// --- glab parsers (factored out of main.ts, behaviour unchanged) -----------

test('parseGlabIssueLabels: string array passthrough, non-strings dropped', () => {
  assert.deepEqual(parseGlabIssueLabels('["bug", "sandcastle"]'), ['bug', 'sandcastle']);
  assert.deepEqual(parseGlabIssueLabels('["ok", 7, null, "x"]'), ['ok', 'x']);
});

test('parseGlabIssueLabels: non-array payload is fatal (never silently empty)', () => {
  throws(() => parseGlabIssueLabels('{"message":"401"}'));
  throws(() => parseGlabIssueLabels('not json'));
});

test('parseGlabIssue: maps glab snake_case/web_url to IssueInfo', () => {
  const raw = JSON.stringify({
    title: 'Fix the thing',
    web_url: 'https://gitlab.example.com/x/-/issues/6',
    labels: ['bug', 'sandcastle'],
    milestone: { title: 'Sprint 3' },
  });
  const info = parseGlabIssue(raw, 'fallback', 6);
  assert.equal(info.number, 6);
  assert.equal(info.title, 'Fix the thing');
  assert.equal(info.url, 'https://gitlab.example.com/x/-/issues/6');
  assert.deepEqual(info.labels, ['bug', 'sandcastle']);
  assert.equal(info.milestone, 'Sprint 3');
});

test('parseGlabIssue: null milestone, missing title falls back', () => {
  const info = parseGlabIssue(JSON.stringify({ title: null, milestone: null }), 'fallback', 9);
  assert.equal(info.title, 'fallback');
  assert.equal(info.milestone, null);
  assert.equal(info.url, undefined);
});

// --- gh argv builders + parsers --------------------------------------------

test('ghIssueLabelsArgs: view N, json labels, jq to bare names', () => {
  assert.deepEqual(ghIssueLabelsArgs(6), [
    'issue',
    'view',
    '6',
    '--json',
    'labels',
    '--jq',
    '.labels[].name',
  ]);
});

test('parseGhIssueLabels: jq raw output is one name per line', () => {
  assert.deepEqual(parseGhIssueLabels('bug\nsandcastle\n'), ['bug', 'sandcastle']);
  assert.deepEqual(parseGhIssueLabels(''), []);
  assert.deepEqual(parseGhIssueLabels('single'), ['single']);
});

test('ghIssueViewArgs: view N with the fields IssueInfo needs', () => {
  assert.deepEqual(ghIssueViewArgs(42), [
    'issue',
    'view',
    '42',
    '--json',
    'number,title,url,labels,milestone',
  ]);
});

test('parseGhIssue: maps gh url/labels[]/milestone to IssueInfo', () => {
  const raw = JSON.stringify({
    number: 6,
    title: 'Land the gh host',
    url: 'https://github.com/softnextapp/software-factory/issues/6',
    labels: [{ name: 'bug' }, { name: 'sandcastle' }],
    milestone: { title: 'v0.2' },
  });
  const info = parseGhIssue(raw, 'fallback', 6);
  assert.equal(info.number, 6);
  assert.equal(info.title, 'Land the gh host');
  assert.equal(info.url, 'https://github.com/softnextapp/software-factory/issues/6');
  assert.deepEqual(info.labels, ['bug', 'sandcastle']);
  assert.equal(info.milestone, 'v0.2');
});

test('parseGhIssue: null milestone → null; labels without a name dropped', () => {
  const raw = JSON.stringify({
    number: 6,
    title: 'T',
    url: 'u',
    labels: [{ name: 'a' }, { id: 'no-name' }, { name: 'b' }],
    milestone: null,
  });
  const info = parseGhIssue(raw, 'fallback', 6);
  assert.deepEqual(info.labels, ['a', 'b']);
  assert.equal(info.milestone, null);
});

test('parseGhIssue: non-object or missing title falls back', () => {
  assert.equal(parseGhIssue(JSON.stringify({ milestone: null }), 'fallback', 7).title, 'fallback');
});

// --- draft change-request (MR / PR) creation argv --------------------------

const CR_ARGS = {
  sourceBranch: 'sandcastle/issue-6-gh-host',
  targetBranch: 'main',
  title: 'feat(host): land the gh module',
  description: 'body with\nnewlines',
  assignee: null,
};

test('glabMrCreateArgs: source/target/draft/yes/no-editor/title/description', () => {
  const argv = glabMrCreateArgs(CR_ARGS);
  assert.deepEqual(argv, [
    'mr',
    'create',
    '--source-branch',
    'sandcastle/issue-6-gh-host',
    '--target-branch',
    'main',
    '--draft',
    '--yes',
    '--no-editor',
    '--title',
    'feat(host): land the gh module',
    '--description',
    'body with\nnewlines',
  ]);
});

test('glabMrCreateArgs: --assignee only when set', () => {
  const withAssignee = glabMrCreateArgs({ ...CR_ARGS, assignee: 'alice' });
  const i = withAssignee.indexOf('--assignee');
  assert.ok(i >= 0, 'expected --assignee');
  assert.equal(withAssignee[i + 1], 'alice');
  // null → no assignee slot at all
  assert.equal(glabMrCreateArgs(CR_ARGS).indexOf('--assignee'), -1);
});

test('ghPrCreateArgs: head/base/draft/title/body (no --yes/--no-editor)', () => {
  const argv = ghPrCreateArgs(CR_ARGS);
  assert.deepEqual(argv, [
    'pr',
    'create',
    '--head',
    'sandcastle/issue-6-gh-host',
    '--base',
    'main',
    '--draft',
    '--title',
    'feat(host): land the gh module',
    '--body',
    'body with\nnewlines',
  ]);
  assert.equal(argv.indexOf('--yes'), -1);
  assert.equal(argv.indexOf('--no-editor'), -1);
});

test('ghPrCreateArgs: --assignee only when set', () => {
  const withAssignee = ghPrCreateArgs({ ...CR_ARGS, assignee: 'octocat' });
  const i = withAssignee.indexOf('--assignee');
  assert.ok(i >= 0);
  assert.equal(withAssignee[i + 1], 'octocat');
  assert.equal(ghPrCreateArgs(CR_ARGS).indexOf('--assignee'), -1);
});

test('manualCreateHint: glab uses mr create --source-branch/--target-branch', () => {
  assert.equal(
    manualCreateHint('glab', 'feat/x', 'main'),
    'glab mr create --source-branch feat/x --target-branch main --draft',
  );
});

test('manualCreateHint: gh uses pr create --head/--base', () => {
  assert.equal(
    manualCreateHint('gh', 'feat/x', 'main'),
    'gh pr create --head feat/x --base main --draft',
  );
});

// --- draft-create OUTPUT classification (issue #21) ------------------------
// `gh pr create` prints the new PR URL to stdout but ALSO warns "Warning: N
// uncommitted changes" — about the HOST working tree (the repo main.ts runs from,
// which carries the adopt-time `@ai-hero/sandcastle` runtime dep), NEVER the agent's
// work (committed to the pushed branch before this call). Printed bare between
// `git push` and the URL it reads like left-behind agent work, so the publish phase
// captures the CLI output and drops that one line via classifyDraftCreateOutput.
// The filter is surgical: only that exact warning goes; the URL and any other
// stderr (a different warning, an auth error) survive — no blanket stderr drop.

test('isUncommittedChangesWarning: matches gh\'s exact host-tree warning (any count, plural/singular)', () => {
  assert.equal(isUncommittedChangesWarning('Warning: 2 uncommitted changes'), true);
  assert.equal(isUncommittedChangesWarning('Warning: 1 uncommitted change'), true);
  assert.equal(isUncommittedChangesWarning('warning: 0 uncommitted changes'), true);
  // gh indents the warning under a banner in some flows; leading whitespace is tolerated.
  assert.equal(isUncommittedChangesWarning('  Warning: 2 uncommitted changes'), true);
});

test('isUncommittedChangesWarning: leaves the URL, banners and OTHER warnings alone (real signal)', () => {
  assert.equal(isUncommittedChangesWarning('https://github.com/owner/repo/pull/42'), false);
  assert.equal(isUncommittedChangesWarning('Creating pull request for feat/x into main in owner/repo'), false);
  // A DIFFERENT warning has no "<digits> uncommitted" → kept.
  assert.equal(isUncommittedChangesWarning('Warning: unpushed commits on origin'), false);
  assert.equal(isUncommittedChangesWarning('Warning: 2 files differ from the base'), false);
  assert.equal(isUncommittedChangesWarning(''), false);
});

test('classifyDraftCreateOutput: keeps the URL, drops only the uncommitted-changes warning', () => {
  const out = classifyDraftCreateOutput(
    'https://github.com/owner/repo/pull/42\n',
    'Warning: 2 uncommitted changes\n\nCreating pull request for feat/x into main in owner/repo\n',
  );
  // The URL rides on stdout, verbatim.
  assert.equal(out.out, 'https://github.com/owner/repo/pull/42\n');
  // Real advisory stderr survives; the warning is gone, no stray "uncommitted" token.
  assert.equal(out.advisory, 'Creating pull request for feat/x into main in owner/repo');
  assert.ok(!out.advisory.includes('uncommitted'), `notice must not carry the warning: ${out.advisory}`);
});

test('classifyDraftCreateOutput: a clean host tree (no warning) passes stderr through unchanged', () => {
  const out = classifyDraftCreateOutput(
    'https://github.com/o/r/pull/7\n',
    'Creating pull request for feat/x into main in o/r\n',
  );
  assert.equal(out.out, 'https://github.com/o/r/pull/7\n');
  assert.equal(out.advisory, 'Creating pull request for feat/x into main in o/r');
});

test('classifyDraftCreateOutput: a DIFFERENT warning is NOT suppressed (no blanket drop)', () => {
  // This is the acceptance guardrail: the filter must not eat arbitrary stderr.
  const out = classifyDraftCreateOutput('https://github.com/o/r/pull/7\n', 'Warning: unpushed commits on origin\n');
  assert.equal(out.advisory, 'Warning: unpushed commits on origin');
});

test('classifyDraftCreateOutput: drops the warning from stdout too (defensive — which stream gh uses)', () => {
  // gh emits the warning on stderr, but should a version move it to stdout it must
  // not survive next to the URL. Only the warning line goes; the URL stays.
  const out = classifyDraftCreateOutput('Warning: 2 uncommitted changes\nhttps://github.com/o/r/pull/7\n', '');
  assert.equal(out.out, 'https://github.com/o/r/pull/7\n');
});

// --- open MR / PR list -----------------------------------------------------

test('parseOpenMergeRequests (glab): maps snake_case fields to OpenMergeRequest', () => {
  const [parsed] = parseOpenMergeRequests(
    JSON.stringify([
      {
        iid: 59,
        source_branch: 'fix/rgaa-lang-viewport',
        target_branch: 'main',
        created_at: '2026-07-28T12:11:47.229Z',
        title: 'Draft: fix(a11y)',
        web_url: 'https://gitlab.example.com/x/-/merge_requests/59',
        state: 'opened',
      },
    ]),
  );
  assert.equal(parsed?.iid, 59);
  assert.equal(parsed?.sourceBranch, 'fix/rgaa-lang-viewport');
  assert.equal(parsed?.targetBranch, 'main');
});

test('parseOpenMergeRequests (glab): rows missing branch fields are dropped, not fatal', () => {
  assert.deepEqual(parseOpenMergeRequests('[{"iid":1},null,3]'), []);
  assert.deepEqual(parseOpenMergeRequests('[]'), []);
});

test('parseOpenMergeRequests (glab): non-array payload is fatal (would silently un-chain)', () => {
  throws(() => parseOpenMergeRequests('{"message":"401 Unauthorized"}'));
  throws(() => parseOpenMergeRequests('not json'));
});

test('ghPrListArgs: open PRs, the fields the stack walk needs', () => {
  assert.deepEqual(ghPrListArgs(), [
    'pr',
    'list',
    '--state',
    'open',
    '--limit',
    '100',
    '--json',
    'number,headRefName,baseRefName,createdAt,title,url',
  ]);
});

test('parseGhPrList: maps gh fields to OpenMergeRequest', () => {
  const [pr] = parseGhPrList(
    JSON.stringify([
      {
        number: 59,
        headRefName: 'fix/rgaa-lang-viewport',
        baseRefName: 'main',
        createdAt: '2026-07-28T12:11:47Z',
        title: 'Draft: fix(a11y)',
        url: 'https://github.com/o/r/pull/59',
      },
    ]),
  );
  assert.equal(pr?.iid, 59);
  assert.equal(pr?.sourceBranch, 'fix/rgaa-lang-viewport');
  assert.equal(pr?.targetBranch, 'main');
  assert.equal(pr?.title, 'Draft: fix(a11y)');
  assert.equal(pr?.webUrl, 'https://github.com/o/r/pull/59');
});

test('parseGhPrList: rows missing branch fields are dropped, not fatal', () => {
  assert.deepEqual(parseGhPrList('[{"number":1},null,{}]'), []);
  assert.deepEqual(parseGhPrList('[]'), []);
});

test('parseGhPrList: non-array payload is fatal (would silently un-chain)', () => {
  throws(() => parseGhPrList('{"message":"401"}'));
  throws(() => parseGhPrList('not json'));
});

// --- origin-host inference (the mismatch warning) --------------------------

test('inferGitHostFromUrl: GitHub HTTPS + SSH → gh', () => {
  assert.equal(inferGitHostFromUrl('https://github.com/softnextapp/software-factory.git'), 'gh');
  assert.equal(inferGitHostFromUrl('git@github.com:softnextapp/software-factory.git'), 'gh');
});

test('inferGitHostFromUrl: GitLab SaaS + self-hosted → glab', () => {
  assert.equal(inferGitHostFromUrl('https://gitlab.com/o/r.git'), 'glab');
  assert.equal(inferGitHostFromUrl('git@gitlab.example.com:o/r.git'), 'glab');
});

test('inferGitHostFromUrl: GitHub Enterprise → gh', () => {
  assert.equal(inferGitHostFromUrl('https://github.company.com/o/r.git'), 'gh');
});

test('inferGitHostFromUrl: unrecognised host → null (no false warning)', () => {
  assert.equal(inferGitHostFromUrl('https://git.company.com/o/r.git'), null);
  assert.equal(inferGitHostFromUrl(''), null);
});

// --- factory + nouns -------------------------------------------------------

test('HOST_TERMS: glab = merge request / GitLab / !N, gh = pull request / GitHub / #N', () => {
  assert.equal(HOST_TERMS.glab.cr, 'merge request');
  assert.equal(HOST_TERMS.glab.cli, 'glab');
  assert.equal(HOST_TERMS.glab.name, 'GitLab');
  assert.equal(HOST_TERMS.glab.ref, '!');
  assert.equal(HOST_TERMS.gh.cr, 'pull request');
  assert.equal(HOST_TERMS.gh.cli, 'gh');
  assert.equal(HOST_TERMS.gh.name, 'GitHub');
  assert.equal(HOST_TERMS.gh.ref, '#');
});

test('createHost: returns the five operations for each host', () => {
  for (const host of ['glab', 'gh'] as const) {
    const h = createHost(host);
    assert.equal(typeof h.labelsOf, 'function', `${host}.labelsOf`);
    assert.equal(typeof h.issueInfoOf, 'function', `${host}.issueInfoOf`);
    assert.equal(typeof h.createDraftChangeRequest, 'function', `${host}.createDraftChangeRequest`);
    assert.equal(typeof h.openChangeRequests, 'function', `${host}.openChangeRequests`);
    assert.equal(typeof h.queueIssues, 'function', `${host}.queueIssues`);
  }
});

// --- host-CLI token (issue #17) ---------------------------------------------

test('HOST_TERMS has a total `local` entry so Record<GitHost,…> compiles', () => {
  // `local` is fenced at the loop (no host CLI), but the type must stay total.
  assert.ok(typeof HOST_TERMS.local.cli === 'string');
  assert.ok(typeof HOST_TERMS.local.name === 'string');
});

test('createHost: local (no tracker) is refused, not silently treated as glab', () => {
  // The belt for main.ts' earlier fence — a direct caller must not get a glab host.
  throws(() => createHost('local'));
});

test('hostTokenKey: gh → GH_TOKEN, glab → GITLAB_TOKEN, local → null (no token)', () => {
  assert.equal(hostTokenKey('gh'), 'GH_TOKEN');
  assert.equal(hostTokenKey('glab'), 'GITLAB_TOKEN');
  // The acceptance: a local / no-tracker consumer is never asked for a token.
  assert.equal(hostTokenKey('local'), null);
});

test('hostTokenMissingMessage: gh names the var, the file, and the gh auth command', () => {
  const msg = hostTokenMissingMessage('GH_TOKEN', 'gh', '.sandcastle/.env');
  assert.ok(msg.includes('GH_TOKEN'), `names the var: ${msg}`);
  assert.ok(msg.includes('.sandcastle/.env'), `names the file resolveEnv flows: ${msg}`);
  assert.ok(msg.includes('gh auth token'), `tells how to obtain it: ${msg}`);
  assert.ok(msg.includes('local'), `notes the local exemption: ${msg}`);
  // Never leaks a value — it is a static message, but assert no secret placeholder slips in.
  assert.ok(!msg.includes('<token>'));
});

test('hostTokenMissingMessage: glab names GITLAB_TOKEN and the glab auth command', () => {
  const msg = hostTokenMissingMessage('GITLAB_TOKEN', 'glab', '.sandcastle/.env');
  assert.ok(msg.includes('GITLAB_TOKEN'), `names the var: ${msg}`);
  assert.ok(msg.includes('.sandcastle/.env'), `names the file: ${msg}`);
  assert.ok(msg.includes('glab auth token'), `glab obtain hint: ${msg}`);
});

test('hostTokenMissingMessage: local falls back to a generic message (never called in practice)', () => {
  // hostTokenKey('local')===null ⇒ main.ts never validates ⇒ never calls this. Defensive.
  const msg = hostTokenMissingMessage('GH_TOKEN', 'local', '.sandcastle/.env');
  assert.ok(msg.includes('GH_TOKEN'));
  assert.ok(msg.includes('.sandcastle/.env'));
});

// --- host-read failure classification + retry (issue #25) --------------------
//
// Three of the five host verbs (labelsOf, openChangeRequests, queueIssues) had no
// try/catch and no retry: a transient host outage (5xx, severed connection, timed
// out) killed a run at the second iteration after the agents had already produced
// work, while a DEFINITIVE failure (404, auth, exhausted quota) would have been
// pointlessly re-attempted. Observed 2026-08-17 during a partial GitHub outage
// (API Requests in major_outage, GraphQL answering 1-in-8) with 4998/5000
// requests left — not quota, pure transience.
//
// The classification is a PURE function over the failing CLI invocation's
// (status, stderr) — the two things the thrown execFileSync error carries — so it
// is testable on captured real CLI output exactly like the parsers above. Every
// fixture string below is a byte-accurate capture of what the CLI actually
// printed (gh 2.97.0, glab 1.63.0), not a paraphrase.

// gh, captured live against github.com:
const GH_401 = 'HTTP 401: Bad credentials (https://api.github.com/graphql)\nTry authenticating with:  gh auth login -h github.com\n';
const GH_404 = 'GraphQL: Could not resolve to an issue or pull request with the number of 999999999. (repository.issue)\n';
const GH_CONN = 'error connecting to github.invalid\ncheck your internet connection or https://githubstatus.com\n';
// gh's Go HTTP transport, surfaced verbatim when the API endpoint itself is
// unreachable (captured live, GH_HOST pointed at a refused port):
const GH_DIAL_REFUSED = 'Post "https://127.0.0.1/api/graphql": dial tcp 127.0.0.1:443: connect: connection refused\n';
// glab, captured live against gitlab.com / a stubbed 5xx endpoint:
const GLAB_401 = 'ERROR: GET https://gitlab.com/api/v4/projects/gitlab-org%2Fcli/issues/1: 401 {message: 401 Unauthorized}\n';
const GLAB_502 = 'ERROR: GET http://127.0.0.1:8443/api/v4/projects/o%2Fr/issues/1: 502 {message: 502 stubbed}\n';
const GLAB_503 = 'ERROR: GET http://127.0.0.1:8453/api/v4/projects/o%2Fr/issues: 503 {message: 503 stubbed}\n';
const GLAB_429 = 'ERROR: GET http://127.0.0.1:8463/api/v4/projects/o%2Fr/issues/1: 429 {message: 429 Too Many Requests}\n';
const GLAB_CONN = 'x error connecting to gitlab.invalid\n• Check your internet connection and status.gitlab.com. If on GitLab Self-Managed, run \'sudo gitlab-ctl status\' on your server.\n';
const GLAB_404_API = 'ERROR: GET https://gitlab.com/api/v4/projects/o%2Fr/issues/999999999: 404 {message: 404 Not Found}\n';

test('classifyHostFailure: server/host outage (5xx) is retryable — gh and glab captures', () => {
  assert.equal(classifyHostFailure(1, GH_CONN).retryable, true);
  assert.equal(classifyHostFailure(1, GLAB_CONN).retryable, true);
  assert.equal(classifyHostFailure(1, GLAB_502).retryable, true);
  assert.equal(classifyHostFailure(1, GLAB_503).retryable, true);
});

test('classifyHostFailure: transport-level refusal/timeout (Go dial tcp, i/o timeout) is the outage case', () => {
  // Both CLIs surface the Go HTTP transport line verbatim when the endpoint is
  // unreachable — captured live from gh. These classify as `outage` (not the
  // catch-all `unknown`) so the retry log names the real cause.
  for (const stderr of [
    GH_DIAL_REFUSED,
    'Get "https://api.github.com/": dial tcp 140.82.1.6:443: i/o timeout\n',
    'Get "https://gitlab.com/api/v4/projects": context deadline exceeded\n',
  ]) {
    const failure = classifyHostFailure(1, stderr);
    assert.equal(failure.retryable, true, stderr);
    assert.equal(failure.reason, 'outage', stderr);
  }
});

test('classifyHostFailure: quota (429) is retryable — the window resets', () => {
  // 429 is "wait, not never": the issue's own incident had quota intact, but a
  // consumer hitting a secondary rate limit recovers by backing off.
  assert.equal(classifyHostFailure(1, GLAB_429).retryable, true);
});

test('classifyHostFailure: auth (401) is definitive — waiting changes nothing', () => {
  const gh = classifyHostFailure(1, GH_401);
  assert.equal(gh.retryable, false);
  assert.equal(gh.reason, 'auth');
  assert.equal(classifyHostFailure(1, GLAB_401).retryable, false);
});

test('classifyHostFailure: not-found (404 / GraphQL could-not-resolve) is definitive', () => {
  assert.equal(classifyHostFailure(1, GH_404).retryable, false);
  assert.equal(classifyHostFailure(1, GLAB_404_API).retryable, false);
});

test('classifyHostFailure: an UNRECOGNISED failure defaults to retryable (fail toward the retry, not the run)', () => {
  // A novel error wording must not classify as definitive on a guess: a run killed
  // by an unrecognised transient is the exact loss this issue is about, while an
  // unknown-but-definitive failure still surfaces after the bounded attempts.
  const unknown = classifyHostFailure(1, 'some never-seen-before CLI error');
  assert.equal(unknown.retryable, true);
  assert.equal(unknown.reason, 'unknown');
});

test('classifyHostFailure: an error with NO captured stderr is retryable (connection killed pre-read)', () => {
  assert.equal(classifyHostFailure(1, '').retryable, true);
});

test('classifyHostFailure: permission (403) is definitive — a token without scope never gains it by waiting', () => {
  assert.equal(
    classifyHostFailure(1, 'ERROR: GET https://gitlab.com/api/v4/projects/o%2Fr/issues: 403 {message: 403 Forbidden}').retryable,
    false,
  );
});

test('hostRetryPlanFor: exponential backoff with a positive jitter bound, capped at the attempt count', () => {
  assert.equal(hostRetryPlanFor(0).delayMs, HOST_RETRY_BASE_DELAY_MS);
  assert.equal(hostRetryPlanFor(1).delayMs, HOST_RETRY_BASE_DELAY_MS * 2);
  assert.equal(hostRetryPlanFor(2).delayMs, HOST_RETRY_BASE_DELAY_MS * 4);
  // Every delay offers jitter headroom; never zero (a zero sleep is no sleep).
  for (let attempt = 0; attempt < HOST_READ_ATTEMPTS; attempt++) {
    const plan = hostRetryPlanFor(attempt);
    assert.ok(plan.jitterMs >= 0 && plan.jitterMs <= HOST_RETRY_JITTER_MS, `attempt ${attempt} jitter in range`);
    assert.ok(plan.delayMs + plan.jitterMs > 0, `attempt ${attempt} total delay > 0`);
  }
});

test('hostRetryPlanFor: named constants are sane (bounded attempts, sub-second base, small jitter)', () => {
  assert.ok(HOST_READ_ATTEMPTS >= 2 && HOST_READ_ATTEMPTS <= 6, `${HOST_READ_ATTEMPTS} attempts`);
  assert.ok(HOST_RETRY_BASE_DELAY_MS >= 250 && HOST_RETRY_BASE_DELAY_MS <= 2000, `${HOST_RETRY_BASE_DELAY_MS}ms base`);
  assert.ok(HOST_RETRY_JITTER_MS > 0 && HOST_RETRY_JITTER_MS <= 1000, `${HOST_RETRY_JITTER_MS}ms jitter`);
});

// A recording stand-in for the real executor + clock. The runner under test takes
// them as parameters, so the retry loop is driven deterministically here and only
// becomes time-based inside createHost().
/** One executed attempt, as the recorder saw it. Test-only — host.ts has no such notion. */
interface SeenAttempt {
  readonly attempt: number;
  readonly status: number | null;
  readonly stderr: string;
}
interface RecordedRead {
  readonly attempts: SeenAttempt[];
  readonly slept: number[];
  readonly logged: string[];
}
const recordedRead = (behaviour: readonly { status: number | null; stderr: string; stdout?: string }[]): {
  run: () => string;
  state: RecordedRead;
} => {
  const state: { attempts: SeenAttempt[]; slept: number[]; logged: string[] } = {
    attempts: [],
    slept: [],
    logged: [],
  };
  let call = 0;
  const run = () =>
    runHostRead('issue view 42', () => {
      const step = behaviour[Math.min(call, behaviour.length - 1)]!;
      call++;
      state.attempts.push({ attempt: call, status: step.status, stderr: step.stderr });
      if (step.status !== 0) {
        const error = new Error(`host CLI failed (exit ${step.status}):\n${step.stderr}`) as Error & {
          status?: number | null;
          stderr?: string;
        };
        error.status = step.status;
        error.stderr = step.stderr;
        throw error;
      }
      return step.stdout ?? '[]';
    }, {
      sleep: (ms) => state.slept.push(ms),
      log: (line) => state.logged.push(line),
      random: () => 0.5, // deterministic jitter: always the midpoint
    });
  return { run, state: state as RecordedRead };
};

test('runHostRead: a transient failure then success retries, sleeps the backoff, and logs each retry', () => {
  const { run, state } = recordedRead([
    { status: 1, stderr: GLAB_503 },
    { status: 0, stderr: '', stdout: '["bug"]' },
  ]);
  assert.equal(run(), '["bug"]');
  assert.equal(state.attempts.length, 2, 'one retry');
  // Deterministic midpoint jitter = half the jitter budget on top of the base delay.
  assert.deepEqual(state.slept, [HOST_RETRY_BASE_DELAY_MS + HOST_RETRY_JITTER_MS / 2]);
  assert.equal(state.logged.length, 1, 'exactly one retry line');
  const line = state.logged[0]!;
  assert.ok(line.includes('issue view 42'), `names the verb: ${line}`);
  assert.ok(/2\/|attempt 2|retry/.test(line), `names the attempt: ${line}`);
  assert.ok(line.length > 0 && line.includes('503'), `carries the cause: ${line}`);
});

test('runHostRead: a definitive failure throws immediately, consuming no further attempts', () => {
  const { run, state } = recordedRead([
    { status: 1, stderr: GH_401 },
    { status: 0, stderr: '', stdout: '[]' },
  ]);
  assert.throws(run, /401/);
  assert.equal(state.attempts.length, 1, 'no retry on a definitive failure');
  assert.deepEqual(state.slept, [], 'no backoff consumed');
});

test('runHostRead: retries stop at the bound and the LAST error is what surfaces', () => {
  const { run, state } = recordedRead([{ status: 1, stderr: GH_CONN }]);
  assert.throws(run, /error connecting/);
  assert.equal(state.attempts.length, HOST_READ_ATTEMPTS, `exactly ${HOST_READ_ATTEMPTS} attempts`);
  assert.equal(state.slept.length, HOST_READ_ATTEMPTS - 1, 'a sleep per retry, none after the last');
  assert.equal(state.logged.length, HOST_READ_ATTEMPTS - 1);
});

test('runHostRead: backoff is strictly exponential across the retry sequence', () => {
  const { run, state } = recordedRead([{ status: 1, stderr: GLAB_502 }]);
  assert.throws(run);
  const expected = [0, 1, 2].slice(0, HOST_READ_ATTEMPTS - 1).map(
    (i) => HOST_RETRY_BASE_DELAY_MS * 2 ** i + HOST_RETRY_JITTER_MS / 2,
  );
  assert.deepEqual(state.slept, expected);
});

test('runHostRead: a first-try success never sleeps and never logs', () => {
  const { run, state } = recordedRead([{ status: 0, stderr: '', stdout: '[]' }]);
  assert.equal(run(), '[]');
  assert.deepEqual(state.slept, []);
  assert.deepEqual(state.logged, []);
});

// --- the throw's SHAPE (issue #31) -------------------------------------------
//
// The per-iteration boundary in main.ts discriminates on the #25 classification
// the spent retry carries OUT with it, so the throw must be a HostReadError
// with verb + failure + the original error as `cause` — not the raw
// execFileSync error, whose (status, stderr) happen to carry the same facts but
// promise nothing. Pinned here so the seam the boundary consumes is a contract.

test('runHostRead: a spent retry throws a HostReadError carrying the classification out (issue #31)', () => {
  const { run } = recordedRead([{ status: 1, stderr: GLAB_503 }]);
  let thrown: unknown;
  try {
    run();
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown instanceof HostReadError, `HostReadError, got ${String(thrown)}`);
  assert.equal(thrown.verb, 'issue view 42');
  assert.equal(thrown.failure.retryable, true);
  assert.equal(thrown.failure.reason, 'outage');
  // The original execFileSync-shaped error rides along, stderr intact.
  assert.ok((thrown.cause as { stderr?: string }).stderr?.includes('503'));
});

test('runHostRead: a definitive failure ALSO throws HostReadError, with retryable=false', () => {
  const { run } = recordedRead([{ status: 1, stderr: GH_401 }]);
  let thrown: unknown;
  try {
    run();
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown instanceof HostReadError);
  assert.equal(thrown.failure.retryable, false);
  assert.equal(thrown.failure.reason, 'auth');
  // One line: the iteration boundary prints this verbatim under its banner.
  assert.equal(thrown.message.split('\n').length, 1, thrown.message);
});

test('HostReadError: message names the verb and the reason — readable in a bare stack', () => {
  const error = new HostReadError('gh issue list --label sandcastle', { retryable: true, reason: 'outage' }, new Error('x'));
  assert.ok(error.message.includes('gh issue list --label sandcastle'), error.message);
  assert.ok(error.message.includes('outage'), error.message);
  assert.equal(error.name, 'HostReadError');
});

test('HostReadError: a cause that is not an Error degrades to a legible line, never a TypeError', () => {
  // The retry reads (status, stderr, message) off whatever the injected read threw,
  // and nothing promises that is an object. A TypeError raised while classifying
  // would leave the retry as a NON-host throw, which the #31 boundary stops the run
  // on — an outage mistaken for a bug.
  for (const cause of [null, undefined, 'a thrown string', 7, { stderr: 42 }]) {
    const error = new HostReadError('gh issue list', { retryable: true, reason: 'outage' }, cause);
    assert.ok(error.message.includes('no stderr captured'), `${String(cause)}: ${error.message}`);
    assert.equal(error.message.split('\n').length, 1, error.message);
  }
});

test('runHostRead: a read that throws a NON-Error still surfaces as a retryable HostReadError', () => {
  // No status and no stderr is what classifyHostFailure calls an outage, so the
  // read burns all its attempts and hands the boundary something it can absorb.
  const slept: number[] = [];
  let thrown: unknown;
  try {
    runHostRead('issue view 42', () => {
      throw null;
    }, { sleep: (ms) => slept.push(ms), log: () => {}, random: () => 0 });
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown instanceof HostReadError, `HostReadError, got ${String(thrown)}`);
  assert.equal(thrown.failure.retryable, true);
  assert.equal(thrown.failure.reason, 'outage');
  assert.equal(slept.length, HOST_READ_ATTEMPTS - 1, 'every attempt was spent');
});

// --- the classifier's remaining corners ------------------------------------

test('classifyHostFailure: GitHub spends its quota as a 403, not a 429 — definitive, but NOT labelled auth', () => {
  // gh surfaces the primary rate limit as `HTTP 403: API rate limit exceeded…`.
  // The issue puts "quota épuisé" among the definitive failures, so it must not
  // be retried — but calling it `auth` sends the operator hunting for a token
  // that is perfectly valid.
  const spent = classifyHostFailure(
    1,
    'HTTP 403: API rate limit exceeded for user ID 1234. (https://api.github.com/graphql)\n',
  );
  assert.equal(spent.retryable, false, 'an exhausted quota is not retried');
  assert.equal(spent.reason, 'quota-exhausted');
  // A plain 403 (missing scope) keeps the auth label.
  assert.equal(classifyHostFailure(1, 'HTTP 403: Resource not accessible by integration\n').reason, 'auth');
});

test('classifyHostFailure: a signal-killed CLI (status null, no stderr status) is an outage, not unknown', () => {
  // execFileSync reports `status: null` when the child died on a signal (OOM
  // killer, severed pipe) instead of exiting. Retryable either way; the point is
  // that the retry log names the real cause.
  const killed = classifyHostFailure(null, 'gh: signal: killed\n');
  assert.equal(killed.retryable, true);
  assert.equal(killed.reason, 'outage');
  // With an exit status present, an unrecognised wording stays `unknown`.
  assert.equal(classifyHostFailure(1, 'gh: signal: killed\n').reason, 'unknown');
});

test('classifyHostFailure: a 4xx that is neither auth nor not-found is definitive (client-error)', () => {
  const unprocessable = classifyHostFailure(1, 'HTTP 422: Validation Failed\n');
  assert.equal(unprocessable.retryable, false);
  assert.equal(unprocessable.reason, 'client-error');
});

test('classifyHostFailure: a 5xx status wins over a definitive-looking word elsewhere in the line', () => {
  // Ordering guard: the HTTP code is read first, so a 503 body mentioning
  // "not found" upstream does not get mis-filed as definitive.
  const gateway = classifyHostFailure(1, 'ERROR: GET https://gitlab.com/api/v4/x: 503 {message: 503 upstream not found}\n');
  assert.equal(gateway.retryable, true);
  assert.equal(gateway.reason, 'outage');
});

test('hostRetryPlanFor: the exponent is capped, so no caller can ask for an unbounded pause', () => {
  const capped = HOST_RETRY_BASE_DELAY_MS * 2 ** (HOST_READ_ATTEMPTS - 2);
  assert.equal(hostRetryPlanFor(HOST_READ_ATTEMPTS - 2).delayMs, capped);
  assert.equal(hostRetryPlanFor(99).delayMs, capped, 'past the bound the delay stops growing');
  assert.equal(hostRetryPlanFor(-1).delayMs, HOST_RETRY_BASE_DELAY_MS, 'a negative attempt floors at the base');
});

// --- createHost() wiring: the acceptance criterion itself -------------------
//
// The tests above drive runHostRead directly, which proves the LOOP but not that
// the three verbs the issue names are plugged into it. createHost() takes its CLI
// runner and its clock as optional deps precisely so this stays a contract test:
// a future edit that calls execFileSync straight from a verb fails here.

const stubHost = (host: 'gh' | 'glab', script: readonly (string | { fail: string })[]) => {
  const calls: { cli: string; argv: readonly string[] }[] = [];
  const slept: number[] = [];
  const logged: string[] = [];
  let step = 0;
  const api = createHost(host, {
    runCli: (cli, argv) => {
      calls.push({ cli, argv });
      const next = script[Math.min(step, script.length - 1)]!;
      step++;
      if (typeof next === 'string') return next;
      const error = new Error(`stub CLI failed:\n${next.fail}`) as Error & {
        status?: number | null;
        stderr?: string;
      };
      error.status = 1;
      error.stderr = next.fail;
      throw error;
    },
    effects: { sleep: (ms) => slept.push(ms), log: (line) => logged.push(line), random: () => 0 },
  });
  return { api, calls, slept, logged };
};

// Each CLI's own success shape for the labels read: gh's --jq prints one name per
// line, glab's --jq prints a JSON array.
const LABELS_STDOUT = { gh: 'bug\nready-for-agent\n', glab: '["bug","ready-for-agent"]' } as const;

for (const host of ['gh', 'glab'] as const) {
  test(`createHost(${host}): labelsOf retries a transient failure and returns the recovered labels`, () => {
    const { api, calls, slept, logged } = stubHost(host, [{ fail: GLAB_503 }, LABELS_STDOUT[host]]);
    assert.deepEqual(api.labelsOf(42), ['bug', 'ready-for-agent']);
    assert.equal(calls.length, 2, 'the read was retried');
    assert.deepEqual(slept, [HOST_RETRY_BASE_DELAY_MS], 'one backoff, jitter pinned to 0');
    assert.equal(logged.length, 1);
    assert.ok(logged[0]!.includes(host), `the log names the CLI: ${logged[0]}`);
  });

  test(`createHost(${host}): openChangeRequests retries a transient failure`, () => {
    const { api, calls } = stubHost(host, [{ fail: GH_CONN }, '[]']);
    assert.deepEqual(api.openChangeRequests(), []);
    assert.equal(calls.length, 2);
  });

  test(`createHost(${host}): queueIssues retries per label, and a definitive failure stops at once`, () => {
    const recovered = stubHost(host, [{ fail: GLAB_502 }, '[]']);
    assert.deepEqual(recovered.api.queueIssues(['ready-for-agent']), []);
    assert.equal(recovered.calls.length, 2, 'retried');

    const definitive = stubHost(host, [{ fail: GH_401 }, '[]']);
    assert.throws(() => definitive.api.queueIssues(['ready-for-agent']), /401/);
    assert.equal(definitive.calls.length, 1, 'no attempt burned on a definitive failure');
    assert.deepEqual(definitive.slept, []);
  });

  test(`createHost(${host}): a read that never recovers gives up after HOST_READ_ATTEMPTS`, () => {
    const { api, calls, slept } = stubHost(host, [{ fail: GH_CONN }]);
    assert.throws(() => api.labelsOf(42), /error connecting/);
    assert.equal(calls.length, HOST_READ_ATTEMPTS);
    assert.equal(slept.length, HOST_READ_ATTEMPTS - 1);
  });

  test(`createHost(${host}): issueInfoOf retries too, then still degrades to the fallback title`, () => {
    // The commit message called issueInfoOf "unchanged"; it is in fact routed
    // through the retry like the other reads. Pinned here so the behaviour is a
    // decision, not a leftover: retries first, degrade only once they are spent.
    const { api, calls } = stubHost(host, [{ fail: GH_CONN }]);
    assert.deepEqual(api.issueInfoOf(42, 'fallback title'), { number: 42, title: 'fallback title' });
    assert.equal(calls.length, HOST_READ_ATTEMPTS, 'the best-effort read still gets its attempts');
  });

  test(`createHost(${host}): a first-try success never sleeps — the happy path is untouched`, () => {
    const { api, calls, slept, logged } = stubHost(host, ['[]']);
    assert.deepEqual(api.queueIssues(['ready-for-agent']), []);
    assert.equal(calls.length, 1);
    assert.deepEqual(slept, []);
    assert.deepEqual(logged, []);
  });
}

finish();
