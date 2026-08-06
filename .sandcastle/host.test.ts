// Tests for the host abstraction — the module that owns every host-CLI difference
// (glab vs gh) so main.ts, chain.ts and the role prompts stay host-neutral.
//
// Covers the PURE pieces only: argv builders, JSON parsers, prompt-command
// builders and origin-host inference. The executing wrappers in createHost() are
// thin shells over execFileSync and are exercised through those builders — they
// are not unit-tested directly (no live glab/gh). Pure: no network, no CLI, no
// process.env.
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

finish();
