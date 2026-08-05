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
  planQueueCommand,
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
} from './host.ts';
import { test, throws, finish } from './test-harness.ts';

// --- prompt command builders -----------------------------------------------
// These strings are fed verbatim into promptArgs, so a regression here is a
// regression in what the planner/implementer/reviewer agents run. They must keep
// emitting the SAME normalized JSON shape per field across hosts (the planner's
// logic does not branch on host).

test('planQueueCommand(glab) is the glab issue-list with iid + description', () => {
  const cmd = planQueueCommand('glab');
  assert.ok(cmd.startsWith('glab issue list '), cmd);
  assert.ok(cmd.includes('--label sandcastle'), cmd);
  // glab issues carry .iid and .description; the planner reads number/body off them.
  assert.ok(cmd.includes('.iid'), cmd);
  assert.ok(cmd.includes('.description'), cmd);
});

test('planQueueCommand(gh) is the gh issue-list selecting number/title/body/labels', () => {
  const cmd = planQueueCommand('gh');
  assert.ok(cmd.startsWith('gh issue list '), cmd);
  assert.ok(cmd.includes('--label sandcastle'), cmd);
  // gh selects fields with --json; labels are objects, so the jq normalises to names.
  assert.ok(cmd.includes('--json'), cmd);
  assert.ok(cmd.includes('.number'), cmd);
  assert.ok(cmd.includes('.body'), cmd);
  assert.ok(cmd.includes('[.labels[].name]'), cmd);
});

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

test('createHost: returns the four operations for each host', () => {
  for (const host of ['glab', 'gh'] as const) {
    const h = createHost(host);
    assert.equal(typeof h.labelsOf, 'function', `${host}.labelsOf`);
    assert.equal(typeof h.issueInfoOf, 'function', `${host}.issueInfoOf`);
    assert.equal(typeof h.createDraftChangeRequest, 'function', `${host}.createDraftChangeRequest`);
    assert.equal(typeof h.openChangeRequests, 'function', `${host}.openChangeRequests`);
  }
});

finish();
